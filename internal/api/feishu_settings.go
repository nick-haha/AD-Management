package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"ad-management/internal/feishu"
	"ad-management/internal/store"
)

// getFeishuConfig 动态加载飞书配置：DB 优先，env 变量作为 bootstrap 回退。
// 返回 nil 表示飞书未配置。
func (s *Server) getFeishuConfig() *feishu.Config {
	// 1. 尝试从 DB 读取
	if s.store != nil {
		settings, err := s.store.GetFeishuSettings(context.Background())
		if err == nil && settings.AppID != "" && settings.Enabled {
			return &feishu.Config{
				AppID:       settings.AppID,
				AppSecret:   settings.AppSecret,
				RedirectURI: settings.RedirectURI,
			}
		}
	}
	// 2. 回退到 env 变量初始化的配置
	if s.feishuCfg != nil && s.feishuCfg.AppID != "" {
		return s.feishuCfg
	}
	return nil
}

// getFeishuSessionDuration 获取飞书自服务 session 时长（DB 优先）
func (s *Server) getFeishuSessionDuration() time.Duration {
	if s.store != nil {
		settings, err := s.store.GetFeishuSettings(context.Background())
		if err == nil && settings.SessionDurationHours > 0 {
			return time.Duration(settings.SessionDurationHours) * time.Hour
		}
	}
	return s.cfg.Feishu.SessionDuration
}

// ── Handler: 获取飞书配置（secret 脱敏） ──

func (s *Server) getFeishuSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := s.store.GetFeishuSettings(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "feishu_settings_query_failed"})
		return
	}
	// 判断是否已配置（app_id 非空）
	configured := settings.AppID != ""
	// 脱敏：app_secret 不返回明文，只返回是否已设置的标志
	hasSecret := strings.TrimSpace(settings.AppSecret) != ""
	response := map[string]any{
		"appId":                settings.AppID,
		"appSecret":            "",
		"appSecretSet":         hasSecret,
		"redirectUri":          settings.RedirectURI,
		"enabled":              settings.Enabled,
		"sessionDurationHours": settings.SessionDurationHours,
		"configured":           configured,
		"updatedAt":            settings.UpdatedAt,
	}
	// 如果 DB 没配置但 env 有，回显 env 值（只读提示）
	if !configured && s.feishuCfg != nil && s.feishuCfg.AppID != "" {
		response["appId"] = s.feishuCfg.AppID
		response["redirectUri"] = s.feishuCfg.RedirectURI
		response["enabled"] = true
		response["configured"] = true
		response["envSourced"] = true
		response["appSecretSet"] = s.feishuCfg.AppSecret != ""
	}
	writeJSON(w, http.StatusOK, response)
}

// ── Handler: 保存飞书配置 ──

func (s *Server) saveFeishuSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AppID               string `json:"appId"`
		AppSecret           string `json:"appSecret"`
		RedirectURI         string `json:"redirectUri"`
		Enabled             bool   `json:"enabled"`
		SessionDurationHours int   `json:"sessionDurationHours"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	settings := store.FeishuSettings{
		AppID:               strings.TrimSpace(req.AppID),
		AppSecret:           req.AppSecret, // 空值时 SaveFeishuSettings 会保留旧值
		RedirectURI:         strings.TrimSpace(req.RedirectURI),
		Enabled:             req.Enabled,
		SessionDurationHours: req.SessionDurationHours,
	}

	if err := s.store.SaveFeishuSettings(r.Context(), settings); err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "feishu_settings_save_failed"})
		return
	}

	s.audit(r.Context(), actorFromContext(r.Context()), "save_ad_settings", "feishu", "")
	writeJSON(w, http.StatusOK, statusResponse{Status: "saved"})
}

// ── Handler: 测试飞书配置 ──
// 用提交的配置尝试调用飞书授权 URL 生成（仅校验参数完整性），
// 并可选地用 app_id+app_secret 换取 app_access_token 验证凭据有效性。

func (s *Server) testFeishuSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AppID                string `json:"appId"`
		AppSecret            string `json:"appSecret"`
		RedirectURI          string `json:"redirectUri"`
		Enabled              bool   `json:"enabled"`
		SessionDurationHours int    `json:"sessionDurationHours"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	// app_secret 为空时用已保存的值
	appSecret := strings.TrimSpace(req.AppSecret)
	if appSecret == "" {
		current, err := s.store.GetFeishuSettings(r.Context())
		if err == nil {
			appSecret = current.AppSecret
		}
	}

	appID := strings.TrimSpace(req.AppID)
	if appID == "" || appSecret == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "feishu_missing_credentials"})
		return
	}

	// 用飞书 tenant_access_token 接口验证凭据
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	cfg := &feishu.Config{AppID: appID, AppSecret: appSecret, RedirectURI: req.RedirectURI}
	if err := cfg.TestCredentials(ctx); err != nil {
		writeJSON(w, http.StatusBadGateway, errorResponse{Error: "feishu_credentials_invalid", Detail: err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, statusResponse{Status: "connected"})
}
