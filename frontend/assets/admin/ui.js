/**
 * UI 模块 — Toast / Modal / Confirm / Theme / Escape
 */

// ─── Toast ───
function showToast(msg, type = 'info', duration = 4000) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const icons = { success: '✓', warning: '⚠', danger: '✕', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
  toast.innerHTML = '<div class="toast-icon">' + (icons[type] || 'ℹ') + '</div><div class="toast-content"><div class="toast-message"></div></div>';
  const msgEl = toast.querySelector('.toast-message');
  if (msgEl) msgEl.textContent = msg;
  container.appendChild(toast);
  toast.style.animation = 'slideInRight 0.3s ease-out';
  setTimeout(function () {
    toast.style.animation = 'fadeOut 0.3s ease-out forwards';
    setTimeout(function () { toast.remove(); }, 300);
  }, duration);
}

// ─── Modal ───
// 焦点陷阱：模态框打开后 Tab 键只在框内循环，符合 WCAG 2.4.3
let _lastFocusedBeforeModal = null;

function trapFocus(modal) {
  if (!modal) return;
  _lastFocusedBeforeModal = document.activeElement;
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('role', 'dialog');
  const getFocusable = () => modal.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  let focusable = getFocusable();
  if (focusable.length > 0) {
    // 延迟聚焦等 display 生效
    requestAnimationFrame(() => { focusable[0].focus(); });
  }
  const handler = function (e) {
    if (e.key !== 'Tab') return;
    focusable = getFocusable();
    if (focusable.length === 0) { e.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  modal.addEventListener('keydown', handler);
  modal._focusTrapHandler = handler;
}

function releaseFocus(modal) {
  if (!modal) return;
  if (modal._focusTrapHandler) {
    modal.removeEventListener('keydown', modal._focusTrapHandler);
    modal._focusTrapHandler = null;
  }
  modal.removeAttribute('aria-modal');
  if (_lastFocusedBeforeModal && typeof _lastFocusedBeforeModal.focus === 'function') {
    _lastFocusedBeforeModal.focus();
    _lastFocusedBeforeModal = null;
  }
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) {
    // 用 .active 类配合 CSS transition 实现淡入，不用 style.display 直接切换
    el.style.display = '';
    el.classList.add('active');
    document.body.classList.add('locked');
    trapFocus(el);
  }
}

function closeModal() {
  document.querySelectorAll('.modal').forEach(function (m) {
    m.classList.remove('active');
    releaseFocus(m);
  });
  document.body.classList.remove('locked');
}

// ─── High-danger Confirm ───
let _dangerConfirmCallback = null;

function openDangerConfirm(opts) {
  const modal = document.getElementById('dangerConfirmModal');
  if (!modal) return;
  const title = document.getElementById('dangerConfirmTitle');
  const desc = document.getElementById('dangerConfirmDesc');
  const target = document.getElementById('dangerConfirmTarget');
  const warn = document.getElementById('dangerConfirmWarn');
  const hint = document.getElementById('dangerConfirmHint');
  const input = document.getElementById('dangerConfirmInput');
  const ok = document.getElementById('dangerConfirmOk');
  if (title) title.textContent = opts.title || '高危操作确认';
  if (desc) desc.textContent = opts.desc || '即将执行高危操作';
  if (target) target.textContent = opts.target || '';
  if (warn) warn.textContent = opts.warning || '此操作不可逆';
  if (hint) hint.textContent = (opts.hint || '请输入账号名以确认') + '：';
  if (input) { input.value = ''; input.placeholder = opts.target || ''; }
  if (ok) ok.disabled = true;
  if (ok && opts.confirmText) ok.textContent = opts.confirmText;
  _dangerConfirmCallback = opts.onConfirm || null;
  // 设置 window 属性供 app.js 的事件监听器读取
  window._dangerTarget = opts.target || '';
  window._dangerConfirmCb = opts.onConfirm || null;
  modal.style.display = '';
  modal.classList.add('active');
  document.body.classList.add('locked');
  trapFocus(modal);
  if (input) input.focus();
}

function closeDangerConfirm() {
  const modal = document.getElementById('dangerConfirmModal');
  if (modal) modal.classList.remove('active');
  releaseFocus(modal);
  document.body.classList.remove('locked');
  _dangerConfirmCallback = null;
  window._dangerTarget = '';
  window._dangerConfirmCb = null;
}

function getDangerConfirmCallback() {
  return _dangerConfirmCallback;
}

// ─── Theme ───
let _sysDark = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)').matches : false;

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  if (t === 'dark') document.body.classList.add('theme-dark');
  else document.body.classList.remove('theme-dark');
  localStorage.setItem('ad_theme', t);
  const btns = document.querySelectorAll('.theme-btn');
  btns.forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-theme') === t);
  });
}

