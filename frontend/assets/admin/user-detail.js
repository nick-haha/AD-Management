/**
 * User Detail 模块 — 用户详情弹窗 + 操作按钮
 */
import { api } from './api.js';
import { showToast, openDangerConfirm, escHTML, escJS } from './ui.js';
import { adTimeToString, pwdExpiryInfo } from './users.js';
import { formatTime, actionLabel, avatarGradient } from './shared.js';

let currentDetailAccount = '';
function getCurrentDetailAccount() { return currentDetailAccount; }

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

async function showUserDetail(account) {
  try {
    const resp = await api('/api/admin/users/detail?account=' + encodeURIComponent(account));
    const modal = document.getElementById('userDetailModal');
    if (!modal) return;
    const user = resp.user || {};
    const scheduledTasks = resp.scheduledTasks || [];
    const recentLogs = resp.recentLogs || [];
    const acct = user.samAccountName || account;
    currentDetailAccount = acct;

    setText('detailAvatar', acct ? acct[0].toUpperCase() : 'U');
    const detailAv = document.getElementById('detailAvatar');
    if (detailAv) detailAv.style.background = avatarGradient(acct);
    setText('detailDisplayName', user.displayName || acct || '-');
    setText('detailBreadcrumbName', user.displayName || acct || '用户详情');
    setText('detailAccount', user.userPrincipalName || acct || '-');

    const statusEl = document.getElementById('detailStatus');
    if (statusEl) {
      const badges = [];
      if (user.enabled === false) badges.push('<span class="status-badge disabled">已禁用</span>');
      else badges.push('<span class="status-badge active">启用</span>');
      if (user.locked) badges.push('<span class="status-badge locked">已锁定</span>');
      statusEl.innerHTML = badges.join(' ');
    }

    const infoGrid = document.getElementById('detailInfoGrid');
    if (infoGrid) {
      const rows = [
        ['域用户名', user.samAccountName], ['UPN', user.userPrincipalName],
        ['邮箱', user.mail], ['部门', user.department], ['职位', user.title],
        ['电话', user.telephoneNumber], ['描述', user.description], ['DN', user.dn],
        ['最后登录', adTimeToString(user.lastLogon)], ['创建时间', adTimeToString(user.whenCreated)],
        ['密码状态', pwdExpiryInfo(user.pwdLastSet, user.passwordNeverExpires, undefined, user.passwordExpiresAt).text],
      ];
      infoGrid.innerHTML = rows.map(function (r) {
        return '<div class="detail-item"><span class="detail-label">' + escHTML(r[0]) + '</span><span class="detail-value">' + escHTML(r[1] || '-') + '</span></div>';
      }).join('');
    }

    const groupsList = document.getElementById('detailGroupsList');
    if (groupsList) {
      groupsList.innerHTML = '';
      if (user.memberOf && user.memberOf.length > 0) {
        user.memberOf.forEach(function (g) {
          const groupName = g.match(/CN=([^,]+)/);
          const div = document.createElement('div');
          div.className = 'group-tag';
          div.innerHTML = '<span class="group-name">' + escHTML(groupName ? groupName[1] : g) + '</span>';
          div.onclick = function () { window.promptRemoveGroup(account, g); };
          groupsList.appendChild(div);
        });
      } else {
        groupsList.innerHTML = '<div class="empty-hint">无组成员</div>';
      }
    }

    const scheduleList = document.getElementById('detailScheduleList');
    if (scheduleList) {
      if (scheduledTasks.length > 0) {
        scheduleList.innerHTML = scheduledTasks.map(function (t) {
          return '<div class="detail-item"><span class="detail-label">' + escHTML(t.action || '禁用') + '</span><span class="detail-value">' + escHTML(formatTime(t.scheduledAt)) + '</span></div>';
        }).join('');
      } else {
        scheduleList.innerHTML = '<div class="empty-hint">无定时任务</div>';
      }
    }

    const historyList = document.getElementById('detailHistoryList');
    if (historyList) {
      if (recentLogs.length > 0) {
        historyList.innerHTML = recentLogs.map(function (l) {
          return '<div class="detail-item"><span class="detail-label">' + escHTML(formatTime(l.createdAt)) + '</span><span class="detail-value">' + escHTML(actionLabel(l.action)) + ' ' + escHTML(l.detail || '') + '</span></div>';
        }).join('');
      } else {
        historyList.innerHTML = '<div class="empty-hint">无操作记录</div>';
      }
    }

    const actionsEl = document.getElementById('detailActions');
    if (actionsEl) {
      actionsEl.innerHTML = '';
      const btns = [];
      const ICO = {
        unlock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>',
        enable: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>',
        disable: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>',
        key: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"/></svg>',
        group: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>',
        offboard: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 21v-5h6v5"/><path d="M15 12h.01"/></svg>',
        trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      };
      if (user.locked && window.hasPerm('unlock')) btns.push('<button class="btn btn-secondary btn-sm" title="解除账号锁定状态" onclick="doUnlock(\'' + escJS(acct) + '\')">' + ICO.unlock + ' 解锁</button>');
      if (user.enabled === false) {
        if (window.hasPerm('disable')) btns.push('<button class="btn btn-primary btn-sm" title="启用此域账号" onclick="doEnable(\'' + escJS(acct) + '\')">' + ICO.enable + ' 启用</button>');
      } else {
        if (window.hasPerm('disable')) btns.push('<button class="btn btn-warning btn-sm" title="禁用此域账号，阻止登录" onclick="doDisable(\'' + escJS(acct) + '\')">' + ICO.disable + ' 禁用</button>');
      }
      if (window.hasPerm('resetPwd')) btns.push('<button class="btn btn-secondary btn-sm" title="重置用户密码，首次登录需修改" onclick="openResetModal(\'' + escJS(acct) + '\')">' + ICO.key + ' 重置密码</button>');
      if (window.hasPerm('addGroup')) btns.push('<button class="btn btn-secondary btn-sm" title="将用户加入指定组" onclick="promptAddGroup(\'' + escJS(acct) + '\')">' + ICO.group + ' 加入组</button>');
      if (window.hasPerm('offboard')) btns.push('<button class="btn btn-danger btn-sm" title="禁用账号并移至离职 OU，清理组关系" onclick="doOffboard(\'' + escJS(acct) + '\')">' + ICO.offboard + ' 离职</button>');
      if (window.hasPerm('delete')) btns.push('<button class="btn btn-danger btn-sm" title="永久删除此账号，不可恢复" onclick="doDeleteUser(\'' + escJS(acct) + '\')">' + ICO.trash + ' 删除账号</button>');
      actionsEl.innerHTML = btns.join('') || '<div style="color: var(--text-tertiary); font-size: 12px; padding: 8px 0;">当前角色无操作权限</div>';
    }

    const timeInput = document.getElementById('detailScheduleTime');
    if (timeInput) {
      const now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      timeInput.min = now.toISOString().slice(0, 16);
      timeInput.value = '';
    }
    modal.classList.add('active');
  } catch (err) {
    showToast('获取用户详情失败: ' + err.message, 'danger');
  }
}

