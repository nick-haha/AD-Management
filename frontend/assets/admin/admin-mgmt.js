/**
 * Admin Management 模块 — 管理员管理 + 权限勾选
 */
import { api, USERNAME_KEY } from './api.js';
import { showToast, openDangerConfirm, escHTML, escJS, renderSkeletonCards } from './ui.js';
import { ALL_PERMS, ROLE_PERMS, hasPerm } from './state.js';
import { avatarGradient } from './shared.js';

const ROLE_LABELS = { super_admin: '超级管理员', hr_admin: 'HR管理员', helpdesk: '服务台', custom: '自定义' };

function openAdminMgmtModal() {
  const modal = document.getElementById('adminMgmtModal');
  if (!modal) return;
  modal.classList.add('active');
  loadAdmins();
  resetCreateAdminForm();
}

function closeAdminMgmtModal() {
  const modal = document.getElementById('adminMgmtModal');
  if (modal) modal.classList.remove('active');
}

function resetCreateAdminForm() {
  const form = document.getElementById('createAdminForm');
  if (form) form.reset();
  const roleSelect = form ? form.querySelector('[name="role"]') : null;
  if (roleSelect) roleSelect.value = 'helpdesk';
  renderPermCheckboxes('createPermsList', ROLE_PERMS.helpdesk);
  applyPresetPerms('helpdesk');
}

function applyPresetPerms(role) {
  const preset = ROLE_PERMS[role] || [];
  document.querySelectorAll('.perm-checkbox').forEach(function (cb) {
    cb.checked = preset.indexOf(cb.value) >= 0;
  });
  document.querySelectorAll('.perm-option').forEach(function (label) {
    const cb = label.querySelector('.perm-checkbox');
    if (cb) label.classList.toggle('checked', cb.checked);
  });
}

function renderPermCheckboxes(containerId, checked) {
  const container = document.getElementById(containerId);
  if (!container) return;
  checked = checked || [];
  let html = '';
  ALL_PERMS.forEach(function (p) {
    const isOn = checked.indexOf(p.key) >= 0;
    html += '<label class="perm-option' + (isOn ? ' checked' : '') + '">';
    html += '<input type="checkbox" class="perm-checkbox" value="' + p.key + '"' + (isOn ? ' checked' : '') + ' onchange="togglePermLabel(this)" />';
    html += '<span class="perm-name">' + escHTML(p.label) + '</span>';
    html += '<span class="perm-desc">' + escHTML(p.desc) + '</span>';
    html += '</label>';
  });
  container.innerHTML = html;
}

function togglePermLabel(cb) {
  const label = cb.closest('.perm-option');
  if (label) label.classList.toggle('checked', cb.checked);
  const roleSelect = document.querySelector('#createAdminForm [name="role"]');
  if (roleSelect && roleSelect.value !== 'custom') {
    const current = [];
    document.querySelectorAll('.perm-checkbox:checked').forEach(function (c) { current.push(c.value); });
    let matched = false;
    Object.keys(ROLE_PERMS).forEach(function (r) {
      const preset = ROLE_PERMS[r].slice().sort();
      const cur = current.slice().sort();
      if (JSON.stringify(preset) === JSON.stringify(cur)) { roleSelect.value = r; matched = true; }
    });
    if (!matched) roleSelect.value = 'custom';
  }
}

async function loadAdmins() {
  const container = document.getElementById('adminsList');
  if (!container) return;
  renderSkeletonCards(container, 2);
  try {
    const data = await api('/api/admin/admins');
    const admins = Array.isArray(data) ? data : (data.admins || []);
    if (admins.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>暂无管理员</p></div>';
      return;
    }
    let html = '<div class="admin-list">';
    admins.forEach(function (a) {
      const isSelf = a.username === localStorage.getItem(USERNAME_KEY);
      const effectivePerms = (a.permissions && a.permissions.length > 0) ? a.permissions : (ROLE_PERMS[a.role] || []);
      const roleLabel = (a.permissions && a.permissions.length > 0 && a.role === 'custom') ? '自定义' : (ROLE_LABELS[a.role] || a.role);
      const roleClass = a.role === 'super_admin' ? 'badge-super' : (a.role === 'hr_admin' ? 'badge-hr' : (a.role === 'helpdesk' ? 'badge-helpdesk' : 'badge-custom'));
      html += '<div class="admin-row' + (isSelf ? ' admin-row-self' : '') + '">';
      html += '<div class="admin-row-avatar" style="background:' + avatarGradient(a.username) + '">' + escHTML((a.username[0] || 'A').toUpperCase()) + '</div>';
      html += '<div class="admin-row-info"><div class="admin-row-name">' + escHTML(a.username) + (isSelf ? ' <span class="admin-self-tag">你</span>' : '') + '</div>';
      html += '<div class="admin-row-sub">ID #' + (a.id || '-') + ' · ' + effectivePerms.length + ' 项权限</div></div>';
      html += '<span class="admin-role-badge ' + roleClass + '">' + escHTML(roleLabel) + '</span>';
      html += '<div class="admin-row-actions">';
      if (hasPerm('adminMgmt')) {
        html += '<button class="btn btn-secondary btn-sm" onclick="editAdminPerms(\'' + escJS(a.username) + '\')">权限</button>';
        if (!isSelf) {
          html += '<button class="btn btn-secondary btn-sm" onclick="resetAdminPwd(\'' + escJS(a.username) + '\')">重置密码</button>';
          html += '<button class="btn btn-danger btn-sm" onclick="deleteAdmin(\'' + escJS(a.username) + '\')">删除</button>';
        } else {
          html += '<span class="admin-row-hint">当前账号</span>';
        }
      }
      html += '</div></div>';
    });
    html += '</div>';
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = '<div class="error-message">加载管理员列表失败: ' + escHTML(err.message) + '</div>';
  }
}

