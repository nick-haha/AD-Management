package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"ad-management/internal/ad"
	"ad-management/internal/config"
	"ad-management/internal/feishu"
	"ad-management/internal/security"
	"ad-management/internal/store"

	"golang.org/x/crypto/bcrypt"
)

type Dependencies struct {
	AD        ad.Directory
	Config    config.Config
	Logger    *slog.Logger
	Store     *store.Store
	FeishuCfg *feishu.Config
}

type Server struct {
	ad         ad.Directory
	cfg        config.Config
	logger     *slog.Logger
	scheduler  *DisableScheduler
	store      *store.Store
	feishuCfg  *feishu.Config
	oauthStore *oauthStateStore
}

func NewRouter(deps Dependencies) http.Handler {
	logger := deps.Logger
	if logger == nil {
		logger = slog.Default()
	}
	server := &Server{
		ad:         deps.AD,
		cfg:        deps.Config,
		logger:     logger,
		scheduler:  NewDisableScheduler(deps.AD, logger, deps.Store),
		store:      deps.Store,
		feishuCfg:  deps.FeishuCfg,
		oauthStore: newOAuthStateStore(),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", server.health)
	mux.HandleFunc("POST /api/admin/login", server.login)

	// 飞书 OAuth 路由（无需认证）
	mux.HandleFunc("GET /api/auth/feishu/login", server.feishuLogin)
	mux.HandleFunc("GET /api/auth/feishu/callback", server.feishuCallback)
	mux.HandleFunc("GET /api/auth/feishu/session", server.selfServiceSession)
	mux.HandleFunc("POST /api/auth/feishu/logout", server.selfServiceLogout)

	// Self-service endpoints protected by dual-track middleware
	// Authenticated: search 60/min, write 20/min
	// Anonymous: search 30/min, write 0/min (blocked)
	selfReadLimiter := NewRateLimiter(60, time.Minute)
	selfWriteLimiter := NewRateLimiter(20, time.Minute)
	mux.Handle("GET /api/me/users", server.requireSelfServiceOrRateLimit(selfReadLimiter, nil)(http.HandlerFunc(server.findUser)))
	mux.Handle("POST /api/me/users/unlock", server.requireSelfServiceOrRateLimit(nil, selfWriteLimiter)(http.HandlerFunc(server.unlockSelf)))
	mux.Handle("POST /api/me/users/password", server.requireSelfServiceOrRateLimit(nil, selfWriteLimiter)(http.HandlerFunc(server.resetSelfPassword)))

	// adminOnly 组合 requireAdmin + requirePerms，先认证再按权限鉴权。
	// 权限项参考 store.go 中的 Perm* 常量，与前端 PERMS 矩阵一一对应。
	mux.Handle("GET /api/admin/options", server.adminOnly([]string{store.PermSearch, store.PermCreate}, server.adminOptions))
	mux.Handle("GET /api/admin/ad-settings", server.adminOnly([]string{store.PermSearch, store.PermADSettings}, server.getADSettings))
	mux.Handle("PUT /api/admin/ad-settings", server.adminOnly([]string{store.PermADSettings}, server.saveADSettings))
	mux.Handle("POST /api/admin/ad-settings/test", server.adminOnly([]string{store.PermADSettings}, server.testADSettings))
	mux.Handle("GET /api/admin/ad-settings/connectivity", server.adminOnly([]string{store.PermSearch, store.PermADSettings}, server.checkADConnectivity))
	mux.Handle("GET /api/admin/ous", server.adminOnly([]string{store.PermCreate}, server.discoverOUs))
	mux.Handle("GET /api/admin/groups", server.adminOnly([]string{store.PermCreate, store.PermAddGroup}, server.discoverGroups))
	mux.Handle("GET /api/admin/users", server.adminOnly([]string{store.PermSearch}, server.findUser))
	mux.Handle("POST /api/admin/users", server.adminOnly([]string{store.PermCreate}, server.createUser))
	mux.Handle("DELETE /api/admin/users", server.adminOnly([]string{store.PermDelete}, server.deleteUser))
	mux.Handle("POST /api/admin/users/disable", server.adminOnly([]string{store.PermDisable}, server.disableUser))
	mux.Handle("POST /api/admin/users/enable", server.adminOnly([]string{store.PermDisable}, server.enableUser))
	mux.Handle("POST /api/admin/users/remove-group", server.adminOnly([]string{store.PermAddGroup}, server.removeUserGroup))
	mux.Handle("POST /api/admin/users/add-group", server.adminOnly([]string{store.PermAddGroup}, server.addUserGroup))
	mux.Handle("PUT /api/admin/users/update", server.adminOnly([]string{store.PermModifyUser}, server.updateUser))
	mux.Handle("POST /api/admin/users/unlock", server.adminOnly([]string{store.PermUnlock}, server.unlockUser))
	mux.Handle("POST /api/admin/users/password", server.adminOnly([]string{store.PermResetPwd}, server.resetUserPassword))
	mux.Handle("POST /api/admin/users/offboard", server.adminOnly([]string{store.PermOffboard}, server.offboardUser))
	mux.Handle("PUT /api/admin/me/password", server.adminOnly(store.AllPermissions(), server.changeMyPassword))
	mux.Handle("GET /api/admin/me", server.adminOnly(store.AllPermissions(), server.currentAdmin))
	mux.Handle("GET /api/admin/users/detail", server.adminOnly([]string{store.PermSearch}, server.userDetail))
	mux.Handle("GET /api/admin/scheduled-tasks", server.adminOnly([]string{store.PermTasks}, server.listScheduledTasks))
	mux.Handle("DELETE /api/admin/scheduled-tasks", server.adminOnly([]string{store.PermTasks}, server.cancelScheduledTask))
	mux.Handle("GET /api/admin/audit-logs", server.adminOnly([]string{store.PermAudit}, server.auditLogs))
	mux.Handle("GET /api/admin/feishu-settings", server.adminOnly([]string{store.PermFeishuSettings}, server.getFeishuSettings))
	mux.Handle("PUT /api/admin/feishu-settings", server.adminOnly([]string{store.PermFeishuSettings}, server.saveFeishuSettings))
	mux.Handle("POST /api/admin/feishu-settings/test", server.adminOnly([]string{store.PermFeishuSettings}, server.testFeishuSettings))
	// 管理员管理（需 adminMgmt 权限）：列表 / 创建 / 删除 / 重置密码 / 改权限
	mux.Handle("GET /api/admin/admins", server.adminOnly([]string{store.PermAdminMgmt}, server.listAdmins))
	mux.Handle("POST /api/admin/admins", server.adminOnly([]string{store.PermAdminMgmt}, server.createAdmin))
	mux.Handle("DELETE /api/admin/admins", server.adminOnly([]string{store.PermAdminMgmt}, server.deleteAdmin))
	mux.Handle("POST /api/admin/admins/reset-password", server.adminOnly([]string{store.PermAdminMgmt}, server.resetAdminPassword))
	mux.Handle("PUT /api/admin/admins/permissions", server.adminOnly([]string{store.PermAdminMgmt}, server.updateAdminPermissions))
	if deps.Config.HTTP.FrontendDir != "" {
		mux.Handle("/", staticFiles(deps.Config.HTTP.FrontendDir))
	}
	return requestLogger(logger)(securityHeaders(recoverer(server.withJSON(mux), logger)))
}

// securityHeaders 添加安全相关的 HTTP 响应头，防止点击劫持、MIME 嗅探、信息泄露。
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		// CSP：当前 admin.html 有内联 onclick 事件，script-src 需 'unsafe-inline'。
		// 后续移除内联事件后可收紧为 script-src 'self'。
		h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

// -- Handlers --

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) findUser(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	// 先记录审计日志（无论搜索是否成功，都记录搜索行为）
	searchDetail := "搜索关键字: " + query
	if strings.HasPrefix(r.URL.Path, "/api/me/") {
		ip := clientIP(r)
		ua := r.UserAgent()
		actor := actorFromContext(r.Context())
		if actor == "" { actor = "anonymous" }
		if actor == "anonymous" {
			s.auditWithIP(r.Context(), actor, "search_users", query, searchDetail, ip, ua)
		} else {
			s.audit(r.Context(), actor, "search_users", query, searchDetail)
		}
	} else {
		s.audit(r.Context(), actorFromContext(r.Context()), "search_users", query, searchDetail)
	}

	users, err := s.ad.SearchUsers(r.Context(), query)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, users)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Error: "database_not_configured"})
		return
	}
	var req loginRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	
	username := strings.TrimSpace(req.Username)
	clientIP := clientIP(r)
	
	// 检查是否被锁定
	locked, attempts, err := s.store.IsLockedOut(r.Context(), username)
	if err != nil {
		s.logger.Warn("check lockout failed", "error", err)
	}
	if locked {
		remaining, _ := s.store.GetLockoutRemaining(r.Context(), username)
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "account_locked", Detail: fmt.Sprintf("登录失败次数过多，请等待 %v 后重试", remaining.Round(time.Minute))})
		s.logger.Warn("login blocked due to lockout", "username", username, "ip", clientIP)
		return
	}
	
	admin, err := s.store.FindAdminByUsername(r.Context(), username)
	if err != nil {
		// 用户不存在也记录失败尝试
		if dbErr := s.store.RecordLoginAttempt(r.Context(), username, clientIP, false); dbErr != nil {
			s.logger.Warn("record login attempt failed", "username", username, "error", dbErr)
		}
		writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "invalid_credentials"})
		return
	}

	if !checkPassword(admin.PasswordHash, req.Password) {
		// 密码错误，记录失败尝试
		if dbErr := s.store.RecordLoginAttempt(r.Context(), username, clientIP, false); dbErr != nil {
			s.logger.Warn("record login attempt failed", "username", username, "error", dbErr)
		}
		attempts++
		remaining := store.MaxLoginAttempts - attempts
		if remaining > 0 {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "invalid_credentials", Detail: fmt.Sprintf("密码错误，剩余 %d 次尝试机会", remaining)})
		} else {
			writeJSON(w, http.StatusForbidden, errorResponse{Error: "account_locked", Detail: "登录失败次数过多，账号已锁定30分钟"})
		}
		s.logger.Warn("login failed", "username", username, "ip", clientIP, "attempts", attempts)
		return
	}
	
	// 登录成功，清除失败记录
	if dbErr := s.store.ClearLoginAttempts(r.Context(), username); dbErr != nil {
		s.logger.Warn("clear login attempts failed", "username", username, "error", dbErr)
	}
	if dbErr := s.store.RecordLoginAttempt(r.Context(), username, clientIP, true); dbErr != nil {
		s.logger.Warn("record login attempt failed", "username", username, "error", dbErr)
	}
	
	token, err := security.GeneratePassword(40)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "token_generation_failed"})
		return
	}
	expiresAt := time.Now().Add(s.cfg.Auth.SessionDuration)
	if err := s.store.CreateSession(r.Context(), token, admin.ID, expiresAt); err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "session_create_failed"})
		return
	}
	s.audit(r.Context(), username, "login", "", "ip="+clientIP)
	writeJSON(w, http.StatusOK, loginResponse{Token: token, Username: admin.Username, Role: admin.Role, Permissions: admin.EffectivePermissions(), ExpiresAt: expiresAt})
}

