/**
 * Settings 模块 — AD/飞书设置 + 向导 + 选项加载
 */
import { api } from './api.js';
import { showToast, escHTML, openModal, closeModal } from './ui.js';

let adConfigured = false;
let adTestPassed = false;
function getAdConfigured() { return adConfigured; }

// ─── AD 设置 ───
async function loadADSettings() {
  try {
    const data = await api('/api/admin/ad-settings');
    adConfigured = !!(data && data.host && data.host.trim());
    // 将密码有效期写入全局变量，供 pwdExpiryInfo 使用
    if (data && data.passwordMaxAgeDays) {
      window.pwdMaxAgeDays = data.passwordMaxAgeDays;
    }
    const form = document.getElementById('adSettingsForm');
    if (form && data) {
      Object.keys(data).forEach(function (key) {
        const input = form.querySelector('input[name="' + key + '"]');
        if (!input) return;
        if (input.type === 'checkbox') input.checked = !!data[key];
        else input.value = data[key] || '';
      });
    }
    updateConnStatus(adConfigured);
    return data;
  } catch (err) {
    console.warn('Load AD settings error:', err);
    return { configured: false };
  }
}

async function saveWizardSettings() {
  const form = document.getElementById('wizardForm');
  if (!form) return;
  const data = collectADFormData(form);
  const btn = document.getElementById('wizardSaveBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 保存中...'; }
  try {
    await api('/api/admin/ad-settings', { method: 'PUT', body: JSON.stringify(data) });
    showToast('域控连接配置已保存', 'success');
    hideSetupWizard();
    await loadADSettings();
    await loadOptions();
  } catch (err) {
    showToast('保存失败: ' + err.message, 'danger');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '保存并开始使用'; }
  }
}

function collectADFormData(form) {
  const data = {};
  form.querySelectorAll('input').forEach(function (input) {
    if (!input.name) return;
    if (input.type === 'checkbox') data[input.name] = input.checked;
    else if (input.type === 'number') { const v = parseInt(input.value, 10); data[input.name] = isNaN(v) ? 0 : v; }
    else data[input.name] = input.value;
  });
  form.querySelectorAll('select').forEach(function (sel) { if (sel.name) data[sel.name] = sel.value; });
  form.querySelectorAll('textarea').forEach(function (ta) { if (ta.name) data[ta.name] = ta.value; });
  return data;
}

function collectFeishuFormData(form) {
  const data = {};
  form.querySelectorAll('input').forEach(function (input) {
    if (!input.name) return;
    if (input.type === 'checkbox') data[input.name] = input.checked;
    else if (input.type === 'number') { const v = parseInt(input.value, 10); data[input.name] = isNaN(v) ? 0 : v; }
    else data[input.name] = input.value;
  });
  return data;
}

function updateConnStatus(connected) {
  const status = document.getElementById('connStatus');
  if (!status) return;
  const dot = document.getElementById('connDot');
  const label = document.getElementById('connLabel');
  status.className = 'conn-status';
  if (dot) dot.className = 'conn-dot';
  if (connected) {
    status.classList.add('connected');
    if (dot) dot.classList.add('connected');
    if (label) label.textContent = '已连接';
  } else {
    status.classList.add('disconnected');
    if (dot) dot.classList.add('error');
    if (label) label.textContent = '未连接';
  }
}

let _connCheckTimer = null;

async function startConnCheck() {
  async function checkOnce() {
    try {
      const data = await api('/api/admin/ad-settings/connectivity');
      updateConnStatus(data.status === 'connected');
    } catch (err) { updateConnStatus(false); }
  }
  checkOnce();
  // 清除旧 timer 避免反复切换 tab 累积多个 interval
  if (_connCheckTimer) clearInterval(_connCheckTimer);
  _connCheckTimer = setInterval(checkOnce, 30000);
}

// ─── 飞书设置 ───
async function loadFeishuSettings() {
  try {
    const data = await api('/api/admin/feishu-settings');
    const form = document.getElementById('feishuSettingsForm');
    if (form && data) {
      setFormValue(form, 'appId', data.appId || '');
      setFormValue(form, 'redirectUri', data.redirectUri || '');
      setFormValue(form, 'sessionDurationHours', data.sessionDurationHours || 8);
      const enabledInput = form.querySelector('input[name="enabled"]');
      if (enabledInput) enabledInput.checked = !!data.enabled;
      const secretInput = form.querySelector('input[name="appSecret"]');
      if (secretInput) { secretInput.value = ''; secretInput.placeholder = data.appSecretSet ? '已设置（留空不修改）' : '请输入 App Secret'; }
    }
    const badge = document.getElementById('feishuStatusBadge');
    if (badge) {
      if (data.configured && data.enabled) { badge.textContent = '已启用'; badge.className = 'badge badge-success'; }
      else if (data.configured) { badge.textContent = '已配置（未启用）'; badge.className = 'badge badge-warning'; }
      else { badge.textContent = '未配置'; badge.className = 'badge badge-neutral'; }
    }
    const hint = document.getElementById('feishuRedirectHint');
    if (hint) hint.textContent = data.redirectUri || (location.origin + '/api/auth/feishu/callback');
    const secretHint = document.getElementById('feishuSecretHint');
    if (secretHint) {
      if (data.envSourced) secretHint.textContent = '当前使用环境变量配置，保存后将转为数据库管理';
      else if (data.appSecretSet) secretHint.textContent = 'App Secret 已设置';
      else secretHint.textContent = '';
    }
    return data;
  } catch (err) {
    console.warn('Load Feishu settings error:', err);
    return null;
  }
}