async function createAdmin(form) {
  const v = Object.fromEntries(new FormData(form));
  if (!v.username || !v.password || v.password.length < 8) {
    showToast('用户名必填，密码至少8位', 'warning');
    return;
  }
  const perms = [];
  document.querySelectorAll('#createAdminForm .perm-checkbox:checked').forEach(function (cb) { perms.push(cb.value); });
  const role = v.role || 'helpdesk';
  const body = { username: v.username, password: v.password, role: role };
  const preset = ROLE_PERMS[role] || [];
  if (perms.slice().sort().join(',') !== preset.slice().sort().join(',')) body.permissions = perms;
  try {
    await api('/api/admin/admins', { method: 'POST', body: JSON.stringify(body) });
    showToast('管理员已创建', 'success');
    resetCreateAdminForm();
    loadAdmins();
  } catch (err) { showToast(err.message, 'danger'); }
}

function editAdminPerms(username) {
  api('/api/admin/admins').then(function (data) {
    const admins = Array.isArray(data) ? data : (data.admins || []);
    const target = admins.find(function (a) { return a.username === username; });
    const currentPerms = target ? ((target.permissions && target.permissions.length > 0) ? target.permissions : (ROLE_PERMS[target.role] || [])) : [];
    const modal = document.getElementById('editPermsModal');
    if (!modal) return;
    const titleEl = modal.querySelector('#editPermsTitle');
    if (titleEl) titleEl.textContent = '编辑权限 · ' + username;
    modal.setAttribute('data-username', username);
    renderPermCheckboxes('editPermsList', currentPerms);
    modal.classList.add('active');
  }).catch(function (err) { showToast(err.message, 'danger'); });
}

function closeEditPermsModal() {
  const modal = document.getElementById('editPermsModal');
  if (modal) modal.classList.remove('active');
}

async function saveAdminPerms() {
  const modal = document.getElementById('editPermsModal');
  if (!modal) return;
  const username = modal.getAttribute('data-username');
  const perms = [];
  document.querySelectorAll('#editPermsList .perm-checkbox:checked').forEach(function (cb) { perms.push(cb.value); });
  if (perms.indexOf('adminMgmt') < 0 && username === localStorage.getItem(USERNAME_KEY)) {
    showToast('不能移除自己的管理员管理权限', 'warning');
    return;
  }
  try {
    await api('/api/admin/admins/permissions', { method: 'PUT', body: JSON.stringify({ username, permissions: perms }) });
    showToast('权限已更新', 'success');
    closeEditPermsModal();
    loadAdmins();
  } catch (err) { showToast(err.message, 'danger'); }
}

async function deleteAdmin(username) {
  openDangerConfirm({
    title: '删除管理员', desc: '即将删除管理员账号', target: username,
    warning: '此操作不可逆，删除后该管理员将无法登录。', confirmText: '确认删除',
    onConfirm: async function () {
      try {
        await api('/api/admin/admins?username=' + encodeURIComponent(username), { method: 'DELETE' });
        showToast('管理员已删除', 'success');
        loadAdmins();
      } catch (err) { showToast(err.message, 'danger'); }
    },
  });
}

async function resetAdminPwd(username) {
  const np = prompt('为 ' + username + ' 设置新密码（至少8位）：');
  if (!np) return;
  if (np.length < 8) { showToast('密码至少8位', 'warning'); return; }
  try {
    await api('/api/admin/admins/reset-password', { method: 'POST', body: JSON.stringify({ username, newPassword: np }) });
    showToast('管理员密码已重置', 'success');
  } catch (err) { showToast(err.message, 'danger'); }
}

export {
  openAdminMgmtModal, closeAdminMgmtModal, resetCreateAdminForm,
  applyPresetPerms, renderPermCheckboxes, togglePermLabel,
  loadAdmins, createAdmin, editAdminPerms, closeEditPermsModal,
  saveAdminPerms, deleteAdmin, resetAdminPwd,
};
