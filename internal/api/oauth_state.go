package api

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// oauthStateEntry 存储 OAuth state 及其创建时间
type oauthStateEntry struct {
	createdAt time.Time
}

// oauthStateStore 是服务端内存中的 state 存储，替代 Cookie 方案
// 解决跨域（如 172.16.x.x → 127.0.0.1）导致 Cookie 丢失的问题
type oauthStateStore struct {
	mu     sync.RWMutex
	entries map[string]oauthStateEntry
	ttl     time.Duration
}

// newOAuthStateStore 创建 state 存储，TTL 默认 10 分钟
func newOAuthStateStore() *oauthStateStore {
	s := &oauthStateStore{
		entries: make(map[string]oauthStateEntry),
		ttl:     10 * time.Minute,
	}
	// 启动定期清理 goroutine
	go s.cleanupLoop()
	return s
}

// generate 生成随机 state 并存入内存
func (s *oauthStateStore) generate() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate oauth state: %w", err)
	}
	state := hex.EncodeToString(b)

	s.mu.Lock()
	s.entries[state] = oauthStateEntry{createdAt: time.Now()}
	s.mu.Unlock()

	return state, nil
}

// validate 校验 state 是否有效（存在且未过期），校验后立即删除（一次性使用）
func (s *oauthStateStore) validate(state string) bool {
	if state == "" {
		return false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.entries[state]
	if !ok {
		return false
	}

	// 删除（一次性使用）
	delete(s.entries, state)

	// 检查是否过期
	return time.Since(entry.createdAt) <= s.ttl
}

// cleanupLoop 定期清理过期的 state 条目
func (s *oauthStateStore) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		s.mu.Lock()
		now := time.Now()
		for k, v := range s.entries {
			if now.Sub(v.createdAt) > s.ttl {
				delete(s.entries, k)
			}
		}
		s.mu.Unlock()
	}
}
