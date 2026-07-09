# AD Management — 设计规范

> 本文档是前端重构的锚点。所有阶段的 CSS Token、组件状态、交互规范以此为准。
> 团队对齐后才开始动手改代码。

---

## 1. 色彩系统

### 1.1 主色（Primary — Blue）

统一为蓝色 `#2563eb`，取代管理端当前 indigo `#6366f1`。理由：运维工具蓝色最安全、最中性，与自助端 `styles.css` 已有的 `--primary: #2563eb` 对齐。

| Token | 值 | 用途 |
|---|---|---|
| `--primary-50` | `#eff6ff` | 背景浅色、选中态底色 |
| `--primary-100` | `#dbeafe` | 边框浅色、badge 背景 |
| `--primary-200` | `#bfdbfe` | hover 边框 |
| `--primary-300` | `#93c5fd` | 禁用态 |
| `--primary-400` | `#60a5fa` | 暗色模式次要文字 |
| `--primary-500` | `#3b82f6` | 图标、链接 |
| `--primary-600` | `#2563eb` | **主色**，按钮、链接、focus ring |
| `--primary-700` | `#1d4ed8` | hover 加深 |
| `--primary-800` | `#1e40af` | active 态 |
| `--primary-900` | `#1e3a8a` | 暗色模式背景点缀 |

### 1.2 语义色

| Token | 50 | 100 | 500 | 600 | 700 |
|---|---|---|---|---|---|
| Success | `#ecfdf5` | `#d1fae5` | `#10b981` | `#059669` | `#047857` |
| Warning | `#fffbeb` | `#fef3c7` | `#f59e0b` | `#d97706` | `#b45309` |
| Danger | `#fef2f2` | `#fee2e2` | `#ef4444` | `#dc2626` | `#b91c1c` |

### 1.3 中性色

| Token | 值 | 用途 |
|---|---|---|
| `--gray-50` | `#f9fafb` | 页面底色 |
| `--gray-100` | `#f3f4f6` | 卡片间隔、表头底色 |
| `--gray-200` | `#e5e7eb` | 默认边框 |
| `--gray-300` | `#d1d5db` | 强边框 |
| `--gray-400` | `#9ca3af` | 三级文字、占位符 |
| `--gray-500` | `#6b7280` | 二级文字 |
| `--gray-600` | `#4b5563` | 正文次要 |
| `--gray-700` | `#374151` | 正文 |
| `--gray-800` | `#1f2937` | 标题 |
| `--gray-900` | `#111827` | 主标题 |

### 1.4 语义映射

| Token | 浅色 | 暗色 |
|---|---|---|
| `--bg-base` | `#ffffff` | `#0f172a` |
| `--bg-subtle` | `#f9fafb` | `#0f172a` |
| `--bg-muted` | `#f3f4f6` | `#1e293b` |
| `--bg-surface` | `#ffffff` | `#1e293b` |
| `--bg-overlay` | `rgba(0,0,0,0.4)` | `rgba(0,0,0,0.6)` |
| `--text-default` | `#111827` | `#f1f5f9` |
| `--text-secondary` | `#4b5563` | `#94a3b8` |
| `--text-tertiary` | `#9ca3af` | `#64748b` |
| `--text-disabled` | `#d1d5db` | `#334155` |
| `--border-subtle` | `#f3f4f6` | `#1e293b` |
| `--border-default` | `#e5e7eb` | `#334155` |
| `--border-strong` | `#d1d5db` | `#475569` |

### 1.5 暗色模式策略

- **class 控制**：`<html data-theme="dark">` 优先于 `prefers-color-scheme`
- 切换时同时设置 body class `theme-dark`（兼容现有内联样式）
- 两个页面统一逻辑，不再各自实现

---

## 2. 间距系统

4px 基数，沿用现有 design-system.css 的 scale：

| Token | 值 | 用途 |
|---|---|---|
| `--space-1` | `4px` | 图标内距、小间隙 |
| `--space-2` | `8px` | 按钮内距、表单项间距 |
| `--space-3` | `12px` | 卡片内距、列表项间距 |
| `--space-4` | `16px` | 标准内距、表单组间距 |
| `--space-5` | `20px` | 卡片 header padding |
| `--space-6` | `24px` | 区块间距 |
| `--space-8` | `32px` | 大区块间距 |
| `--space-10` | `40px` | 页面 padding |
| `--space-12` | `48px` | 空状态/大间距 |

