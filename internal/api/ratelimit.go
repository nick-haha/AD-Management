package api

import (
	"net/http"
	"sync"
	"time"
)

// RateLimiter provides IP-based rate limiting for self-service endpoints.
type RateLimiter struct {
	mu         sync.Mutex
	visitors   map[string]*visitorInfo
	rate       int           // max requests per window
	window     time.Duration // time window
	maxEntries int           // max tracked IPs to prevent unbounded memory growth
}

type visitorInfo struct {
	count    int
	expiryAt time.Time
}

// NewRateLimiter creates a rate limiter allowing `rate` requests per `window`.
func NewRateLimiter(rate int, window time.Duration) *RateLimiter {
	rl := &RateLimiter{
		visitors:   make(map[string]*visitorInfo),
		rate:       rate,
		window:     window,
		maxEntries: 10000, // 防止大量不同 IP 导致内存无限增长
	}
	// Periodic cleanup of expired entries
	go rl.cleanup()
	return rl
}

func (rl *RateLimiter) cleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		rl.mu.Lock()
		now := time.Now()
		for ip, v := range rl.visitors {
			if now.After(v.expiryAt) {
				delete(rl.visitors, ip)
			}
		}
		rl.mu.Unlock()
	}
}

// Allow checks if a request from the given IP is allowed.
func (rl *RateLimiter) Allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	v, exists := rl.visitors[ip]
	if !exists || now.After(v.expiryAt) {
		// 超过最大条目数时跳过记录，避免内存无限增长（不阻止请求，只停止追踪新 IP）
		if !exists && len(rl.visitors) >= rl.maxEntries {
			return true
		}
		rl.visitors[ip] = &visitorInfo{
			count:    1,
			expiryAt: now.Add(rl.window),
		}
		return true
	}

	v.count++
	if v.count > rl.rate {
		return false
	}
	return true
}

// Middleware returns an HTTP middleware that rate-limits by IP.
// Self-service endpoints: 30 requests per minute per IP.
// Write endpoints (unlock/reset): 10 requests per minute per IP.
func (s *Server) selfServiceRateLimit(rl *RateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIP(r)
			if !rl.Allow(ip) {
				writeJSON(w, http.StatusTooManyRequests, errorResponse{Error: "rate_limit_exceeded", Detail: "请求过于频繁，请稍后再试"})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
