/**
 * App 入口 — 初始化 + 事件绑定 + 登录/会话 + 重置密码/加组/离职
 */
import { api, getToken, clearAuth, onAuthExpired, TOKEN_KEY, USERNAME_KEY, ROLE_KEY, PERMS_KEY } from './api.js';
import { showToast, openModal, closeModal, applyTheme, initTheme, cycleTheme, openDangerConfirm, closeDangerConfirm, escHTML, escAttr, escJS, html, raw, capitalize, validateField, clearFieldError } from './ui.js';
import { searchUsers, prevPage, nextPage } from './users.js';
import { showUserDetail, closeUserDetail, doUnlock, doEnable, doDisable, doOffboard, doDeleteUser, getCurrentDetailAccount } from './user-detail.js';
import { loadADSettings, saveWizardSettings, collectADFormData, collectFeishuFormData, startConnCheck, loadFeishuSettings, saveFeishuSettings, loadOptions, showSetupWizard, hideSetupWizard, fillOptionalDefaults, fillBaseDefaults } from './settings.js';
import { loadLogs, loadTasks, cancelTask, auditGoPage, resetAuditPage, setAuditFilter, setAuditRefresh, auditDebouncedLoad } from './audit.js';
import { openAdminMgmtModal, closeAdminMgmtModal, resetCreateAdminForm, applyPresetPerms, renderPermCheckboxes, togglePermLabel, loadAdmins, createAdmin, editAdminPerms, closeEditPermsModal, saveAdminPerms, deleteAdmin, resetAdminPwd } from './admin-mgmt.js';
import { hasPerm, applyRoleUI, setMyRole, setMyPerms } from './state.js';
import { genRandomPassword, passwordStrength, avatarGradient } from './shared.js';

// ─── 状态 ───
let resetTarget = '';
let resetPwdCountdownTimer = null;
let resetPwdCountdownSec = 0;
let resetPwdMustChangeVal = true;

function resetCreateForm() { const f = document.getElementById('createForm'); if (f) f.reset(); }
async function loadOffboardDefaults() {}

// 密码强度条更新
function updatePwdStrength(input) {
  if (!input) return;
  const pwd = input.value;
  const st = passwordStrength(pwd);
  let bar = input.parentElement?.parentElement?.querySelector('.pwd-strength');
  if (!bar && pwd) {
    bar = document.createElement('div');
    bar.className = 'pwd-strength';
    bar.innerHTML = '<div class="pwd-strength-bar"><div class="pwd-strength-seg"></div><div class="pwd-strength-seg"></div><div class="pwd-strength-seg"></div><div class="pwd-strength-seg"></div></div><span class="pwd-strength-label"></span>';
    input.parentElement?.parentElement?.appendChild(bar);
  }
  if (bar) {
    const segs = bar.querySelectorAll('.pwd-strength-seg');
    const label = bar.querySelector('.pwd-strength-label');
    segs.forEach((s, i) => { s.classList.toggle('active', i < st.score); s.style.background = i < st.score ? st.color : ''; });
    if (label) { label.textContent = st.label; label.style.color = st.color; }
    bar.style.display = pwd ? 'flex' : 'none';
  }
}

// ─── 显示/隐藏 ───
async function showAdmin() {
  document.body.classList.remove('locked');
  document.querySelector('#loginPage')?.classList.add('hidden');
  document.querySelector('#adminApp')?.classList.remove('hidden');
  initTheme();
  try {
    const settings = await loadADSettings();
    if (!settings?.host?.trim()) showSetupWizard();
    loadOptions(); startConnCheck(); loadFeishuSettings();
  } catch (e) { showSetupWizard(); }
}

function hideAdmin() {
  clearAuth(); setMyRole(''); setMyPerms([]);
  document.body.classList.add('locked');
  document.querySelector('#loginPage')?.classList.remove('hidden');
  document.querySelector('#adminApp')?.classList.add('hidden');
  closeModal();
}
onAuthExpired(hideAdmin);

// ─── Tab 导航 ───
async function switchTab(id) {
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  document.querySelector('.sidebar-item[data-tab="' + id + '"]')?.classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('#' + id)?.classList.add('active');
  if (id === 'overview') { document.querySelector('#adminResult').innerHTML = ''; setTimeout(searchUsers, 50); }
  else if (id === 'create') { resetCreateForm(); await loadOptions(); }
  else if (id === 'logs') await loadLogs();
  else if (id === 'tasks') await loadTasks();
  else if (id === 'settings') { await loadADSettings(); loadFeishuSettings(); }
}

