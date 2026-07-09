# 密码到期时间显示修复

## 背景
用户详情页"密码状态"显示的到期时间与 AD 实际查询结果不符。

## 根因
前端 `pwdExpiryInfo()` 用 `pwdLastSet + 人工配置天数（passwordMaxAgeDays，默认 90）` 在客户端估算到期，而非读取 AD 域控计算出的权威属性 `msDS-UserPasswordExpiryTimeComputed`。该构造属性综合了域策略 `maxPwdAge`、用户 `pwdLastSet`、UAC 标志位与细粒度密码策略（PSO），是真实到期时间。配置天数一旦与域策略脱节（如域策略 180 天而配置填 90），结果就错。

此外 `pwdLastSet = -1` 被误判为"永不过期"，其真实含义是"管理员已重置，用户下次登录须改密"。

## 改动文件
| 文件 | 改动 |
|------|------|
| `internal/ad/types.go` | `User` 增加 `PasswordExpiresAt string`（json: `passwordExpiresAt`），承载构造属性原始值 |
| `internal/ad/client.go` | `search()` 属性列表加 `msDS-UserPasswordExpiryTimeComputed`；`entryToUser()` 填充字段 |
| `frontend/assets/admin/users.js` | `pwdExpiryInfo` 增加 `passwordExpiresAt` 参数，优先用真实值；`-1` 改判"需设置"；取不到时回退旧估算 |
| `frontend/assets/admin/user-detail.js` | 调用点传 `user.passwordExpiresAt` |
| `frontend/assets/admin.js` | 遗留文件同步保持一致（未被 admin.html 引用，仅维护一致性） |
| `frontend/admin.html` | `app.js` 缓存版本 `v37 → v38` |

## 新判断优先级
1. **优先用 AD 真实属性 `passwordExpiresAt`**
   - `0` / `9223372036854775807`（INT64_MAX） → 永不过期
   - `-1` → 需设置（用户须改密）
   - 正数 → 到期时间，与 `now` 比较输出"已过期 / X天后到期"
2. **取不到时回退旧估算**（向后兼容）：`passwordNeverExpires` → `pwdLastSet` 0/-1 → `pwdLastSet + maxAge`

## 验证
- `go build ./...` 通过
- `go vet ./...` 通过
- `gofmt` 清理干净

## 注意事项
- `msDS-UserPasswordExpiryTimeComputed` 是构造属性，部分 AD 环境或低权限绑定账号可能不返回 → 此时自动回退旧估算逻辑（已兼容）。
- ES module 子模块（users.js / user-detail.js）的 `import` 路径无版本号，部署后需**硬刷新（Cmd+Shift+R）**才能加载最新代码。