func (s *Server) unlockSelf(w http.ResponseWriter, r *http.Request) {
	var req accountRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	// 身份校验：只能操作自己的账户
	if err := ensureSelfAction(r.Context(), req.Account); err != nil {
		writeJSON(w, http.StatusForbidden, errorResponse{Error: err.Error()})
		return
	}
	if err := s.ad.UnlockUser(r.Context(), req.Account); err != nil {
		writeError(w, err)
		return
	}
	// 审计日志记录真实操作者
	ssUser, _ := selfServiceUserFromContext(r.Context())
	actor := req.Account
	if ssUser != nil && ssUser.ADAccount != "" {
		actor = ssUser.ADAccount
	}
	s.audit(r.Context(), actor, "unlock_self", req.Account, "")
	writeJSON(w, http.StatusOK, statusResponse{Status: "unlocked"})
}

func (s *Server) resetSelfPassword(w http.ResponseWriter, r *http.Request) {
	var req passwordRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	// 身份校验：只能操作自己的账户
	if err := ensureSelfAction(r.Context(), req.Account); err != nil {
		writeJSON(w, http.StatusForbidden, errorResponse{Error: err.Error()})
		return
	}
	password := req.Password
	if strings.TrimSpace(password) == "" {
		var err error
		password, err = security.GeneratePassword(14)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "password_generation_failed"})
			return
		}
	}
	if err := s.ad.ResetPassword(r.Context(), req.Account, password, true); err != nil {
		writeError(w, err)
		return
	}
	// 审计日志记录真实操作者
	ssUser, _ := selfServiceUserFromContext(r.Context())
	actor := req.Account
	if ssUser != nil && ssUser.ADAccount != "" {
		actor = ssUser.ADAccount
	}
	s.audit(r.Context(), actor, "reset_self_password", req.Account, "mustChange=true")
	writeJSON(w, http.StatusOK, statusResponse{Status: "password_reset", MustChange: true, Password: password})
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	var req ad.CreateUserInput
	if !decodeJSON(w, r, &req) {
		return
	}
	generatedPassword := ""
	if strings.TrimSpace(req.Password) == "" {
		password, err := security.GeneratePassword(14)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "password_generation_failed"})
			return
		}
		req.Password = password
		generatedPassword = password
	}
	user, err := s.ad.CreateUser(r.Context(), req)
	if err != nil {
		writeError(w, err)
		return
	}
	s.audit(r.Context(), actorFromContext(r.Context()), "create_user", req.SAMAccountName, "")
	writeJSON(w, http.StatusCreated, createUserResponse{User: user, Password: generatedPassword})
}

