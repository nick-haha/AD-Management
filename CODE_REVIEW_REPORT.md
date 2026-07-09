# 全面代码审查报告 — 10 个新问题

> 时间：2026-07-09 14:50–15:10
> 审查人：资深开发工程师（吴八哥）
> 范围：后端 Go + 前端 JS + 安全 + 性能

---

## 一、发现问题清单

### P1 — 安全/正确性（4 项）

| # | 文件 | 问题 | 影响 |
|---|---|---|---|
| 1 | `admin/audit.js:60` | **XSS 残留**：`err.message` 未转义直接拼入 `innerHTML` | 后端错误消息如含用户输入（LDAP 查询），可注入脚本 |
| 2 | `api/router.go` | **安全头缺失**：全局无 `X-Content-Type-Options`/`X-Frame-Options`/`CSP`/`Referrer-Policy` | 点击劫持、MIME 嗅探、信息泄露 |
| 3 | `api/router.go:178/185/199` | **RecordLoginAttempt 错误未检查**：DB 写入失败时静默忽略 | 登录锁定机制可能失效——攻击者可无限尝试密码 |
| 4 | `api/router.go:653` | **UpdateAdminPassword 错误未检查**：DB 更新失败仍返回成功 | 用户以为密码已改但实际没改 |

### P2 — 代码质量/性能（6 项）

| # | 文件 | 问题 | 影响 |
|---|---|---|---|
| 5 | `admin/app.js:238-239` | **选择器拼写错误**：`.side-item` 应为 `.sidebar-item` | 事件绑定到不存在的元素（死代码），侧边栏靠内联 onclick 工作 |
| 6 | `admin/settings.js:102` | **setInterval 泄漏**：`setInterval(checkOnce, 30000)` 无 timer ID | 反复切换 tab 累积多个 interval，持续发 API 请求 |
| 7 | `api/router.go:298` | **adminOptions 用 context.Background()** 而非 `r.Context()` | 请求取消时 DB 查询不会取消，浪费资源 |
| 8 | `api/ratelimit.go` | **限流器无最大条目数**：visitors map 无上限 | 大量不同 IP 可导致内存无限增长 |
| 9 | `admin/app.js:127` | **clipboard 未处理 catch**：`navigator.clipboard.writeText()` 缺 `.catch()` | 剪贴板权限被拒时 Promise rejection 未处理 |
| 10 | `api/router.go:249-250` | **冗余赋值**：`password := ""; password = req.Password` | 代码冗余 |

---

## 二、修复详情

### 1. XSS 残留（audit.js:60）

```diff
- container.innerHTML = '<div class="error-message">加载日志失败: ' + err.message + '</div>';
+ container.innerHTML = '<div class="error-message">加载日志失败: ' + escHTML(err.message) + '</div>';
```

### 2. 安全头中间件（router.go）

新增 `securityHeaders` 中间件，在请求链最外层添加：
```go
func securityHeaders(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        h := w.Header()
        h.Set("X-Content-Type-Options", "nosniff")
        h.Set("X-Frame-Options", "DENY")
        h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
        h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; ...")
        next.ServeHTTP(w, r)
    })
}
```
> CSP 暂含 `'unsafe-inline'`（admin.html 有内联 onclick），后续移除内联事件后可收紧。

### 3-4. 错误处理补全（router.go）

```diff
- s.store.RecordLoginAttempt(r.Context(), username, clientIP, false)
+ if dbErr := s.store.RecordLoginAttempt(r.Context(), username, clientIP, false); dbErr != nil {
+     s.logger.Warn("record login attempt failed", "username", username, "error", dbErr)
+ }

- s.store.UpdateAdminPassword(r.Context(), admin.ID, string(hash))
+ if err := s.store.UpdateAdminPassword(r.Context(), admin.ID, string(hash)); err != nil {
+     s.logger.Error("update admin password failed", "username", admin.Username, "error", err)
+     writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "password_update_failed"})
+     return
+ }
```

### 5. 选择器修正（app.js）

```diff
- document.querySelector('#sidebarNav')?.addEventListener('click', e => { const item = e.target.closest('.side-item'); ... });
- document.querySelectorAll('.side-item').forEach(item => item.addEventListener('click', ...));
+ document.querySelector('#sidebarNav')?.addEventListener('click', e => { const item = e.target.closest('.sidebar-item'); ... });
```
> 合并为单次事件委托，消除死代码。

### 6. setInterval 泄漏（settings.js）

```diff
+ let _connCheckTimer = null;
  ...
- setInterval(checkOnce, 30000);
+ if (_connCheckTimer) clearInterval(_connCheckTimer);
+ _connCheckTimer = setInterval(checkOnce, 30000);
```

### 7. context 修正（router.go）

```diff
- func (s *Server) adminOptions(w http.ResponseWriter, _ *http.Request) {
-     settings, err := s.store.GetADSettings(context.Background())
+ func (s *Server) adminOptions(w http.ResponseWriter, r *http.Request) {
+     settings, err := s.store.GetADSettings(r.Context())
```

### 8. 限流器上限（ratelimit.go）

```diff
  type RateLimiter struct {
-     mu       sync.Mutex
-     visitors map[string]*visitorInfo
-     rate     int
-     window   time.Duration
+     mu         sync.Mutex
+     visitors   map[string]*visitorInfo
+     rate       int
+     window     time.Duration
+     maxEntries int // 防止大量不同 IP 导致内存无限增长
  }
  // Allow() 中：
+ if !exists && len(rl.visitors) >= rl.maxEntries {
+     return true // 超限时不追踪新 IP，但不阻止请求
+ }
```

### 9. clipboard catch（app.js）

```diff
- navigator.clipboard.writeText(password).then(() => showToast('密码已复制', 'success'))
+ navigator.clipboard.writeText(password).then(() => showToast('密码已复制', 'success')).catch(() => showToast('复制失败，请手动复制', 'warning'))
```

### 10. 冗余赋值（router.go）

```diff
- password := ""
- password = req.Password
+ password := req.Password
```

---

## 三、验证结果

```
go build ./...    ✅
go vet ./...      ✅
node --check (3 JS) ✅
```

---

## 四、涉及文件

| 文件 | 改动 |
|---|---|
| `internal/api/router.go` | 安全头中间件 + 4处错误检查 + context修正 + 冗余赋值 |
| `internal/api/ratelimit.go` | maxEntries 上限 |
| `frontend/assets/admin/audit.js` | XSS 修复 |
| `frontend/assets/admin/app.js` | 选择器修正 + clipboard catch |
| `frontend/assets/admin/settings.js` | setInterval 泄漏修复 |
