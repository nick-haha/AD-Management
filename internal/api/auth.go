package api

import (
	"context"
	"net/http"
	"strings"

	"ad-management/internal/store"
)

type remoteAddrKey struct{}
type roleKey struct{}
type permsKey struct{}
type userAgentKey struct{}

func (s *Server) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r.Header.Get("Authorization"))
		if token == "" {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "missing_bearer_token"})
			return
		}
		admin, err := s.adminForToken(r.Context(), token)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "invalid_token"})
			return
		}
		// 读取管理员真实角色与权限写入 context。
		// 权限优先取 permissions 字段；为空时由 EffectivePermissions 回退到 role 预设。
		role := admin.Role
		if role == "" {
			role = store.RoleSuperAdmin
		}
		perms := admin.EffectivePermissions()
		ctx := contextWithActor(r.Context(), admin.Username)
		ctx = context.WithValue(ctx, remoteAddrKey{}, clientIP(r))
		ctx = context.WithValue(ctx, roleKey{}, role)
		ctx = context.WithValue(ctx, permsKey{}, perms)
		ctx = context.WithValue(ctx, userAgentKey{}, r.UserAgent())
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func roleFromContext(ctx context.Context) string {
	v, _ := ctx.Value(roleKey{}).(string)
	return v
}

func permsFromContext(ctx context.Context) []string {
	v, _ := ctx.Value(permsKey{}).([]string)
	return v
}

// adminOnly 组合 requireAdmin + requirePerms：先做登录认证（写入 perms 到 context），
// 再按权限做细粒度鉴权。perms 参数是允许访问的权限项，管理员拥有其中任意一个即可通过。
// 返回可直接注册到 mux 的 http.Handler。
func (s *Server) adminOnly(perms []string, h func(http.ResponseWriter, *http.Request)) http.Handler {
	return s.requireAdmin(s.requirePerms(perms...)(http.HandlerFunc(h)))
}

// requirePerms 返回一个中间件，仅允许拥有指定权限之一的管理员访问。
// 必须在 requireAdmin 之后使用（依赖 context 中已写入的 perms）。
// 安全校验靠后端，前端隐藏只是体验优化。
func (s *Server) requirePerms(perms ...string) func(http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(perms))
	for _, p := range perms {
		allowed[p] = struct{}{}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			currentPerms := permsFromContext(r.Context())
			ok := false
			for _, p := range currentPerms {
				if _, has := allowed[p]; has {
					ok = true
					break
				}
			}
			if !ok {
				writeJSON(w, http.StatusForbidden, errorResponse{Error: "forbidden"})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (s *Server) adminForToken(ctx context.Context, token string) (store.Admin, error) {
	if s.store == nil {
		return store.Admin{}, store.ErrNotFound
	}
	return s.store.FindAdminBySession(ctx, token)
}

func bearerToken(value string) string {
	prefix := "Bearer "
	if !strings.HasPrefix(value, prefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(value, prefix))
}
