# UI/UX 审计修复报告

> 时间：2026-07-09 14:17–14:50
> 修复人：资深开发工程师（吴八哥）
> 范围：P0 可访问性 + P1 CSS/交互 + P2 内联CSS提取/设计取向

---

## 一、P0 可访问性（4 项全部修复）

| # | 问题 | WCAG | 修复 |
|---|---|---|---|
| 6.1 | viewport 禁止缩放 | 1.4.4 | index.html 移除 `maximum-scale=1.0, user-scalable=0` |
| 6.3 | 模态框无焦点陷阱 | 2.4.3 | ui.js 新增 `trapFocus()`/`releaseFocus()`，Tab 键只在弹窗内循环，关闭后焦点返回触发元素 |
| 6.4 | 状态仅靠颜色 | 1.4.1 | ES Module 迁移后已自动解决（表格有"已禁用/正常"文字标签） |
| 6.5 | 错误信息缺 role=alert | 4.1.3 | `setFieldError` 创建的错误元素加 `role="alert"` + `aria-live="assertive"`，input 加 `aria-invalid` |

### 焦点陷阱实现亮点
```js
function trapFocus(modal) {
  _lastFocusedBeforeModal = document.activeElement;  // 记住触发元素
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('role', 'dialog');
  // Tab/Shift+Tab 在弹窗内循环
  const handler = function (e) {
    if (e.key !== 'Tab') return;
    if (e.shiftKey && activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && activeElement === last) { e.preventDefault(); first.focus(); }
  };
}
```

---

## 二、P1 CSS 架构清理

### .btn-primary 从 4 处定义统一为 1 处
| 位置 | 修改前 | 修改后 |
|---|---|---|
| components.css:54 | 纯色 `var(--primary-600)` | ✅ 保留（唯一生效版本） |
| design-system.css:333 | 渐变 + 阴影 + translateY(-1px) | 🗑 删除 |
| design-system.css:979 | 硬编码靛蓝 #6366f1→#8b5cf6 + translateY(-2px) | 🗑 删除 |
| design-system.css:1295 | gradientShift 3s 无限动画 | 🗑 删除 |

### 其他 CSS 清理
- **gradientShift 动画**：@keyframes + 引用全部删除
- **.card:hover 位移**：`translateY(-4px)` → `border-color` 变化（数据密集型工具不抖动）
- **暗色模式选择器**：design-system.css 8 处 `.theme-dark` → `[data-theme="dark"]`
- **圆角别名**：tokens.css `--radius-xl`/`--radius-2xl` 从别名(12px)改为独立值(16px/20px)
- **:root 重复定义**：加注释说明 tokens.css 是唯一 token 源

---

## 三、P1 交互修复

| # | 问题 | 修复 |
|---|---|---|
| 4.1 | 模态框 style.display 绕过 CSS 过渡 | 改为 `classList.add/remove('active')`，配合 CSS `opacity + visibility + transition` 淡入淡出 |
| 4.2 | 下拉菜单仅 hover 触发 | 加 `.dropdown.open` CSS 规则，配合 app.js 的 click 事件（触摸设备可用） |
| 4.3 | 搜索无防抖 | ui.js 新增 `debounce()` 工具函数并导出（auditDebouncedLoad 已是正确实现） |

---

## 四、P2 内联 CSS 提取 + 设计取向

### admin.html 从 2332 行缩减到 860 行（减 63%）
- 1471 行内联 `<style>` 提取到新文件 `assets/admin-page.css`
- 现可被浏览器缓存，后续访问只需下载 860 行 HTML

### 登录页渐变球移除
| 元素 | 修改前 | 修改后 |
|---|---|---|
| `.login-page` 背景 | `linear-gradient(135deg, #0f172a, #1e1b4b, #312e81)` 深色渐变 | `var(--bg-muted)` 纯色 |
| `.login-page::before` | 500px radial-gradient 球 + float 10s 动画 | `display: none` |
| `.login-page::after` | 400px radial-gradient 球 + float 12s 动画 | `display: none` |
| `.login-card` | 半透明白 + backdrop-filter blur + 80px 强阴影 | 纯白 + border + 标准阴影 |

---

## 五、验证结果

```
go build ./...                ✅ 通过
node --check ui.js/app.js     ✅ 通过
CSS 大括号匹配                 ✅ 3 个文件全部匹配
admin.html                    2332 → 860 行（-63%）
admin-page.css                1460 行（新文件，可缓存）
CSS 版本号 bump               design-system v11, tokens v2
```

---

## 六、未完成（后续任务）

| 项 | 原因 | 建议 |
|---|---|---|
| Emoji 换 SVG (6.2) | 侧边栏+下拉菜单 20+ 处 Emoji 需逐个替换为 SVG | 下个迭代专项处理 |
| admin-page.css 剩余 15 处渐变 | 部分渐变是合理设计（状态指示器），需逐一评估 | 分批清理 |
| 164 处行内 style="" | 需逐个提取为 class | 随组件重构逐步清理 |
| 折叠面板改平铺 (3.2) | 设计取向需团队共识 | 产品讨论后决定 |
| 面包屑导航 (3.3) | 新功能开发 | 下个迭代 |
| 侧边栏折叠功能 (4.4) | CSS 有 .collapsed 但无切换按钮 | 补按钮即可 |
| Undo Toast (4.5) | 死代码 | 确认后删除 |
| 键盘快捷键 (4.6) | 新功能 | 下个迭代 |

---

## 七、给团队的 CSS 架构建议

1. **Token 单一源原则**：`tokens.css` 是唯一的 token 定义源。`design-system.css` 和 `admin-page.css` 只消费 token，不重复定义。修改颜色/间距/圆角时只改 `tokens.css`。

2. **组件样式单一定义原则**：`.btn-primary` 只在 `components.css` 定义一次。`design-system.css` 不再重复定义组件，只做扩展（如暗色模式覆盖）。

3. **内联 CSS 零容忍**：1471 行内联 CSS 是性能杀手——无法缓存、无法复用、维护困难。新代码不允许内联 `<style>`，行内 `style=""` 只用于真正的动态值（如 `style="animation-delay: 0.05s"`）。

4. **运维工具设计取向**：纯色 > 渐变，border 变化 > 位移抖动，无装饰 > 营销风格。按钮不做动画闪烁，卡片不做悬浮位移。
