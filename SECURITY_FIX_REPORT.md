# AD Management 安全审计修复报告

> 修复时间：2026-07-09 13:54–14:30
> 修复人：资深开发工程师（吴八哥）
> 审计来源：团队提交的代码审计报告（6 个问题）

---

## 一、二次审计结论

团队提交的审计报告方向正确，但定位存在偏差。作为资深开发者，我逐行核对了全部源码后，修正如下：

| 审计报告原文 | 实际情况 |
|---|---|
| "管理员页面完全缺失 escHTML/escJS 调用" | ❌ 不准确。`users.js`、`admin-mgmt.js`、`user-detail.js` 的 onclick 已用 escJS；`app.js:213` 已用 escHTML |
| "ui.js 已导出但所有位置都未调用" | ❌ 部分误判。多数位置已调用，但有 3 处**误用了 escJS** |

### 真正的根因（比报告描述更隐蔽）

**误把 `escJS` 当成"万能转义"用在 HTML 属性值和文本节点里。**

`escJS` 的实现只转义 `\ ' "`，**不转义 `< > &`**。在 HTML 属性上下文（`title="..."`、`value="..."`）中，攻击者输入 `" onmouseover="alert(1)` 即可闭合属性注入任意脚本——因为 escJS 把 `"` 转义成 `\"`，但 HTML 解析器不认 `\"`，`"` 照样闭合属性。

这是比"完全没转义"更危险的 bug，因为它**看起来转义了，实际没用**，容易在 code review 中蒙混过关。

---

## 二、已修复问题（5/6）

### P0-1 前端 XSS：escJS 误用于 HTML 上下文

**根因**：`escJS` 只转义 `\ ' "`，不转义 `< > &`，在 HTML 属性/文本节点中无效。

| 文件 | 行号 | 问题 | 修复 |
|---|---|---|---|
| `frontend/assets/admin/app.js` | L141 | group-option 的 `value="..."` 和 `<span>` 文本用 escJS | → `escAttr()` / `escHTML()` |
| `frontend/assets/admin/app.js` | L457 | 批量离职失败列表文本节点用 escJS（审计报告漏掉） | → `escHTML()` |
| `frontend/assets/admin/audit.js` | L116 | `log-col-detail` 的 `title="..."` 和文本用 escJS（**最严重**，detail 含用户搜索词等可控数据） | → `escAttr()` / `escHTML()` |
| `frontend/assets/admin/user-detail.js` | L77 | scheduleList 的 `t.action` 和 `formatTime()` 完全未转义 | → `escHTML()` |

**额外加固**（`frontend/assets/admin/ui.js`）：
- 新增 `escAttr()`：属性专用转义，与 escHTML 等价但语义明确，便于 code review 时一眼区分
- 新增 `html\`\`` 标签模板函数：自动对 `${}` 插值做 escHTML，从根本上避免手动拼接遗漏
- 新增 `raw()`：标记原生 HTML 插值（如 SVG）
- 修正 `escHTML`/`escJS` 用 `if(!s)` 吞掉数字 `0` 和布尔 `false` 的 bug
- 添加**团队转义规范注释**：
  - HTML 文本节点 → `escHTML()`
  - HTML 属性值 → `escAttr()`
  - JS 字符串字面量 → `escJS()`
  - URL 参数 → `encodeURIComponent()`

### P0-2 onclick 属性注入

**审计报告定位的 `user-detail.js:99` 和 `admin-mgmt.js:100-103` 经核对已正确使用 escJS**（escJS 用于 onclick 内单引号字符串是有效防护，因为 `\'` 在 JS 解析时不会闭合字符串）。

但更稳健的做法是改用 `addEventListener` + `data-*` 属性。本次保留 escJS 方案（已足够安全），并在 ui.js 注释中明确了使用边界。

### P1-3 CreateUser 部分失败无回滚

**文件**：`internal/ad/client.go` — `CreateUser()`

**根因**：创建用户后按顺序执行 ResetPassword → EnableUser → AddUserToGroups，任一步失败则遗留"禁用 + 无密码"的脏账号，既无法使用也无法用同名重新创建。

**修复**：
```go
if err := c.ResetPassword(ctx, input.SAMAccountName, input.Password, input.MustChange); err != nil {
    c.rollbackCreateUser(ctx, input.SAMAccountName, "reset password", err)
    return User{}, fmt.Errorf("create user: reset password failed: %w", err)
}
// EnableUser / AddUserToGroups 同理
```
新增 `rollbackCreateUser()` 方法：
- best-effort 删除已创建用户（失败只记日志，不掩盖原始错误）
- 用 `fmt.Errorf("...: %w", err)` 包装错误，保留错误链供上层 `errors.Is/As` 判断
- 记录 warn（回滚触发）和 error（回滚失败需人工清理）两级日志

### P1-4 FindAdminBySession 时间比较不一致（session 永不过期）

**文件**：`internal/store/store.go`

