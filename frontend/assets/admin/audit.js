/**
 * Audit 模块 — 审计日志 + 定时任务管理
 */
import { api } from './api.js';
import { showToast, escHTML, escAttr, escJS, renderSkeletonCards, renderEmptyState } from './ui.js';
import { formatTime, relativeTime, fullTimeStr, actionLabel } from './shared.js';

// ─── 审计日志状态 ───
let auditFilterType = 'all';
let auditRefreshTimer = null;
let auditPage = 1;
const auditPageSize = 20;
let auditTotal = 0;
let lastAuditLogs = [];

function setAuditFilter(type) {
  auditFilterType = type;
  document.querySelectorAll('.audit-filter-tab').forEach(function (tab) {
    tab.classList.toggle('active', tab.dataset.filter === type);
  });
  renderLogs();
}

function setAuditRefresh(seconds) {
  if (auditRefreshTimer) { clearInterval(auditRefreshTimer); auditRefreshTimer = null; }
  const statusEl = document.getElementById('auditRefreshStatus');
  if (seconds > 0) {
    auditRefreshTimer = setInterval(loadLogs, seconds * 1000);
    if (statusEl) statusEl.textContent = '每 ' + seconds + 's 刷新';
  } else {
    if (statusEl) statusEl.textContent = '';
  }
}

async function loadLogs() {
  const container = document.getElementById('auditLogs');
  if (!container) return;
  renderSkeletonCards(container, 3);
  try {
    const params = [];
    const af = document.getElementById('auditActionFilter');
    if (af && af.value) params.push('action=' + encodeURIComponent(af.value));
    const actorEl = document.getElementById('auditActorInput');
    if (actorEl && actorEl.value.trim()) params.push('actor=' + encodeURIComponent(actorEl.value.trim()));
    const targetEl = document.getElementById('auditSearch');
    if (targetEl && targetEl.value.trim()) params.push('target=' + encodeURIComponent(targetEl.value.trim()));
    const sd = document.getElementById('auditStartDate');
    const ed = document.getElementById('auditEndDate');
    if (sd && sd.value) params.push('startDate=' + encodeURIComponent(sd.value.replace('T', ' ')));
    if (ed && ed.value) params.push('endDate=' + encodeURIComponent(ed.value.replace('T', ' ')));
    params.push('page=' + auditPage);
    params.push('pageSize=' + auditPageSize);

    const data = await api('/api/admin/audit-logs?' + params.join('&'));
    lastAuditLogs = Array.isArray(data) ? data : (data.logs || []);
    auditTotal = (data && typeof data.total === 'number') ? data.total : lastAuditLogs.length;
    renderLogs();
    renderAuditPagination();
  } catch (err) {
    container.innerHTML = '<div class="error-message">加载日志失败: ' + escHTML(err.message) + '</div>';
  }
}

function resetAuditPage() { auditPage = 1; }
function auditDebouncedLoad() {
  clearTimeout(window._auditDebounce);
  window._auditDebounce = setTimeout(function () { resetAuditPage(); loadLogs(); }, 400);
}

function auditGoPage(n) {
  const totalPages = Math.max(1, Math.ceil(auditTotal / auditPageSize));
  n = Math.max(1, Math.min(n, totalPages));
  if (n === auditPage) return;
  auditPage = n;
  loadLogs();
}

function renderAuditPagination() {
  const el = document.getElementById('auditPagination');
  if (!el) return;
  if (auditTotal === 0) { el.innerHTML = ''; return; }
  const totalPages = Math.max(1, Math.ceil(auditTotal / auditPageSize));
  let html = '';
  html += '<button class="btn btn-ghost btn-sm" onclick="auditGoPage(' + (auditPage - 1) + ')" ' + (auditPage <= 1 ? 'disabled' : '') + '>上一页</button>';
  html += '<span style="font-size:12px;color:var(--text-secondary);">' + auditPage + ' / ' + totalPages + ' 页</span>';
  html += '<button class="btn btn-ghost btn-sm" onclick="auditGoPage(' + (auditPage + 1) + ')" ' + (auditPage >= totalPages ? 'disabled' : '') + '>下一页</button>';
  html += '<span style="font-size:11px;color:var(--text-tertiary);">跳至</span>';
  html += '<input type="number" min="1" max="' + totalPages + '" value="' + auditPage + '" style="width:56px;padding:2px 6px;font-size:12px;border:1px solid var(--border-default);border-radius:6px;" onchange="auditGoPage(parseInt(this.value)||1)"/>';
  html += '<span style="font-size:11px;color:var(--text-tertiary);">页</span>';
  el.innerHTML = html;
}