> **砍掉** `--space-1_5`(6px)、`--space-2_5`(10px)、`--space-3_5`(14px)、`--space-7`(28px)、`--space-9`(36px) 等非标准值。

---

## 3. 圆角（三档）

| Token | 值 | 用途 |
|---|---|---|
| `--radius-sm` | `6px` | 按钮、输入框、badge |
| `--radius-md` | `8px` | 卡片、面板 |
| `--radius-lg` | `12px` | 弹窗、大面板 |
| `--radius-full` | `9999px` | 圆形头像、pill badge |

> **砍掉** 4px/10px/14px/16px/24px 等非标准值。当前用了 7 个不同值，统一到 3+1 档。

---

## 4. 阴影（三档）

| Token | 值 | 用途 |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | 卡片默认 |
| `--shadow-md` | `0 2px 8px rgba(0,0,0,0.08)` | hover/浮起 |
| `--shadow-lg` | `0 8px 24px rgba(0,0,0,0.12)` | 弹窗/dropdown |

> **砍掉** `--shadow-xs`、`--shadow-xl`、`--shadow-2xl`、`--shadow-inner`、所有 `--glow-*`。

---

## 5. 字重

| Token | 值 | 用途 |
|---|---|---|
| `--weight-normal` | `400` | 正文 |
| `--weight-medium` | `500` | 次要标题、标签 |
| `--weight-semibold` | `600` | 标题、按钮文字 |

> **砍掉** `--weight-bold`(700)。当前过度使用 700 导致视觉层级过多。

---

## 6. 排版

| Token | 值 |
|---|---|
| `--font-sans` | `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif` |
| `--font-mono` | `ui-monospace, "SF Mono", Menlo, monospace` |
| `--text-xs` | `12px` |
| `--text-sm` | `14px` |
| `--text-base` | `16px` |
| `--text-lg` | `18px` |
| `--text-xl` | `20px` |
| `--text-2xl` | `24px` |

---

## 7. 动画规范

### 7.1 时长（两档）

| Token | 值 | 用途 |
|---|---|---|
| `--duration-fast` | `100ms` | hover、focus、颜色变化 |
| `--duration-normal` | `200ms` | 面板展开、弹窗出现、过渡 |

> **砍掉** 75ms/150ms/300ms/500ms/700ms/1000ms。

### 7.2 缓动（单一）

| Token | 值 |
|---|---|
| `--ease` | `cubic-bezier(0, 0, 0.2, 1)` (ease-out) |

> **砍掉** `--ease-bounce`、`--ease-spring`、`--ease-in-out`、`--ease-in`。所有过渡统一使用 ease-out。

### 7.3 砍掉的动画效果

| 效果 | 位置 | 替代 |
|---|---|---|
| 登录页浮动光球 `float` | admin.html `::before/::after` | 纯色背景 `#0f172a` |
| 按钮 `gradientShift` 呼吸 | design-system.css | 纯色按钮，hover 加深 |
| 卡片 hover `translateY(-4px)` | design-system.css | `translateY(-1px)` + 阴影升一档 |
| `card-glass` 毛玻璃 | design-system.css | 纯白/深灰面板 |
| `glow-primary/accent/success` | design-system.css | 删除 |
| 按钮 hover 发光阴影 | design-system.css | background 变深 + border 变化 |
| 重复 @keyframes（bounceIn×2, float×2, spin×2, shimmer×2, inputFocus×2） | 两文件各一份 | 每个保留一份 |
| `breathe-green/red` 连接状态脉冲 | design-system.css | 静态绿/红圆点 |
| `user-card:nth-child` 逐项延迟入场 | design-system.css | 统一 fadeUp 200ms |

**保留的 8 个 @keyframes**：`fadeIn`、`fadeUp`(slideInUp)、`scaleIn`、`spin`、`shimmer`、`pulse`、`shrink`(undo bar)、`toastSlideIn`

