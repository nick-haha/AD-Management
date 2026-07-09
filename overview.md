# AD Management 前端升级 — 渐进式重构

## 已完成阶段

### 阶段零：设计规范文档
- 产出 `DESIGN_SPEC.md`（约 200 行），作为后续所有重构的锚点
- 关键决策：主色 #2563eb（蓝）、4px 间距系统、3 档圆角（6/8/12px）、3 档阴影、2 档动画时长（100ms/200ms）、ease-out 统一缓动
- 暗色模式策略：`data-theme="dark"` class 控制，优先于 `prefers-color-scheme`

### 阶段一：统一 CSS Token + 砍噪音
从 design-system.css（1830 行，indigo 主色）+ styles.css（1081 行，蓝色但独立 token）分裂体系，合并为统一的 4 文件架构：

| 新文件 | 用途 | 行数 |
|---|---|---|
| `tokens.css` | 所有 CSS 变量（色彩/间距/圆角/阴影/字重/动画/z-index）+ 向后兼容别名 | ~200 |
| `components.css` | 通用组件样式（按钮/输入框/卡片/badge/弹窗/toast/表单/骨架屏/spinner/审计表格） | ~420 |
| `admin.css` | 管理端专属布局（sidebar/top-bar/user-card/detail-modal/settings/wizard） | ~300 |
| `selfservice.css` | 自助端专属布局（hero/search-box/ss-card/auth-overlay） | ~300 |

**砍掉的视觉噪音**：登录页浮动光球、按钮 gradientShift 呼吸动画、卡片 hover translateY(-4px)、毛玻璃 backdrop-filter、glow 发光阴影、连接状态 breathe 脉冲、nth-child 逐项延迟入场

**保留的 8 个 @keyframes**：fadeIn、fadeUp、scaleIn、spin、shimmer、pulse、undoCountdown、toastIn

### 阶段二：图标系统
新建 `icons.js` — Lucide 内联 SVG 图标库，约 45 个图标，零依赖：

- 导航类：users/userPlus/userMinus/scrollText/clock
- 操作类：search/unlock/key/refresh/settings/logout/copy/check/x/plus/trash/edit/save
- 状态类：checkCircle/alertTriangle/xCircle/info/power
- 主题类：moon/sun/monitor
- 折叠类：chevronRight/chevronDown/chevronLeft/chevronUp/menu/panelLeft
- 其他：mail/eye/eyeOff/calendar/zap/wifi/link/building/filter/lock/ban 等

支持 ES Module 导出和 `window.icons` 全局挂载两种用法。

## 文件变更清单

| 文件 | 操作 |
|---|---|
| `DESIGN_SPEC.md` | 新增 — 设计规范文档 |
| `frontend/assets/tokens.css` | 新增 — 统一 CSS 变量 |
| `frontend/assets/components.css` | 新增 — 通用组件样式 |
| `frontend/assets/admin.css` | 新增 — 管理端布局 |
| `frontend/assets/selfservice.css` | 新增 — 自助端布局 |
| `frontend/assets/icons.js` | 新增 — Lucide 图标库 |
| `frontend/assets/admin/` | 新增目录 — 待用（阶段三 JS 模块化） |
| `frontend/admin.html` | 修改 — CSS link 更新为 tokens+components+admin |
| `frontend/index.html` | 修改 — CSS link 更新为 tokens+components+selfservice |
| `frontend/assets/design-system.css` | 保留未删 — 向后兼容（待内联样式清理后删除） |
| `frontend/assets/styles.css` | 保留未删 — 同上 |

## 阶段三：JS 模块化拆分

admin.js（2954 行单文件）拆为 10 个 ES Module（共 1753 行，平均 175 行/文件）：

| 模块 | 行数 | 职责 |
|---|---|---|
| `api.js` | 71 | fetch 封装 + token 管理 + 401 回调 |
| `ui.js` | 139 | toast/modal/confirm/theme/escHTML |
| `state.js` | 64 | 权限常量 + myPerms/hasPerm/applyRoleUI |
| `shared.js` | 45 | formatTime/actionLabel/genRandomPassword |
| `users.js` | 142 | 搜索/列表渲染/分页 |
| `user-detail.js` | 189 | 详情弹窗 + 解锁/禁用/离职/删除 |
| `settings.js` | 269 | AD/飞书设置 + 向导 + 选项加载 |
| `audit.js` | 193 | 审计日志 + 定时任务 |
| `admin-mgmt.js` | 204 | 管理员管理 + 权限勾选 |
| `app.js` | 437 | 入口 — 初始化 + 事件绑定 + 登录/会话 + 重置密码/加组 |

- admin.html 改用 `<script type="module" src="/assets/admin/app.js?v=36">`
- app.js 通过 `Object.assign(window, {...})` 暴露函数到全局，兼容内联 onclick
- 浏览器原生 ES Module，零构建工具

## 阶段四：消灭 innerHTML + 补齐交互

- `shared.js` 新增 `relativeTime()`、`passwordStrength()` 等
- `ui.js` 新增 `renderSkeletonCards()`、`renderEmptyState()`、`validateField()`
- `components.css` 新增骨架屏卡片、密码强度条、表单校验错误、相对时间 tooltip
- 搜索/日志/任务加载改用骨架屏，审计日志时间改用相对时间（hover 显示完整时间）
- 创建/重置密码输入框实时显示密码强度条

## 阶段五：管理端布局优化

- 用户列表从卡片网格改为紧凑表格（pageSize 10→20，一屏 15-20 条）
- 侧边栏 emoji 改 SVG 图标 + 折叠按钮（56px 仅图标模式，状态持久化 localStorage）
- 侧边栏类名统一：`sidebar-brand` → `side-brand`、`sidebar-item` → `side-item`
- 详情弹窗顶部添加面包屑 "账号操作 > [用户名]"
- 设置页卡片化样式预埋（`.settings-card`）

## 阶段六：自助端体验打磨

- 搜索防抖从 500ms 减到 300ms
- 认证成功后自动聚焦搜索框
- 飞书未配置时显示友好提示页（不再无限重定向）

## 阶段七：微交互和可访问性

- 全局 `:focus-visible` 样式（2px 蓝色外圈）
- `.sr-only` 屏幕阅读器辅助类
- ARIA 角色：侧边栏 `role="navigation"`、弹窗 `role="dialog" aria-modal="true"`、toast `role="alert" aria-live="polite"`
- Esc 键全局关闭弹窗
- 管理端 9 个 ARIA 属性，自助端 4 个，CSS 8 个无障碍样式

## 全部 7 个阶段已完成 ✅
