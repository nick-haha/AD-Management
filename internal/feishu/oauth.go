package feishu

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Config 飞书应用配置
type Config struct {
	AppID       string
	AppSecret   string
	RedirectURI string
}

// AuthorizeURL 生成飞书授权页 URL，包含 state 参数防 CSRF
func (c *Config) AuthorizeURL(state string) string {
	u := url.URL{
		Scheme: "https",
		Host:   "accounts.feishu.cn",
		Path:   "/open-apis/authen/v1/authorize",
	}
	q := u.Query()
	q.Set("app_id", c.AppID)
	q.Set("redirect_uri", c.RedirectURI)
	q.Set("state", state)
	q.Set("response_type", "code")
	u.RawQuery = q.Encode()
	return u.String()
}

// GenerateState 生成随机 state 参数（32 字节 hex）
func GenerateState() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate state: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// TokenResponse 飞书 token 响应（v3 接口返回扁平结构，字段在顶层）
type TokenResponse struct {
	Code          int    `json:"code"`
	Msg           string `json:"msg,omitempty"`
	AccessToken   string `json:"access_token"`
	TokenType     string `json:"token_type"`
	ExpiresIn     int    `json:"expires_in"`
	RefreshToken  string `json:"refresh_token,omitempty"`
	Scope         string `json:"scope"`
}

// ExchangeCode 用授权码换取 user_access_token
// POST https://accounts.feishu.cn/oauth/v3/token
// Body: application/x-www-form-urlencoded
func (c *Config) ExchangeCode(ctx context.Context, code string) (*TokenResponse, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("client_id", c.AppID)
	form.Set("client_secret", c.AppSecret)
	form.Set("code", code)
	form.Set("redirect_uri", c.RedirectURI)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://accounts.feishu.cn/oauth/v3/token",
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("create token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("exchange code: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("token API HTTP %d: %s", resp.StatusCode, string(raw))
	}

	// 飞书 v3 token 接口返回扁平结构：{"code":0, "access_token":"...", "token_type":"Bearer", ...}
	var result TokenResponse
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("decode token response failed: %w, raw=%s", err, string(raw))
	}
	if result.Code != 0 {
		return nil, fmt.Errorf("token API error code=%d msg=%s (raw=%s)", result.Code, result.Msg, string(raw))
	}
	if result.AccessToken == "" {
		return nil, fmt.Errorf("token API returned empty access_token (raw=%s)", string(raw))
	}

	return &result, nil
}

// tenantTokenAPIResponse 飞书 tenant_access_token 响应
type tenantTokenAPIResponse struct {
	Code              int    `json:"code"`
	Msg               string `json:"msg"`
	TenantAccessToken string `json:"tenant_access_token"`
	Expire            int    `json:"expire"`
}

// TestCredentials 用 app_id+app_secret 换取 tenant_access_token，
// 验证应用凭据是否有效。成功返回 nil。
func (c *Config) TestCredentials(ctx context.Context) error {
	body := url.Values{}
	body.Set("app_id", c.AppID)
	body.Set("app_secret", c.AppSecret)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
		strings.NewReader(body.Encode()))
	if err != nil {
		return fmt.Errorf("create test request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("test credentials: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("feishu token API returned %d: %s", resp.StatusCode, string(raw))
	}

	var result tenantTokenAPIResponse
	if err := json.Unmarshal(raw, &result); err != nil {
		return fmt.Errorf("decode token response: %w", err)
	}
	if result.Code != 0 {
		return fmt.Errorf("feishu error: code=%d msg=%s", result.Code, result.Msg)
	}
	return nil
}