---

## 8. 组件状态定义

### 8.1 按钮

| 状态 | Primary | Secondary | Ghost | Danger |
|---|---|---|---|---|
| Default | `bg: --primary-600` | `bg: surface, border: default` | `bg: transparent` | `bg: --danger-600` |
| Hover | `bg: --primary-700` | `bg: muted, border: strong` | `bg: muted` | `bg: --danger-700` |
| Active | `bg: --primary-800, scale(0.98)` | `scale(0.98)` | `scale(0.98)` | `scale(0.98)` |
| Disabled | `opacity: 0.5, cursor: not-allowed` | 同 | 同 | 同 |
| Focus | `box-shadow: 0 0 0 3px --primary-100` | 同 | 同 | `box-shadow: 0 0 0 3px --danger-100` |

**按钮样式**：
- 纯色背景（无渐变）
- `border-radius: var(--radius-sm)` (6px)
- `padding: 8px 16px`（标准）、`6px 12px`（sm）、`12px 24px`（lg）
- `font-weight: var(--weight-medium)` (500)
- hover 时 `translateY(-1px)` + 阴影从 sm→md

### 8.2 输入框

| 状态 | 样式 |
|---|---|
| Default | `border: 1px solid --border-default, bg: --bg-surface, radius: --radius-sm` |
| Hover | `border-color: --border-strong` |
| Focus | `border-color: --primary-600, box-shadow: 0 0 0 3px --primary-100` |
| Disabled | `bg: --bg-muted, color: --text-disabled, cursor: not-allowed` |
| Error | `border-color: --danger-500, box-shadow: 0 0 0 3px --danger-100` |

### 8.3 卡片

| 状态 | 样式 |
|---|---|
| Default | `bg: --bg-surface, border: 1px solid --border-default, radius: --radius-md, shadow: --shadow-sm` |
| Hover | `shadow: --shadow-md, border-color: --primary-200` |

### 8.4 弹窗（Modal）

| 状态 | 样式 |
|---|---|
| Backdrop | `bg: --bg-overlay` |
| Content | `bg: --bg-surface, radius: --radius-lg, shadow: --shadow-lg` |
| 出现 | `opacity: 0→1, transform: scale(0.95)→scale(1), duration: 200ms ease-out` |

### 8.5 Badge / 状态标签

| 类型 | 背景 | 文字 | 边框 |
|---|---|---|---|
| Success | `--success-50` | `--success-700` | `--success-100` |
| Warning | `--warning-50` | `--warning-700` | `--warning-100` |
| Danger | `--danger-50` | `--danger-700` | `--danger-100` |
| Primary | `--primary-50` | `--primary-700` | `--primary-100` |
| Neutral | `--bg-muted` | `--text-secondary` | transparent |

### 8.6 Toast

| 类型 | 左边框 |
|---|---|
| Success | `3px solid --success-500` |
| Warning | `3px solid --warning-500` |
| Danger | `3px solid --danger-500` |
| Info | `3px solid --primary-500` |

### 8.7 连接状态指示器

| 状态 | 圆点颜色 |
|---|---|
| Connected | `--success-500`（静态，无脉冲） |
| Disconnected | `--danger-500`（静态） |
| Warning | `--warning-500`（静态） |
| Checking | `--gray-400` |

---

## 9. Z-Index 层级

| Token | 值 | 用途 |
|---|---|---|
| `--z-dropdown` | `1000` | dropdown |
| `--z-sticky` | `1020` | sticky header |
| `--z-fixed` | `1030` | sidebar |
| `--z-modal-backdrop` | `1040` | modal 背景 |
| `--z-modal` | `1050` | modal 内容 |
| `--z-toast` | `1080` | toast |

---

## 10. 文件结构规划