async function saveFeishuSettings() {
  const form = document.getElementById('feishuSettingsForm');
  if (!form) return;
  const data = collectFeishuFormData(form);
  const submitBtn = form.querySelector('button[type="submit"]');
  const origText = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<span class="spinner"></span> 保存中...'; }
  try {
    await api('/api/admin/feishu-settings', { method: 'PUT', body: JSON.stringify(data) });
    showToast('飞书配置已保存', 'success');
    await loadFeishuSettings();
  } catch (err) {
    showToast('保存失败: ' + err.message, 'danger');
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; }
  }
}

// ─── 选项加载 (OU/Groups) ───
async function loadOptions() {
  try {
    const [ousResp, groupsResp] = await Promise.all([
      api('/api/admin/ous').catch(function () { return []; }),
      api('/api/admin/groups').catch(function () { return []; }),
    ]);
    const ous = Array.isArray(ousResp) ? ousResp : (ousResp.ous || []);
    const groups = Array.isArray(groupsResp) ? groupsResp : (groupsResp.groups || []);

    const ouSelect = document.getElementById('createOU');
    if (ouSelect) {
      ouSelect.innerHTML = '<option value="">请选择部门</option>';
      ous.forEach(function (ou) {
        const opt = document.createElement('option');
        opt.value = ou.value || ou.dn || '';
        opt.textContent = ou.label || ou.name + (ou.description ? ' - ' + ou.description : '');
        ouSelect.appendChild(opt);
      });
    }

    const grpBox = document.getElementById('grpCheckboxes');
    if (grpBox) {
      grpBox.innerHTML = '';
      if (groups.length > 0) {
        groups.forEach(function (g) {
          const label = document.createElement('label');
          label.className = 'grp-checkbox-item';
          label.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:12px;cursor:pointer;background:var(--bg-surface);';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = g.value || g.dn || '';
          label.appendChild(cb);
          const nameSpan = document.createElement('span');
          nameSpan.textContent = g.label || g.name || g.value;
          nameSpan.style.fontWeight = '500';
          label.appendChild(nameSpan);
          if (g.description) {
            const descSpan = document.createElement('span');
            descSpan.textContent = g.description;
            descSpan.style.cssText = 'color:var(--text-tertiary);font-size:11px;margin-left:2px;';
            label.appendChild(descSpan);
          }
          grpBox.appendChild(label);
        });
      } else {
        grpBox.innerHTML = '<span style="color:var(--text-tertiary);font-size:12px;">未加载到组选项，请检查域控配置中的"组同步范围"</span>';
      }
    }
  } catch (err) {
    console.warn('Load options error:', err);
  }
}

// ─── 向导 ───
// 注意：CSS 中 .wizard-overlay 默认 opacity:0/visibility:hidden，
// 通过 .active 类切换可见性（带过渡动画）。不能再用 .hidden（display:none）
// 否则向导不可见但 body.locked 残留 → 设置页无法滚动。
function showSetupWizard() {
  const el = document.getElementById('setupWizard');
  if (el) el.classList.add('active');
  document.body.classList.add('locked');
}

function hideSetupWizard() {
  const el = document.getElementById('setupWizard');
  if (el) el.classList.remove('active');
  document.body.classList.remove('locked');
}

function fillWizOptionalExample() {
  const form = document.getElementById('wizardForm');
  if (!form) return;
  setFormValue(form, 'ouScope', 'DC=example,DC=com');
  setFormValue(form, 'groupScope', 'DC=example,DC=com');
}

// ─── 表单辅助 ───
function setFormValue(form, name, value) {
  const input = form.querySelector('input[name="' + name + '"], select[name="' + name + '"]');
  if (input) input.value = value;
}

function toggleOptional() {
  const body = document.getElementById('optionalBody');
  const btn = document.querySelector('.toggle-optional');
  if (body) body.classList.toggle('hidden');
  if (btn) {
    const isOpen = !body || !body.classList.contains('hidden');
    btn.textContent = isOpen ? '收起可选设置' : '展开可选设置';
  }
}

