package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"time"

	"ad-management/internal/feishu"
	"ad-management/internal/store"
)

// SelfServiceUser 自服务用户上下文
type SelfServiceUser struct {
	FeishuName string // 飞书用户姓名
	ADAccount  string // 对应的 AD samAccountName (可能为空，如 AD 中无匹配)
	OpenID     string // 飞书 open_id
}

type selfServiceUserKey struct{}

func contextWithSelfServiceUser(ctx context.Context, u *SelfServiceUser) context.Context {
	return context.WithValue(ctx, selfServiceUserKey{}, u)
}

func selfServiceUserFromContext(ctx context.Context) (*SelfServiceUser, bool) {
	u, ok := ctx.Value(selfServiceUserKey{}).(*SelfServiceUser)
	return u, ok
}

// ── Handler: 飞书登录入口 ──

func (s *Server) feishuLogin(w http.ResponseWriter, r *http.Request) {
	// 动态加载飞书配置（DB 优先，env 回退）
	cfg := s.getFeishuConfig()
	if cfg == nil || cfg.AppID == "" {
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Error: "feishu_not_configured"})
		return
	}

	// 1. 生成随机 state 并存入服务端内存（10分钟有效）
	state, err := s.oauthStore.generate()
	if err != nil {
		s.logger.Error("generate oauth state failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "internal_error"})
		return
	}

	// 2. 302 重定向到飞书授权 URL（无需 Cookie）
	authURL := cfg.AuthorizeURL(state)
	http.Redirect(w, r, authURL, http.StatusFound)
}

// ── Handler: 飞书 OAuth 回调 ──

func (s *Server) feishuCallback(w http.ResponseWriter, r *http.Request) {
	// 动态加载飞书配置
	cfg := s.getFeishuConfig()
	if cfg == nil || cfg.AppID == "" {
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Error: "feishu_not_configured"})
		return
	}

	// 1. 校验 state（从服务端内存中查找，防 CSRF）
	urlState := r.URL.Query().Get("state")
	if !s.oauthStore.validate(urlState) {
		s.logger.Warn("feishu callback: invalid or expired state", "url_state", urlState)
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "invalid_oauth_state"})
		return
	}

	// 2. 获取授权码
	code := r.URL.Query().Get("code")
	if code == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing_authorization_code"})
		return
	}

	// 3. 用 code 换 user_access_token
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	tokenResp, err := cfg.ExchangeCode(ctx, code)
	if err != nil {
		s.logger.Error("exchange feishu code failed", "error", err)
		writeJSON(w, http.StatusBadGateway, errorResponse{Error: "feishu_token_exchange_failed", Detail: err.Error()})
		return
	}
	s.logger.Info("feishu token exchange success", "token_type", tokenResp.TokenType, "expires_in", tokenResp.ExpiresIn, "scope", tokenResp.Scope)

	// 4. 用 token 获取用户信息 (name, open_id)
	userInfo, err := feishu.GetUserInfo(ctx, tokenResp.AccessToken)
	if err != nil {
		s.logger.Error("get feishu userinfo failed", "error", err, "access_token_prefix", tokenResp.AccessToken[:min(20, len(tokenResp.AccessToken))])
		writeJSON(w, http.StatusBadGateway, errorResponse{Error: "feishu_userinfo_failed", Detail: err.Error()})
		return
	}

	s.logger.Info("feishu auth success", "name", userInfo.Name, "open_id", userInfo.OpenID)

	// 5. 用 name 在 AD 中查找对应的 samAccountName
	adAccount := ""
	if userInfo.Name != "" {
		adAccount, err = s.matchFeishuNameToAD(ctx, userInfo.Name)
		if err != nil {
			s.logger.Warn("feishu name match AD failed", "name", userInfo.Name, "error", err)
			// 不阻断登录，只是 ad_account 为空，用户只能搜索
		}
	}

	// 6. 生成自服务 session token（40 字节 hex）
	sessionToken, err := generateSessionToken()
	if err != nil {
		s.logger.Error("generate session token failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "internal_error"})
		return
	}

	// 7. 写入 DB（session 时长使用动态配置）
	sessionDuration := s.getFeishuSessionDuration()
	expiresAt := time.Now().Add(sessionDuration)
	if err := s.store.CreateSelfServiceSession(ctx, sessionToken, userInfo.OpenID, userInfo.Name, adAccount, expiresAt); err != nil {
		s.logger.Error("create self-service session failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "internal_error"})
		return
	}

	// 8. 写入 HttpOnly Cookie
	maxAge := int(sessionDuration.Seconds())
	secure := isSecureRequest(r)
	http.SetCookie(w, &http.Cookie{
		Name:     "ss_token",
		Value:    sessionToken,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})

	// 9. 记录审计日志
	ip := clientIP(r)
	ua := r.UserAgent()
	actor := adAccount
	if actor == "" {
		actor = "feishu:" + userInfo.Name
	}
	s.auditWithIP(ctx, actor, "login", "", "feishu_oauth", ip, ua)

	// 10. 302 重定向到首页
	redirectURL := "/"
	if adAccount == "" {
		redirectURL = "/?auth=ok&no_ad=1"
	} else {
		redirectURL = "/?auth=ok"
	}
	http.Redirect(w, r, redirectURL, http.StatusFound)
}

// matchFeishuNameToAD 用飞书姓名在 AD 中查找对应的 samAccountName
// 优先匹配 displayName，再匹配 cn；若多个匹配则返回第一个
func (s *Server) matchFeishuNameToAD(ctx context.Context, name string) (string, error) {
	users, err := s.ad.SearchUsers(ctx, name)
	if err != nil {
		return "", err
	}

	// 优先精确匹配 displayName
	for _, u := range users {
		if u.DisplayName == name && u.SAMAccountName != "" {
			return u.SAMAccountName, nil
		}
	}

	// 再精确匹配 cn
	for _, u := range users {
		if u.CN == name && u.SAMAccountName != "" {
			return u.SAMAccountName, nil
		}
	}

	// 取第一个非管理员的结果
	for _, u := range users {
		if !u.IsAdmin && u.SAMAccountName != "" {
			return u.SAMAccountName, nil
		}
	}

	return "", fmt.Errorf("no matching AD account found for feishu name: %s", name)
}

// ── Handler: 获取当前自服务 session 信息 ──

func (s *Server) selfServiceSession(w http.ResponseWriter, r *http.Request) {
	// 从 Cookie 读取 session（此路由无中间件，需自行解析）
	user, err := s.lookupSelfServiceSession(r)
	if err != nil || user == nil {
		writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "self_service_auth_required"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"name":    user.FeishuName,
		"account": user.ADAccount,
		"openId":  user.OpenID,
	})
}

