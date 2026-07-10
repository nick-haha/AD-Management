package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"ad-management/internal/ad"
	"ad-management/internal/api"
	"ad-management/internal/config"
	"ad-management/internal/feishu"
	"ad-management/internal/security"
	"ad-management/internal/store"

	"golang.org/x/crypto/bcrypt"
)

var logger *slog.Logger

func init() {
	// 初始化默认logger
	logger = slog.New(slog.NewJSONHandler(os.Stdout, nil))
}

func main() {
	// 创建多输出日志处理器（控制台 + 文件）
	logDir := os.Getenv("LOG_DIR")
	if logDir == "" {
		logDir = "logs"
	}
	
	// 确保日志目录存在
	if err := os.MkdirAll(logDir, 0755); err == nil {
		// 创建日志文件（按日期命名）
		logFile := filepath.Join(logDir, "server-"+time.Now().Format("2006-01-02")+".log")
		file, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err == nil {
			// 多输出：同时写入控制台和文件
			multiWriter := io.MultiWriter(os.Stdout, file)
			logger = slog.New(slog.NewJSONHandler(multiWriter, &slog.HandlerOptions{
				Level: slog.LevelInfo,
			}))
			logger.Info("log file created", "path", logFile)
		} else {
			logger.Warn("failed to create log file, using stdout only", "error", err)
		}
	}

	cfg, err := config.Load()
	if err != nil {
		logger.Error("load config failed", "error", err)
		os.Exit(1)
	}
	logger.Info("configuration loaded", "db_path", cfg.DB.Path, "http_addr", cfg.HTTP.Addr, "frontend", cfg.HTTP.FrontendDir)

	db, err := store.Open(cfg.DB.Path)
	if err != nil {
		logger.Error("open database failed", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	logger.Info("database opened", "path", cfg.DB.Path)

	// 加载凭据加密密钥（方案 B：字段级 AES-256-GCM 加密）
	cipher, err := security.NewCredentialCipher(cfg.Security.CredentialEncKey)
	if err != nil {
		logger.Error("init credential cipher failed", "error", err)
		os.Exit(1)
	}
	db.SetCipher(cipher)
	if cipher.Enabled() {
		logger.Info("credential encryption enabled")
		// 启动迁移：把存量明文凭据（bindPassword/appSecret）加密回写
		if n, mErr := db.EnsureEncrypted(context.Background()); mErr != nil {
			logger.Error("encrypt existing credentials failed", "error", mErr)
			os.Exit(1)
		} else if n > 0 {
			logger.Info("migrated plaintext credentials to encrypted", "count", n)
		}
	} else {
		logger.Warn("credential encryption NOT enabled (AD_CRED_ENC_KEY unset); sensitive credentials stored as plaintext. Set AD_CRED_ENC_KEY to enable.")
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(cfg.Bootstrap.AdminPassword), bcrypt.DefaultCost)
	if err != nil {
		logger.Error("hash bootstrap admin password failed", "error", err)
		os.Exit(1)
	}
	if err := db.EnsureAdmin(context.Background(), cfg.Bootstrap.AdminUsername, hash); err != nil {
		logger.Error("ensure bootstrap admin failed", "error", err)
		os.Exit(1)
	}
	logger.Info("bootstrap admin ensured", "username", cfg.Bootstrap.AdminUsername)

	// Check for password reset request
	if resetPassword := os.Getenv("ADMIN_RESET_PASSWORD"); resetPassword != "" {
		resetHash, err := bcrypt.GenerateFromPassword([]byte(resetPassword), bcrypt.DefaultCost)
		if err != nil {
			logger.Error("hash reset password failed", "error", err)
			os.Exit(1)
		}
		if err := db.ResetAdminPasswordByUsername(context.Background(), cfg.Bootstrap.AdminUsername, string(resetHash)); err != nil {
			logger.Error("reset admin password failed", "error", err)
			os.Exit(1)
		}
		logger.Info("admin password reset completed", "username", cfg.Bootstrap.AdminUsername)
		// Clear the environment variable for security
		os.Unsetenv("ADMIN_RESET_PASSWORD")
	}

	adClient := ad.NewDBClient(db, logger)
	logger.Info("AD client initialized, waiting for domain controller configuration")

	// 初始化飞书 OAuth 客户端
	var feishuCfg *feishu.Config
	if cfg.Feishu.AppID != "" {
		feishuCfg = &feishu.Config{
			AppID:       cfg.Feishu.AppID,
			AppSecret:   cfg.Feishu.AppSecret,
			RedirectURI: cfg.Feishu.RedirectURI,
		}
		logger.Info("Feishu OAuth configured", "app_id", cfg.Feishu.AppID, "redirect_uri", cfg.Feishu.RedirectURI)
	} else {
		logger.Info("Feishu OAuth not configured, self-service auth disabled")
	}

	server := &http.Server{
		Addr:              cfg.HTTP.Addr,
		Handler:           api.NewRouter(api.Dependencies{AD: adClient, Config: cfg, Logger: logger, Store: db, FeishuCfg: feishuCfg}),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Info("server started", "addr", cfg.HTTP.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
	}
}