function initTheme() {
  const saved = localStorage.getItem('ad_theme') || (_sysDark ? 'dark' : 'light');
  applyTheme(saved);
}

function cycleTheme() {
  const current = localStorage.getItem('ad_theme') || 'light';
  const next = current === 'light' ? 'dark' : current === 'dark' ? 'auto' : 'light';
  if (next === 'auto') {
    document.documentElement.removeAttribute('data-theme');
    document.body.classList.remove('theme-dark');
  } else {
    applyTheme(next);
  }
  localStorage.setItem('ad_theme', next);
  const btns = document.querySelectorAll('.theme-btn');
  btns.forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-theme') === next);
  });
  showToast(next === 'light' ? '浅色模式' : next === 'dark' ? '深色模式' : '自动模式', 'info', 1500);
}

// ─── Escape / Helpers ───
//
// 转义规范（团队必须遵守）：
//   - HTML 文本节点（<span>USER_DATA</span>）         → escHTML()
//   - HTML 属性值（value="USER_DATA", title="USER_DATA"）→ escAttr()（与 escHTML 等价，语义更明确）
//   - JavaScript 字符串字面量（onclick="fn('USER_DATA')"）→ escJS()
//   - URL 参数                                      → encodeURIComponent()
//
// ⚠️ 常见误区：escJS 只转义 \ ' "，不转义 < > &。
//    在 HTML 属性上下文（title="..."、value="..."）里用 escJS 是无效的——
//    攻击者输入 " onmouseover="alert(1) 即可闭合属性注入任意脚本。
//    必须用 escHTML/escAttr。
//
// 推荐使用 html`` 模板函数（见下方），自动对 ${} 插值做 escHTML。
function escHTML(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// escAttr 用于 HTML 属性值上下文，与 escHTML 转义规则相同（& < > " ' 全转义）。
// 单独命名是为了在代码 review 时一眼区分"属性"vs"文本"，降低误用 escJS 的概率。
function escAttr(s) {
  return escHTML(s);
}

function escJS(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// html`` 标签模板函数：对 ${} 插值自动 escHTML，避免手动拼接遗漏转义。
// 用法：html`<td>${user.name}</td><td title="${user.dept}">${user.dept}</td>`
// 注意：插入的值会经过 escHTML，适用于文本节点和属性值。
//      如需插入原生 HTML（如 SVG），用 raw() 标记。
const _rawMarker = Symbol('raw');
function raw(htmlStr) { return { [_rawMarker]: true, html: String(htmlStr) }; }
function html(strings, ...values) {
  let result = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v && typeof v === 'object' && v[_rawMarker]) {
      result += v.html;
    } else {
      result += escHTML(v);
    }
    result += strings[i + 1];
  }
  return result;
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// debounce 工具函数：延迟执行，快速重复调用只保留最后一次。
// 用法：input.addEventListener('input', debounce(searchUsers, 300));
function debounce(fn, wait) {
  let timer = null;
  return function () {
    const ctx = this, args = arguments;
    clearTimeout(timer);
    timer = setTimeout(() => { fn.apply(ctx, args); }, wait || 300);
  };
}

// ─── 表单校验 ───
function setFieldError(input, msg) {
  if (!input) return;
  input.classList.add('form-error');
  input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  let errEl = input.parentElement?.querySelector('.form-error-msg');
  if (!errEl) {
    errEl = document.createElement('div');
    errEl.className = 'form-error-msg';
    errEl.setAttribute('role', 'alert');
    errEl.setAttribute('aria-live', 'assertive');
    input.parentElement?.appendChild(errEl);
  }
  if (msg) { errEl.textContent = msg; errEl.classList.add('visible'); }
  else { errEl.classList.remove('visible'); input.classList.remove('form-error'); }
}

function clearFieldError(input) {
  if (!input) return;
  input.classList.remove('form-error');
  const errEl = input.parentElement?.querySelector('.form-error-msg');
  if (errEl) errEl.classList.remove('visible');
}

// blur 校验：非空 + 最小长度
function validateField(input, opts) {
  opts = opts || {};
  const val = (input.value || '').trim();
  if (opts.required && !val) { setFieldError(input, (opts.label || '此项') + '不能为空'); return false; }
  if (opts.minLen && val.length < opts.minLen) { setFieldError(input, '至少 ' + opts.minLen + ' 个字符'); return false; }
  if (opts.email && val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) { setFieldError(input, '邮箱格式不正确'); return false; }
  clearFieldError(input);
  return true;
}

// ─── 骨架屏生成 ───
function renderSkeletonCards(container, count) {
  if (!container) return;
  count = count || 3;
  let html = '';
  for (let i = 0; i < count; i++) {
    html += '<div class="skeleton-card"><div class="skeleton-card-head">';
    html += '<div class="skeleton-avatar"></div>';
    html += '<div style="flex:1"><div class="skeleton-line w-40" style="margin-bottom:6px"></div>';
    html += '<div class="skeleton-line w-60"></div></div></div>';
    html += '<div class="skeleton-line w-80" style="margin-bottom:6px"></div>';
    html += '<div class="skeleton-line w-40"></div></div>';
  }
  container.innerHTML = html;
}

// ─── 空状态 SVG ───
const EMPTY_SVG = {
  search: '<svg width="120" height="120" viewBox="0 0 120 120" fill="none"><circle cx="60" cy="60" r="56" stroke="var(--primary-200)" stroke-width="2" fill="var(--primary-50)" opacity="0.6"/><circle cx="60" cy="60" r="40" stroke="var(--primary-300)" stroke-width="1.5" fill="var(--primary-50)" opacity="0.3"/><line x1="45" y1="52" x2="75" y2="52" stroke="var(--primary-400)" stroke-width="3" stroke-linecap="round"/><line x1="45" y1="60" x2="68" y2="60" stroke="var(--primary-300)" stroke-width="3" stroke-linecap="round"/><line x1="45" y1="68" x2="62" y2="68" stroke="var(--primary-200)" stroke-width="3" stroke-linecap="round"/><circle cx="82" cy="38" r="10" stroke="var(--primary-500)" stroke-width="2" fill="var(--primary-100)"/><line x1="89" y1="45" x2="96" y2="52" stroke="var(--primary-500)" stroke-width="2" stroke-linecap="round"/></svg>',
  users: '<svg width="120" height="120" viewBox="0 0 120 120" fill="none"><circle cx="50" cy="45" r="20" stroke="var(--gray-300)" stroke-width="2" fill="var(--gray-100)" opacity="0.5"/><path d="M20 100c0-16 13-30 30-30s30 14 30 30" stroke="var(--gray-300)" stroke-width="2" fill="none" opacity="0.5"/><circle cx="80" cy="40" r="14" stroke="var(--gray-300)" stroke-width="1.5" fill="var(--gray-50)" opacity="0.3"/><path d="M70 90c0-10 8-18 18-18s18 8 18 18" stroke="var(--gray-300)" stroke-width="1.5" fill="none" opacity="0.3"/></svg>',
  empty: '<svg width="120" height="120" viewBox="0 0 120 120" fill="none"><rect x="30" y="20" width="60" height="80" rx="8" stroke="var(--gray-300)" stroke-width="2" fill="var(--gray-50)" opacity="0.5"/><line x1="42" y1="40" x2="78" y2="40" stroke="var(--gray-300)" stroke-width="2" stroke-linecap="round"/><line x1="42" y1="55" x2="68" y2="55" stroke="var(--gray-300)" stroke-width="2" stroke-linecap="round"/><line x1="42" y1="70" x2="72" y2="70" stroke="var(--gray-300)" stroke-width="2" stroke-linecap="round"/></svg>',
};

function renderEmptyState(container, type, title, desc) {
  if (!container) return;
  const svg = EMPTY_SVG[type] || EMPTY_SVG.empty;
  container.innerHTML = '<div class="empty-state">' + svg + '<h3>' + (title || '暂无数据') + '</h3><p>' + (desc || '') + '</p></div>';
}

export {
  showToast, openModal, closeModal,
  openDangerConfirm, closeDangerConfirm, getDangerConfirmCallback,
  applyTheme, initTheme, cycleTheme,
  escHTML, escAttr, escJS, html, raw,
  capitalize, debounce,
  setFieldError, clearFieldError, validateField,
  renderSkeletonCards, renderEmptyState,
};