// ── Handler: 自服务登出 ──

func (s *Server) selfServiceLogout(w http.ResponseWriter, r *http.Request) {
	// 从 Cookie 读取 ss_token
	if c, err := r.Cookie("ss_token"); err == nil && c.Value != "" {
		_ = s.store.DeleteSelfServiceSession(r.Context(), c.Value)
	}

	// 清除 Cookie
	http.SetCookie(w, &http.Cookie{
		Name:     "ss_token",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   isSecureRequest(r),
		SameSite: http.SameSiteLaxMode,
	})

	// 审计日志（从 Cookie 读取用户信息，此路由无中间件）
	user, _ := s.lookupSelfServiceSession(r)
	if user != nil {
		actor := user.ADAccount
		if actor == "" {
			actor = "feishu:" + user.FeishuName
		}
		ip := clientIP(r)
		ua := r.UserAgent()
		s.auditWithIP(r.Context(), actor, "login", "", "logout", ip, ua)
	}

	writeJSON(w, http.StatusOK, statusResponse{Status: "logged_out"})
}

// ── 辅助函数 ──

// isSecureRequest 判断请求是否通过 HTTPS（含反向代理场景）
func isSecureRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	// 支持反向代理设置的标准头
	if v := r.Header.Get("X-Forwarded-Proto"); v == "https" {
		return true
	}
	return false
}

func generateSessionToken() (string, error) {
	b := make([]byte, 40)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate session token: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// lookupSelfServiceSession 从 Cookie 解析并验证自服务 session
func (s *Server) lookupSelfServiceSession(r *http.Request) (*SelfServiceUser, error) {
	c, err := r.Cookie("ss_token")
	if err != nil {
		if errors.Is(err, http.ErrNoCookie) {
			return nil, nil // 无 Cookie，非错误
		}
		return nil, err
	}

	sess, err := s.store.FindSelfServiceSession(r.Context(), c.Value)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, nil // 无效/过期 token
		}
		return nil, err
	}

	// 更新 last_seen（异步，不阻塞）
	go func() {
		_ = s.store.TouchSelfServiceSession(context.Background(), c.Value)
	}()

	return &SelfServiceUser{
		FeishuName: sess.FeishuName,
		ADAccount:  sess.ADAccount,
		OpenID:     sess.OpenID,
	}, nil
}