function renderLogs() {
  const container = document.getElementById('auditLogs');
  if (!container) return;
  const logs = lastAuditLogs.filter(function (log) {
    const isAdminRole = log.role === 'admin' || log.role === 'super_admin' || log.role === 'hr_admin' || log.role === 'helpdesk';
    if (auditFilterType === 'admin' && !isAdminRole) return false;
    if (auditFilterType === 'user' && log.role !== 'user') return false;
    return true;
  });

  if (logs.length > 0) {
    let html = '<div class="log-table"><div class="log-header">' +
      '<span class="log-col-time">时间</span><span class="log-col-action">操作</span>' +
      '<span class="log-col-actor">操作人</span><span class="log-col-detail">详情</span>' +
      '<span class="log-col-status">状态</span><span class="log-col-ip">IP</span></div>';
    html += logs.map(function (log) {
      const detail = log.detail || log.target || '-';
      const statusClass = log.success ? 'log-status-success' : 'log-status-fail';
      const statusText = log.success ? '成功' : (log.errorMsg ? '失败' : '未知');
      return '<div class="log-row' + (!log.success ? ' log-row-fail' : '') + '">' +
        '<span class="log-col-time"><span class="log-time time-relative" title="' + escHTML(fullTimeStr(log.createdAt)) + '">' + escHTML(relativeTime(log.createdAt)) + '</span></span>' +
        '<span class="log-col-action">' + actionTag(log.action) + '</span>' +
        '<span class="log-col-actor">' + escHTML(log.actor || '-') + '</span>' +
        '<span class="log-col-detail" title="' + escAttr(detail) + '">' + escHTML(detail) + '</span>' +
        '<span class="log-col-status"><span class="' + statusClass + '">' + statusText + '</span></span>' +
        '<span class="log-col-ip">' + escHTML(log.remoteAddr || '-') + '</span></div>';
    }).join('');
    html += '</div>';
    container.innerHTML = html;
  } else {
    renderEmptyState(container, 'empty', '暂无审计日志', '操作记录将在此显示');
  }
  const summary = document.getElementById('auditCountSummary');
  if (summary) summary.textContent = '第 ' + auditPage + ' 页，共 ' + auditTotal + ' 条';
}

function actionTag(action) {
  const label = actionLabel(action);
  let color = '#64748b', bg = 'rgba(100,116,139,0.12)';
  if (/delete|offboard/.test(action)) { color = '#dc2626'; bg = 'rgba(220,38,38,0.1)'; }
  else if (/disable|remove_group|cancel/.test(action)) { color = '#ea580c'; bg = 'rgba(234,88,12,0.1)'; }
  else if (/reset.*password|reset_admin/.test(action)) { color = '#d97706'; bg = 'rgba(217,119,6,0.1)'; }
  else if (/create|enable|add_group/.test(action)) { color = '#059669'; bg = 'rgba(5,150,105,0.1)'; }
  else if (/unlock/.test(action)) { color = '#0891b2'; bg = 'rgba(8,145,178,0.1)'; }
  else if (/save_ad|update_user/.test(action)) { color = '#7c3aed'; bg = 'rgba(124,58,237,0.1)'; }
  return '<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;color:' + color + ';background:' + bg + ';">' + escHTML(label) + '</span>';
}

// ─── 定时任务 ───
async function loadTasks() {
  const container = document.getElementById('tasksList');
  const emptyEl = document.getElementById('tasksEmpty');
  if (!container) return;
  renderSkeletonCards(container, 2);
  try {
    const data = await api('/api/admin/scheduled-tasks');
    const tasks = Array.isArray(data) ? data : (data.tasks || []);
    if (tasks.length > 0) {
      const now = new Date();
      container.innerHTML = tasks.map(function (task) {
        const sched = new Date(task.scheduledAt);
        const created = task.createdAt ? new Date(task.createdAt) : null;
        let statusClass = '', statusText = '';
        if (sched <= now) { statusClass = 'overdue'; statusText = '已到期'; }
        else {
          const diffMs = sched - now;
          const diffH = Math.floor(diffMs / 3600000);
          const diffM = Math.floor((diffMs % 3600000) / 60000);
          statusClass = 'pending';
          statusText = diffH > 24 ? (Math.floor(diffH / 24) + '天' + (diffH % 24) + '小时后') : (diffH + '小时' + diffM + '分后');
        }
        const actionLabel2 = task.action === 'disable' ? '定时禁用' : (task.action === 'enable' ? '定时启用' : '定时任务');
        return '<div class="task-card" data-id="' + escJS(task.id) + '">' +
          '<div class="task-card-header"><div class="task-card-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>' +
          '<div class="task-card-main"><div class="task-card-account">' + escHTML(task.account || '-') + '</div>' +
          '<div class="task-card-meta"><span class="task-type-badge">' + actionLabel2 + '</span><span class="task-status ' + statusClass + '">' + statusText + '</span></div></div>' +
          '<button class="btn btn-sm btn-ghost btn-danger-text" onclick="cancelTask(\'' + escJS(task.id) + '\')" title="取消此任务">取消</button></div>' +
          '<div class="task-card-body"><div class="task-detail-item"><span class="task-detail-label">执行时间</span><span class="task-detail-value">' + escHTML(formatTime(task.scheduledAt)) + '</span></div>' +
          (created ? '<div class="task-detail-item"><span class="task-detail-label">创建时间</span><span class="task-detail-value">' + escHTML(formatTime(task.createdAt)) + '</span></div>' : '') + '</div></div>';
      }).join('');
      if (emptyEl) emptyEl.style.display = 'none';
    } else {
      container.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'block';
    }
  } catch (err) {
    container.innerHTML = '<div class="error-message">加载任务失败</div>';
  }
}

async function cancelTask(id) {
  if (!confirm('确定取消该定时任务吗？')) return;
  try {
    await api('/api/admin/scheduled-tasks?id=' + encodeURIComponent(id), { method: 'DELETE' });
    showToast('任务已取消', 'success');
    loadTasks();
  } catch (err) { showToast(err.message, 'danger'); }
}

export { setAuditFilter, setAuditRefresh, loadLogs, resetAuditPage, auditDebouncedLoad, auditGoPage, renderAuditPagination, renderLogs, actionTag, loadTasks, cancelTask };