func (s *Server) adminOptions(w http.ResponseWriter, r *http.Request) {
	settings, err := s.store.GetADSettings(r.Context())
	if err != nil {
		writeJSON(w, http.StatusOK, adminOptionsResponse{})
		return
	}
	writeJSON(w, http.StatusOK, adminOptionsResponse{
		OUOptions:    parseOptionList(settings.OUOptions),
		GroupOptions: parseOptionList(settings.GroupOptions),
	})
}

func (s *Server) getADSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := s.store.GetADSettings(r.Context())
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusOK, store.ADSettings{Port: 389, InsecureSkipVerify: false})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "ad_settings_query_failed"})
		return
	}
	settings.BindPassword = ""
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) saveADSettings(w http.ResponseWriter, r *http.Request) {
	var req store.ADSettings
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.BindPassword) == "" {
		current, err := s.store.GetADSettings(r.Context())
		if err == nil {
			req.BindPassword = current.BindPassword
		}
	}
	if err := s.store.SaveADSettings(r.Context(), req); err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "ad_settings_save_failed"})
		return
	}
	s.audit(r.Context(), actorFromContext(r.Context()), "save_ad_settings", req.Host, "")
	writeJSON(w, http.StatusOK, statusResponse{Status: "saved"})
}

func (s *Server) testADSettings(w http.ResponseWriter, r *http.Request) {
	var req store.ADSettings
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.BindPassword) == "" {
		current, err := s.store.GetADSettings(r.Context())
		if err == nil {
			req.BindPassword = current.BindPassword
		}
	}
	client := ad.NewClient(adConfigFromSettings(req), s.logger)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := client.TestConnection(ctx); err != nil {
		writeJSON(w, http.StatusBadGateway, errorResponse{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, statusResponse{Status: "connected"})
}

func (s *Server) checkADConnectivity(w http.ResponseWriter, r *http.Request) {
	settings, err := s.store.GetADSettings(r.Context())
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "not_configured"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "error", "error": err.Error()})
		return
	}
	client := ad.NewClient(adConfigFromSettings(settings), s.logger)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := client.TestConnection(ctx); err != nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "disconnected", "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "connected"})
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	account := strings.TrimSpace(r.URL.Query().Get("account"))
	if s.deleteProtected(account) {
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "delete_protected_account"})
		return
	}
	if err := s.ad.DeleteUser(r.Context(), account); err != nil {
		writeError(w, err)
		return
	}
	s.audit(r.Context(), actorFromContext(r.Context()), "delete_user", account, "")
	writeJSON(w, http.StatusOK, statusResponse{Status: "deleted"})
}