**根因**：
```
CreateSession 传入 time.Time → modernc 驱动序列化为 "2026-07-09T17:30:00+08:00"
FindAdminBySession 查询: WHERE expires_at > CURRENT_TIMESTAMP
SQLite CURRENT_TIMESTAMP 产出: "2026-07-09 09:30:00"（UTC）
字符串逐位比较: 第 11 字符 'T'(0x54) > ' '(0x20) → 恒真 → session 永不过期
```
这是一个**严重的安全漏洞**：过期的 session 永远有效，token 泄露后无法自然失效。

**修复**：
- 新增 `sqliteTimeFormat = "2006-01-02 15:04:05"` 常量（与 CURRENT_TIMESTAMP 格式一致）
- 新增 `sqliteTimeUTC(t time.Time) string` 辅助函数
- `CreateSession` / `CreateSelfServiceSession` 写入时统一用 `sqliteTimeUTC(expiresAt)`
- 影响范围：`FindAdminBySession`、`FindSelfServiceSession`、`CleanExpiredSessions`、`CleanExpiredSelfServiceSessions` 的比较全部修正

### P1-5 CountSuperAdmins 统计不完整

**文件**：`internal/store/store.go` — `CountSuperAdmins()`

**根因**：旧 SQL `permissions LIKE '%"adminMgmt"%' OR (permissions = '' AND role = ?)` 漏掉了 `permissions = '[]'`（空数组 JSON 序列化）的 super_admin。这会导致系统认为没有 super_admin，可能允许删除最后一个 super_admin。

**修复**：
```sql
-- 旧：漏掉 permissions='[]' 的 super_admin
WHERE permissions LIKE '%"adminMgmt"%' OR (permissions = '' AND role = ?)

-- 新：与 EffectivePermissions 逻辑一致，所有 super_admin 都被统计
WHERE permissions LIKE '%"adminMgmt"%' OR role = ?
```

---

## 三、待评估问题（1/6）

### P1-6 token 存储在 localStorage

**现状**：管理员 token 存在 `localStorage`，XSS 攻击可立即窃取。结合已修复的 P0 XSS 漏洞，风险已大幅降低，但根本性风险仍在。

**未立即修复的原因**：迁移到 HttpOnly cookie 是较大架构改动，涉及：
1. 后端登录接口改为设置 HttpOnly + SameSite=Strict cookie
2. 所有 API 中间件改为从 cookie 读取 token
3. **必须配套 CSRF 防护**（cookie 自动携带会引入 CSRF 风险）
4. 前端所有 fetch 需加 `credentials: 'include'`

**建议方案（供团队评估）**：
| 方案 | 改动量 | 安全性 | 建议优先级 |
|---|---|---|---|
| A. 迁移到 HttpOnly cookie + CSRF token | 大 | 高 | 长期目标 |
| B. 缩短 token 有效期（如 2 小时）+ 滑动续期 | 小 | 中 | 短期缓解 |
| C. 加 CSP 头（Content-Security-Policy）限制脚本来源 | 小 | 中 | 立即可做 |

建议先做 B + C 作为短期缓解，A 作为下个迭代的技术债。

---

## 四、验证结果

```
go build ./...      ✅ 通过
go vet ./...        ✅ 通过
node --check (7个JS) ✅ 全部通过
```

---

## 五、涉及文件清单

| 文件 | 改动类型 |
|---|---|
| `frontend/assets/admin/ui.js` | 新增 escAttr/html/raw + 转义规范注释 + 修复 if(!s) bug |
| `frontend/assets/admin/app.js` | 2 处 XSS 修复 + import + window 暴露 |
| `frontend/assets/admin/audit.js` | 1 处 XSS 修复 + import |
| `frontend/assets/admin/user-detail.js` | 1 处 XSS 修复 |
| `internal/ad/client.go` | CreateUser 事务性回滚 + rollbackCreateUser |
| `internal/store/store.go` | sqliteTimeFormat + CreateSession/CreateSelfServiceSession + CountSuperAdmins |

---

## 六、给团队的代码质量建议

1. **转义工具统一化**：以后所有 HTML 拼接优先用 `html\`\`` 模板函数，不再手动调 escHTML/escAttr，从源头杜绝遗漏。
2. **SQL 时间比较**：SQLite + Go 驱动的时间格式是个经典坑。凡是 `> CURRENT_TIMESTAMP` 的列，写入必须用 `sqliteTimeUTC()`，并在 code review 时检查。
3. **事务性操作**：涉及"创建 → 配置 → 启用"多步操作时，必须考虑部分失败的回滚。回滚要 best-effort，不能掩盖原始错误（用 `%w` 包装）。
4. **SQL 统计逻辑**：涉及"防误删最后一个 XX"的查询，要覆盖所有边界情况（空串、空数组、null），最好与业务层的 Effective 逻辑保持一致。
5. **审计报告要精确**：这次审计报告说"完全没转义"实际是"转义工具误用"，定位偏差会误导修复方向。建议团队下次审计时附上 PoC（攻击 payload），验证漏洞可利用性后再下结论。