function fillOptionalDefaults() {
  const form = document.getElementById('adSettingsForm');
  if (!form) return;
  setFormValue(form, 'ouScope', 'DC=example,DC=com');
  setFormValue(form, 'groupScope', 'DC=example,DC=com');
}

function fillBaseDefaults() {
  const form = document.getElementById('adSettingsForm') || document.getElementById('wizardForm');
  if (!form) return;
  const hostInput = form.querySelector('input[name="host"]');
  if (hostInput && !hostInput.value) hostInput.value = 'dc01.example.com';
  const portInput = form.querySelector('input[name="port"]');
  if (portInput && !portInput.value) portInput.value = '636';
  const domainInput = form.querySelector('input[name="domainName"]');
  if (domainInput && !domainInput.value) domainInput.value = 'example.com';
  const baseDNInput = form.querySelector('input[name="baseDN"]');
  if (baseDNInput && !baseDNInput.value) baseDNInput.value = 'DC=example,DC=com';
  const bindInput = form.querySelector('input[name="bindUsername"]');
  if (bindInput && !bindInput.value) bindInput.value = 'admin@example.com';
}

// ─── OU/组 检测（设置页与向导共用）───
// type: 'ous' | 'groups'；form: 所属表单元素；targetName: 选中后回填的 input name；title: 弹窗标题
async function detectScope(type, form, targetName, title) {
  if (!form) return;
  const targetInput = form.querySelector('input[name="' + targetName + '"]');
  if (!targetInput) return;
  // 前置校验：域控地址必须填写
  const hostInput = form.querySelector('input[name="host"]');
  if (!hostInput || !hostInput.value.trim()) {
    showToast('请先填写域控地址', 'warning');
    hostInput?.focus();
    return;
  }
  const baseInput = form.querySelector('input[name="baseDN"]');
  const base = baseInput ? baseInput.value.trim() : '';
  // 用当前表单填的临时配置检测（无需先保存即可读取域控 OU/组）
  const data = collectADFormData(form);
  const url = '/api/admin/' + type + '/discover' + (base ? '?base=' + encodeURIComponent(base) : '');
  showToast('正在从域控检测…', 'info');
  let entries;
  try {
    entries = await api(url, { method: 'POST', body: JSON.stringify(data) });
  } catch (e) {
    const msg = (e && e.message) ? e.message : '';
    showToast('检测失败' + (msg ? '：' + msg : '，请确认域控地址/账号/密码正确'), 'danger');
    return;
  }
  const list = Array.isArray(entries) ? entries : (entries[type] || []);
  if (!list || list.length === 0) { showToast('未检测到可选项', 'info'); return; }
  const titleEl = document.getElementById('scopePickerTitle');
  if (titleEl) titleEl.textContent = title;
  const listEl = document.getElementById('scopePickerList');
  if (!listEl) { showToast('选择弹窗未就绪', 'danger'); return; }
  listEl.innerHTML = '';
  list.forEach(function (item) {
    const val = item.value || item.dn || '';
    const label = item.label || item.name || val;
    const desc = item.description || '';
    const row = document.createElement('div');
    row.className = 'scope-picker-item';
    row.style.cssText = 'padding:10px 14px;border:1px solid var(--border-default);border-radius:var(--radius-md);margin-bottom:8px;cursor:pointer;background:var(--bg-surface);transition:all .15s;';
    row.onmouseenter = function () { row.style.borderColor = 'var(--primary-500, #6366f1)'; row.style.background = 'var(--bg-muted)'; };
    row.onmouseleave = function () { row.style.borderColor = 'var(--border-default)'; row.style.background = 'var(--bg-surface)'; };
    const lbl = document.createElement('div');
    lbl.textContent = label;
    lbl.style.cssText = 'font-weight:600;color:var(--text-default);font-size:14px;';
    row.appendChild(lbl);
    if (val && val !== label) {
      const v = document.createElement('div');
      v.textContent = val;
      v.style.cssText = 'font-size:12px;color:var(--text-tertiary);margin-top:2px;word-break:break-all;';
      row.appendChild(v);
    }
    if (desc) {
      const d = document.createElement('div');
      d.textContent = desc;
      d.style.cssText = 'font-size:12px;color:var(--text-secondary);margin-top:2px;';
      row.appendChild(d);
    }
    row.addEventListener('click', function () {
      targetInput.value = val;
      closeModal();
      showToast('已选择：' + label, 'success');
    });
    listEl.appendChild(row);
  });
  openModal('scopePickerModal');
}

export {
  loadADSettings, saveWizardSettings, collectADFormData, collectFeishuFormData,
  updateConnStatus, startConnCheck,
  loadFeishuSettings, saveFeishuSettings,
  loadOptions, showSetupWizard, hideSetupWizard, fillWizOptionalExample,
  setFormValue, toggleOptional, fillOptionalDefaults, fillBaseDefaults,
  getAdConfigured, detectScope,
};