func (s *Server) deleteProtected(account string) bool {
	_, ok := s.cfg.Safe.DeleteProtectedAccounts[normalizeAccount(account)]
	return ok
}

func (s *Server) disableUser(w http.ResponseWriter, r *http.Request) {
	var req disableRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Account) == "" {
		writeError(w, ad.ErrInvalidInput)
		return
	}
	if !req.DisableAt.IsZero() && req.DisableAt.After(time.Now()) {
		scheduleID := s.scheduler.Schedule(req.Account, req.DisableAt)
		s.audit(r.Context(), actorFromContext(r.Context()), "schedule_disable_user", req.Account, req.DisableAt.Format(time.RFC3339))
		writeJSON(w, http.StatusAccepted, statusResponse{Status: "disable_scheduled", ScheduleID: scheduleID})
		return
	}
	if err := s.ad.DisableUser(r.Context(), req.Account); err != nil {
		writeError(w, err)
		return
	}
	s.audit(r.Context(), actorFromContext(r.Context()), "disable_user", req.Account, "")
	writeJSON(w, http.StatusOK, statusResponse{Status: "disabled"})
}

func (s *Server) removeUserGroup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Account string `json:"account"`
		GroupDN string `json:"groupDN"`
	}
	if !decodeJSON(w, r, &req) { return }
	if req.Account == "" || req.GroupDN == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_input"})
		return
	}
	if err := s.ad.RemoveUserFromGroup(r.Context(), req.Account, req.GroupDN); err != nil {
		writeError(w, err)
		return
	}
	s.audit(r.Context(), actorFromContext(r.Context()), "remove_group", req.Account, req.GroupDN)
	writeJSON(w, http.StatusOK, statusResponse{Status: "removed"})
}

func (s *Server) addUserGroup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Account string `json:"account"`
		GroupDN string `json:"groupDN"`
	}
	if !decodeJSON(w, r, &req) { return }
	if req.Account == "" || req.GroupDN == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_input"})
		return
	}
	if err := s.ad.AddUserToGroups(r.Context(), req.Account, []string{req.GroupDN}); err != nil {
		writeError(w, err)
		return
	}
	s.audit(r.Context(), actorFromContext(r.Context()), "add_group", req.Account, req.GroupDN)
	writeJSON(w, http.StatusOK, statusResponse{Status: "added"})
}