// ─── 会话恢复 ───
async function tryRestoreSession() {
  const token = getToken();
  if (!token) return;
  try {
    const settings = await api('/api/admin/ad-settings');
    try {
      const me = await api('/api/admin/me');
      if (me?.role) { setMyRole(me.role); localStorage.setItem(ROLE_KEY, me.role); }
      if (me?.permissions) { setMyPerms(me.permissions); localStorage.setItem(PERMS_KEY, JSON.stringify(me.permissions)); }
      // 更新角色 badge
      const roleLabels = { super_admin: '超级管理员', hr_admin: 'HR管理员', helpdesk: '服务台', custom: '自定义' };
      const badge = document.querySelector('#adminRoleBadge');
      if (badge) badge.textContent = roleLabels[me?.role] || me?.role || '管理员';
    } catch (e) {}
    document.querySelector('#loginPage')?.classList.add('hidden');
    document.querySelector('#adminApp')?.classList.remove('hidden');
    initTheme(); applyRoleUI();
    const savedName = localStorage.getItem(USERNAME_KEY) || 'admin';
    const dn = document.querySelector('#dropdownName'); if (dn) dn.textContent = savedName;
    const av = document.querySelector('#adminAvatar'); if (av) { av.textContent = savedName[0].toUpperCase(); av.style.background = avatarGradient(savedName); }
    if (!settings?.host?.trim()) showSetupWizard();
    loadOptions(); startConnCheck();
  } catch (err) { clearAuth(); }
}

// ─── 重置密码 ───
async function openResetModal(account) {
  resetTarget = account;
  const t = document.querySelector('#resetPwdTarget'); if (t) t.textContent = '用户：' + account;
  const i = document.querySelector('#resetPwdInput'); if (i) i.value = '';
  const m = document.querySelector('#resetPwdMustChange'); if (m) m.checked = true;
  const r = document.querySelector('#resetPwdResult'); if (r) r.style.display = 'none';
  document.querySelector('#resetPwdModal')?.classList.add('active');
}

function closeResetPwdModal() {
  if (resetPwdCountdownTimer) { clearInterval(resetPwdCountdownTimer); resetPwdCountdownTimer = null; }
  document.querySelector('#resetPwdModal')?.classList.remove('active');
  setTimeout(() => {
    document.querySelector('#resetPwdInput').value = '';
    document.querySelector('#resetPwdResult').style.display = 'none';
    const btn = document.querySelector('#resetPwdConfirm'); if (btn?.parentElement) btn.parentElement.style.display = '';
  }, 300);
}

function showResetPwdResult(password) {
  const f = document.querySelector('#resetPwdFinal'); if (f) { f.textContent = password; f.style.color = 'var(--success-600)'; }
  document.querySelector('#resetPwdResultActions').style.display = 'flex';
  document.querySelector('#resetPwdExpiredActions').style.display = 'none';
  document.querySelector('#resetPwdResult').style.display = 'block';
  const copyBtn = document.querySelector('#resetPwdCopy');
  if (copyBtn) copyBtn.onclick = () => navigator.clipboard.writeText(password).then(() => showToast('密码已复制', 'success')).catch(() => showToast('复制失败，请手动复制', 'warning'));
  resetPwdCountdownSec = 60;
  const update = () => { const el = document.querySelector('#resetPwdCountdown'); if (el) { el.textContent = '密码将在 ' + resetPwdCountdownSec + ' 秒后隐藏'; el.style.color = resetPwdCountdownSec <= 10 ? 'var(--danger-600)' : 'var(--warning-600)'; } };
  update();
  resetPwdCountdownTimer = setInterval(() => { resetPwdCountdownSec--; if (resetPwdCountdownSec <= 0) { clearInterval(resetPwdCountdownTimer); resetPwdCountdownTimer = null; const f2 = document.querySelector('#resetPwdFinal'); if (f2) { f2.textContent = '••••••••'; f2.style.color = 'var(--text-tertiary)'; } document.querySelector('#resetPwdResultActions').style.display = 'none'; document.querySelector('#resetPwdExpiredActions').style.display = 'flex'; } else update(); }, 1000);
}

