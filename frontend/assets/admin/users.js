/**
 * Users 模块 — 用户搜索/列表渲染/分页
 */
import { api } from './api.js';
import { showToast, escHTML, escJS, renderSkeletonCards, renderEmptyState } from './ui.js';
import { avatarGradient } from './shared.js';

// ─── 状态 ───
let currentPage = 1;
const pageSize = 20;
let totalUsers = 0;
let lastSearchResults = [];

// ─── 时间工具 ───
function adTimeToString(ts) {
  if (!ts || ts === '0' || ts === '') return '从未';
  try {
    const ticks = parseInt(ts, 10);
    if (isNaN(ticks) || ticks <= 0) return '从未';
    const adEpochMs = -11644473600000;
    const ms = Math.floor(ticks / 10000) + adEpochMs;
    const date = new Date(ms);
    if (date.getFullYear() < 1970 || date.getFullYear() > 2100) return '从未';
    return date.toLocaleDateString('zh-CN') + ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch (e) { return '从未'; }
}

function pwdExpiryInfo(pwdLastSet, passwordNeverExpires, maxAgeDays, passwordExpiresAt) {
  // 优先用 AD 真实计算属性 msDS-UserPasswordExpiryTimeComputed（域控综合域策略/PSO/UAC 算出的权威到期时间）
  if (passwordExpiresAt) {
    const pe = String(passwordExpiresAt).trim();
    // 0 / INT64_MAX(9223372036854775807) → 永不过期
    if (pe === '0' || pe === '' || pe === '9223372036854775807') return { text: '永不过期', cls: 'ok' };
    // -1 → 用户须在下次登录改密
    if (pe === '-1') return { text: '需设置', cls: 'warn' };
    try {
      const ticks = parseInt(pe, 10);
      if (!isNaN(ticks) && ticks > 0) {
        const adEpochMs = -11644473600000;
        const expiryMs = Math.floor(ticks / 10000) + adEpochMs;
        if (expiryMs <= 0) return { text: '需设置', cls: 'warn' };
        const now = Date.now();
        if (expiryMs < now) return { text: '已过期', cls: 'bad' };
        const daysLeft = Math.ceil((expiryMs - now) / (24 * 60 * 60 * 1000));
        return { text: daysLeft + '天后到期', cls: daysLeft < 14 ? 'warn' : 'ok' };
      }
    } catch (e) { /* 解析失败则回退到下方估算 */ }
  }

  // 回退：用 pwdLastSet + 配置天数估算（当 AD 未返回构造属性时向后兼容）
  if (passwordNeverExpires) return { text: '永不过期', cls: 'ok' };
  if (!pwdLastSet || pwdLastSet === '0') return { text: '需设置', cls: 'warn' };
  // -1 实为“管理员已重置，用户下次登录须改密”，非永不过期
  if (pwdLastSet === '-1') return { text: '需设置', cls: 'warn' };
  // 密码有效期优先用参数传入的值，其次用全局配置，最后默认 90 天
  const maxAge = maxAgeDays || (typeof window !== 'undefined' && window.pwdMaxAgeDays) || 90;
  if (maxAge <= 0) return { text: '永不过期', cls: 'ok' };
  try {
    const ticks = parseInt(pwdLastSet, 10);
    if (isNaN(ticks) || ticks <= 0) return { text: '需设置', cls: 'warn' };
    const adEpochMs = -11644473600000;
    const setMs = Math.floor(ticks / 10000) + adEpochMs;
    const expiryMs = setMs + maxAge * 24 * 60 * 60 * 1000;
    const now = Date.now();
    if (expiryMs < now) return { text: '已过期', cls: 'bad' };
    const daysLeft = Math.ceil((expiryMs - now) / (24 * 60 * 60 * 1000));
    return { text: daysLeft + '天后到期', cls: daysLeft < 14 ? 'warn' : 'ok' };
  } catch (e) { return { text: '未知', cls: '' }; }
}

// ─── 搜索 ───
async function searchUsers() {
  const queryEl = document.querySelector('#adminQuery');
  const q = queryEl ? queryEl.value.trim() : '';
  const result = document.querySelector('#adminResult');
  const btn = document.querySelector('#adminSearchBtn');
  if (!result) return;

  if (!q) {
    renderEmptyState(result, 'search', '开始搜索', '输入姓名或用户名开始搜索');
    lastSearchResults = [];
    totalUsers = 0;
    return;
  }

  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 搜索中...'; }
  renderSkeletonCards(result, 5);

  try {
    const data = await api('/api/admin/users?q=' + encodeURIComponent(q));
    lastSearchResults = Array.isArray(data) ? data : (data.users || []);
    totalUsers = lastSearchResults.length;
    currentPage = 1;
    renderUserList();
  } catch (err) {
    result.innerHTML = '<div class="empty-state"><p>搜索失败: ' + escHTML(err.message) + '</p></div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '搜索'; }
  }
}

function renderUserList() {
  const result = document.querySelector('#adminResult');
  if (!result) return;

  const start = (currentPage - 1) * pageSize;
  const end = start + pageSize;
  const pageUsers = lastSearchResults.slice(start, end);

  if (pageUsers.length === 0) {
    renderEmptyState(result, 'search', '暂无匹配结果', '请尝试其他搜索关键词');
    return;
  }

  // 卡片网格视图
  let html = '<div class="user-grid">';
  pageUsers.forEach(function (user) {
    const pwdInfo = pwdExpiryInfo(user.pwdLastSet, user.passwordNeverExpires, undefined, user.passwordExpiresAt);
    const acct = user.samAccountName || '';
    const isDisabled = user.enabled === false;
    const dept = user.department || user.dn?.match(/OU=([^,]+)/)?.[1] || '-';
    const name = user.displayName || acct || '-';

    html += '<div class="user-card' + (isDisabled ? ' disabled' : '') + '" onclick="showUserDetail(\'' + escJS(acct) + '\')">';
    html += '<div class="user-card-header">';
    html += '<div class="user-card-avatar" style="background:' + avatarGradient(acct) + '">' + escHTML(acct ? acct[0].toUpperCase() : '?') + '</div>';
    html += '<div class="user-card-info"><div class="user-card-name">' + escHTML(name) + '</div>';
    html += '<div class="user-card-acct">' + escHTML(acct || '-') + '</div></div>';
    html += '<span class="badge ' + (isDisabled ? 'badge-danger' : 'badge-success') + '">' + (isDisabled ? '已禁用' : '正常') + '</span>';
    html += '</div>';
    html += '<div class="user-card-body">';
    html += '<div class="user-card-label">部门</div><div class="user-card-value">' + escHTML(dept) + '</div>';
    html += '<div class="user-card-label">密码</div><div class="user-card-value pwd-' + pwdInfo.cls + '">' + escHTML(pwdInfo.text) + '</div>';
    html += '</div>';
    html += '<div class="user-card-actions" onclick="event.stopPropagation()">';
    html += '<button class="row-btn" title="重置密码" onclick="openResetModal(\'' + escJS(acct) + '\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg></button>';
    html += '<button class="row-btn" title="加入组" onclick="promptAddGroup(\'' + escJS(acct) + '\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg></button>';
    html += '</div>';
    html += '</div>';
  });
  html += '</div>';

  if (totalUsers > pageSize) {
    const totalPages = Math.ceil(totalUsers / pageSize);
    html += '<div class="pagination">';
    html += '<button class="page-btn" onclick="prevPage()" ' + (currentPage === 1 ? 'disabled' : '') + '>';
    html += '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M15 18l-6-6 6-6"/></svg></button>';
    html += '<span class="page-info">' + currentPage + ' / ' + totalPages + ' <small>(' + totalUsers + '条)</small></span>';
    html += '<button class="page-btn" onclick="nextPage()" ' + (currentPage >= totalPages ? 'disabled' : '') + '>';
    html += '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 18l6-6-6-6"/></svg></button>';
    html += '</div>';
  }

  result.innerHTML = html;
}

function prevPage() {
  if (currentPage > 1) { currentPage--; renderUserList(); }
}

function nextPage() {
  const totalPages = Math.ceil(totalUsers / pageSize);
  if (currentPage < totalPages) { currentPage++; renderUserList(); }
}

export { searchUsers, renderUserList, prevPage, nextPage, adTimeToString, pwdExpiryInfo };