func (s *Server) discoverOUs(w http.ResponseWriter, r *http.Request) {
	baseDN := strings.TrimSpace(r.URL.Query().Get("base"))
	entries, err := s.ad.DiscoverOUs(r.Context(), baseDN)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) discoverGroups(w http.ResponseWriter, r *http.Request) {
	baseDN := strings.TrimSpace(r.URL.Query().Get("base"))
	entries, err := s.ad.DiscoverGroups(r.Context(), baseDN)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) enableUser(w http.ResponseWriter, r *http.Request) {
	var req accountRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.ad.EnableUser(r.Context(), req.Account); err != nil {
		writeError(w, err)
		return
	}
	s.audit(r.Context(), actorFromContext(r.Context()), "enable_user", req.Account, "")
	writeJSON(w, http.StatusOK, statusResponse{Status: "enabled"})
}

func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Account string `json:"account"`
		Mail    string `json:"mail"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Account) == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_input"})
		return
	}
	attrs := map[string]string{}
	if strings.TrimSpace(req.Mail) != "" {
		attrs["mail"] = strings.TrimSpace(req.Mail)
	}
	if len(attrs) == 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "no_attributes_to_update"})
		return
	}
	if err := s.ad.UpdateUserAttributes(r.Context(), req.Account, attrs); err != nil {
		writeError(w, err)
		return
	}
	s.audit(r.Context(), actorFromContext(r.Context()), "update_user", req.Account, "mail="+req.Mail)
	writeJSON(w, http.StatusOK, statusResponse{Status: "updated"})
}

func (s *Server) unlockUser(w http.ResponseWriter, r *http.Request) {
	var req accountRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.ad.UnlockUser(r.Context(), req.Account); err != nil {
		writeError(w, err)
		return
	}
	s.audit(r.Context(), actorFromContext(r.Context()), "unlock_user", req.Account, "")
	writeJSON(w, http.StatusOK, statusResponse{Status: "unlocked"})
}

func (s *Server) resetUserPassword(w http.ResponseWriter, r *http.Request) {
	var req passwordRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	password := req.Password
	if strings.TrimSpace(password) == "" {
		var err error
		password, err = security.GeneratePassword(14)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "password_generation_failed"})
			return
		}
	}
	if err := s.ad.ResetPassword(r.Context(), req.Account, password, req.MustChange); err != nil {
		writeError(w, err)
		return
	}
	s.audit(r.Context(), actorFromContext(r.Context()), "reset_user_password", req.Account, "mustChange="+strconv.FormatBool(req.MustChange))
	writeJSON(w, http.StatusOK, statusResponse{Status: "password_reset", MustChange: req.MustChange, Password: password})
}

func (s *Server) offboardUser(w http.ResponseWriter, r *http.Request) {
	var req offboardRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.ad.OffboardUser(r.Context(), req.Account, req.TargetOU); err != nil {
		writeError(w, err)
		return
	}
	s.audit(r.Context(), actorFromContext(r.Context()), "offboard_user", req.Account, req.TargetOU)
	writeJSON(w, http.StatusOK, statusResponse{Status: "offboarded"})
}

func (s *Server) auditLogs(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Error: "database_not_configured"})
		return
	}
	q := r.URL.Query()
	// helpdesk 仅能查看自己操作的日志（安全合规：防止横向越权浏览他人操作记录）
	actor := strings.TrimSpace(q.Get("actor"))
	role := roleFromContext(r.Context())
	if role == store.RoleHelpdesk {
		actor = actorFromContext(r.Context())
	}
	// action 支持多选（逗号分隔），转成切片走 IN 查询
	actionParam := strings.TrimSpace(q.Get("action"))
	var actions []string
	if actionParam != "" {
		for _, a := range strings.Split(actionParam, ",") {
			a = strings.TrimSpace(a)
			if a != "" {
				actions = append(actions, a)
			}
		}
	}
	startDate := strings.TrimSpace(q.Get("startDate"))
	endDate := strings.TrimSpace(q.Get("endDate"))
	target := strings.TrimSpace(q.Get("target"))
	page, _ := strconv.Atoi(q.Get("page"))
	pageSize, _ := strconv.Atoi(q.Get("pageSize"))

	filter := store.AuditLogFilter{
		Actor:     actor,
		Actions:   actions,
		Target:    target,
		StartDate: startDate,
		EndDate:   endDate,
		Page:      page,
		PageSize:  pageSize,
	}
	result, err := s.store.ListAuditLogsFiltered(r.Context(), filter)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "audit_log_query_failed"})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// currentAdmin 返回当前登录管理员的用户名、角色与权限列表，供前端做权限渲染。
func (s *Server) currentAdmin(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	role := roleFromContext(r.Context())
	perms := permsFromContext(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"username": actor, "role": role, "permissions": perms})
}

func (s *Server) changeMyPassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		OldPassword string `json:"oldPassword"`
		NewPassword string `json:"newPassword"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if len([]rune(req.NewPassword)) < 8 {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "password_too_short"})
		return
	}
	actor := actorFromContext(r.Context())
	admin, err := s.store.FindAdminByUsername(r.Context(), actor)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "invalid_credentials"})
		return
	}
	if !checkPassword(admin.PasswordHash, req.OldPassword) {
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "wrong_password"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "password_hash_failed"})
		return
	}
	if err := s.store.UpdateAdminPassword(r.Context(), admin.ID, string(hash)); err != nil {
		s.logger.Error("update admin password failed", "username", admin.Username, "error", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "password_update_failed"})
		return
	}
	s.audit(r.Context(), actor, "change_password", admin.Username, "")
	writeJSON(w, http.StatusOK, statusResponse{Status: "password_changed"})
}