// ─── 加组/移组 ───
function promptAddGroup(account) {
  api('/api/admin/groups').then(resp => {
    const list = Array.isArray(resp) ? resp : (resp.groups || []);
    if (!list.length) { showToast('没有可用的组', 'warning'); return; }
    list.sort((a, b) => (a.label || a.name || '').localeCompare(b.label || b.name || ''));
    let html = '<div class="modal active" id="grpModal"><div class="modal-content" style="max-width:500px"><div class="modal-header"><h3>加入组</h3></div><div class="modal-body"><p class="form-hint">为 ' + escHTML(account) + ' 选择要加入的组</p><input id="grpSearch" placeholder="搜索组..." class="form-input" style="width:100%;margin-bottom:12px" oninput="filterGroupList(this.value)"/><div id="grpList" style="max-height:280px;overflow-y:auto">';
    list.forEach(g => { const name = g.label || g.name || g.value; const desc = g.description ? '<span class="group-desc" style="color:var(--text-tertiary);font-size:11px;margin-left:6px;">' + escHTML(g.description) + '</span>' : ''; html += '<label class="group-option"><input type="checkbox" class="grp-cb" value="' + escAttr(g.value || g.dn) + '"/><span class="group-name">' + escHTML(name) + '</span>' + desc + '</label>'; });
    html += '</div></div><div class="modal-footer"><button class="btn btn-secondary" onclick="document.getElementById(\'grpModal\').remove()">取消</button><button class="btn btn-primary" onclick="doAddGroups(\'' + escJS(account) + '\')">确定加入</button></div></div></div>';
    const div = document.createElement('div'); div.innerHTML = html; document.body.appendChild(div);
  }).catch(err => showToast(err.message, 'danger'));
}

function filterGroupList(q) {
  const lq = q.toLowerCase();
  document.querySelectorAll('#grpList label').forEach(el => { const n = el.querySelector('.group-name'); el.style.display = (!q || n?.textContent.toLowerCase().includes(lq)) ? 'flex' : 'none'; });
}

async function doAddGroups(account) {
  const cbs = document.querySelectorAll('.grp-cb:checked');
  if (!cbs.length) { showToast('请至少选择一个组', 'warning'); return; }
  try { for (const cb of cbs) await api('/api/admin/users/add-group', { method: 'POST', body: JSON.stringify({ account, groupDN: cb.value }) }); showToast('已加入 ' + cbs.length + ' 个组', 'success'); document.getElementById('grpModal')?.remove(); searchUsers(); }
  catch (err) { showToast(err.message, 'danger'); }
}

function promptRemoveGroup(account, groupDN) {
  const gn = groupDN.match(/CN=([^,]+)/); const dn = gn ? gn[1] : groupDN;
  if (confirm('确定要将 ' + account + ' 从组 ' + dn + ' 中移除吗？')) {
    api('/api/admin/users/remove-group', { method: 'POST', body: JSON.stringify({ account, groupDN }) }).then(() => { showToast('已从组中移除', 'success'); showUserDetail(account); }).catch(err => showToast(err.message, 'danger'));
  }
}

// ─── 暴露到 window（兼容 HTML 内联 onclick）───
Object.assign(window, {
  // API/State
  hasPerm, applyRoleUI, searchUsers, prevPage, nextPage,
  showUserDetail, closeUserDetail, doUnlock, doEnable, doDisable, doOffboard, doDeleteUser,
  loadADSettings, saveWizardSettings, collectADFormData, loadFeishuSettings, saveFeishuSettings, loadOptions,
  showSetupWizard, hideSetupWizard, fillBaseDefaults, fillOptionalDefaults, startConnCheck,
  loadLogs, loadTasks, cancelTask, auditGoPage, resetAuditPage, setAuditFilter, setAuditRefresh, auditDebouncedLoad,
  openAdminMgmtModal, closeAdminMgmtModal, resetCreateAdminForm, applyPresetPerms, renderPermCheckboxes, togglePermLabel,
  loadAdmins, createAdmin, editAdminPerms, closeEditPermsModal, saveAdminPerms, deleteAdmin, resetAdminPwd,
  openResetModal, closeResetPwdModal, showResetPwdResult,
  promptAddGroup, filterGroupList, doAddGroups, promptRemoveGroup,
  showToast, openModal, closeModal, openDangerConfirm, closeDangerConfirm,
  applyTheme, initTheme, cycleTheme, genRandomPassword, escHTML, escAttr, escJS, html, raw,
  switchTab, showAdmin, hideAdmin, tryRestoreSession, resetCreateForm,
});