```
frontend/assets/
  tokens.css          ← 所有 CSS 变量（合并 design-system.css + styles.css 的 :root）
  components.css      ← 通用组件样式（按钮/卡片/输入框/弹窗/badge/toast/表格）
  admin.css           ← 管理端专属布局（sidebar/tab-panel/search-area/detail-modal）
  selfservice.css     ← 自助端专属布局（hero/auth-overlay/ss-card）
  icons.js            ← Lucide SVG 图标库（~25 个图标）
  admin/
    app.js            ← 入口，初始化 + 事件绑定
    api.js            ← fetch 封装 + token 管理 + 错误处理
    users.js          ← 用户搜索/列表/分页
    user-detail.js    ← 用户详情弹窗
    create-user.js    ← 创建用户
    offboard.js       ← 离职处理
    audit.js          ← 审计日志
    settings.js       ← AD/飞书设置
    scheduler.js      ← 定时任务
    ui.js             ← toast/modal/confirm 通用组件
```

### HTML 引用顺序

**admin.html**:
```html
<link rel="stylesheet" href="/assets/tokens.css?v=1" />
<link rel="stylesheet" href="/assets/components.css?v=1" />
<link rel="stylesheet" href="/assets/admin.css?v=1" />
<script type="module" src="/assets/admin/app.js?v=1"></script>
```

**index.html**:
```html
<link rel="stylesheet" href="/assets/tokens.css?v=1" />
<link rel="stylesheet" href="/assets/components.css?v=1" />
<link rel="stylesheet" href="/assets/selfservice.css?v=1" />
<script type="module" src="/assets/app.js?v=1"></script>
```

---

## 11. 验收标准

### 阶段一验收
- [ ] 两个页面并排打开，主色/间距/圆角/阴影肉眼一致
- [ ] 暗色模式切换无色差
- [ ] 无发光/脉冲/呼吸效果
- [ ] 登录页无浮动光球动画
- [ ] 按钮无渐变呼吸动画
- [ ] 卡片 hover 仅 `translateY(-1px)` + 阴影变化

### 阶段二验收
- [ ] 所有 emoji 替换为 SVG 图标
- [ ] macOS/Windows/iOS 截图对比渲染一致
- [ ] 侧边栏导航项有图标
- [ ] Toast 类型用图标标识

### 阶段三验收
- [ ] admin.js 从 1 个 2400 行文件变为 9 个平均 270 行文件
- [ ] 功能零回归
- [ ] 浏览器原生 ES Module 直接加载，无构建工具

### 阶段四验收
- [ ] innerHTML 拼接降到 0（除模板函数内部可控场景）
- [ ] 所有加载态有骨架屏
- [ ] 表单有即时校验
- [ ] 时间显示有相对时间

### 阶段五验收
- [ ] 用户列表一屏可见 15+ 条
- [ ] 侧边栏可折叠到 56px
- [ ] 设置页结构清晰分组
- [ ] 详情弹窗有面包屑返回路径

### 阶段六验收
- [ ] 自助端从打开到看到结果 ≤ 2 次点击
- [ ] 飞书未配置不会白屏
- [ ] 搜索自动聚焦
- [ ] 输入防抖自动搜索

### 阶段七验收
- [ ] 所有弹窗支持 Esc 关闭
- [ ] Tab 聚焦循环
- [ ] ARIA 标签完整
- [ ] 全局 `:focus-visible` 样式
- [ ] 色彩对比度达 WCAG AA (4.5:1)

---

## 12. 决策记录

| 决策项 | 选择 | 理由 |
|---|---|---|
| 主色 | `#2563eb`（蓝） | 运维工具蓝色最安全，两套现有系统取蓝那套对齐 |
| 间距系统 | 4px 基数 | design-system.css 已有这套，直接沿用 |
| 圆角 | 3 档（6/8/12px） | 当前 7 个不同值，砍到 3 档统一 |
| 阴影 | 3 档（sm/md/lg） | 去掉所有 glow/inner shadow |
| 字重 | 400/500/600 | 去掉 700，减少视觉层级 |
| 动画时长 | 100ms + 200ms | 当前 75ms~1000ms 跨度太大 |
| 缓动 | ease-out 统一 | 去掉 bounce/spring |
| 暗色策略 | `data-theme="dark"` class 控制 | 两个页面统一触发逻辑 |
| 图标 | Lucide 内联 SVG | 零依赖，跨平台一致 |
| JS 模块 | ES Module 原生 | 不引入构建工具 |