// -- Helpers --

func checkPassword(hash string, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

func (s *Server) audit(ctx context.Context, actor string, action string, target string, detail string) {
	if s.store == nil { return }
	if actor == "" { actor = "anonymous" }
	role, _ := ctx.Value(roleKey{}).(string)
	if role == "" { role = "user" }
	remoteAddr, _ := ctx.Value(remoteAddrKey{}).(string)
	userAgent, _ := ctx.Value(userAgentKey{}).(string)
	// Debug: log the IP if it's empty
	if remoteAddr == "" {
		s.logger.Debug("audit: IP is empty", "actor", actor, "action", action)
	}
	if err := s.store.AddAuditLog(ctx, actor, role, action, target, detail, remoteAddr, userAgent, true, "", 0); err != nil {
		s.logger.Warn("write audit log failed", "error", err)
	}
}

func (s *Server) auditFail(ctx context.Context, actor string, action string, target string, detail string, errorMsg string) {
	if s.store == nil { return }
	if actor == "" { actor = "anonymous" }
	role, _ := ctx.Value(roleKey{}).(string)
	if role == "" { role = "user" }
	remoteAddr, _ := ctx.Value(remoteAddrKey{}).(string)
	userAgent, _ := ctx.Value(userAgentKey{}).(string)
	if err := s.store.AddAuditLog(ctx, actor, role, action, target, detail, remoteAddr, userAgent, false, errorMsg, 0); err != nil {
		s.logger.Warn("write audit fail log failed", "error", err)
	}
}

func (s *Server) auditWithIP(ctx context.Context, actor string, action string, target string, detail string, ip string, ua string) {
	if s.store == nil { return }
	if actor == "" { actor = "anonymous" }
	role := "user"
	_ = ctx // not needed for self-service
	if err := s.store.AddAuditLog(ctx, actor, role, action, target, detail, ip, ua, true, "", 0); err != nil {
		s.logger.Warn("write audit log failed", "error", err)
	}
}

// clientIP extracts the real client IP from the request
func clientIP(r *http.Request) string {
	ip := r.Header.Get("X-Forwarded-For")
	if ip != "" {
		// X-Forwarded-For may contain multiple IPs, take the first
		if idx := strings.Index(ip, ","); idx >= 0 {
			ip = strings.TrimSpace(ip[:idx])
		}
		return ip
	}
	ip = r.Header.Get("X-Real-IP")
	if ip != "" {
		return strings.TrimSpace(ip)
	}
	ip = r.RemoteAddr
	// Strip port: handle both IPv4 (1.2.3.4:port) and IPv6 ([::1]:port)
	if strings.HasPrefix(ip, "[") {
		// IPv6 with port: [::1]:12345
		if idx := strings.LastIndex(ip, "]"); idx >= 0 {
			return ip[1:idx]
		}
	} else {
		// IPv4 with port: 1.2.3.4:12345
		if idx := strings.LastIndex(ip, ":"); idx >= 0 {
			return ip[:idx]
		}
	}
	return ip
}

func (s *Server) withJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/healthz" {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
		}
		next.ServeHTTP(w, r)
	})
}

func requestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			requestID := uuid.New().String()[:8]
			wrapped := &responseWriter{ResponseWriter: w, status: 200}
			next.ServeHTTP(wrapped, r)
			logger.Info("http",
				"request_id", requestID,
				"method", r.Method,
				"path", r.URL.Path,
				"status", wrapped.status,
				"duration", time.Since(start).String(),
				"remote", truncateAddr(r.RemoteAddr, 20),
			)
		})
	}
}

func truncateAddr(addr string, max int) string {
	if len(addr) > max {
		return addr[:max]
	}
	return addr
}

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.status = code
	rw.ResponseWriter.WriteHeader(code)
}

func recoverer(next http.Handler, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				logger.Error("panic recovered", "error", recovered, "path", r.URL.Path)
				writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "internal_error"})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_json"})
		return false
	}
	return true
}

func writeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ad.ErrInvalidInput), errors.Is(err, ad.ErrUnsafePassword):
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: err.Error()})
	case errors.Is(err, ad.ErrNotFound):
		writeJSON(w, http.StatusNotFound, errorResponse{Error: err.Error()})
	default:
		writeJSON(w, http.StatusBadGateway, errorResponse{Error: "ad_operation_failed"})
	}
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

// -- Types --

type accountRequest struct {
	Account string `json:"account"`
}

type passwordRequest struct {
	Account    string `json:"account"`
	Password   string `json:"password"`
	MustChange bool   `json:"mustChange"`
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type loginResponse struct {
	Token       string    `json:"token"`
	Username    string    `json:"username"`
	Role        string    `json:"role"`
	Permissions []string  `json:"permissions"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

type disableRequest struct {
	Account   string    `json:"account"`
	DisableAt time.Time `json:"disableAt"`
}

type offboardRequest struct {
	Account  string `json:"account"`
	TargetOU string `json:"targetOU"`
}

type statusResponse struct {
	Status     string `json:"status"`
	MustChange bool   `json:"mustChange,omitempty"`
	ScheduleID string `json:"scheduleId,omitempty"`
	Password   string `json:"password,omitempty"`
}

type createUserResponse struct {
	User     ad.User `json:"user"`
	Password string  `json:"password,omitempty"`
}

type adminOptionsResponse struct {
	OUOptions    []store.Option `json:"ouOptions"`
	GroupOptions []store.Option `json:"groupOptions"`
}

type errorResponse struct {
	Error  string `json:"error"`
	Detail string `json:"detail,omitempty"`
}

type actorContextKey struct{}

func contextWithActor(ctx context.Context, actor string) context.Context {
	return context.WithValue(ctx, actorContextKey{}, actor)
}

func actorFromContext(ctx context.Context) string {
	value, _ := ctx.Value(actorContextKey{}).(string)
	return value
}

// ── User Detail ──

func (s *Server) userDetail(w http.ResponseWriter, r *http.Request) {
	account := strings.TrimSpace(r.URL.Query().Get("account"))
	if account == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "account_required"})
		return
	}
	user, err := s.ad.FindUser(r.Context(), account)
	if err != nil {
		writeError(w, err)
		return
	}
	// Get scheduled tasks for this account
	var scheduledTasks []ScheduledTask
	if s.scheduler != nil {
		scheduledTasks = s.scheduler.GetByAccount(account)
	}
	// Get recent audit logs for this user (by target, excluding search logs)
	var recentLogs []store.AuditLog
	if s.store != nil {
		recentLogs, _ = s.store.ListAuditLogsByTarget(r.Context(), account, 50)
	}
	response := map[string]any{
		"user":           user,
		"scheduledTasks": scheduledTasks,
		"recentLogs":     recentLogs,
	}
	writeJSON(w, http.StatusOK, response)
}

// ── Scheduled Tasks ──

func (s *Server) listScheduledTasks(w http.ResponseWriter, r *http.Request) {
	if s.scheduler == nil {
		writeJSON(w, http.StatusOK, []ScheduledTask{})
		return
	}
	tasks := s.scheduler.List()
	writeJSON(w, http.StatusOK, tasks)
}

func (s *Server) cancelScheduledTask(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "id_required"})
		return
	}
	if s.scheduler == nil {
		writeJSON(w, http.StatusNotFound, errorResponse{Error: "task_not_found"})
		return
	}
	if !s.scheduler.Cancel(id) {
		writeJSON(w, http.StatusNotFound, errorResponse{Error: "task_not_found"})
		return
	}
	s.audit(r.Context(), actorFromContext(r.Context()), "cancel_scheduled_task", id, "")
	writeJSON(w, http.StatusOK, statusResponse{Status: "cancelled"})
}

// ── Admin Management（仅 super_admin）──

var validRoles = map[string]bool{store.RoleSuperAdmin: true, store.RoleHRAdmin: true, store.RoleHelpdesk: true, store.RoleCustom: true}

type createAdminRequest struct {
	Username    string   `json:"username"`
	Password    string   `json:"password"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
}

func (s *Server) listAdmins(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Error: "database_not_configured"})
		return
	}
	admins, err := s.store.ListAdmins(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "admin_query_failed"})
		return
	}
	if admins == nil {
		admins = []store.Admin{}
	}
	writeJSON(w, http.StatusOK, admins)
}

