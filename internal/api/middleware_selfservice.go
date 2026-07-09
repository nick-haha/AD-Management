package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// ── 中间件: requireSelfService ──
// 要求自服务端点必须携带有效的 ss_token Cookie，
// 无有效 Cookie 则返回 401

func (s *Server) requireSelfService(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := s.lookupSelfServiceSession(r)
		if err != nil {
			s.logger.Warn("self-service session lookup error", "error", err)
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "self_service_auth_required"})
			return
		}
		if user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "self_service_auth_required"})
			return
		}
		ctx := contextWithSelfServiceUser(r.Context(), user)
		// 同时写入 actor context（用于审计日志）
		ctx = contextWithActor(ctx, user.FeishuName)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// ── 中间件: requireSelfServiceOrRateLimit ──
// 渐进式中间件：
// - 有 ss_token → 走已认证路径（较宽松速率限制）
// - 无 ss_token → 走 IP 速率限制（仅允许搜索，写入 0/min）

func (s *Server) requireSelfServiceOrRateLimit(readRL, writeRL *RateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := s.lookupSelfServiceSession(r)
			if err != nil {
				s.logger.Warn("self-service session lookup error", "error", err)
			}

			if user != nil {
				// 已认证用户：检查认证用户的速率限制
				// 搜索 60/min，写入 20/min
				rl := readRL
				if r.Method == http.MethodPost {
					rl = writeRL
				}
				ip := clientIP(r)
				if !rl.Allow(ip) {
					writeJSON(w, http.StatusTooManyRequests, errorResponse{
						Error: "rate_limit_exceeded",
						Detail: "请求过于频繁，请稍后再试",
					})
					return
				}
				ctx := contextWithSelfServiceUser(r.Context(), user)
				ctx = contextWithActor(ctx, user.FeishuName)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			// 匿名用户：仅允许搜索（GET），写入 POST 完全禁止
			if r.Method == http.MethodPost {
				writeJSON(w, http.StatusUnauthorized, errorResponse{
					Error: "self_service_auth_required",
					Detail: "请先通过飞书登录后再进行操作",
				})
				return
			}

			// 匿名搜索：应用 IP 速率限制
			if readRL != nil {
				ip := clientIP(r)
				if !readRL.Allow(ip) {
					writeJSON(w, http.StatusTooManyRequests, errorResponse{
						Error: "rate_limit_exceeded",
						Detail: "请求过于频繁，请稍后再试",
					})
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ── 辅助: ensureSelfAction ──
// 校验"只能操作自己"的约束
// 返回 nil 表示允许操作，返回 error 表示禁止

func ensureSelfAction(ctx context.Context, targetAccount string) error {
	u, ok := selfServiceUserFromContext(ctx)
	if !ok || u == nil {
		return fmt.Errorf("self_service_auth_required")
	}
	if u.ADAccount == "" {
		return fmt.Errorf("no_ad_account_linked")
	}
	// 用 samAccountName 精确比对（不区分大小写）
	if !strings.EqualFold(u.ADAccount, targetAccount) {
		return fmt.Errorf("cannot_operate_other_account")
	}
	return nil
}