function closeUserDetail() {
  const modal = document.getElementById('userDetailModal');
  if (modal) modal.classList.remove('active');
}

async function doUnlock(account) {
  try {
    await api('/api/admin/users/unlock', { method: 'POST', body: JSON.stringify({ account }) });
    showToast('已解锁', 'success');
    showUserDetail(account);
  } catch (err) { showToast(err.message, 'danger'); }
}

async function doEnable(account) {
  try {
    await api('/api/admin/users/enable', { method: 'POST', body: JSON.stringify({ account }) });
    showToast('已启用', 'success');
    showUserDetail(account);
  } catch (err) { showToast(err.message, 'danger'); }
}

async function doDisable(account) {
  openDangerConfirm({
    title: '禁用账号', desc: '即将在 AD 中禁用此账号', target: account,
    warning: '禁用后用户将无法登录，但账号仍保留可随时启用。', confirmText: '确认禁用',
    onConfirm: async function () {
      try {
        await api('/api/admin/users/disable', { method: 'POST', body: JSON.stringify({ account }) });
        showToast('已禁用', 'success');
        showUserDetail(account);
      } catch (err) { showToast(err.message, 'danger'); }
    },
  });
}

async function doOffboard(account) {
  openDangerConfirm({
    title: '离职处理', desc: '即将禁用账号并移动到离职 OU', target: account,
    warning: '离职处理后账号将被禁用并移出原部门，组关系也会清理。', confirmText: '确认离职处理',
    onConfirm: async function () {
      try {
        await api('/api/admin/users/offboard', { method: 'POST', body: JSON.stringify({ account, targetOU: '' }) });
        showToast('离职处理完成', 'success');
        closeUserDetail();
        window.searchUsers();
      } catch (err) { showToast(err.message, 'danger'); }
    },
  });
}

async function doDeleteUser(account) {
  openDangerConfirm({
    title: '删除账号', desc: '即将从 AD 中永久删除此账号', target: account,
    warning: '此操作不可逆！删除后账号将无法恢复，所有数据将丢失。', confirmText: '确认删除',
    onConfirm: async function () {
      try {
        await api('/api/admin/users?account=' + encodeURIComponent(account), { method: 'DELETE' });
        showToast('已删除', 'success');
        closeUserDetail();
        window.searchUsers();
      } catch (err) { showToast(err.message, 'danger'); }
    },
  });
}

export { showUserDetail, closeUserDetail, doUnlock, doEnable, doDisable, doOffboard, doDeleteUser, setText, getCurrentDetailAccount };