func (s *Server) createAdmin(w http.ResponseWriter, r *http.Request) {
	var req createAdminRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	username := strings.TrimSpace(req.Username)
	if username == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_input"})
		return
	}
	if len([]rune(req.Password)) < 8 {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "password_too_short"})
		return
	}
	role := strings.TrimSpace(req.Role)
	if role == "" {
		role = store.RoleHelpdesk
	}
	// 自定义权限：校验权限项合法性，role 标记为 custom
	var permissions []string
	if len(req.Permissions) > 0 {
		allPerms := make(map[string]bool, len(store.AllPermissions()))
		for _, p := range store.AllPermissions() {
			allPerms[p] = true
		}
		for _, p := range req.Permissions {
			p = strings.TrimSpace(p)
			if !allPerms[p] {
				writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_permission"})
				return
			}
			permissions = append(permissions, p)
		}
		role = store.RoleCustom
	} else if !validRoles[role] {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_role"})
		return
	}
	exists, err := s.store.AdminExists(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "admin_query_failed"})
		return
	}
	if exists {
		writeJSON(w, http.StatusConflict, errorResponse{Error: "admin_already_exists"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "password_hash_failed"})
		return
	}
	if len(permissions) > 0 {
		if err := s.store.CreateAdminWithPermissions(r.Context(), username, hash, role, permissions); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "admin_create_failed"})
			return
		}
	} else {
		if err := s.store.CreateAdminWithRole(r.Context(), username, hash, role); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "admin_create_failed"})
			return
		}
	}
	s.audit(r.Context(), actorFromContext(r.Context()), "create_admin", username, "role="+role)
	writeJSON(w, http.StatusCreated, statusResponse{Status: "created"})
}

// updateAdminPermissions 修改管理员的权限列表（role 自动设为 custom）。
type updateAdminPermissionsRequest struct {
	Username    string   `json:"username"`
	Permissions []string `json:"permissions"`
}

func (s *Server) updateAdminPermissions(w http.ResponseWriter, r *http.Request) {
	var req updateAdminPermissionsRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	username := strings.TrimSpace(req.Username)
	if username == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_input"})
		return
	}
	// 校验权限项合法性
	allPerms := make(map[string]bool, len(store.AllPermissions()))
	for _, p := range store.AllPermissions() {
		allPerms[p] = true
	}
	var permissions []string
	for _, p := range req.Permissions {
		p = strings.TrimSpace(p)
		if !allPerms[p] {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_permission"})
			return
		}
		permissions = append(permissions, p)
	}
	// 不允许把自己改成没有 adminMgmt 权限（防止自我降权锁死）
	actor := actorFromContext(r.Context())
	if username == actor {
		hasAdminMgmt := false
		for _, p := range permissions {
			if p == store.PermAdminMgmt {
				hasAdminMgmt = true
				break
			}
		}
		if !hasAdminMgmt {
			writeJSON(w, http.StatusForbidden, errorResponse{Error: "cannot_remove_own_admin_mgmt"})
			return
		}
	}
	if err := s.store.UpdateAdminPermissions(r.Context(), username, permissions); err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "admin_update_failed"})
		return
	}
	s.audit(r.Context(), actor, "update_admin_permissions", username, "")
	writeJSON(w, http.StatusOK, statusResponse{Status: "updated"})
}

func (s *Server) deleteAdmin(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	if username == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "username_required"})
		return
	}
	actor := actorFromContext(r.Context())
	if username == actor {
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "cannot_delete_self"})
		return
	}
	// 查询目标管理员，若拥有 adminMgmt 权限则禁止删除最后一个能管理管理员的人
	target, err := s.store.FindAdminByUsername(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse{Error: "admin_not_found"})
		return
	}
	if target.HasPermission(store.PermAdminMgmt) {
		count, err := s.store.CountSuperAdmins(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "admin_query_failed"})
			return
		}
		if count <= 1 {
			writeJSON(w, http.StatusForbidden, errorResponse{Error: "cannot_delete_last_super_admin"})
			return
		}
	}
	ok, err := s.store.DeleteAdmin(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "admin_delete_failed"})
		return
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, errorResponse{Error: "admin_not_found"})
		return
	}
	s.audit(r.Context(), actor, "delete_admin", username, "")
	writeJSON(w, http.StatusOK, statusResponse{Status: "deleted"})
}

type resetAdminPasswordRequest struct {
	Username    string `json:"username"`
	NewPassword string `json:"newPassword"`
}

func (s *Server) resetAdminPassword(w http.ResponseWriter, r *http.Request) {
	var req resetAdminPasswordRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	username := strings.TrimSpace(req.Username)
	if username == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_input"})
		return
	}
	password := req.NewPassword
	if strings.TrimSpace(password) == "" {
		var err error
		password, err = security.GeneratePassword(14)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "password_generation_failed"})
			return
		}
	} else if len([]rune(password)) < 8 {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "password_too_short"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "password_hash_failed"})
		return
	}
	if err := s.store.ResetAdminPasswordByUsername(r.Context(), username, string(hash)); err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse{Error: "admin_not_found"})
		return
	}
	s.audit(r.Context(), actorFromContext(r.Context()), "reset_admin_password", username, "")
	writeJSON(w, http.StatusOK, statusResponse{Status: "password_reset", Password: password})
}