// ─── 初始化 ───
function initDOMListeners() {
  // 向导
  const wizardForm = document.getElementById('wizardForm');
  const wizardSaveBtn = document.getElementById('wizardSaveBtn');
  const wizardTestBtn = document.getElementById('wizardTestBtn');
  const wizardSkipBtn = document.getElementById('wizardSkipBtn');
  const wizardStatus = document.getElementById('wizardStatus');

  function checkWizardValid() {
    const fields = ['host','port','domainName','baseDN','bindUsername','bindPassword','ouScope','groupScope'];
    let valid = true;
    fields.forEach(n => { const el = document.querySelector('#wizardForm input[name="'+n+'"]'); if (!el?.value.trim()) valid = false; });
    if (wizardSaveBtn) wizardSaveBtn.disabled = !valid;
    return valid;
  }

  if (wizardForm) {
    wizardForm.querySelectorAll('input[required]').forEach(i => i.addEventListener('input', checkWizardValid));
    wizardForm.addEventListener('submit', async e => { e.preventDefault(); await saveWizardSettings(); });
  }
  if (wizardTestBtn) {
    wizardTestBtn.addEventListener('click', async () => {
      if (!checkWizardValid()) { showToast('请先填写所有必填项', 'warning'); return; }
      wizardTestBtn.disabled = true; wizardTestBtn.innerHTML = '<span class="spinner"></span> 测试中...';
      try {
        const data = collectADFormData(wizardForm);
        const result = await api('/api/admin/ad-settings/test', { method:'POST', body: JSON.stringify(data) });
        if (result.status === 'connected') { if (wizardStatus) wizardStatus.innerHTML = '<span style="color:var(--success-600)">✓ 连接成功</span>'; wizardTestBtn.innerHTML = '✓ 连接成功'; showToast('连接测试成功', 'success'); }
        else { if (wizardStatus) wizardStatus.innerHTML = '<span style="color:var(--danger-600)">✕ 失败</span>'; wizardTestBtn.innerHTML = '测试连接'; wizardTestBtn.disabled = false; }
      } catch (err) { if (wizardStatus) wizardStatus.innerHTML = '<span style="color:var(--danger-600)">✕ ' + escHTML(err.message) + '</span>'; wizardTestBtn.innerHTML = '测试连接'; wizardTestBtn.disabled = false; }
    });
  }
  if (wizardSkipBtn) wizardSkipBtn.addEventListener('click', () => { hideSetupWizard(); showToast('可稍后在设置中配置', 'info'); });

  // 域名→Base DN
  const wizDomain = document.getElementById('wizDomain');
  const wizBaseDN = document.getElementById('wizBaseDN');
  if (wizDomain && wizBaseDN) {
    wizDomain.addEventListener('input', function() {
      const d = this.value.trim();
      if (d) { const parts = d.split('.'); wizBaseDN.value = parts.map(p => 'DC='+p).join(','); const u = document.getElementById('wizUPNSuffix'); if (u && !u.dataset.touched) u.value = d; const n = document.getElementById('wizNetBIOS'); if (n && !n.dataset.touched) n.value = parts[0]?.toUpperCase() || ''; }
      else wizBaseDN.value = '';
    });
  }
  const settingsDomain = document.getElementById('settingsDomain');
  if (settingsDomain) {
    settingsDomain.addEventListener('input', function() {
      const d = this.value.trim();
      if (d) { const parts = d.split('.'); const u = document.getElementById('settingsUPNSuffix'); if (u && !u.dataset.touched) u.value = d; const n = document.getElementById('settingsNetBIOS'); if (n && !n.dataset.touched) n.value = parts[0]?.toUpperCase() || ''; }
    });
  }
  ['wizUPNSuffix','wizNetBIOS','settingsUPNSuffix','settingsNetBIOS'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('input', function() { this.dataset.touched = '1'; }); });

  // 侧边栏：事件委托（只需绑定一次，避免重复触发）
  document.querySelector('#sidebarNav')?.addEventListener('click', e => { const item = e.target.closest('.sidebar-item'); if (item?.dataset.tab) switchTab(item.dataset.tab); });

  // 侧边栏折叠
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');
  if (sidebar && localStorage.getItem('ad_sidebar_collapsed') === '1') sidebar.classList.add('collapsed');
  sidebarToggle?.addEventListener('click', e => {
    e.stopPropagation();
    sidebar?.classList.toggle('collapsed');
    localStorage.setItem('ad_sidebar_collapsed', sidebar?.classList.contains('collapsed') ? '1' : '0');
  });

  // 主题
  document.querySelector('#themeToggle')?.addEventListener('click', e => { e.stopPropagation(); cycleTheme(); });
  document.querySelectorAll('.theme-btn').forEach(btn => btn.addEventListener('click', function(e) { e.stopPropagation(); document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active')); this.classList.add('active'); applyTheme(this.dataset.theme); }));
  document.getElementById('sidebarBrand')?.addEventListener('click', () => switchTab('overview'));

  // 详情弹窗 tab
  document.querySelector('.detail-tabs')?.addEventListener('click', function(e) {
    const tab = e.target.closest('.detail-tab'); if (!tab?.dataset.tab) return;
    this.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active')); tab.classList.add('active');
    const modal = document.getElementById('userDetailModal');
    modal?.querySelectorAll('.detail-tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('detailTab' + capitalize(tab.dataset.tab))?.classList.add('active');
  });

  // 头像下拉
  document.querySelector('#adminAvatar')?.addEventListener('click', e => { e.stopPropagation(); document.querySelector('#adminDropdown')?.classList.toggle('open'); });
  document.addEventListener('click', () => document.querySelector('#adminDropdown')?.classList.remove('open'));
  document.querySelectorAll('.dropdown-item[data-action]').forEach(btn => btn.addEventListener('click', function() {
    document.querySelector('#adminDropdown')?.classList.remove('open');
    const a = this.dataset.action;
    if (a === 'logout') { hideAdmin(); showToast('已退出登录'); }
    else if (a === 'settings') switchTab('settings');
    else if (a === 'feishuSettings') { switchTab('settings'); setTimeout(() => document.querySelector('#feishuSettingsForm')?.closest('.admin-card')?.scrollIntoView({ behavior:'smooth' }), 200); }
    else if (a === 'changePassword') openModal('changePwdModal');
    else if (a === 'adminMgmt') openAdminMgmtModal();
  }));

  // 修改密码
  document.querySelector('#changePwdCancel')?.addEventListener('click', closeModal);
  document.querySelector('#changePwdForm')?.addEventListener('submit', async function(e) {
    e.preventDefault(); const v = Object.fromEntries(new FormData(this));
    if (v.newPassword !== v.confirmPassword) { showToast('两次密码不一致', 'warning'); return; }
    try { await api('/api/admin/me/password', { method:'PUT', body: JSON.stringify({ oldPassword: v.oldPassword, newPassword: v.newPassword }) }); showToast('密码已修改', 'success'); closeModal(); this.reset(); }
    catch (err) { showToast(err.message, 'danger'); }
  });

  // 登录
  document.querySelector('#loginForm')?.addEventListener('submit', async function(e) {
    e.preventDefault(); const v = Object.fromEntries(new FormData(this));
    const btn = this.querySelector('button[type="submit"]'); const orig = btn?.innerHTML || '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 登录中...'; }
    try {
      const res = await fetch((window.API_BASE||'') + '/api/admin/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(v) });
      const d = await res.json();
      if (!res.ok) { let msg = d.error || '登录失败'; if (msg === 'invalid_credentials') msg = '用户名或密码错误'; else if (d.detail) msg = d.detail; throw new Error(msg); }
      localStorage.setItem(TOKEN_KEY, d.token); localStorage.setItem(USERNAME_KEY, d.username);
      if (d.role) { setMyRole(d.role); localStorage.setItem(ROLE_KEY, d.role); }
      if (d.permissions) { setMyPerms(d.permissions); localStorage.setItem(PERMS_KEY, JSON.stringify(d.permissions)); }
      const roleLabels = { super_admin: '超级管理员', hr_admin: 'HR管理员', helpdesk: '服务台', custom: '自定义' };
      const badge = document.querySelector('#adminRoleBadge');
      if (badge) badge.textContent = roleLabels[d.role] || d.role || '管理员';
      const dn = document.querySelector('#dropdownName'); if (dn) dn.textContent = d.username;
      const av = document.querySelector('#adminAvatar'); if (av) { av.textContent = d.username[0].toUpperCase(); av.style.background = avatarGradient(d.username); }
      applyRoleUI(); await showAdmin(); showToast('欢迎，' + d.username, 'success');
    } catch (err) { showToast(err.message, 'danger'); }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = orig; } }
  });

  // 搜索
  document.querySelector('#adminSearchBtn')?.addEventListener('click', searchUsers);
  document.querySelector('#adminQuery')?.addEventListener('keypress', e => { if (e.key === 'Enter') searchUsers(); });

  // 模态框关闭
  document.querySelectorAll('.modal-close').forEach(el => el.addEventListener('click', closeModal));

  // AD 设置
  document.getElementById('adSettingsForm')?.addEventListener('submit', async function(e) {
    e.preventDefault(); const data = collectADFormData(this);
    const btn = this.querySelector('button[type="submit"]'); const orig = btn?.innerHTML || '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 保存中...'; }
    try { await api('/api/admin/ad-settings', { method:'PUT', body: JSON.stringify(data) }); showToast('域控配置已保存', 'success'); await loadADSettings(); }
    catch (err) { showToast('保存失败: ' + err.message, 'danger'); }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = orig; } }
  });
  document.getElementById('testADSettings')?.addEventListener('click', async function() {
    const form = document.getElementById('adSettingsForm'); if (!form) return;
    if (!form.querySelector('input[name="host"]')?.value.trim()) { showToast('请先填写域控地址', 'warning'); return; }
    const orig = this.innerHTML; this.disabled = true; this.innerHTML = '<span class="spinner"></span> 测试中...';
    try { const data = collectADFormData(form); const r = await api('/api/admin/ad-settings/test', { method:'POST', body: JSON.stringify(data) }); showToast(r.status === 'connected' ? '连接测试成功' : '连接失败', r.status === 'connected' ? 'success' : 'danger'); }
    catch (err) { showToast('测试失败: ' + err.message, 'danger'); }
    finally { this.disabled = false; this.innerHTML = orig; }
  });
  document.getElementById('fillBaseDefaults')?.addEventListener('click', fillBaseDefaults);
  document.getElementById('fillOptionalDefaults')?.addEventListener('click', e => { e.stopPropagation(); fillOptionalDefaults(); });

  // 飞书配置
  document.getElementById('feishuSettingsForm')?.addEventListener('submit', async e => { e.preventDefault(); await saveFeishuSettings(); });
  document.getElementById('testFeishuSettings')?.addEventListener('click', async function() {
    const form = document.getElementById('feishuSettingsForm'); if (!form) return;
    if (!form.querySelector('input[name="appId"]')?.value.trim()) { showToast('请先填写 App ID', 'warning'); return; }
    const orig = this.innerHTML; this.disabled = true; this.innerHTML = '<span class="spinner"></span> 测试中...';
    try { const data = collectFeishuFormData(form); const r = await api('/api/admin/feishu-settings/test', { method:'POST', body: JSON.stringify(data) }); showToast(r.status === 'connected' ? '飞书凭据验证成功' : '验证失败', r.status === 'connected' ? 'success' : 'danger'); }
    catch (err) { showToast('测试失败: ' + err.message, 'danger'); }
    finally { this.disabled = false; this.innerHTML = orig; }
  });

  // 详情弹窗 - 定时任务
  document.getElementById('detailScheduleBtn')?.addEventListener('click', async function() {
    const timeInput = document.getElementById('detailScheduleTime');
    if (!timeInput?.value) { showToast('请选择执行时间', 'warning'); return; }
    const account = getCurrentDetailAccount(); if (!account) { showToast('无法获取用户信息', 'warning'); return; }
    if (new Date(timeInput.value) < new Date()) { showToast('执行时间不能早于当前时间', 'warning'); return; }
    this.disabled = true; this.innerHTML = '<span class="spinner"></span> 添加中...';
    try { let iso = timeInput.value + ':00'; try { iso = new Date(timeInput.value).toISOString(); } catch(e){} await api('/api/admin/users/disable', { method:'POST', body: JSON.stringify({ account, disableAt: iso }) }); showToast('定时禁用任务已添加', 'success'); timeInput.value = ''; showUserDetail(account); }
    catch (err) { showToast('添加失败: ' + err.message, 'danger'); }
    finally { this.disabled = false; this.textContent = '添加任务'; }
  });

  // 审计/任务刷新
  document.getElementById('refreshLogs')?.addEventListener('click', loadLogs);
  document.getElementById('refreshTasks')?.addEventListener('click', loadTasks);

  // 重置密码弹窗事件
  document.querySelector('#resetPwdCancel')?.addEventListener('click', closeResetPwdModal);
  document.querySelector('#resetPwdGenerate')?.addEventListener('click', () => { const i = document.querySelector('#resetPwdInput'); if (i) { i.value = genRandomPassword(); updatePwdStrength(i); } });
  // 密码输入时实时显示强度
  document.querySelector('#resetPwdInput')?.addEventListener('input', function() { updatePwdStrength(this); });
  document.querySelector('#resetPwdConfirm')?.addEventListener('click', async function() {
    const input = document.querySelector('#resetPwdInput'); const password = input?.value.trim() || '';
    if (password.length < 8) { showToast('密码至少需要 8 位', 'warning'); return; }
    const mustChange = document.querySelector('#resetPwdMustChange')?.checked ?? true;
    resetPwdMustChangeVal = mustChange;
    try { const d = await api('/api/admin/users/password', { method:'POST', body: JSON.stringify({ account: resetTarget, password, mustChange }) }); this.parentElement.style.display = 'none'; showResetPwdResult(d.password || password); showToast('密码已重置', 'success'); setTimeout(searchUsers, 300); }
    catch (err) { showToast(err.message, 'danger'); }
  });
  document.querySelector('#resetPwdDone')?.addEventListener('click', closeResetPwdModal);
  document.querySelector('#resetPwdExpiredClose')?.addEventListener('click', closeResetPwdModal);
  document.querySelector('#resetPwdRegenerate')?.addEventListener('click', async function() {
    if (!resetTarget) return; this.disabled = true;
    try { const d = await api('/api/admin/users/password', { method:'POST', body: JSON.stringify({ account: resetTarget, password: '', mustChange: resetPwdMustChangeVal }) }); showResetPwdResult(d.password || ''); showToast('已重新生成密码', 'success'); }
    catch (err) { showToast(err.message, 'danger'); }
    finally { this.disabled = false; }
  });

  // 高危确认弹窗
  const dangerOk = document.getElementById('dangerConfirmOk');
  if (dangerOk) dangerOk.addEventListener('click', () => { if (!dangerOk.disabled) { document.getElementById('dangerConfirmModal')?.classList.remove('active'); const cb = window._dangerConfirmCb; if (cb) cb(); } });
  const dangerInput = document.getElementById('dangerConfirmInput');
  if (dangerInput) dangerInput.addEventListener('input', function() { const ok = document.getElementById('dangerConfirmOk'); if (ok) ok.disabled = this.value.trim() !== window._dangerTarget; });

  // 新建账户
  const createForm = document.getElementById('createForm');
  if (createForm) {
    const fn = document.getElementById('createFullName');
    const cn = document.getElementById('createCN');
    const dn = document.getElementById('createDisplayName');
    const sn = document.getElementById('createSurname');
    const gn = document.getElementById('createGivenName');
    fn?.addEventListener('input', function() {
      const name = this.value.trim(); if (cn) cn.value = name;
      if (dn && !dn.dataset.touched) dn.value = name;
      if (name) {
        if (/[\u4e00-\u9fa5]/.test(name)) { if (sn && !sn.dataset.touched) sn.value = name.charAt(0); if (gn && !gn.dataset.touched) gn.value = name.length > 1 ? name.slice(1) : ''; }
        else { const parts = name.split(/\s+/); if (parts.length >= 2) { if (gn && !gn.dataset.touched) gn.value = parts[0]; if (sn && !sn.dataset.touched) sn.value = parts[parts.length-1]; } }
      }
    });
    [dn, sn, gn].forEach(el => el?.addEventListener('input', function() { this.dataset.touched = '1'; }));
    document.getElementById('createPwdGenerateInline')?.addEventListener('click', () => { const i = document.getElementById('createPassword'); if (i) { i.value = genRandomPassword(); updatePwdStrength(i); } });
    // 密码显示/隐藏切换按钮（眼睛图标切换）
    document.querySelectorAll('.pwd-toggle').forEach(btn => {
      btn.addEventListener('click', function() {
        const target = document.getElementById(this.getAttribute('data-target'));
        if (!target) return;
        if (target.type === 'password') {
          target.type = 'text';
          this.classList.add('showing');
        } else {
          target.type = 'password';
          this.classList.remove('showing');
        }
      });
    });
    // 创建账户密码实时强度
    document.getElementById('createPassword')?.addEventListener('input', function() { updatePwdStrength(this); });
    createForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      const fullName = (document.getElementById('createFullName')||{}).value || '';
      const cnVal = (document.getElementById('createCN')||{}).value || fullName;
      const sam = (document.getElementById('createSAM')||{}).value || '';
      if (!sam) { showToast('请填写域用户名', 'warning'); return; }
      const pwdInput = document.getElementById('createPassword');
      let password = pwdInput?.value.trim() || genRandomPassword();
      const btn = this.querySelector('button[type="submit"]'); const orig = btn?.innerHTML || '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 创建中...'; }
      let upn = ''; try { const s = await api('/api/admin/ad-settings'); upn = s.domainUPNSuffix || ''; } catch(e){}
      const data = { cn: cnVal, samAccountName: sam, userPrincipalName: upn ? (sam+'@'+upn) : '', displayName: (document.getElementById('createDisplayName')||{}).value || fullName, givenName: (document.getElementById('createGivenName')||{}).value || '', surname: (document.getElementById('createSurname')||{}).value || '', mail: createForm.querySelector('[name="mail"]')?.value || '', ou: (document.getElementById('createOU')||{}).value || '', password, mustChange: createForm.querySelector('[name="mustChange"]')?.checked ?? true, groups: [] };
      document.querySelectorAll('#grpCheckboxes input:checked').forEach(cb => data.groups.push(cb.value));
      try {
        const result = await api('/api/admin/users', { method:'POST', body: JSON.stringify(data) });
        const finalPwd = result.password || password;
        // 安全：不直接在 toast 中明文显示密码。如果有自动生成的密码，用弹窗展示（含倒计时隐藏）。
        showToast('账号 ' + (result.user?.samAccountName || sam) + ' 创建成功', 'success');
        if (result.password) {
          // 后端返回了生成的密码，用密码展示弹窗（复用 resetPwd 流程）
          openResetModal(result.user?.samAccountName || sam);
          setTimeout(() => showResetPwdResult(finalPwd), 300);
        }
        createForm.reset();
      } catch (err) { showToast(err.message, 'danger'); }
      finally { if (btn) { btn.disabled = false; btn.innerHTML = orig; } }
    });
  }

  // 离职处理
  document.getElementById('offboardForm')?.addEventListener('submit', async function(e) {
    e.preventDefault(); const v = Object.fromEntries(new FormData(this));
    const acct = v.account?.trim(); if (!acct) { showToast('请输入域用户名', 'warning'); return; }
    openDangerConfirm({ title:'离职处理', desc:'即将禁用账号并移动到离职 OU', target: acct, warning:'离职处理后账号将被禁用并移出原部门。', confirmText:'确认离职处理',
      onConfirm: async () => { const btn = this.querySelector('button[type="submit"]'); const orig = btn?.innerHTML || ''; if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 处理中...'; }
        try { await api('/api/admin/users/offboard', { method:'POST', body: JSON.stringify({ account: acct, targetOU: v.targetOU || '' }) }); showToast('离职处理完成', 'success'); this.reset(); }
        catch (err) { showToast('离职处理失败: ' + err.message, 'danger'); }
        finally { if (btn) { btn.disabled = false; btn.innerHTML = orig; } }
      }
    });
  });

  // 批量离职
  document.getElementById('batchOffboardBtn')?.addEventListener('click', async function() {
    const textarea = document.getElementById('batchAccounts');
    const targetOUInput = document.getElementById('batchTargetOU');
    const resultDiv = document.getElementById('batchResult');
    const accounts = textarea?.value.trim() || '';
    if (!accounts) { showToast('请输入账号列表', 'warning'); return; }
    const acctList = accounts.split(/\n/).map(s => s.trim()).filter(s => s.length > 0);
    this.disabled = true; this.innerHTML = '<span class="spinner"></span> 批量处理中...';
    if (resultDiv) resultDiv.innerHTML = '';
    const success = [], failed = [];
    for (const acct of acctList) { try { await api('/api/admin/users/offboard', { method:'POST', body: JSON.stringify({ account: acct, targetOU: targetOUInput?.value.trim() || '' }) }); success.push(acct); } catch (err) { failed.push(acct + ': ' + err.message); } }
    if (resultDiv) { let h = '<div style="margin-top:8px"><div style="color:var(--success-600);font-size:13px">✓ 成功 ' + success.length + ' 个</div>'; if (failed.length) { h += '<div style="color:var(--danger-600);font-size:13px">✕ 失败 ' + failed.length + ' 个:</div>'; failed.forEach(f => h += '<div style="color:var(--danger-500);font-size:12px;padding-left:12px">' + escHTML(f) + '</div>'); } resultDiv.innerHTML = h + '</div>'; }
    this.disabled = false; this.textContent = '批量禁用并移入离职 OU';
  });

  // 刷新选项
  document.getElementById('refreshOptions')?.addEventListener('click', function() { this.innerHTML = '<span class="spinner"></span>'; const self = this; loadOptions().then(() => { self.innerHTML = '刷新选项'; showToast('选项已刷新', 'success'); }); });
}

// ─── 全局键盘可访问性 ───
document.addEventListener('keydown', function(e) {
  // Esc 关闭所有弹窗
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal.active, .modal[style*="display: flex"]').forEach(m => m.classList.remove('active'));
    document.body.classList.remove('locked');
  }
});

// Toast 容器加 role="alert"（无障碍）
if (typeof document !== 'undefined') {
  const tc = document.getElementById('toastContainer');
  if (tc) tc.setAttribute('role', 'alert');
  if (tc) tc.setAttribute('aria-live', 'polite');
}

// ─── 启动 ───
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { initDOMListeners(); initTheme(); tryRestoreSession(); });
} else {
  initDOMListeners(); initTheme(); tryRestoreSession();
}

console.log('admin app.js (ES Module) loaded');
