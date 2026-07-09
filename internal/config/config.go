package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	HTTP      HTTPConfig
	Auth      AuthConfig
	DB        DBConfig
	Safe      SafetyConfig
	AD        ADConfig
	Feishu    FeishuConfig
	Bootstrap BootstrapConfig
}

type FeishuConfig struct {
	AppID       string
	AppSecret   string
	RedirectURI string
	SessionDuration time.Duration
}

type HTTPConfig struct {
	Addr        string
	FrontendDir string
}

type BootstrapConfig struct {
	AdminUsername string
	AdminPassword string
}

type ADConfig struct {
	Host                  string
	Port                  int
	UseTLS                bool
	InsecureSkipVerify    bool
	BaseDN                string
	UserOU                string
	DisabledOU            string
	BindUsername          string
	BindPassword          string
	DomainNetBIOS         string
	DomainUPNSuffix       string
	DefaultUnlockDuration time.Duration
}

type AuthConfig struct {
	SessionDuration time.Duration
}

type DBConfig struct {
	Path string
}

type SafetyConfig struct {
	DeleteProtectedAccounts map[string]struct{}
}

func Load() (Config, error) {
	cfg := Config{
		HTTP: HTTPConfig{
			Addr:        env("HTTP_ADDR", ":8080"),
			FrontendDir: env("FRONTEND_DIR", "frontend"),
		},
		Auth: AuthConfig{
			SessionDuration: envDuration("ADMIN_SESSION_DURATION", 12*time.Hour),
		},
		DB: DBConfig{
			Path: env("DB_PATH", "ad-management.db"),
		},
		Safe: SafetyConfig{
			DeleteProtectedAccounts: normalizedSet(os.Getenv("AD_DELETE_PROTECTED_ACCOUNTS")),
		},
		Bootstrap: BootstrapConfig{
			AdminUsername: env("BOOTSTRAP_ADMIN_USERNAME", "admin"),
			AdminPassword: env("BOOTSTRAP_ADMIN_PASSWORD", "admin"),
		},
		AD: ADConfig{
			Host:                  env("AD_HOST", ""),
			Port:                  envInt("AD_PORT", 389),
			UseTLS:                envBool("AD_USE_TLS", false),
			InsecureSkipVerify:    envBool("AD_INSECURE_SKIP_VERIFY", false),
			BaseDN:                env("AD_BASE_DN", ""),
			UserOU:                env("AD_USER_OU", ""),
			DisabledOU:            env("AD_DISABLED_OU", ""),
			BindUsername:          env("AD_BIND_USERNAME", ""),
			BindPassword:          env("AD_BIND_PASSWORD", ""),
			DomainNetBIOS:         env("AD_DOMAIN_NETBIOS", ""),
			DomainUPNSuffix:       env("AD_DOMAIN_UPN_SUFFIX", ""),
			DefaultUnlockDuration: envDuration("AD_DEFAULT_UNLOCK_DURATION", 24*time.Hour),
		},
		Feishu: FeishuConfig{
			AppID:           env("FEISHU_APP_ID", ""),
			AppSecret:       env("FEISHU_APP_SECRET", ""),
			RedirectURI:     env("FEISHU_REDIRECT_URI", ""),
			SessionDuration: envDuration("SELF_SERVICE_SESSION_DURATION", 8*time.Hour),
		},
	}
	return cfg, nil
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

func envBool(key string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return fallback
	}
	return value
}

func envDuration(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := time.ParseDuration(raw)
	if err != nil {
		return fallback
	}
	return value
}

func normalizedSet(raw string) map[string]struct{} {
	values := map[string]struct{}{}
	for _, value := range strings.Split(raw, ",") {
		value = normalizeAccount(value)
		if value != "" {
			values[value] = struct{}{}
		}
	}
	return values
}

func normalizeAccount(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	if strings.Contains(value, `\`) {
		_, account, ok := strings.Cut(value, `\`)
		if ok {
			value = account
		}
	}
	if strings.Contains(value, "@") {
		account, _, ok := strings.Cut(value, "@")
		if ok {
			value = account
		}
	}
	return value
}
