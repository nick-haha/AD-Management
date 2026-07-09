// ═══════════════════════════════════════════════════════════════════════════
// AD Management - Admin Panel JavaScript (v2)
// ═══════════════════════════════════════════════════════════════════════════

// 分页变量
let currentPage = 1;
let pageSize = 10;
let totalUsers = 0;

// AD时间戳转换
function adTimeToString(ts) {
  if (!ts || ts === "0" || ts === "") return "从未";
  try {
    const ticks = parseInt(ts, 10);
    if (isNaN(ticks) || ticks <= 0) return "从未";
    const adEpochMs = -11644473600000;
    const ms = Math.floor(ticks / 10000) + adEpochMs;
    const date = new Date(ms);
    if (date.getFullYear() < 1970 || date.getFullYear() > 2100) return "从未";
    return date.toLocaleDateString("zh-CN") + " " + date.toLocaleTimeString("zh-CN", {hour: "2-digit", minute: "2-digit"});
  } catch(e) { return "从未"; }
}

function pwdExpiryInfo(pwdLastSet, passwordNeverExpires, maxAgeDays, passwordExpiresAt) {
  // 优先用 AD 真实计算属性 msDS-UserPasswordExpiryTimeComputed（域控综合域策略/PSO/UAC 算出的权威到期时间）
  if (passwordExpiresAt) {
    const pe = String(passwordExpiresAt).trim();
    if (pe === "0" || pe === "" || pe === "9223372036854775807") return { text: "永不过期", cls: "ok" };
    if (pe === "-1") return { text: "需设置", cls: "warn" };
    try {
      const ticks = parseInt(pe, 10);
      if (!isNaN(ticks) && ticks > 0) {
        const adEpochMs = -11644473600000;
        const expiryMs = Math.floor(ticks / 10000) + adEpochMs;
        if (expiryMs <= 0) return { text: "需设置", cls: "warn" };
        const now = Date.now();
        if (expiryMs < now) return { text: "已过期", cls: "bad" };
        const daysLeft = Math.ceil((expiryMs - now) / (24 * 60 * 60 * 1000));
        return { text: daysLeft + "天后到期", cls: daysLeft < 14 ? "warn" : "ok" };
      }
    } catch(e) { /* 解析失败回退估算 */ }
  }
  // 回退：pwdLastSet + 配置天数估算（AD 未返回构造属性时向后兼容）
  // 优先判断 AD 标志位：userAccountControl & 0x10000
  if (passwordNeverExpires) return { text: "永不过期", cls: "ok" };
  if (!pwdLastSet || pwdLastSet === "0") return { text: "需设置", cls: "warn" };
  if (pwdLastSet === "-1") return { text: "需设置", cls: "warn" }; // 修正：-1 实为“管理员已重置，须改密”，非永不过期
  if (!maxAgeDays || maxAgeDays <= 0) maxAgeDays = 90; // 默认 90 天
  try {
    const ticks = parseInt(pwdLastSet, 10);
    if (isNaN(ticks) || ticks <= 0) return { text: "需设置", cls: "warn" };
    const adEpochMs = -11644473600000;
    const setMs = Math.floor(ticks / 10000) + adEpochMs;
    const expiryMs = setMs + maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    if (expiryMs < now) return { text: "已过期", cls: "bad" };
    const daysLeft = Math.ceil((expiryMs - now) / (24 * 60 * 60 * 1000));
    return { text: daysLeft + "天后到期", cls: daysLeft < 14 ? "warn" : "ok" };
  } catch(e) { return { text: "未知", cls: "" }; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════
const API = window.API_BASE || "";
const TOKEN_KEY = "ad_admin_token";
const THEME_KEY = "ad_theme";
const ROLE_KEY = "ad_admin_role";
const PERMS_KEY = "ad_admin_perms";

let adConfigured = false;
let adTestPassed = false;
let pwdMaxAgeDays = 90; // 域密码策略有效期（天），从 AD 设置读取
let myRole = localStorage.getItem(ROLE_KEY) || ""; // super_admin | hr_admin | helpdesk | custom
let myPerms = []; // 实际权限列表，从后端 /api/admin/me 获取
try { myPerms = JSON.parse(localStorage.getItem(PERMS_KEY) || "[]"); } catch(e) {}

// ─── 权限项定义（与后端 store.Perm* 一一对应）───
const ALL_PERMS = [
  { key: "search",         label: "搜索用户",     desc: "查看用户列表和详情" },
  { key: "create",         label: "创建用户",     desc: "新建 AD 账号" },
  { key: "delete",         label: "删除用户",     desc: "永久删除 AD 账号（不可逆）" },
  { key: "disable",        label: "禁用/启用用户", desc: "切换账号启用状态" },
  { key: "unlock",         label: "解锁用户",     desc: "解除账号锁定" },
  { key: "resetPwd",       label: "重置密码",     desc: "重置用户密码" },
  { key: "offboard",       label: "离职处理",     desc: "禁用并移至离职 OU" },
  { key: "modifyUser",     label: "修改用户属性", desc: "编辑用户基本信息" },
  { key: "addGroup",       label: "加组/移组",    desc: "管理用户组成员关系" },
  { key: "adSettings",     label: "域控配置",     desc: "修改 AD 连接设置" },
  { key: "feishuSettings", label: "飞书配置",     desc: "修改飞书登录设置" },
  { key: "audit",          label: "审计日志",     desc: "查看操作审计记录" },
  { key: "tasks",          label: "定时任务",     desc: "管理定时禁用任务" },
  { key: "adminMgmt",      label: "管理员管理",   desc: "管理管理员账号和权限" },
];

// ─── 预设角色权限映射（与后端 store.RolePermissions 一致）───
const ROLE_PERMS = {
  super_admin: ALL_PERMS.map(function(p) { return p.key; }),
  hr_admin:    ["search","create","disable","offboard","modifyUser","addGroup","audit","tasks"],
  helpdesk:    ["search","unlock","resetPwd","audit"],
};

function hasPerm(perm) { return myPerms.indexOf(perm) >= 0; }

function applyRoleUI() {
  // 侧边栏导航项
  document.querySelectorAll(".sidebar-item[data-tab]").forEach(function(btn) {
    var tab = btn.getAttribute("data-tab");
    var show = true;
    if (tab === "create" && !hasPerm("create")) show = false;
    if (tab === "offboard" && !hasPerm("offboard")) show = false;
    if (tab === "tasks" && !hasPerm("tasks")) show = false;
    btn.style.display = show ? "" : "none";
  });
  // 下拉菜单项：有权限显示（清除 display:none），无权限隐藏
  document.querySelectorAll(".dropdown-item[data-action]").forEach(function(item) {
    var act = item.getAttribute("data-action");
    var show = true;
    if (act === "settings" && !hasPerm("adSettings")) show = false;
    if (act === "feishuSettings" && !hasPerm("feishuSettings")) show = false;
    if (act === "adminMgmt" && !hasPerm("adminMgmt")) show = false;
    item.style.display = show ? "" : "none";
  });
  // 角色标签
  var roleLabels = { super_admin: "超级管理员", hr_admin: "HR管理员", helpdesk: "服务台", custom: "自定义权限" };
  var roleBadge = document.querySelector("#adminRoleBadge");
  if (roleBadge) roleBadge.textContent = roleLabels[myRole] || myRole;
}

function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }

// ═══════════════════════════════════════════════════════════════════════════
// Toast Notification - 右上角显示
// ═══════════════════════════════════════════════════════════════════════════
function showToast(msg, type = "info") {
  var container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  
  var icons = { success: "✓", warning: "⚠", danger: "✕", info: "ℹ" };
  var toast = document.createElement("div");
  toast.className = "toast toast-" + (type || "info");
  toast.innerHTML = '<div class="toast-icon">' + (icons[type] || "ℹ") + '</div><div class="toast-content"><div class="toast-message"></div></div>';
  var msgEl = toast.querySelector(".toast-message");
  if (msgEl) msgEl.textContent = msg;
  else toast.querySelector(".toast-content").firstChild.textContent = msg;
  container.appendChild(toast);
  
  // 动画
  toast.style.animation = "slideInRight 0.3s ease-out";
  
  // 第三个参数可自定义显示时长（毫秒）
  var duration = 4000;
  if (arguments.length >= 3 && typeof arguments[2] === "number") {
    duration = arguments[2];
  }
  setTimeout(function() {
    toast.style.animation = "fadeOut 0.3s ease-out forwards";
    setTimeout(function() { toast.remove(); }, 300);
  }, duration);
}

// ═══════════════════════════════════════════════════════════════════════════
// API Helper
// ═══════════════════════════════════════════════════════════════════════════
async function api(path, opts = {}) {
  var token = getToken();
  try {
    const res = await fetch(API + path, {
      ...opts,
      headers: { 
        "Content-Type": "application/json", 
        Authorization: "Bearer " + token, 
        ...(opts.headers || {}) 
      },
    });
    var d = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 401 说明 token 失效/过期，清掉 token 并跳回登录页
      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        hideAdmin();
      }
      // 友好化错误消息
      var errMsg = d.error || "请求失败";
      if (errMsg === "invalid_credentials") {
        errMsg = "用户名或密码错误";
      } else if (errMsg === "account_locked") {
        errMsg = "账号已被锁定，请30分钟后再试";
      } else if (errMsg === "invalid_token" || errMsg === "missing_bearer_token") {
        errMsg = "登录已过期，请重新登录";
      } else if (d.detail) {
        errMsg = d.detail;
      }
      var err = new Error(errMsg);
      err.code = d.error;
      err.status = res.status;
      throw err;
    }
    return d;
  } catch (e) {
    if (e.message === "Failed to fetch") {
      throw new Error("网络连接失败，请检查网络");
    }
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Theme Management - 深色/浅色/自动切换
// ═══════════════════════════════════════════════════════════════════════════
let sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

function applyTheme(t) {
  var isDark = t === "dark" || (t === "auto" && sysDark);
  document.body.classList.toggle("theme-dark", isDark);
  localStorage.setItem(THEME_KEY, t);
  
  // 更新主题按钮状态
  document.querySelectorAll(".theme-btn").forEach(function(b) { 
    b.classList.toggle("active", b.dataset.theme === t); 
  });
  
  // 更新图标
  var themeIcon = document.querySelector("#themeIcon");
  if (themeIcon) {
    if (t === "light") themeIcon.textContent = "☀️";
    else if (t === "dark") themeIcon.textContent = "🌙";
    else themeIcon.textContent = "💻";
  }
}

function initTheme() {
  var t = localStorage.getItem(THEME_KEY) || "auto";
  applyTheme(t);
}

function cycleTheme() {
  var themes = ["light", "dark", "auto"];
  var current = localStorage.getItem(THEME_KEY) || "auto";
  var idx = themes.indexOf(current);
  var next = themes[(idx + 1) % themes.length];
  applyTheme(next);
  var toastContainer = document.getElementById("toastContainer"); if (toastContainer) { var existingToast = toastContainer.querySelector(".toast"); if (existingToast) existingToast.remove(); } var toast = document.createElement("div"); toast.className = "toast toast-info"; toast.innerHTML = '<div class="toast-icon">🎨</div><div class="toast-content"><div class="toast-message">' + (next === "light" ? "浅色模式" : next === "dark" ? "深色模式" : "自动模式") + '</div></div>'; if (toastContainer) toastContainer.appendChild(toast); setTimeout(function() { toast.style.animation = "fadeOut 0.2s ease-out forwards"; setTimeout(function() { toast.remove(); }, 200); }, 1000);
}

// ═══════════════════════════════════════════════════════════════════════════
// UI Management
// ═══════════════════════════════════════════════════════════════════════════
async function showAdmin() {
  console.log("[showAdmin] Starting...");
  document.body.classList.remove("locked");
  
  var loginPage = document.querySelector("#loginPage");
  var adminApp = document.querySelector("#adminApp");
  if (loginPage) loginPage.classList.add("hidden");
  if (adminApp) adminApp.classList.remove("hidden");
  
  initTheme();
  console.log("[showAdmin] UI unlocked");
  
  // 加载AD设置并检查是否需要初始化
  try {
    var settings = await loadADSettings();
    console.log("[showAdmin] Settings loaded:", settings);
    
    // 后端返回扁平结构，用 host 判断是否已配置
    if (!settings || !settings.host || !settings.host.trim()) {
      console.log("[showAdmin] AD not configured, showing wizard");
      showSetupWizard();
    }
    
    loadOptions();
    startConnCheck();
    loadFeishuSettings();
  } catch (e) {
    console.warn("[showAdmin] Load issue:", e);
    showSetupWizard();
  }
}

function hideAdmin() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem("ad_admin_username");
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(PERMS_KEY);
  myRole = "";
  myPerms = [];
  document.body.classList.add("locked");
  var loginPage = document.querySelector("#loginPage");
  var adminApp = document.querySelector("#adminApp");
  if (loginPage) loginPage.classList.remove("hidden");
  if (adminApp) adminApp.classList.add("hidden");
  closeModal();
}

function showSetupWizard() {
  var wizard = document.getElementById("setupWizard");
  if (wizard) {
    wizard.classList.add("active");
  }
}

function hideSetupWizard() {
  var wizard = document.getElementById("setupWizard");
  if (wizard) {
    wizard.classList.remove("active");
  }
}

// 填充可选设置的示例值（已改为必填，此函数保留用于手动填充）
function fillWizOptionalExample() {
  var form = document.getElementById("wizardForm");
  if (!form) return;
  
  var domainName = form.querySelector('input[name="domainName"]');
  
  // 根据域名生成示例值
  var domain = domainName ? domainName.value.trim() : "domain.com";
  if (!domain) domain = "domain.com";
  
  var parts = domain.split(".");
  var dcParts = parts.map(function(p) { return "DC=" + p; });
  var dcStr = dcParts.join(",");
  
  var disabledOUInput = form.querySelector('input[name="disabledOU"]');
  var domainNetBIOSInput = form.querySelector('input[name="domainNetBIOS"]');
  var domainUPNSuffixInput = form.querySelector('input[name="domainUPNSuffix"]');
  
  if (disabledOUInput && !disabledOUInput.value) disabledOUInput.value = "OU=Disabled Users," + dcStr;
  if (domainNetBIOSInput && !domainNetBIOSInput.value) domainNetBIOSInput.value = parts[0] ? parts[0].toUpperCase() : "DOMAIN";
  if (domainUPNSuffixInput && !domainUPNSuffixInput.value) domainUPNSuffixInput.value = domain;
  
  showToast("已填入示例值", "success");
}

function openModal(id) { 
  var el = document.getElementById(id);
  if (el) el.classList.add("active"); 
}

function closeModal() { 
  document.querySelectorAll(".modal.active").forEach(function(m) { 
    m.classList.remove("active"); 
  }); 
}

// ═══════════════════════════════════════════════════════════════════════════
// Tab Navigation
// ═══════════════════════════════════════════════════════════════════════════
async function switchTab(id) {
  // 更新侧边栏状态
  document.querySelectorAll(".sidebar-item").forEach(function(i) { 
    i.classList.remove("active"); 
  });
  var btn = document.querySelector('.sidebar-item[data-tab="' + id + '"]');
  if (btn) btn.classList.add("active");
  
  // 更新面板显示
  document.querySelectorAll(".tab-panel").forEach(function(p) { 
    p.classList.remove("active"); 
  });
  var panel = document.querySelector("#" + id);
  if (panel) panel.classList.add("active");
  
  // 特定面板的加载逻辑
  if (id === "overview") {
    var resultEl = document.querySelector("#adminResult");
    if (resultEl) resultEl.innerHTML = "";
    setTimeout(searchUsers, 50);
  } else if (id === "create") {
    resetCreateForm();
    await loadOptions();
  } else if (id === "offboard") {
    loadOffboardDefaults();
  } else if (id === "logs") {
    await loadLogs();
  } else if (id === "tasks") {
    await loadTasks();
  } else if (id === "settings") {
    await loadADSettings();
    loadFeishuSettings();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DOM Ready - Initialize all event listeners
// ═══════════════════════════════════════════════════════════════════════════
function initDOMListeners() {
  console.log("[initDOMListeners] Setting up event listeners...");
 // 域名自动生成 Base DN
  // ═══ 向导表单处理 ═══
  var wizardForm = document.getElementById("wizardForm");
  var wizardTestBtn = document.getElementById("wizardTestBtn");
  var wizardSaveBtn = document.getElementById("wizardSaveBtn");
  var wizardSkipBtn = document.getElementById("wizardSkipBtn");
  var wizardStatus = document.getElementById("wizardStatus");
  
  // 检查表单是否有效
  function checkWizardFormValid() {
    var host = document.querySelector('#wizardForm input[name="host"]');
    var port = document.querySelector('#wizardForm input[name="port"]');
    var domainName = document.querySelector('#wizardForm input[name="domainName"]');
    var baseDN = document.querySelector('#wizardForm input[name="baseDN"]');
    var bindUsername = document.querySelector('#wizardForm input[name="bindUsername"]');
    var bindPassword = document.querySelector('#wizardForm input[name="bindPassword"]');
    var ouScope = document.querySelector('#wizardForm input[name="ouScope"]');
    var groupScope = document.querySelector('#wizardForm input[name="groupScope"]');
    var disabledOU = document.querySelector('#wizardForm input[name="disabledOU"]');
    var domainNetBIOS = document.querySelector('#wizardForm input[name="domainNetBIOS"]');
    var domainUPNSuffix = document.querySelector('#wizardForm input[name="domainUPNSuffix"]');
    
    var valid = host && host.value.trim() &&
                port && port.value.trim() &&
                domainName && domainName.value.trim() &&
                baseDN && baseDN.value.trim() &&
                bindUsername && bindUsername.value.trim() &&
                bindPassword && bindPassword.value.trim() &&
                ouScope && ouScope.value.trim() &&
                groupScope && groupScope.value.trim() &&
                disabledOU && disabledOU.value.trim() &&
                domainNetBIOS && domainNetBIOS.value.trim() &&
                domainUPNSuffix && domainUPNSuffix.value.trim();
    
    if (wizardSaveBtn) wizardSaveBtn.disabled = !valid;
    return valid;
  }
  
  // 监听必填输入框变化
  if (wizardForm) {
    wizardForm.querySelectorAll('input[required]').forEach(function(input) {
      input.addEventListener('input', checkWizardFormValid);
    });
    
    // 表单提交处理
    wizardForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      await saveWizardSettings();
    });
  }
  
  // 测试连接按钮
  if (wizardTestBtn) {
    wizardTestBtn.addEventListener('click', async function() {
      if (!checkWizardFormValid()) {
        showToast("请先填写所有必填项", "warning");
        return;
      }
      
      wizardTestBtn.disabled = true;
      wizardTestBtn.innerHTML = '<span class="spinner"></span> 测试中...';
      if (wizardStatus) wizardStatus.textContent = "正在测试连接...";
      
      try {
        // 直接把表单数据 POST 给测试接口，后端会用这些参数即时测试，无需先保存
        var data = collectADFormData(wizardForm);
        var result = await api("/api/admin/ad-settings/test", {
          method: "POST",
          body: JSON.stringify(data)
        });
        
        // 后端成功返回 {status:"connected"}，失败时通过 api 抛错
        if (result.status === "connected") {
          if (wizardStatus) wizardStatus.innerHTML = '<span style="color: var(--success-600);">✓ 连接成功！</span>';
          wizardTestBtn.innerHTML = '✓ 连接成功';
          wizardTestBtn.classList.remove('btn-secondary');
          wizardTestBtn.classList.add('btn-success');
          showToast("连接测试成功", "success");
        } else {
          if (wizardStatus) wizardStatus.innerHTML = '<span style="color: var(--error-600);">✕ 连接失败：' + (result.error || "未知错误") + '</span>';
          wizardTestBtn.innerHTML = '测试连接';
          wizardTestBtn.disabled = false;
          showToast("连接测试失败", "danger");
        }
      } catch (err) {
        if (wizardStatus) wizardStatus.innerHTML = '<span style="color: var(--error-600);">✕ 测试失败：' + err.message + '</span>';
        wizardTestBtn.innerHTML = '测试连接';
        wizardTestBtn.disabled = false;
        showToast("测试失败：" + err.message, "danger");
      }
    });
  }
  
  // 跳过按钮
  if (wizardSkipBtn) {
    wizardSkipBtn.addEventListener('click', function() {
      hideSetupWizard();
      showToast("您可以稍后在设置中配置域控连接", "info");
    });
  }
  
 var wizDomain = document.getElementById("wizDomain");
  var wizBaseDN = document.getElementById("wizBaseDN");
  if (wizDomain && wizBaseDN) {
    wizDomain.addEventListener("input", function() {
      var domain = this.value.trim();
      if (domain) {
        var parts = domain.split(".");
        var dnParts = parts.map(function(p) { return "DC=" + p; });
        wizBaseDN.value = dnParts.join(",");
        // 自动填充 UPN 后缀
        var upnInput = document.getElementById("wizUPNSuffix");
        if (upnInput && !upnInput.dataset.touched) upnInput.value = domain;
        // 自动填充 NetBIOS 域名（取域名第一段大写）
        var netbiosInput = document.getElementById("wizNetBIOS");
        if (netbiosInput && !netbiosInput.dataset.touched) netbiosInput.value = parts[0] ? parts[0].toUpperCase() : "";
      } else {
        wizBaseDN.value = "";
      }
    });
  }
  
  // 设置页域名自动填充 UPN/NetBIOS
  var settingsDomain = document.getElementById("settingsDomain");
  if (settingsDomain) {
    settingsDomain.addEventListener("input", function() {
      var domain = this.value.trim();
      if (domain) {
        var parts = domain.split(".");
        var upnInput = document.getElementById("settingsUPNSuffix");
        if (upnInput && !upnInput.dataset.touched) upnInput.value = domain;
        var netbiosInput = document.getElementById("settingsNetBIOS");
        if (netbiosInput && !netbiosInput.dataset.touched) netbiosInput.value = parts[0] ? parts[0].toUpperCase() : "";
      }
    });
  }
  // 标记 UPN/NetBIOS 手动修改过
  ["wizUPNSuffix", "wizNetBIOS", "settingsUPNSuffix", "settingsNetBIOS"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("input", function() { this.dataset.touched = "1"; });
  });
 
  // 侧边栏导航 - 事件委托
  var sidebarNav = document.querySelector("#sidebarNav");
  if (sidebarNav) {
    sidebarNav.addEventListener("click", function(e) {
      var item = e.target.closest(".sidebar-item");
      if (item && item.dataset.tab) {
        switchTab(item.dataset.tab);
      }
    });
  }
  
  // 也直接绑定作为备份
  document.querySelectorAll(".sidebar-item").forEach(function(item) {
    item.addEventListener("click", function() {
      if (this.dataset.tab) {
        switchTab(this.dataset.tab);
      }
    });
  });
  
  // 主题切换按钮
  var themeToggle = document.querySelector("#themeToggle");
  if (themeToggle) {
    themeToggle.addEventListener("click", function(e) {
      e.stopPropagation();
      cycleTheme();
    });
  }
  
  // 左上角 logo 点击回到首页（overview）
  var sidebarBrand = document.getElementById("sidebarBrand");
  if (sidebarBrand) {
    sidebarBrand.addEventListener("click", function() {
      switchTab("overview");
    });
  }
  
  // 用户详情弹窗的 tab 切换（事件委托）
  var detailTabs = document.querySelector(".detail-tabs");
  if (detailTabs) {
    detailTabs.addEventListener("click", function(e) {
      var tab = e.target.closest(".detail-tab");
      if (!tab || !tab.dataset.tab) return;
      // 切换按钮 active
      detailTabs.querySelectorAll(".detail-tab").forEach(function(t) { t.classList.remove("active"); });
      tab.classList.add("active");
      // 切换内容 active
      var modal = document.getElementById("userDetailModal");
      if (modal) {
        modal.querySelectorAll(".detail-tab-content").forEach(function(c) { c.classList.remove("active"); });
        var target = document.getElementById("detailTab" + capitalize(tab.dataset.tab));
        if (target) target.classList.add("active");
      }
    });
  }
  
  // 主题按钮组
  document.querySelectorAll(".theme-btn").forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      document.querySelectorAll(".theme-btn").forEach(function(b) { 
        b.classList.remove("active"); 
      });
      this.classList.add("active");
      applyTheme(this.dataset.theme);
      showToast("主题已切换");
    });
  });
  
  // 头像下拉菜单
  var adminAvatar = document.querySelector("#adminAvatar");
  if (adminAvatar) {
    adminAvatar.addEventListener("click", function(e) {
      e.stopPropagation();
      var dropdown = document.querySelector("#adminDropdown");
      if (dropdown) dropdown.classList.toggle("open");
    });
  }
  
  // 关闭下拉菜单
  document.addEventListener("click", function() {
    var dropdown = document.querySelector("#adminDropdown");
    if (dropdown) dropdown.classList.remove("open");
  });
  
  // 下拉菜单项
  document.querySelectorAll('.dropdown-item[data-action]').forEach(function(btn) {
    btn.addEventListener("click", function() {
      var dropdown = document.querySelector("#adminDropdown");
      if (dropdown) dropdown.classList.remove("open");
      var action = this.dataset.action;
      if (action === "logout") { 
        hideAdmin(); 
        showToast("已退出登录"); 
      } else if (action === "settings") {
        switchTab("settings");
      } else if (action === "feishuSettings") {
        switchTab("settings");
        // 滚动到飞书配置卡片
        setTimeout(function() {
          var feishuCard = document.querySelector("#feishuSettingsForm");
          if (feishuCard) {
            feishuCard.closest(".admin-card").scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }, 200);
      } else if (action === "changePassword") {
        openModal("changePwdModal");
      } else if (action === "adminMgmt") {
        openAdminMgmtModal();
      }
    });
  });
  
  // 修改密码模态框
  var changePwdCancel = document.querySelector("#changePwdCancel");
  if (changePwdCancel) changePwdCancel.addEventListener("click", closeModal);
  
  var changePwdForm = document.querySelector("#changePwdForm");
  if (changePwdForm) {
    changePwdForm.addEventListener("submit", async function(e) {
      e.preventDefault();
      var v = Object.fromEntries(new FormData(e.currentTarget));
      if (v.newPassword !== v.confirmPassword) { 
        showToast("两次输入的新密码不一致", "warning"); 
        return; 
      }
      try {
        await api("/api/admin/me/password", { 
          method: "PUT", 
          body: JSON.stringify({ 
            oldPassword: v.oldPassword, 
            newPassword: v.newPassword 
          }) 
        });
        showToast("密码已修改", "success"); 
        closeModal(); 
        e.currentTarget.reset();
      } catch (err) { 
        showToast(err.message, "danger"); 
      }
    });
  }
  
  // 登录表单
  var loginForm = document.querySelector("#loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", async function(e) {
      e.preventDefault();
      console.log("[login] Submitting form...");
      var v = Object.fromEntries(new FormData(e.currentTarget));
      
      // 显示加载状态
      var submitBtn = loginForm.querySelector('button[type="submit"]');
      var originalText = submitBtn ? submitBtn.innerHTML : '';
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner"></span> 登录中...';
      }
      
      try {
        var res = await fetch(API + "/api/admin/login", {
          method: "POST", 
          headers: { "Content-Type": "application/json" }, 
          body: JSON.stringify(v),
        });
        var d = await res.json();
        console.log("[login] Response:", res.status, d);
        
        if (!res.ok) {
          var errMsg = d.error || "登录失败";
          if (errMsg === "invalid_credentials") {
            errMsg = "用户名或密码错误";
          } else if (d.detail) {
            errMsg = d.detail;
          }
          throw new Error(errMsg);
        }
        
        localStorage.setItem(TOKEN_KEY, d.token);
        localStorage.setItem("ad_admin_username", d.username);
        if (d.role) {
          myRole = d.role;
          localStorage.setItem(ROLE_KEY, d.role);
        }
        if (d.permissions) {
          myPerms = d.permissions;
          localStorage.setItem(PERMS_KEY, JSON.stringify(d.permissions));
        }
        var dropdownName = document.querySelector("#dropdownName");
        var adminAvatarEl = document.querySelector("#adminAvatar");
        if (dropdownName) dropdownName.textContent = d.username;
        if (adminAvatarEl) adminAvatarEl.textContent = d.username[0].toUpperCase();
        applyRoleUI();
        
        console.log("[login] Token saved, calling showAdmin...");
        await showAdmin();
        console.log("[login] showAdmin completed successfully");
        showToast("欢迎，" + d.username, "success");
      } catch (err) {
        console.error("[login] ERROR:", err.message);
        showToast(err.message, "danger");
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = originalText;
        }
      }
    });
  }
  
  // 搜索按钮
  var searchBtn = document.querySelector("#adminSearchBtn");
  if (searchBtn) {
    searchBtn.addEventListener("click", searchUsers);
  }
  
  // 搜索输入框回车
  var searchInput = document.querySelector("#adminQuery");
  if (searchInput) {
    searchInput.addEventListener("keypress", function(e) {
      if (e.key === "Enter") {
        searchUsers();
      }
    });
  }
  
  // 模态框关闭按钮
  document.querySelectorAll('.modal-close, .modal-overlay').forEach(function(el) {
    el.addEventListener("click", function(e) {
      if (e.target === el) {
        closeModal();
      }
    });
  });
  
  // ═══ 设置页：保存配置 / 测试连接 / 填入示例值 ═══
  var adSettingsForm = document.getElementById("adSettingsForm");
  if (adSettingsForm) {
    adSettingsForm.addEventListener("submit", async function(e) {
      e.preventDefault();
      var data = collectADFormData(adSettingsForm);
      var submitBtn = adSettingsForm.querySelector('button[type="submit"]');
      var origText = submitBtn ? submitBtn.innerHTML : "";
      if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<span class="spinner"></span> 保存中...'; }
      try {
        await api("/api/admin/ad-settings", { method: "PUT", body: JSON.stringify(data) });
        showToast("域控配置已保存", "success");
        await loadADSettings();
      } catch (err) {
        showToast("保存失败: " + err.message, "danger");
      } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; }
      }
    });
  }
  
  var testADSettingsBtn = document.getElementById("testADSettings");
  if (testADSettingsBtn) {
    testADSettingsBtn.addEventListener("click", async function() {
      var form = document.getElementById("adSettingsForm");
      if (!form) return;
      var hostInput = form.querySelector('input[name="host"]');
      if (!hostInput || !hostInput.value.trim()) {
        showToast("请先填写域控地址", "warning");
        return;
      }
      var origText = testADSettingsBtn.innerHTML;
      testADSettingsBtn.disabled = true;
      testADSettingsBtn.innerHTML = '<span class="spinner"></span> 测试中...';
      try {
        var data = collectADFormData(form);
        var result = await api("/api/admin/ad-settings/test", {
          method: "POST",
          body: JSON.stringify(data)
        });
        if (result.status === "connected") {
          showToast("连接测试成功", "success");
        } else {
          showToast("连接失败: " + (result.error || "未知错误"), "danger");
        }
      } catch (err) {
        showToast("测试失败: " + err.message, "danger");
      } finally {
        testADSettingsBtn.disabled = false;
        testADSettingsBtn.innerHTML = origText;
      }
    });
  }
  
  var fillBaseBtn = document.getElementById("fillBaseDefaults");
  if (fillBaseBtn) fillBaseBtn.addEventListener("click", fillBaseDefaults);
  
  var fillOptBtn = document.getElementById("fillOptionalDefaults");
  if (fillOptBtn) fillOptBtn.addEventListener("click", function(e) { e.stopPropagation(); fillOptionalDefaults(); });

  // ═══ 飞书配置：保存 / 测试凭据 ═══
  var feishuForm = document.getElementById("feishuSettingsForm");
  if (feishuForm) {
    feishuForm.addEventListener("submit", async function(e) {
      e.preventDefault();
      await saveFeishuSettings();
    });
  }

  var testFeishuBtn = document.getElementById("testFeishuSettings");
  if (testFeishuBtn) {
    testFeishuBtn.addEventListener("click", async function() {
      var form = document.getElementById("feishuSettingsForm");
      if (!form) return;
      var appIdInput = form.querySelector('input[name="appId"]');
      if (!appIdInput || !appIdInput.value.trim()) {
        showToast("请先填写 App ID", "warning");
        return;
      }
      var origText = testFeishuBtn.innerHTML;
      testFeishuBtn.disabled = true;
      testFeishuBtn.innerHTML = '<span class="spinner"></span> 测试中...';
      try {
        var data = collectFeishuFormData(form);
        var result = await api("/api/admin/feishu-settings/test", {
          method: "POST",
          body: JSON.stringify(data)
        });
        if (result.status === "connected") {
          showToast("飞书凭据验证成功", "success");
        } else {
          showToast("验证失败: " + (result.error || "未知错误"), "danger");
        }
      } catch (err) {
        showToast("测试失败: " + err.message, "danger");
      } finally {
        testFeishuBtn.disabled = false;
        testFeishuBtn.innerHTML = origText;
      }
    });
  }
  
  // ═══ 用户详情弹窗 - 添加定时任务按钮 ═══
  var detailScheduleBtn = document.getElementById("detailScheduleBtn");
  if (detailScheduleBtn) {
    detailScheduleBtn.addEventListener("click", async function() {
      var timeInput = document.getElementById("detailScheduleTime");
      if (!timeInput || !timeInput.value) {
        showToast("请选择执行时间", "warning");
        return;
      }
      // 获取当前查看的用户账号（从详情弹窗的隐藏字段获取 samAccountName）
      var account = currentDetailAccount || "";
      if (!account) {
        showToast("无法获取用户信息", "warning");
        return;
      }
      
      var timeInput = document.getElementById("detailScheduleTime");
      if (!timeInput || !timeInput.value) {
        showToast("请选择执行时间", "warning");
        return;
      }
      // 校验：不允许选择过去的时间
      var selectedTime = new Date(timeInput.value);
      if (selectedTime < new Date()) {
        showToast("执行时间不能早于当前时间", "warning");
        return;
      }
      
      var scheduleTime = timeInput.value;
      this.disabled = true;
      this.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;"></span> 添加中...';
      try {
        // datetime-local 值格式 "YYYY-MM-DDTHH:mm" 需转为 RFC3339 (Go time.Time 要求)
        var disableAtISO = scheduleTime + ":00";
        try { disableAtISO = new Date(scheduleTime).toISOString(); } catch(e) {}
        
        await api("/api/admin/users/disable", {
          method: "POST",
          body: JSON.stringify({ account: account, disableAt: disableAtISO })
        });
        showToast("定时禁用任务已添加：" + scheduleTime, "success");
        timeInput.value = "";
        // 刷新用户详情中的定时任务列表
        showUserDetail(account);
      } catch (err) {
        showToast("添加失败: " + err.message, "danger");
      } finally {
        this.disabled = false;
        this.textContent = "添加任务";
      }
    });
  }

  // ═══ 审计日志 / 定时任务 刷新按钮 ═══
  var refreshLogsBtn = document.getElementById("refreshLogs");
  if (refreshLogsBtn) refreshLogsBtn.addEventListener("click", loadLogs);
  
  var refreshTasksBtn = document.getElementById("refreshTasks");
  if (refreshTasksBtn) refreshTasksBtn.addEventListener("click", loadTasks);
  
  // 操作筛选框变化时由 HTML onchange 内联触发 resetAuditPage()+loadLogs()，此处不再重复绑定
  
  // 新建账户表单提交
  var createForm = document.getElementById("createForm");
  if (createForm) {
    // 姓名输入时自动同步 CN、显示名、姓、名
    var createFullName = document.getElementById("createFullName");
    var createCN = document.getElementById("createCN");
    var createDisplayName = document.getElementById("createDisplayName");
    var createSurname = document.getElementById("createSurname");
    var createGivenName = document.getElementById("createGivenName");
    if (createFullName) {
      createFullName.addEventListener("input", function() {
        var name = this.value.trim();
        // 同步 CN
        if (createCN) createCN.value = name;
        // 显示名：只在用户没手动改过时同步
        if (createDisplayName && !createDisplayName.dataset.touched) {
          createDisplayName.value = name;
        }
        // 姓和名：只在用户没手动改过时自动拆分
        // 中文姓名：第一个字是姓，其余是名；英文姓名：第一个单词是名，最后一个单词是姓
        if (name) {
          // 中文姓名（含中文字符）
          if (/[\u4e00-\u9fa5]/.test(name)) {
            if (createSurname && !createSurname.dataset.touched) {
              createSurname.value = name.charAt(0);
            }
            if (createGivenName && !createGivenName.dataset.touched) {
              createGivenName.value = name.length > 1 ? name.slice(1) : "";
            }
          } else {
            // 英文姓名：第一个单词=名，最后一个单词=姓
            var parts = name.split(/\s+/);
            if (parts.length >= 2) {
              if (createGivenName && !createGivenName.dataset.touched) {
                createGivenName.value = parts[0];
              }
              if (createSurname && !createSurname.dataset.touched) {
                createSurname.value = parts[parts.length - 1];
              }
            }
          }
        }
      });
    }
    if (createDisplayName) {
      createDisplayName.addEventListener("input", function() { this.dataset.touched = "1"; });
    }
    if (createSurname) {
      createSurname.addEventListener("input", function() { this.dataset.touched = "1"; });
    }
    if (createGivenName) {
      createGivenName.addEventListener("input", function() { this.dataset.touched = "1"; });
    }
    
    // 表单内随机密码按钮
    var createPwdInline = document.getElementById("createPwdGenerateInline");
    if (createPwdInline) {
      createPwdInline.addEventListener("click", function() {
        var input = document.getElementById("createPassword");
        if (input) input.value = genRandomPassword();
      });
    }
    
    createForm.addEventListener("submit", async function(e) {
      e.preventDefault();
      var fullName = (document.getElementById("createFullName") || {}).value || "";
      var cn = (document.getElementById("createCN") || {}).value || fullName;
      var sam = (document.getElementById("createSAM") || {}).value || "";
      if (!sam) { showToast("请填写域用户名", "warning"); return; }
      // 密码：留空则自动生成
      var passwordInput = document.getElementById("createPassword");
      var password = passwordInput ? passwordInput.value.trim() : "";
      if (!password) {
        password = genRandomPassword();
        if (passwordInput) passwordInput.value = password;
      }
      
      var submitBtn = createForm.querySelector('button[type="submit"]');
      var origText = submitBtn ? submitBtn.innerHTML : "";
      if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<span class="spinner"></span> 创建中...'; }
      
      // 获取域控配置中的 UPN 后缀，用于拼接 userPrincipalName
      var upnSuffix = "";
      try {
        var settings = await api("/api/admin/ad-settings");
        upnSuffix = settings.domainUPNSuffix || "";
      } catch(e) {}
      
      var data = {
        cn: cn,
        samAccountName: sam,
        userPrincipalName: upnSuffix ? (sam + "@" + upnSuffix) : "",
        displayName: (document.getElementById("createDisplayName") || {}).value || fullName,
        givenName: (document.getElementById("createGivenName") || {}).value || "",
        surname: (document.getElementById("createSurname") || {}).value || "",
        mail: createForm.querySelector('[name="mail"]') ? createForm.querySelector('[name="mail"]').value : "",
        ou: (document.getElementById("createOU") || {}).value || "",
        password: password,
        mustChange: createForm.querySelector('[name="mustChange"]') ? createForm.querySelector('[name="mustChange"]').checked : true,
        groups: []
      };
      var checked = document.querySelectorAll("#grpCheckboxes input:checked");
      checked.forEach(function(cb) { data.groups.push(cb.value); });
      
      try {
        var result = await api("/api/admin/users", { method: "POST", body: JSON.stringify(data) });
        var finalPwd = result.password || password;
        var createdAcct = result.user && result.user.samAccountName ? result.user.samAccountName : sam;
        showToast("账号 " + createdAcct + " 创建成功，初始密码：" + finalPwd, "success", 8000);
        // 复制密码到剪贴板
        if (navigator.clipboard) {
          navigator.clipboard.writeText(finalPwd).then(function() {
            showToast("初始密码已复制到剪贴板", "success");
          }).catch(function(){});
        }
        // 重置表单
        createForm.reset();
        if (createCN) createCN.value = "";
        if (createDisplayName) delete createDisplayName.dataset.touched;
      } catch (err) {
        showToast(err.message, "danger");
      } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; }
      }
    });
  }
  
  // 新建账户密码弹窗（已废弃，密码直接在表单内处理）—— 保留兼容
  var createPwdGenerateBtn = document.getElementById("createPwdGenerateBtn");
  if (createPwdGenerateBtn) {
    createPwdGenerateBtn.addEventListener("click", function() {
      var input = document.getElementById("createPwdInput");
      if (input) input.value = genRandomPassword();
    });
  }
  
  var createPwdConfirmBtn = document.getElementById("createPwdConfirmBtn");
  if (createPwdConfirmBtn) {
    createPwdConfirmBtn.addEventListener("click", async function() {
      if (!pendingCreateData) return;
      var input = document.getElementById("createPwdInput");
      var password = input ? input.value.trim() : "";
      if (!password || password.length < 8) { showToast("密码至少需要 8 位", "warning"); return; }
      pendingCreateData.password = password;
      createPwdConfirmBtn.disabled = true;
      createPwdConfirmBtn.innerHTML = '<span class="spinner"></span> 创建中...';
      try {
        var result = await api("/api/admin/users", { method: "POST", body: JSON.stringify(pendingCreateData) });
        var finalPwd = result.password || password;
        var finalEl = document.getElementById("createPwdFinalPwd");
        var userEl = document.getElementById("createPwdResultUser");
        if (finalEl) finalEl.textContent = finalPwd;
        if (userEl) userEl.textContent = "账号 " + (result.user && result.user.samAccountName ? result.user.samAccountName : pendingCreateData.samAccountName) + " 已创建";
        document.getElementById("createPwdStep1").style.display = "none";
        document.getElementById("createPwdStep2").style.display = "block";
        var copyBtn = document.getElementById("createPwdCopyBtn");
        if (copyBtn) copyBtn.onclick = function() {
          navigator.clipboard.writeText(finalPwd).then(function() { showToast("密码已复制", "success"); });
        };
        showToast("账号创建成功", "success");
      } catch (err) {
        showToast(err.message, "danger");
      } finally {
        createPwdConfirmBtn.disabled = false;
        createPwdConfirmBtn.textContent = "创建账号";
      }
    });
  }
  
  var createPwdCancelBtn = document.getElementById("createPwdCancelBtn");
  if (createPwdCancelBtn) createPwdCancelBtn.addEventListener("click", function() {
    document.getElementById("createPwdModal").classList.remove("active");
  });
  
  var createPwdDoneBtn = document.getElementById("createPwdDoneBtn");
  if (createPwdDoneBtn) createPwdDoneBtn.addEventListener("click", function() {
    document.getElementById("createPwdModal").classList.remove("active");
    document.getElementById("createPwdStep1").style.display = "block";
    document.getElementById("createPwdStep2").style.display = "none";
    var form = document.getElementById("createForm");
    if (form) form.reset();
    pendingCreateData = null;
  });
  
  // ═══ 离职处理表单（单个 + 批量） ═══
  var offboardForm = document.getElementById("offboardForm");
  if (offboardForm) {
    offboardForm.addEventListener("submit", async function(e) {
      e.preventDefault();
      var v = Object.fromEntries(new FormData(e.currentTarget));
      if (!v.account || !v.account.trim()) {
        showToast("请输入域用户名", "warning");
        return;
      }
      var acct = v.account.trim();
      var ou = v.targetOU || "";
      // 高危二次确认
      openDangerConfirm({
        title: "离职处理",
        desc: "即将禁用账号并移动到离职 OU",
        target: acct,
        warning: "离职处理后账号将被禁用并移出原部门，组关系也会清理。",
        confirmText: "确认离职处理",
        onConfirm: async function() {
          var btn = offboardForm.querySelector('button[type="submit"]');
          var origText = btn ? btn.innerHTML : "";
          if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 处理中...'; }
          try {
            await api("/api/admin/users/offboard", {
              method: "POST",
              body: JSON.stringify({ account: acct, targetOU: ou })
            });
            showToast("离职处理完成：" + acct + " 已禁用并移至离职 OU", "success");
            offboardForm.reset();
          } catch (err) {
            showToast("离职处理失败: " + err.message, "danger");
          } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = origText; }
          }
        },
      });
    });
  }

  var batchOffboardBtn = document.getElementById("batchOffboardBtn");
  if (batchOffboardBtn) {
    batchOffboardBtn.addEventListener("click", async function() {
      var textarea = document.getElementById("batchAccounts");
      var targetOUInput = document.getElementById("batchTargetOU");
      var resultDiv = document.getElementById("batchResult");
      var accounts = textarea ? textarea.value.trim() : "";
      var targetOU = targetOUInput ? targetOUInput.value.trim() : "";
      if (!accounts) { showToast("请输入账号列表", "warning"); return; }

      var acctList = accounts.split(/\n/).map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; });
      if (acctList.length === 0) { showToast("请输入有效的账号（每行一个）", "warning"); return; }

      batchOffboardBtn.disabled = true;
      batchOffboardBtn.innerHTML = '<span class="spinner"></span> 批量处理中...';
      if (resultDiv) resultDiv.innerHTML = "";

      var success = [], failed = [];
      for (var i = 0; i < acctList.length; i++) {
        try {
          await api("/api/admin/users/offboard", {
            method: "POST",
            body: JSON.stringify({ account: acctList[i], targetOU: targetOU })
          });
          success.push(acctList[i]);
        } catch (err) {
          failed.push(acctList[i] + ": " + err.message);
        }
      }

      if (resultDiv) {
        var html = '<div style="margin-top:8px;">';
        html += '<div style="color:var(--success-600);font-size:13px;margin-bottom:4px;">✓ 成功 ' + success.length + ' 个</div>';
        if (failed.length > 0) {
          html += '<div style="color:var(--danger-600);font-size:13px;">✕ 失败 ' + failed.length + ' 个:</div>';
          failed.forEach(function(f) { html += '<div style="color:var(--danger-500);font-size:12px;padding-left:12px;">' + escJS(f) + '</div>'; });
        } else {
          html += '<div style="color:var(--success-600);font-size:12px;">全部成功！</div>';
        }
        html += '</div>';
        resultDiv.innerHTML = html;
      }

      batchOffboardBtn.disabled = false;
      batchOffboardBtn.textContent = "批量禁用并移入离职 OU";
    });
  }

  // 刷新选项按钮
  var refreshOptionsBtn = document.getElementById("refreshOptions");
  if (refreshOptionsBtn) refreshOptionsBtn.addEventListener("click", function() {
    this.innerHTML = '<span class="spinner"></span>';
    var self = this;
    loadOptions().then(function() {
      self.innerHTML = "🔄 刷新选项";
      showToast("选项已刷新", "success");
    });
  });
  
  // ═══ 密码显示/隐藏切换（所有 .pwd-toggle 按钮） ═══
  document.querySelectorAll(".pwd-toggle").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var targetId = this.dataset.target;
      var input = document.getElementById(targetId);
      if (!input) return;
      var eye = btn.querySelector(".icon-eye");
      var eyeSlash = btn.querySelector(".icon-eye-slash");
      if (input.type === "password") {
        input.type = "text";
        if (eye) eye.style.display = "none";
        if (eyeSlash) eyeSlash.style.display = "block";
        btn.title = "隐藏密码";
      } else {
        input.type = "password";
        if (eye) eye.style.display = "block";
        if (eyeSlash) eyeSlash.style.display = "none";
        btn.title = "显示密码";
      }
    });
  });
  
  // ═══ OU/组同步范围「检测」按钮 ═══
  // 说明：OU 范围和组范围都需要填「OU 容器」，不是具体的组 CN。
  // 因此两者都调 /api/admin/ous 获取组织单位列表。
  function bindDetectBtn(btnId, inputId, scopeType) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener("click", async function() {
      // 找到所在的表单，收集基础连接字段
      var form = btn.closest("form");
      if (!form) return;
      var hostInput = form.querySelector('input[name="host"]');
      var baseDNInput = form.querySelector('input[name="baseDN"]');
      if (!hostInput || !hostInput.value.trim()) {
        showToast("请先填写域控地址", "warning");
        return;
      }
      if (!baseDNInput || !baseDNInput.value.trim()) {
        showToast("请先填写 Base DN", "warning");
        return;
      }
      var origText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 检测中...';
      try {
        // 先临时保存配置，让后端 discover 接口能用
        var data = collectADFormData(form);
        await api("/api/admin/ad-settings", { method: "PUT", body: JSON.stringify(data) });
        // 无论是 OU 同步范围还是组同步范围，都需要选择 OU 容器
        var resp = await api("/api/admin/ous");
        var entries = Array.isArray(resp) ? resp : [];
        if (entries.length === 0) {
          // 检测成功但无数据，回退到从 Base DN 自动生成
          autoGenScope(inputId, scopeType, baseDNInput.value.trim());
          showToast("域控未返回 OU 数据，已从 Base DN 自动生成，请核对", "info");
        } else {
          // 弹出选择列表
          showScopePicker(entries, inputId, scopeType);
        }
      } catch (err) {
        // 检测失败，回退到从 Base DN 自动生成
        autoGenScope(inputId, scopeType, baseDNInput.value.trim());
        showToast("检测失败（" + err.message + "），已从 Base DN 自动生成", "warning");
      } finally {
        btn.disabled = false;
        btn.innerHTML = origText;
      }
    });
  }
  bindDetectBtn("wizDetectOU", "wizOuScope", "ou");
  bindDetectBtn("wizDetectGroup", "wizGroupScope", "group");
  bindDetectBtn("wizDetectDisabledOU", "wizDisabledOU", "disabledOU");
  bindDetectBtn("settingsDetectOU", "settingsOuScope", "ou");
  bindDetectBtn("settingsDetectGroup", "settingsGroupScope", "group");
  bindDetectBtn("settingsDetectDisabledOU", "settingsDisabledOU", "disabledOU");
  
  console.log("[initDOMListeners] Event listeners setup complete");
}

// 从 Base DN 自动生成 OU/组同步范围/离职 OU
function autoGenScope(inputId, scopeType, baseDN) {
  var input = document.getElementById(inputId);
  if (!input) return;
  var prefix;
  if (scopeType === "ou") prefix = "OU=Users,";
  else if (scopeType === "group") prefix = "OU=Groups,";
  else if (scopeType === "disabledOU") prefix = "OU=Disabled Users,";
  else prefix = "OU=Users,";
  input.value = prefix + baseDN;
}

// 弹出 OU/组选择列表
function showScopePicker(entries, inputId, scopeType) {
  // 移除已有弹窗
  var old = document.getElementById("scopePicker");
  if (old) old.remove();
  
  var titles = {
    ou: "选择 OU（部门）",
    group: "选择组所在 OU",
    disabledOU: "选择离职 OU"
  };
  var title = titles[scopeType] || "选择 OU";
  var html = '<div class="modal active" id="scopePicker"><div class="modal-content" style="max-width:520px">';
  html += '<div class="modal-header"><h3 class="modal-title">🔍 ' + title + '</h3></div>';
  html += '<div class="modal-body">';
  html += '<input id="scopePickerSearch" placeholder="搜索..." class="form-input" style="width:100%;margin-bottom:12px" oninput="filterScopePicker(this.value)"/>';
  html += '<div id="scopePickerList" style="max-height:320px;overflow-y:auto">';
  entries.forEach(function(e) {
    var label = e.label || e.name || e.value;
    var value = e.value || e.dn || "";
    var desc = e.description ? " — " + e.description : "";
    html += '<div class="scope-pick-item" data-value="' + escJS(value) + '" data-label="' + escJS(label.toLowerCase()) + '" onclick="pickScope(\'' + escJS(inputId) + '\',\'' + escJS(value) + '\')" style="padding:10px 12px;border:1px solid var(--border-subtle);border-radius:var(--radius-lg);margin-bottom:6px;cursor:pointer;font-size:13px;">';
    html += '<div style="font-weight:500;">' + escJS(label) + '</div>';
    if (desc) html += '<div style="font-size:11px;color:var(--text-tertiary);">' + escJS(e.description) + '</div>';
    html += '<div style="font-size:11px;color:var(--text-tertiary);margin-top:2px;font-family:monospace;">' + escJS(value) + '</div>';
    html += '</div>';
  });
  html += '</div></div>';
  html += '<div class="modal-footer">';
  html += '<button class="btn btn-secondary" onclick="document.getElementById(\'scopePicker\').remove()">取消</button>';
  html += '</div></div></div>';
  
  var div = document.createElement("div");
  div.innerHTML = html;
  document.body.appendChild(div);
}

function filterScopePicker(q) {
  var lowerQ = (q || "").toLowerCase();
  document.querySelectorAll("#scopePickerList .scope-pick-item").forEach(function(el) {
    el.style.display = (!q || el.dataset.label.indexOf(lowerQ) >= 0) ? "block" : "none";
  });
}

function pickScope(inputId, value) {
  var input = document.getElementById(inputId);
  if (input) input.value = value;
  var picker = document.getElementById("scopePicker");
  if (picker) picker.remove();
  showToast("已填入", "success");
}

var pendingCreateData = null;

// ═══════════════════════════════════════════════════════════════════════════
// Search & User Management
// ═══════════════════════════════════════════════════════════════════════════
let lastSearchResults = [];

async function searchUsers() {
  var queryEl = document.querySelector("#adminQuery");
  var q = queryEl ? queryEl.value.trim() : "";
  var result = document.querySelector("#adminResult");
  var btn = document.querySelector("#adminSearchBtn");

  if (!result) return;

  // 空查询时显示提示，不发起请求
  if (!q) {
    result.innerHTML = '<div class="empty-state" style="padding:60px 0;text-align:center;"><div style="font-size:48px;margin-bottom:12px;opacity:0.3;">🔍</div><div style="color:var(--text-tertiary);font-size:var(--text-sm);">输入姓名或用户名开始搜索</div></div>';
    lastSearchResults = [];
    totalUsers = 0;
    return;
  }
  
  // 显示加载状态
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 搜索中...';
  }
  result.innerHTML = '<div class="loading-spinner"><div class="spinner spinner-large"></div><p>正在搜索...</p></div>';
  
  try {
    // 后端路由是 GET /api/admin/users?q=...（不是 /search），返回的是数组
    var data = await api("/api/admin/users?q=" + encodeURIComponent(q));
    lastSearchResults = Array.isArray(data) ? data : (data.users || []);
    totalUsers = lastSearchResults.length;
    currentPage = 1;
    renderUserList();
  } catch (err) {
    result.innerHTML = '<div class="error-message"><p>搜索失败: ' + err.message + '</p></div>';
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "搜索";
    }
  }
}

function renderUserList() {
  var result = document.querySelector("#adminResult");
  if (!result) return;
  
  var start = (currentPage - 1) * pageSize;
  var end = start + pageSize;
  var pageUsers = lastSearchResults.slice(start, end);
  
  if (pageUsers.length === 0) {
    result.innerHTML = '<div class="empty-state-illustrated"><svg class="empty-illustration" width="120" height="120" viewBox="0 0 120 120" fill="none"><circle cx="60" cy="60" r="56" stroke="var(--primary-200)" stroke-width="2" fill="var(--primary-50)" opacity="0.6"/><circle cx="60" cy="60" r="40" stroke="var(--primary-300)" stroke-width="1.5" fill="var(--primary-50)" opacity="0.3"/><line x1="45" y1="52" x2="75" y2="52" stroke="var(--primary-400)" stroke-width="3" stroke-linecap="round"/><line x1="45" y1="60" x2="68" y2="60" stroke="var(--primary-300)" stroke-width="3" stroke-linecap="round"/><line x1="45" y1="68" x2="62" y2="68" stroke="var(--primary-200)" stroke-width="3" stroke-linecap="round"/><circle cx="82" cy="38" r="10" stroke="var(--primary-500)" stroke-width="2" fill="var(--primary-100)"/><line x1="89" y1="45" x2="96" y2="52" stroke="var(--primary-500)" stroke-width="2" stroke-linecap="round"/></svg><div class="empty-title">暂无匹配结果</div><div class="empty-desc">请尝试其他搜索关键词</div></div>';
    return;
  }
  
  var html = '<div class="user-grid">';
  pageUsers.forEach(function(user, idx) {
    var pwdInfo = pwdExpiryInfo(user.pwdLastSet, user.passwordNeverExpires, pwdMaxAgeDays, user.passwordExpiresAt);
    var lastLogin = adTimeToString(user.lastLogon);
    // 后端 User 结构体的 JSON tag 是 samAccountName / enabled，不是 sAMAccountName / userAccountControl
    var acct = user.samAccountName || "";
    var statusClass = user.enabled === false ? "disabled" : "active";
    
    html += '<div class="user-card" onclick="showUserDetail(\'' + escJS(acct) + '\')" style="animation-delay: ' + (idx * 0.05) + 's">';
    html += '<div class="user-card-header">';
    html += '<div class="user-avatar">' + (acct ? acct[0].toUpperCase() : '?') + '</div>';
    html += '<div class="user-info">';
    html += '<div class="user-name">' + escHTML(user.displayName || acct || '-') + '</div>';
    html += '<div class="user-account">' + escHTML(acct || '-') + '</div>';
    html += '</div>';
    html += '<div class="user-status-badge ' + statusClass + '">' + (statusClass === "disabled" ? "已禁用" : "正常") + '</div>';
    html += '</div>';
    html += '<div class="user-card-body">';
    html += '<div class="user-meta-row"><div class="user-meta"><span class="meta-label">最后登录</span><span class="meta-value">' + escHTML(lastLogin) + '</span></div>';
    html += '<div class="user-meta"><span class="meta-label">密码状态</span><span class="meta-value pwd-' + pwdInfo.cls + '">' + escHTML(pwdInfo.text) + '</span></div></div>';
    html += '</div>';
    html += '<div class="user-card-actions">';
    html += '<button class="btn btn-sm btn-ghost" title="重置密码" style="display:inline-flex;align-items:center;gap:4px;" onclick="event.stopPropagation();openResetModal(\'' + escJS(acct) + '\')">';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';
    html += '<span>重置密码</span>';
    html += '</button>';
    html += '<button class="btn btn-sm btn-ghost" title="加入组" style="display:inline-flex;align-items:center;gap:4px;" onclick="event.stopPropagation();promptAddGroup(\'' + escJS(acct) + '\')">';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
    html += '<span>加入组</span>';
    html += '</button>';
    html += '</div>';
    html += '</div>';
  });
  html += '</div>';
  
  // 分页
  if (totalUsers > pageSize) {
    var totalPages = Math.ceil(totalUsers / pageSize);
    html += '<div class="pagination">';
    html += '<button class="page-btn" onclick="prevPage()" ' + (currentPage === 1 ? 'disabled' : '') + '>';
    html += '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M15 18l-6-6 6-6"/></svg>';
    html += '</button>';
    html += '<span class="page-info">' + currentPage + ' / ' + totalPages + ' <small>(' + totalUsers + '条)</small></span>';
    html += '<button class="page-btn" onclick="nextPage()" ' + (currentPage >= totalPages ? 'disabled' : '') + '>';
    html += '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 18l6-6-6-6"/></svg>';
    html += '</button>';
    html += '</div>';
  }
  
  result.innerHTML = html;
}

function prevPage() {
  if (currentPage > 1) {
    currentPage--;
    renderUserList();
  }
}

function nextPage() {
  var totalPages = Math.ceil(totalUsers / pageSize);
  if (currentPage < totalPages) {
    currentPage++;
    renderUserList();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// User Detail Modal
// ═══════════════════════════════════════════════════════════════════════════
async function showUserDetail(account) {
  try {
    // 后端返回 {user, scheduledTasks, recentLogs}
    var resp = await api("/api/admin/users/detail?account=" + encodeURIComponent(account));
    var modal = document.getElementById("userDetailModal");
    if (!modal) return;
    
    var user = resp.user || {};
    var scheduledTasks = resp.scheduledTasks || [];
    var recentLogs = resp.recentLogs || [];
    var acct = user.samAccountName || account;
    currentDetailAccount = acct;
    
    // 头部
    setText("detailAvatar", acct ? acct[0].toUpperCase() : "U");
    setText("detailDisplayName", user.displayName || acct || "-");
    setText("detailAccount", user.userPrincipalName || acct || "-");
    var statusEl = document.getElementById("detailStatus");
    if (statusEl) {
      var badges = [];
      if (user.enabled === false) badges.push('<span class="status-badge disabled">已禁用</span>');
      else badges.push('<span class="status-badge active">启用</span>');
      if (user.locked) badges.push('<span class="status-badge locked">已锁定</span>');
      statusEl.innerHTML = badges.join(" ");
    }
    
    // 基本信息 grid
    var infoGrid = document.getElementById("detailInfoGrid");
    if (infoGrid) {
      var rows = [
        ["域用户名", user.samAccountName],
        ["UPN", user.userPrincipalName],
        ["邮箱", user.mail],
        ["部门", user.department],
        ["职位", user.title],
        ["电话", user.telephoneNumber],
        ["描述", user.description],
        ["DN", user.dn],
        ["最后登录", adTimeToString(user.lastLogon)],
        ["创建时间", adTimeToString(user.whenCreated)],
        ["密码状态", pwdExpiryInfo(user.pwdLastSet, user.passwordNeverExpires, pwdMaxAgeDays, user.passwordExpiresAt).text]
      ];
      infoGrid.innerHTML = rows.map(function(r) {
        return '<div class="detail-item"><span class="detail-label">' + escHTML(r[0]) + '</span><span class="detail-value">' + escHTML(r[1] || "-") + '</span></div>';
      }).join("");
    }
    
    // 组成员
    var groupsList = document.getElementById("detailGroupsList");
    if (groupsList) {
      groupsList.innerHTML = '';
      if (user.memberOf && user.memberOf.length > 0) {
        user.memberOf.forEach(function(g) {
          var groupName = g.match(/CN=([^,]+)/);
          var div = document.createElement("div");
          div.className = "group-tag";
          div.innerHTML = '<span class="group-name">' + escHTML(groupName ? groupName[1] : g) + '</span>';
          div.onclick = function() { promptRemoveGroup(account, g); };
          groupsList.appendChild(div);
        });
      } else {
        groupsList.innerHTML = '<div class="empty-hint">无组成员</div>';
      }
    }
    
    // 定时任务
    var scheduleList = document.getElementById("detailScheduleList");
    if (scheduleList) {
      if (scheduledTasks.length > 0) {
        scheduleList.innerHTML = scheduledTasks.map(function(t) {
          return '<div class="detail-item"><span class="detail-label">' + (t.action || "禁用") + '</span><span class="detail-value">' + formatTime(t.scheduledAt) + '</span></div>';
        }).join("");
      } else {
        scheduleList.innerHTML = '<div class="empty-hint">无定时任务</div>';
      }
    }
    
    // 操作记录
    var historyList = document.getElementById("detailHistoryList");
    if (historyList) {
      if (recentLogs.length > 0) {
        historyList.innerHTML = recentLogs.map(function(l) {
          return '<div class="detail-item"><span class="detail-label">' + escHTML(formatTime(l.createdAt)) + '</span><span class="detail-value">' + escHTML(actionLabel(l.action)) + ' ' + escHTML(l.detail || "") + '</span></div>';
        }).join("");
      } else {
        historyList.innerHTML = '<div class="empty-hint">无操作记录</div>';
      }
    }
    
    // 操作按钮 —— 按角色权限矩阵渲染
    var actionsEl = document.getElementById("detailActions");
    if (actionsEl) {
      actionsEl.innerHTML = '';
      var btns = [];
      if (user.locked && hasPerm("unlock")) btns.push('<button class="btn btn-secondary btn-sm" onclick="doUnlock(\'' + escJS(acct) + '\')">🔓 解锁</button>');
      if (user.enabled === false) {
        if (hasPerm("enable")) btns.push('<button class="btn btn-primary btn-sm" onclick="doEnable(\'' + escJS(acct) + '\')">✅ 启用</button>');
      } else {
        if (hasPerm("disable")) btns.push('<button class="btn btn-warning btn-sm" onclick="doDisable(\'' + escJS(acct) + '\')">🚫 禁用</button>');
      }
      if (hasPerm("resetPwd")) {
        btns.push('<button class="btn btn-secondary btn-sm" style="display:inline-flex;align-items:center;gap:4px;" onclick="openResetModal(\'' + escJS(acct) + '\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg> 重置密码</button>');
      }
      if (hasPerm("addGroup")) {
        btns.push('<button class="btn btn-secondary btn-sm" style="display:inline-flex;align-items:center;gap:4px;" onclick="promptAddGroup(\'' + escJS(acct) + '\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> 加入组</button>');
      }
      if (hasPerm("offboard")) btns.push('<button class="btn btn-danger btn-sm" onclick="doOffboard(\'' + escJS(acct) + '\')">🚪 离职</button>');
      if (hasPerm("delete")) btns.push('<button class="btn btn-danger btn-sm" onclick="doDeleteUser(\'' + escJS(acct) + '\')">🗑 删除账号</button>');
      actionsEl.innerHTML = btns.join("");
      if (btns.length === 0) {
        actionsEl.innerHTML = '<div style="color: var(--text-tertiary); font-size: 12px; padding: 8px 0;">当前角色无操作权限</div>';
      }
    }
    
    // 设置执行时间的最小值为当前时间（禁止选择过去时间）
    var timeInput = document.getElementById("detailScheduleTime");
    if (timeInput) {
      var now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      timeInput.min = now.toISOString().slice(0, 16);
      timeInput.value = "";
    }
    
    modal.classList.add("active");
  } catch (err) {
    showToast("获取用户详情失败: " + err.message, "danger");
  }
}

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text;
}

function closeUserDetail() {
  var modal = document.getElementById("userDetailModal");
  if (modal) modal.classList.remove("active");
}

async function doUnlock(account) {
  try {
    await api("/api/admin/users/unlock", { method: "POST", body: JSON.stringify({ account: account }) });
    showToast("已解锁", "success");
    showUserDetail(account);
  } catch (err) { showToast(err.message, "danger"); }
}

async function doEnable(account) {
  try {
    await api("/api/admin/users/enable", { method: "POST", body: JSON.stringify({ account: account }) });
    showToast("已启用", "success");
    showUserDetail(account);
  } catch (err) { showToast(err.message, "danger"); }
}

async function doDisable(account) {
  openDangerConfirm({
    title: "禁用账号",
    desc: "即将在 AD 中禁用此账号",
    target: account,
    warning: "禁用后用户将无法登录，但账号仍保留可随时启用。",
    confirmText: "确认禁用",
    onConfirm: async function() {
      try {
        await api("/api/admin/users/disable", { method: "POST", body: JSON.stringify({ account: account }) });
        showToast("已禁用", "success");
        showUserDetail(account);
      } catch (err) { showToast(err.message, "danger"); }
    },
  });
}

async function doOffboard(account) {
  openDangerConfirm({
    title: "离职处理",
    desc: "即将禁用账号并移动到离职 OU",
    target: account,
    warning: "离职处理后账号将被禁用并移出原部门，组关系也会清理。",
    confirmText: "确认离职处理",
    onConfirm: async function() {
      try {
        await api("/api/admin/users/offboard", { method: "POST", body: JSON.stringify({ account: account, targetOU: "" }) });
        showToast("离职处理完成", "success");
        closeUserDetail();
        searchUsers();
      } catch (err) { showToast(err.message, "danger"); }
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// AD Settings
// ═══════════════════════════════════════════════════════════════════════════
async function loadADSettings() {
  try {
    // 后端直接返回扁平的 ADSettings 结构，没有 configured/settings 包装字段。
    // 用 host 是否为空来判断"是否已配置"。
    var data = await api("/api/admin/ad-settings");
    adConfigured = !!(data && data.host && data.host.trim());
    if (data && data.passwordMaxAgeDays) pwdMaxAgeDays = data.passwordMaxAgeDays;
    
    // 回填设置页表单（直接用返回的扁平结构）
    var form = document.getElementById("adSettingsForm");
    if (form && data) {
      Object.keys(data).forEach(function(key) {
        var input = form.querySelector('input[name="' + key + '"]');
        if (!input) return;
        // bindPassword 不回填明文（安全脱敏），用 placeholder 提示已设置
        if (key === "bindPassword") {
          input.value = "";
          if (data.bindUsername) {
            input.placeholder = "已设置（留空不修改）";
          } else {
            input.placeholder = "请输入绑定密码";
          }
          return;
        }
        if (input.type === "checkbox") {
          input.checked = !!data[key];
        } else {
          input.value = data[key] || "";
        }
      });
    }
    
    updateConnStatus(adConfigured);
    return data;
  } catch (err) {
    console.warn("Load AD settings error:", err);
    return { configured: false };
  }
}

async function saveWizardSettings() {
  var form = document.getElementById("wizardForm");
  if (!form) return;
  
  var data = collectADFormData(form);
  
  var btn = document.getElementById("wizardSaveBtn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 保存中...';
  }
  
  try {
    await api("/api/admin/ad-settings", {
      method: "PUT",
      body: JSON.stringify(data)
    });
    showToast("域控连接配置已保存", "success");
    hideSetupWizard();
    await loadADSettings();
    await loadOptions();
  } catch (err) {
    showToast("保存失败: " + err.message, "danger");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "保存并开始使用";
    }
  }
}

// 把表单数据收集成后端期望的 JSON 结构。
// 关键：checkbox 必须转成真正的 bool，port 必须转成 number，
// 否则 Go 的 encoding/json 会因为类型不匹配直接报 invalid_json。
function collectADFormData(form) {
  var data = {};
  // 文本/数字输入
  form.querySelectorAll("input").forEach(function(input) {
    var name = input.name;
    if (!name) return;
    if (input.type === "checkbox") {
      data[name] = input.checked;
    } else if (input.type === "number") {
      var v = parseInt(input.value, 10);
      data[name] = isNaN(v) ? 0 : v;
    } else {
      data[name] = input.value;
    }
  });
  // select
  form.querySelectorAll("select").forEach(function(sel) {
    if (sel.name) data[sel.name] = sel.value;
  });
  // textarea
  form.querySelectorAll("textarea").forEach(function(ta) {
    if (ta.name) data[ta.name] = ta.value;
  });
  return data;
}

function updateConnStatus(connected) {
  var status = document.getElementById("connStatus");
  if (!status) return;
  var dot = document.getElementById("connDot");
  var label = document.getElementById("connLabel");
  
  // 移除旧状态类
  status.className = "conn-status";
  if (dot) dot.className = "conn-dot";
  
  if (connected) {
    status.classList.add("connected");
    if (dot) dot.classList.add("connected");
    if (label) label.textContent = "已连接";
  } else {
    status.classList.add("disconnected");
    if (dot) dot.classList.add("error");
    if (label) label.textContent = "未连接";
  }
}

async function startConnCheck() {
  // 立即检测一次，再设置定时
  async function checkOnce() {
    try {
      // 后端返回 {status: "connected" | "disconnected" | "not_configured" | "error"}
      var data = await api("/api/admin/ad-settings/connectivity");
      updateConnStatus(data.status === "connected");
    } catch (err) {
      updateConnStatus(false);
    }
  }
  checkOnce();
  setInterval(checkOnce, 30000);
}

// ═══════════════════════════════════════════════════════════════════════════
// Feishu Settings
// ═══════════════════════════════════════════════════════════════════════════
async function loadFeishuSettings() {
  try {
    var data = await api("/api/admin/feishu-settings");
    var form = document.getElementById("feishuSettingsForm");
    if (form && data) {
      setFormValue(form, "appId", data.appId || "");
      setFormValue(form, "redirectUri", data.redirectUri || "");
      setFormValue(form, "sessionDurationHours", data.sessionDurationHours || 8);
      var enabledInput = form.querySelector('input[name="enabled"]');
      if (enabledInput) enabledInput.checked = !!data.enabled;
      var secretInput = form.querySelector('input[name="appSecret"]');
      if (secretInput) {
        secretInput.value = "";
        secretInput.placeholder = data.appSecretSet ? "已设置（留空不修改）" : "请输入 App Secret";
      }
    }
    // 更新状态徽章
    var badge = document.getElementById("feishuStatusBadge");
    if (badge) {
      if (data.configured && data.enabled) {
        badge.textContent = "已启用";
        badge.className = "badge badge-success";
      } else if (data.configured) {
        badge.textContent = "已配置（未启用）";
        badge.className = "badge badge-warning";
      } else {
        badge.textContent = "未配置";
        badge.className = "badge badge-neutral";
      }
    }
    // 更新回调地址提示
    var hint = document.getElementById("feishuRedirectHint");
    if (hint) {
      if (data.redirectUri) {
        hint.textContent = data.redirectUri;
      } else {
        // 生成默认提示
        hint.textContent = location.origin + "/api/auth/feishu/callback";
      }
    }
    // secret 提示
    var secretHint = document.getElementById("feishuSecretHint");
    if (secretHint) {
      if (data.envSourced) {
        secretHint.textContent = "ℹ️ 当前使用环境变量配置，保存后将转为数据库管理";
      } else if (data.appSecretSet) {
        secretHint.textContent = "✓ App Secret 已设置";
      } else {
        secretHint.textContent = "";
      }
    }
    return data;
  } catch (err) {
    console.warn("Load Feishu settings error:", err);
    return null;
  }
}

async function saveFeishuSettings() {
  var form = document.getElementById("feishuSettingsForm");
  if (!form) return;
  var data = collectFeishuFormData(form);
  var submitBtn = form.querySelector('button[type="submit"]');
  var origText = submitBtn ? submitBtn.innerHTML : "";
  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<span class="spinner"></span> 保存中...'; }
  try {
    await api("/api/admin/feishu-settings", { method: "PUT", body: JSON.stringify(data) });
    showToast("飞书配置已保存", "success");
    await loadFeishuSettings();
  } catch (err) {
    showToast("保存失败: " + err.message, "danger");
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; }
  }
}

function collectFeishuFormData(form) {
  var data = {};
  form.querySelectorAll("input").forEach(function(input) {
    var name = input.name;
    if (!name) return;
    if (input.type === "checkbox") {
      data[name] = input.checked;
    } else if (input.type === "number") {
      var v = parseInt(input.value, 10);
      data[name] = isNaN(v) ? 0 : v;
    } else {
      data[name] = input.value;
    }
  });
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════
// Load Options (OUs, Groups)
// ═══════════════════════════════════════════════════════════════════════════
async function loadOptions() {
  try {
    // 后端 /api/admin/ous 和 /api/admin/groups 都返回数组 [{label,value,description}]
    var [ousResp, groupsResp] = await Promise.all([
      api("/api/admin/ous").catch(function(){ return []; }),
      api("/api/admin/groups").catch(function(){ return []; })
    ]);
    var ous = Array.isArray(ousResp) ? ousResp : (ousResp.ous || []);
    var groups = Array.isArray(groupsResp) ? groupsResp : (groupsResp.groups || []);
    
    // 填充新建账户页的部门下拉框（id=createOU）
    var ouSelect = document.getElementById("createOU");
    if (ouSelect) {
      ouSelect.innerHTML = '<option value="">请选择部门</option>';
      ous.forEach(function(ou) {
        var opt = document.createElement("option");
        opt.value = ou.value || ou.dn || "";
        opt.textContent = ou.label || ou.name + (ou.description ? " - " + ou.description : "");
        ouSelect.appendChild(opt);
      });
    }
    
    // 填充新建账户页的组复选框（id=grpCheckboxes）
    var grpBox = document.getElementById("grpCheckboxes");
    if (grpBox) {
      grpBox.innerHTML = '';
      if (groups.length > 0) {
        groups.forEach(function(g) {
          var label = document.createElement("label");
          label.className = "grp-checkbox-item";
          label.style.cssText = "display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:12px;cursor:pointer;background:var(--bg-surface);";
          var cb = document.createElement("input");
          cb.type = "checkbox";
          cb.value = g.value || g.dn || "";
          label.appendChild(cb);
          label.appendChild(document.createTextNode(g.label || g.name || g.value));
          if (g.description) label.title = g.description;
          grpBox.appendChild(label);
        });
      } else {
        grpBox.innerHTML = '<span style="color:var(--text-tertiary);font-size:12px;">未加载到组选项，请检查域控配置中的"组同步范围"</span>';
      }
    }
  } catch (err) {
    console.warn("Load options error:", err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Logs & Tasks
// ═══════════════════════════════════════════════════════════════════════════
var auditFilterType = "all"; // all | admin | user
var auditRefreshTimer = null;
// 审计日志分页状态（后端分页 + 筛选）
var auditPage = 1;
var auditPageSize = 20;
var auditTotal = 0;

function setAuditFilter(type) {
  auditFilterType = type;
  document.querySelectorAll(".audit-filter-tab").forEach(function(tab) {
    tab.classList.toggle("active", tab.dataset.filter === type);
  });
  renderLogs();
}

function setAuditRefresh(seconds) {
  if (auditRefreshTimer) { clearInterval(auditRefreshTimer); auditRefreshTimer = null; }
  var statusEl = document.getElementById("auditRefreshStatus");
  if (seconds > 0) {
    auditRefreshTimer = setInterval(loadLogs, seconds * 1000);
    if (statusEl) statusEl.textContent = "每 " + seconds + "s 刷新";
  } else {
    if (statusEl) statusEl.textContent = "";
  }
}

// 保存最近一次拉取的日志，供前端筛选时复用
var lastAuditLogs = [];
// 当前用户详情弹窗中查看的 samAccountName（供添加任务等操作使用）
var currentDetailAccount = "";

async function loadLogs() {
  var container = document.getElementById("auditLogs");
  if (!container) return;

  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

  try {
    // 收集筛选条件，全部走后端查询（支持 actor/action/target/时间范围/分页）
    var params = [];
    var af = document.getElementById("auditActionFilter");
    var action = af ? af.value : "";
    if (action) params.push("action=" + encodeURIComponent(action));
    var actorEl = document.getElementById("auditActorInput");
    var actor = actorEl ? actorEl.value.trim() : "";
    if (actor) params.push("actor=" + encodeURIComponent(actor));
    var targetEl = document.getElementById("auditSearch");
    var target = targetEl ? targetEl.value.trim() : "";
    if (target) params.push("target=" + encodeURIComponent(target));
    var sd = document.getElementById("auditStartDate");
    var ed = document.getElementById("auditEndDate");
    var startDate = (sd && sd.value) ? sd.value.replace("T", " ") : "";
    var endDate = (ed && ed.value) ? ed.value.replace("T", " ") : "";
    if (startDate) params.push("startDate=" + encodeURIComponent(startDate));
    if (endDate) params.push("endDate=" + encodeURIComponent(endDate));
    params.push("page=" + auditPage);
    params.push("pageSize=" + auditPageSize);

    var data = await api("/api/admin/audit-logs?" + params.join("&"));
    // 兼容旧格式（数组）与新格式（{logs,total}）
    lastAuditLogs = Array.isArray(data) ? data : (data.logs || []);
    auditTotal = (data && typeof data.total === "number") ? data.total : lastAuditLogs.length;
    renderLogs();
    renderAuditPagination();
  } catch (err) {
    container.innerHTML = '<div class="error-message">加载日志失败: ' + err.message + '</div>';
  }
}

// 筛选条件变化时重置到第1页再查询
function resetAuditPage() { auditPage = 1; }
function auditDebouncedLoad() {
  clearTimeout(window._auditDebounce);
  window._auditDebounce = setTimeout(function() {
    resetAuditPage();
    loadLogs();
  }, 400);
}

// 分页跳转
function auditGoPage(n) {
  var totalPages = Math.max(1, Math.ceil(auditTotal / auditPageSize));
  if (n < 1) n = 1;
  if (n > totalPages) n = totalPages;
  if (n === auditPage) return;
  auditPage = n;
  loadLogs();
}

function renderAuditPagination() {
  var el = document.getElementById("auditPagination");
  if (!el) return;
  if (auditTotal === 0) { el.innerHTML = ""; return; }
  var totalPages = Math.max(1, Math.ceil(auditTotal / auditPageSize));
  var html = "";
  html += '<button class="btn btn-ghost btn-sm" onclick="auditGoPage(' + (auditPage - 1) + ')" ' + (auditPage <= 1 ? 'disabled' : '') + '>上一页</button>';
  html += '<span style="font-size:12px;color:var(--text-secondary);">' + auditPage + ' / ' + totalPages + ' 页</span>';
  html += '<button class="btn btn-ghost btn-sm" onclick="auditGoPage(' + (auditPage + 1) + ')" ' + (auditPage >= totalPages ? 'disabled' : '') + '>下一页</button>';
  html += '<span style="font-size:11px;color:var(--text-tertiary);">跳至</span>';
  html += '<input type="number" min="1" max="' + totalPages + '" value="' + auditPage + '" style="width:56px;padding:2px 6px;font-size:12px;border:1px solid var(--border-default);border-radius:6px;" onchange="auditGoPage(parseInt(this.value)||1)"/>';
  html += '<span style="font-size:11px;color:var(--text-tertiary);">页</span>';
  el.innerHTML = html;
}

function renderLogs() {
  var container = document.getElementById("auditLogs");
  if (!container) return;

  // tab 仅对当前页做快速过滤（管理员/普通用户）；操作类型、操作者、目标账号已走后端筛选
  var logs = lastAuditLogs.filter(function(log) {
    var isAdminRole = log.role === "admin" || log.role === "super_admin" || log.role === "hr_admin" || log.role === "helpdesk";
    if (auditFilterType === "admin" && !isAdminRole) return false;
    if (auditFilterType === "user" && log.role !== "user") return false;
    return true;
  });

  if (logs.length > 0) {
    // 表头
    var html = '<div class="log-table">' +
               '<div class="log-header">' +
                 '<span class="log-col-time">时间</span>' +
                 '<span class="log-col-action">操作</span>' +
                 '<span class="log-col-actor">操作人</span>' +
                 '<span class="log-col-detail">详情</span>' +
                 '<span class="log-col-status">状态</span>' +
                 '<span class="log-col-ip">IP</span>' +
               '</div>';

    // 数据行
    html += logs.map(function(log) {
      // 详情显示：优先 detail，为空则显示 target
      var detail = log.detail || log.target || "-";

      // 状态
      var statusClass = log.success ? "log-status-success" : "log-status-fail";
      var statusText = log.success ? "成功" : (log.errorMsg ? "失败" : "未知");

      return '<div class="log-row' + (!log.success ? ' log-row-fail' : '') + '">' +
             '<span class="log-col-time"><span class="log-time">' + escHTML(formatTime(log.createdAt)) + '</span></span>' +
             '<span class="log-col-action">' + actionTag(log.action) + '</span>' +
             '<span class="log-col-actor">' + escHTML(log.actor || '-') + '</span>' +
             '<span class="log-col-detail" title="' + escJS(detail) + '">' + escJS(detail) + '</span>' +
             '<span class="log-col-status"><span class="' + statusClass + '">' + statusText + '</span></span>' +
             '<span class="log-col-ip">' + escHTML(log.remoteAddr || '-') + '</span>' +
             '</div>';
    }).join("");
    html += '</div>';
    container.innerHTML = html;
  } else {
    container.innerHTML = '<div class="empty-state"><p>暂无审计日志</p></div>';
  }

  var summary = document.getElementById("auditCountSummary");
  if (summary) summary.textContent = "第 " + auditPage + " 页，共 " + auditTotal + " 条";
}

// 操作类型彩色标签：按操作类别着色，便于扫读
function actionTag(action) {
  var label = actionLabel(action);
  var color = "#64748b", bg = "rgba(100,116,139,0.12)";
  if (/delete|offboard/.test(action)) { color = "#dc2626"; bg = "rgba(220,38,38,0.1)"; }
  else if (/disable|remove_group|cancel/.test(action)) { color = "#ea580c"; bg = "rgba(234,88,12,0.1)"; }
  else if (/reset.*password|reset_admin/.test(action)) { color = "#d97706"; bg = "rgba(217,119,6,0.1)"; }
  else if (/create|enable|add_group/.test(action)) { color = "#059669"; bg = "rgba(5,150,105,0.1)"; }
  else if (/unlock/.test(action)) { color = "#0891b2"; bg = "rgba(8,145,178,0.1)"; }
  else if (/save_ad|update_user/.test(action)) { color = "#7c3aed"; bg = "rgba(124,58,237,0.1)"; }
  return '<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;color:' + color + ';background:' + bg + ';">' + escHTML(label) + '</span>';
}

async function loadTasks() {
  var container = document.getElementById("tasksList");
  var emptyEl = document.getElementById("tasksEmpty");
  if (!container) return;
  
  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  if (emptyEl) emptyEl.style.display = "none";
  
  try {
    var data = await api("/api/admin/scheduled-tasks");
    var tasks = Array.isArray(data) ? data : (data.tasks || []);
    
    if (tasks.length > 0) {
      var now = new Date();
      container.innerHTML = tasks.map(function(task) {
        var sched = new Date(task.scheduledAt);
        var created = task.createdAt ? new Date(task.createdAt) : null;
        
        // 计算状态
        var statusClass = "", statusText = "";
        if (sched <= now) {
          statusClass = "overdue"; statusText = "已到期";
        } else {
          // 倒计时
          var diffMs = sched - now;
          var diffH = Math.floor(diffMs / 3600000);
          var diffM = Math.floor((diffMs % 3600000) / 60000);
          statusClass = "pending"; 
          if (diffH > 24) {
            statusText = Math.floor(diffH / 24) + "天" + (diffH % 24) + "小时后";
          } else {
            statusText = diffH + "小时" + diffM + "分后";
          }
        }
        
        // 操作类型标签
        var actionLabel2 = (task.action === "disable") ? "定时禁用" : ((task.action === "enable") ? "定时启用" : "定时任务");
        
        return '<div class="task-card" data-id="' + escJS(task.id) + '">' +
               // 头部：图标 + 账号 + 状态标签
               '<div class="task-card-header">' +
                 '<div class="task-card-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>' +
                 '<div class="task-card-main">' +
                   '<div class="task-card-account">' + escHTML(task.account || '-') + '</div>' +
                   '<div class="task-card-meta"><span class="task-type-badge">' + actionLabel2 + '</span><span class="task-status ' + statusClass + '">' + statusText + '</span></div>' +
                 '</div>' +
                 '<button class="btn btn-sm btn-ghost btn-danger-text" onclick="cancelTask(\'' + escJS(task.id) + '\')" title="取消此任务">取消</button>' +
               '</div>' +
               // 底部详情行
               '<div class="task-card-body">' +
                 '<div class="task-detail-item"><span class="task-detail-label">执行时间</span><span class="task-detail-value">' + escHTML(formatTime(task.scheduledAt)) + '</span></div>' +
                 (created ? ('<div class="task-detail-item"><span class="task-detail-label">创建时间</span><span class="task-detail-value">' + escHTML(formatTime(task.createdAt)) + '</span></div>') : '') +
               '</div>' +
               '</div>';
      }).join("");
      if (emptyEl) emptyEl.style.display = "none";
    } else {
      container.innerHTML = "";
      if (emptyEl) emptyEl.style.display = "block";
    }
  } catch (err) {
    container.innerHTML = '<div class="error-message">加载任务失败</div>';
  }
}

async function cancelTask(id) {
  if (!confirm("确定取消该定时任务吗？")) return;
  try {
    await api("/api/admin/scheduled-tasks?id=" + encodeURIComponent(id), { method: "DELETE" });
    showToast("任务已取消", "success");
    loadTasks();
  } catch (err) {
    showToast(err.message, "danger");
  }
}

// 后端返回的 createdAt/scheduledAt 是 RFC3339 时间，转成可读格式
function formatTime(t) {
  if (!t) return "-";
  try {
    var d = new Date(t);
    if (isNaN(d.getTime())) return t;
    return d.toLocaleDateString("zh-CN") + " " + d.toLocaleTimeString("zh-CN", {hour: "2-digit", minute: "2-digit"});
  } catch(e) { return t; }
}

// 审计日志 action 英文 → 中文映射
var ACTION_LABELS = {
  "login": "登录",
  "logout": "登出",
  "search_users": "搜索用户",
  "create_user": "创建用户",
  "delete_user": "删除用户",
  "disable_user": "禁用用户",
  "enable_user": "启用用户",
  "unlock_user": "解锁用户",
  "unlock_self": "自助解锁",
  "reset_user_password": "重置密码",
  "reset_self_password": "修改密码",
  "change_password": "修改密码",
  "offboard_user": "离职处理",
  "schedule_disable_user": "定时禁用",
  "cancel_scheduled_task": "取消定时任务",
  "add_group": "加入组",
  "remove_group": "移除组",
  "update_user": "更新用户",
  "save_ad_settings": "保存域控配置",
  "test_ad_connection": "测试域控连接",
  "create_admin": "创建管理员",
  "delete_admin": "删除管理员",
  "reset_admin_password": "重置管理员密码"
};

function actionLabel(action) {
  if (!action) return "-";
  return ACTION_LABELS[action] || action;
}

// 首字母大写（用于 tab 名 info→Info 转成 detailTabInfo）
function capitalize(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// 生成随机密码（16位，含大小写字母+数字+符号，排除易混淆字符）
function genRandomPassword() {
  var chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^&*";
  var pwd = "";
  // 使用 crypto.getRandomValues 生成加密安全的随机数
  var buf = new Uint32Array(16);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(buf);
    for (var i = 0; i < 16; i++) pwd += chars[buf[i] % chars.length];
  } else {
    // fallback: Math.random（非加密安全，仅在 crypto API 不可用时使用）
    for (var j = 0; j < 16; j++) pwd += chars[Math.floor(Math.random() * chars.length)];
  }
  return pwd;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════
function escJS(s) {
  if (!s) return "";
  // 用于 onclick="func('...')" 上下文：需同时转义 JS 字符串和 HTML 属性
  // 顺序：先 \ 再 ' 再 HTML 特殊字符
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// HTML 文本转义（用于 innerHTML 拼接的显示内容，非 onclick 属性）
function escHTML(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function resetCreateForm() {
  var form = document.getElementById("createForm");
  if (form) form.reset();
}

async function loadOffboardDefaults() {
  // 预留：加载离职处理默认值
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings Tab - 可选设置展开/收起 & 示例值填充
// ═══════════════════════════════════════════════════════════════════════════
function toggleOptional() {
  var body = document.getElementById("optionalBody");
  var toggle = document.getElementById("optionalToggle");
  if (!body) return;
  var isOpen = body.style.display !== "none";
  if (isOpen) {
    body.style.display = "none";
    if (toggle) toggle.textContent = "▶";
  } else {
    body.style.display = "grid";
    if (toggle) toggle.textContent = "▼";
  }
}

// 设置页"填入示例值"：根据 Base DN 反推域名并填充可选字段
function fillOptionalDefaults() {
  var form = document.getElementById("adSettingsForm");
  if (!form) return;
  var baseDNInput = form.querySelector('input[name="baseDN"]');
  var baseDN = baseDNInput ? baseDNInput.value.trim() : "";
  // 从 Base DN 反推域名
  var domain = "";
  if (baseDN) {
    var parts = baseDN.split(",");
    var dcParts = [];
    parts.forEach(function(p) {
      p = p.trim();
      if (p.toUpperCase().indexOf("DC=") === 0) {
        dcParts.push(p.substring(3));
      }
    });
    domain = dcParts.join(".");
  }
  if (!domain) domain = "domain.com";
  var dcStr = domain.split(".").map(function(p) { return "DC=" + p; }).join(",");

  setFormValue(form, "disabledOU", "OU=Disabled Users," + dcStr);
  setFormValue(form, "domainNetBIOS", domain.split(".")[0] ? domain.split(".")[0].toUpperCase() : "DOMAIN");
  setFormValue(form, "domainUPNSuffix", domain);
  setFormValue(form, "domainName", domain);
  showToast("已填入示例值", "success");
}

// 设置页基础连接"填入示例值"
function fillBaseDefaults() {
  var form = document.getElementById("adSettingsForm");
  if (!form) return;
  setFormValue(form, "host", "172.16.3.100");
  setFormValue(form, "port", "389");
  setFormValue(form, "baseDN", "DC=domain,DC=com");
  setFormValue(form, "bindUsername", "admin@domain.com");
  showToast("已填入示例值，请按实际修改", "info");
}

function setFormValue(form, name, value) {
  var input = form.querySelector('input[name="' + name + '"]');
  if (input) input.value = value;
}

// ═══════════════════════════════════════════════════════════════════════════
// Password Reset Modal
// ═══════════════════════════════════════════════════════════════════════════
var resetTarget = "";
// 密码弹窗倒计时相关状态
var resetPwdCountdownTimer = null;
var resetPwdCountdownSec = 0;
var resetPwdMustChangeVal = true;

async function openResetModal(account) {
  resetTarget = account;
  var targetEl = document.querySelector("#resetPwdTarget");
  var inputEl = document.querySelector("#resetPwdInput");
  var mustChangeEl = document.querySelector("#resetPwdMustChange");
  var resultEl = document.querySelector("#resetPwdResult");
  var modalEl = document.querySelector("#resetPwdModal");
  
  if (targetEl) targetEl.textContent = "用户：" + account;
  if (inputEl) inputEl.value = "";
  if (mustChangeEl) mustChangeEl.checked = true;
  if (resultEl) resultEl.style.display = "none";
  if (modalEl) modalEl.classList.add("active");
}

// 初始化密码重置相关事件
document.addEventListener("DOMContentLoaded", function() {
  var resetPwdCancel = document.querySelector("#resetPwdCancel");
  if (resetPwdCancel) {
    resetPwdCancel.addEventListener("click", closeResetPwdModal);
  }
  
  var resetPwdGenerate = document.querySelector("#resetPwdGenerate");
  if (resetPwdGenerate) {
    resetPwdGenerate.addEventListener("click", function() {
      var input = document.querySelector("#resetPwdInput");
      if (input) input.value = genRandomPassword();
    });
  }
  
  var resetPwdConfirm = document.querySelector("#resetPwdConfirm");
  if (resetPwdConfirm) {
    resetPwdConfirm.addEventListener("click", async function() {
      var input = document.querySelector("#resetPwdInput");
      var password = input ? input.value.trim() : "";
      if (!password || password.length < 8) { 
        showToast("密码至少需要 8 位", "warning"); 
        return; 
      }
      var mustChangeEl = document.querySelector("#resetPwdMustChange");
      var mustChange = mustChangeEl ? mustChangeEl.checked : true;
      resetPwdMustChangeVal = mustChange;
      try {
        var d = await api("/api/admin/users/password", {
          method: "POST",
          body: JSON.stringify({ account: resetTarget, password: password, mustChange: mustChange }),
        });
        var finalPwd = d.password || password;
        // 隐藏重置按钮区域，显示结果区域
        var btnRow = this.parentElement;
        if (btnRow) btnRow.style.display = "none";
        showResetPwdResult(finalPwd);
        showToast("密码已重置", "success");
        setTimeout(searchUsers, 300);
      } catch (err) { 
        showToast(err.message, "danger"); 
      }
    });
  }

  // 显示重置结果并启动 60 秒倒计时
  function showResetPwdResult(password) {
    var finalEl = document.querySelector("#resetPwdFinal");
    var resultEl = document.querySelector("#resetPwdResult");
    var actionsEl = document.querySelector("#resetPwdResultActions");
    var expiredEl = document.querySelector("#resetPwdExpiredActions");
    if (finalEl) {
      finalEl.textContent = password;
      finalEl.style.color = "var(--success-600)";
    }
    if (actionsEl) actionsEl.style.display = "flex";
    if (expiredEl) expiredEl.style.display = "none";
    if (resultEl) resultEl.style.display = "block";
    // 复制按钮：可反复点击，不关闭弹窗
    var copyBtn = document.querySelector("#resetPwdCopy");
    if (copyBtn) {
      copyBtn.onclick = function() {
        navigator.clipboard.writeText(password).then(function() { 
          showToast("密码已复制", "success"); 
        });
      };
    }
    startResetPwdCountdown();
  }

  function startResetPwdCountdown() {
    clearResetPwdCountdown();
    resetPwdCountdownSec = 60;
    updateResetPwdCountdown();
    resetPwdCountdownTimer = setInterval(function() {
      resetPwdCountdownSec--;
      if (resetPwdCountdownSec <= 0) {
        clearResetPwdCountdown();
        expireResetPwdModal();
      } else {
        updateResetPwdCountdown();
      }
    }, 1000);
  }

  function updateResetPwdCountdown() {
    var el = document.querySelector("#resetPwdCountdown");
    if (!el) return;
    el.textContent = "密码将在 " + resetPwdCountdownSec + " 秒后隐藏";
    el.style.color = resetPwdCountdownSec <= 10 ? "var(--danger-600)" : "var(--warning-600)";
  }

  function expireResetPwdModal() {
    var finalEl = document.querySelector("#resetPwdFinal");
    var countdownEl = document.querySelector("#resetPwdCountdown");
    var actionsEl = document.querySelector("#resetPwdResultActions");
    var expiredEl = document.querySelector("#resetPwdExpiredActions");
    if (finalEl) {
      finalEl.textContent = "••••••••";
      finalEl.style.color = "var(--text-tertiary)";
    }
    if (countdownEl) countdownEl.textContent = "密码已隐藏，如未复制可重新生成";
    if (actionsEl) actionsEl.style.display = "none";
    if (expiredEl) expiredEl.style.display = "flex";
  }

  function clearResetPwdCountdown() {
    if (resetPwdCountdownTimer) { clearInterval(resetPwdCountdownTimer); resetPwdCountdownTimer = null; }
  }

  function closeResetPwdModal() {
    clearResetPwdCountdown();
    document.querySelector("#resetPwdModal").classList.remove("active");
    // 重置弹窗状态，便于下次打开
    setTimeout(function() {
      var rInput = document.querySelector("#resetPwdInput");
      var rResult = document.querySelector("#resetPwdResult");
      var confirmBtn = document.querySelector("#resetPwdConfirm");
      var rBtnRow = confirmBtn ? confirmBtn.parentElement : null;
      if (rInput) rInput.value = "";
      if (rResult) rResult.style.display = "none";
      if (rBtnRow) rBtnRow.style.display = "";
    }, 300);
  }

  // 完成按钮：关闭弹窗
  var resetPwdDoneBtn = document.querySelector("#resetPwdDone");
  if (resetPwdDoneBtn) resetPwdDoneBtn.addEventListener("click", closeResetPwdModal);
  // 倒计时结束：已复制关闭
  var resetPwdExpiredCloseBtn = document.querySelector("#resetPwdExpiredClose");
  if (resetPwdExpiredCloseBtn) resetPwdExpiredCloseBtn.addEventListener("click", closeResetPwdModal);
  // 倒计时结束：重新生成（随机密码，沿用原 mustChange 设置）
  var resetPwdRegenerateBtn = document.querySelector("#resetPwdRegenerate");
  if (resetPwdRegenerateBtn) {
    resetPwdRegenerateBtn.addEventListener("click", async function() {
      if (!resetTarget) return;
      this.disabled = true;
      try {
        var d = await api("/api/admin/users/password", {
          method: "POST",
          body: JSON.stringify({ account: resetTarget, password: "", mustChange: resetPwdMustChangeVal }),
        });
        this.disabled = false;
        showResetPwdResult(d.password || "");
        showToast("已重新生成密码", "success");
      } catch (err) {
        this.disabled = false;
        showToast(err.message, "danger");
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Group Management
// ═══════════════════════════════════════════════════════════════════════════
function promptAddGroup(account) {
  api("/api/admin/groups").then(function(groupsResp) {
    var groupList = Array.isArray(groupsResp) ? groupsResp : (groupsResp.groups || []);
    if (!groupList || groupList.length === 0) { 
      showToast("没有可用的组", "warning"); 
      return; 
    }
    groupList.sort(function(a,b) { 
      return (a.label || a.name || a.value).localeCompare(b.label || b.name || b.value); 
    });
    
    var html = '<div class="modal active" id="grpModal"><div class="modal-content" style="max-width:500px">';
    html += '<div class="modal-header"><h3>加入组</h3></div>';
    html += '<div class="modal-body">';
    html += '<p class="form-hint">为 ' + account + ' 选择要加入的组</p>';
    html += '<input id="grpSearch" placeholder="搜索组..." class="form-input" style="width:100%;margin-bottom:12px" oninput="filterGroupList(this.value)"/>';
    html += '<div id="grpList" style="max-height:280px;overflow-y:auto">';
    groupList.forEach(function(g) {
      var name = g.label || g.name || g.value;
      var desc = g.description ? " (" + g.description + ")" : "";
      html += '<label class="group-option"><input type="checkbox" class="grp-cb" value="' + escJS(g.value || g.dn) + '"/>';
      html += '<span class="group-name">' + escJS(name) + '</span>';
      if (desc) html += '<span class="group-desc">' + desc + '</span>';
      html += '</label>';
    });
    html += '</div></div>';
    html += '<div class="modal-footer">';
    html += '<button class="btn btn-secondary" onclick="document.getElementById(\'grpModal\').remove()">取消</button>';
    html += '<button class="btn btn-primary" onclick="doAddGroups(\'' + escJS(account) + '\')">确定加入</button>';
    html += '</div></div></div>';
    
    var div = document.createElement("div");
    div.innerHTML = html;
    document.body.appendChild(div);
  }).catch(function(err) { 
    showToast(err.message, "danger"); 
  });
}

function filterGroupList(q) {
  var lowerQ = q.toLowerCase();
  document.querySelectorAll('#grpList label').forEach(function(el) {
    var name = el.querySelector('.group-name');
    if (name) {
      el.style.display = (!q || name.textContent.toLowerCase().indexOf(lowerQ) >= 0) ? 'flex' : 'none';
    }
  });
}

async function doAddGroups(account) {
  var cbs = document.querySelectorAll(".grp-cb:checked");
  if (cbs.length === 0) { 
    showToast("请至少选择一个组", "warning"); 
    return; 
  }
  
  try {
    for (var i = 0; i < cbs.length; i++) {
      await api("/api/admin/users/add-group", { 
        method: "POST", 
        body: JSON.stringify({ account: account, groupDN: cbs[i].value }) 
      });
    }
    showToast("已加入 " + cbs.length + " 个组", "success");
    var modal = document.getElementById("grpModal");
    if (modal) modal.remove();
    searchUsers();
  } catch (err) { 
    showToast(err.message, "danger"); 
  }
}

function promptRemoveGroup(account, groupDN) {
  var groupName = groupDN.match(/CN=([^,]+)/);
  var displayName = groupName ? groupName[1] : groupDN;
  
  if (confirm("确定要将 " + account + " 从组 " + displayName + " 中移除吗？")) {
    api("/api/admin/users/remove-group", {
      method: "POST",
      body: JSON.stringify({ account: account, groupDN: groupDN })
    }).then(function() {
      showToast("已从组中移除", "success");
      showUserDetail(account);
    }).catch(function(err) {
      showToast(err.message, "danger");
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Initialize
// ═══════════════════════════════════════════════════════════════════════════
async function tryRestoreSession() {
  var token = getToken();
  if (!token) return;
  // 用一个轻量接口验证 token 是否还有效
  try {
    var settings = await api("/api/admin/ad-settings");
    // 拉取当前管理员角色（后端权威来源，避免 localStorage 与后端不同步）
    try {
      var me = await api("/api/admin/me");
      if (me && me.role) {
        myRole = me.role;
        localStorage.setItem(ROLE_KEY, me.role);
      }
      if (me && me.permissions) {
        myPerms = me.permissions;
        localStorage.setItem(PERMS_KEY, JSON.stringify(me.permissions));
      }
    } catch (e) { /* 角色接口失败不阻断登录 */ }
    // token 有效，恢复登录态
    var loginPage = document.querySelector("#loginPage");
    var adminApp = document.querySelector("#adminApp");
    if (loginPage) loginPage.classList.add("hidden");
    if (adminApp) adminApp.classList.remove("hidden");
    initTheme();
    applyRoleUI();
    // 回填用户名（从 token 解析不了，先从 settings 之类接口拿不到，用 localStorage 缓存的名字）
    var savedName = localStorage.getItem("ad_admin_username") || "admin";
    var dropdownName = document.querySelector("#dropdownName");
    var adminAvatarEl = document.querySelector("#adminAvatar");
    if (dropdownName) dropdownName.textContent = savedName;
    if (adminAvatarEl) adminAvatarEl.textContent = savedName[0].toUpperCase();
    // 加载AD设置并检查是否需要初始化
    if (!settings || !settings.host || !settings.host.trim()) {
      showSetupWizard();
    }
    loadOptions();
    startConnCheck();
    console.log("[tryRestoreSession] session restored, role=" + myRole);
  } catch (err) {
    console.log("[tryRestoreSession] token invalid:", err.message);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ROLE_KEY);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function() {
    initDOMListeners();
    initTheme();
    tryRestoreSession();
  });
} else {
  initDOMListeners();
  initTheme();
  tryRestoreSession();
}

console.log("admin.js v2 loaded");

// ═══════════════════════════════════════════════════════════════════════════
// 管理员管理（模态框 + 权限勾选）
// ═══════════════════════════════════════════════════════════════════════════
const ROLE_LABELS = { super_admin: "超级管理员", hr_admin: "HR管理员", helpdesk: "服务台", custom: "自定义" };

// 打开管理员管理模态框
function openAdminMgmtModal() {
  var modal = document.getElementById("adminMgmtModal");
  if (!modal) return;
  modal.classList.add("active");
  loadAdmins();
  resetCreateAdminForm();
}

function closeAdminMgmtModal() {
  var modal = document.getElementById("adminMgmtModal");
  if (modal) modal.classList.remove("active");
}

function resetCreateAdminForm() {
  var form = document.getElementById("createAdminForm");
  if (form) form.reset();
  // 默认选中 helpdesk 预设
  var roleSelect = form ? form.querySelector('[name="role"]') : null;
  if (roleSelect) roleSelect.value = "helpdesk";
  // 渲染创建表单的权限勾选清单
  renderPermCheckboxes("createPermsList", ROLE_PERMS.helpdesk);
  applyPresetPerms("helpdesk");
}

// 选择预设角色时自动勾选对应权限
function applyPresetPerms(role) {
  var preset = ROLE_PERMS[role] || [];
  document.querySelectorAll('.perm-checkbox').forEach(function(cb) {
    cb.checked = preset.indexOf(cb.value) >= 0;
  });
}

// 渲染权限勾选清单
function renderPermCheckboxes(containerId, checked) {
  var container = document.getElementById(containerId);
  if (!container) return;
  checked = checked || [];
  var html = '';
  ALL_PERMS.forEach(function(p) {
    var isOn = checked.indexOf(p.key) >= 0;
    html += '<label class="perm-option' + (isOn ? " checked" : "") + '">';
    html += '<input type="checkbox" class="perm-checkbox" value="' + p.key + '"' + (isOn ? " checked" : "") + ' onchange="togglePermLabel(this)" />';
    html += '<span class="perm-name">' + escHTML(p.label) + '</span>';
    html += '<span class="perm-desc">' + escHTML(p.desc) + '</span>';
    html += '</label>';
  });
  container.innerHTML = html;
}

function togglePermLabel(cb) {
  var label = cb.closest(".perm-option");
  if (label) {
    if (cb.checked) label.classList.add("checked");
    else label.classList.remove("checked");
  }
  // 手动调整后，预设选择改为"自定义"
  var roleSelect = document.querySelector('#createAdminForm [name="role"]');
  if (roleSelect && roleSelect.value !== "custom") {
    // 检查是否仍与某个预设完全匹配
    var current = [];
    document.querySelectorAll('.perm-checkbox:checked').forEach(function(c) { current.push(c.value); });
    var matched = false;
    Object.keys(ROLE_PERMS).forEach(function(r) {
      var preset = ROLE_PERMS[r].slice().sort();
      var cur = current.slice().sort();
      if (JSON.stringify(preset) === JSON.stringify(cur)) {
        roleSelect.value = r;
        matched = true;
      }
    });
    if (!matched) roleSelect.value = "custom";
  }
}

async function loadAdmins() {
  var container = document.getElementById("adminsList");
  if (!container) return;
  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  try {
    var data = await api("/api/admin/admins");
    var admins = Array.isArray(data) ? data : (data.admins || []);
    if (admins.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>暂无管理员</p></div>';
      return;
    }
    var html = '<div class="admin-list">';
    admins.forEach(function(a) {
      var isSelf = a.username === localStorage.getItem("ad_admin_username");
      var effectivePerms = (a.permissions && a.permissions.length > 0) ? a.permissions : (ROLE_PERMS[a.role] || []);
      var roleLabel = (a.permissions && a.permissions.length > 0 && a.role === "custom") ? "自定义" : (ROLE_LABELS[a.role] || a.role);
      var roleClass = a.role === "super_admin" ? "badge-super" : (a.role === "hr_admin" ? "badge-hr" : (a.role === "helpdesk" ? "badge-helpdesk" : "badge-custom"));
      html += '<div class="admin-row' + (isSelf ? " admin-row-self" : "") + '">';
      html += '<div class="admin-row-avatar">' + escHTML((a.username[0] || "A").toUpperCase()) + '</div>';
      html += '<div class="admin-row-info"><div class="admin-row-name">' + escHTML(a.username) + (isSelf ? ' <span class="admin-self-tag">你</span>' : '') + '</div>';
      html += '<div class="admin-row-sub">ID #' + (a.id || "-") + ' · ' + effectivePerms.length + ' 项权限</div></div>';
      html += '<span class="admin-role-badge ' + roleClass + '">' + escHTML(roleLabel) + '</span>';
      html += '<div class="admin-row-actions">';
      if (hasPerm("adminMgmt")) {
        html += '<button class="btn btn-secondary btn-sm" onclick="editAdminPerms(\'' + escJS(a.username) + '\')">⚙️ 权限</button>';
        if (!isSelf) {
          html += '<button class="btn btn-secondary btn-sm" onclick="resetAdminPwd(\'' + escJS(a.username) + '\')">🔑 重置密码</button>';
          html += '<button class="btn btn-danger btn-sm" onclick="deleteAdmin(\'' + escJS(a.username) + '\')">🗑 删除</button>';
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
  var v = Object.fromEntries(new FormData(form));
  if (!v.username || !v.password || v.password.length < 8) {
    showToast("用户名必填，密码至少8位", "warning");
    return;
  }
  // 收集勾选的权限
  var perms = [];
  document.querySelectorAll('#createAdminForm .perm-checkbox:checked').forEach(function(cb) { perms.push(cb.value); });
  var role = v.role || "helpdesk";
  var body = { username: v.username, password: v.password, role: role };
  // 如果勾选权限与预设不完全一致，则传 permissions（后端会设 role=custom）
  var preset = ROLE_PERMS[role] || [];
  var permsSorted = perms.slice().sort().join(",");
  var presetSorted = preset.slice().sort().join(",");
  if (permsSorted !== presetSorted) {
    body.permissions = perms;
  }
  try {
    await api("/api/admin/admins", {
      method: "POST",
      body: JSON.stringify(body),
    });
    showToast("管理员已创建", "success");
    resetCreateAdminForm();
    loadAdmins();
  } catch (err) {
    showToast(err.message, "danger");
  }
}

// 编辑管理员权限：弹出权限编辑子模态框
function editAdminPerms(username) {
  // 先拉取当前权限
  api("/api/admin/admins").then(function(data) {
    var admins = Array.isArray(data) ? data : (data.admins || []);
    var target = admins.find(function(a) { return a.username === username; });
    var currentPerms = target ? ((target.permissions && target.permissions.length > 0) ? target.permissions : (ROLE_PERMS[target.role] || [])) : [];
    var modal = document.getElementById("editPermsModal");
    if (!modal) return;
    var titleEl = modal.querySelector("#editPermsTitle");
    if (titleEl) titleEl.textContent = "编辑权限 · " + username;
    modal.setAttribute("data-username", username);
    renderPermCheckboxes("editPermsList", currentPerms);
    modal.classList.add("active");
  }).catch(function(err) { showToast(err.message, "danger"); });
}

function closeEditPermsModal() {
  var modal = document.getElementById("editPermsModal");
  if (modal) modal.classList.remove("active");
}

async function saveAdminPerms() {
  var modal = document.getElementById("editPermsModal");
  if (!modal) return;
  var username = modal.getAttribute("data-username");
  var perms = [];
  document.querySelectorAll('#editPermsList .perm-checkbox:checked').forEach(function(cb) { perms.push(cb.value); });
  if (perms.indexOf("adminMgmt") < 0 && username === localStorage.getItem("ad_admin_username")) {
    showToast("不能移除自己的管理员管理权限", "warning");
    return;
  }
  try {
    await api("/api/admin/admins/permissions", {
      method: "PUT",
      body: JSON.stringify({ username: username, permissions: perms }),
    });
    showToast("权限已更新", "success");
    closeEditPermsModal();
    loadAdmins();
  } catch (err) { showToast(err.message, "danger"); }
}

async function deleteAdmin(username) {
  if (!confirm("确定删除管理员 " + username + "？此操作不可撤销。")) return;
  try {
    await api("/api/admin/admins?username=" + encodeURIComponent(username), { method: "DELETE" });
    showToast("管理员已删除", "success");
    loadAdmins();
  } catch (err) { showToast(err.message, "danger"); }
}

async function resetAdminPwd(username) {
  var np = prompt("为 " + username + " 设置新密码（至少8位）：");
  if (!np) return;
  if (np.length < 8) { showToast("密码至少8位", "warning"); return; }
  try {
    await api("/api/admin/admins/reset-password", {
      method: "POST",
      body: JSON.stringify({ username: username, newPassword: np }),
    });
    showToast("管理员密码已重置", "success");
  } catch (err) { showToast(err.message, "danger"); }
}

// ═══════════════════════════════════════════════════════════════════════════
// 高危操作二次确认（输入账号名才能确认）
// ═══════════════════════════════════════════════════════════════════════════
function openDangerConfirm(opts) {
  var modal = document.getElementById("dangerConfirmModal");
  if (!modal) return;
  var titleEl = modal.querySelector("#dangerConfirmTitle");
  var descEl = modal.querySelector("#dangerConfirmDesc");
  var warnEl = modal.querySelector("#dangerConfirmWarn");
  var targetEl = modal.querySelector("#dangerConfirmTarget");
  var inputEl = modal.querySelector("#dangerConfirmInput");
  var okBtn = modal.querySelector("#dangerConfirmOk");
  var hintEl = modal.querySelector("#dangerConfirmHint");
  if (titleEl) titleEl.textContent = opts.title || "高危操作确认";
  if (descEl) descEl.textContent = opts.desc || "";
  if (warnEl) warnEl.textContent = opts.warning || "";
  if (targetEl) targetEl.textContent = opts.target || "";
  if (hintEl) hintEl.textContent = '请输入 "' + (opts.target || "") + '" 以确认';
  if (inputEl) {
    inputEl.value = "";
    inputEl.placeholder = "输入账号名以确认";
  }
  if (okBtn) {
    okBtn.textContent = opts.confirmText || "确认执行";
    okBtn.disabled = true;
    // 替换克隆以清除旧监听
    var newOk = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOk, okBtn);
    newOk.addEventListener("click", function() {
      if (newOk.disabled) return;
      modal.classList.remove("active");
      if (typeof opts.onConfirm === "function") opts.onConfirm();
    });
  }
  if (inputEl) {
    var newInput = inputEl.cloneNode(true);
    inputEl.parentNode.replaceChild(newInput, inputEl);
    newInput.addEventListener("input", function() {
      var ok = modal.querySelector("#dangerConfirmOk");
      if (ok) ok.disabled = (newInput.value.trim() !== opts.target);
    });
  }
  modal.classList.add("active");
}

function closeDangerConfirm() {
  var modal = document.getElementById("dangerConfirmModal");
  if (modal) modal.classList.remove("active");
}

// 删除账号（super_admin 专属，使用高危二次确认）
function doDeleteUser(account) {
  openDangerConfirm({
    title: "删除账号",
    desc: "即将从 Active Directory 永久删除账号",
    target: account,
    warning: "删除后该账号的 SID 将永久消失，即使重建同名账号权限也不一致。此操作不可逆。",
    confirmText: "确认删除",
    onConfirm: async function() {
      try {
        await api("/api/admin/users", {
          method: "DELETE",
          body: JSON.stringify({ account: account }),
        });
        showToast("账号已删除", "success");
        closeUserDetail();
        searchUsers();
      } catch (err) { showToast(err.message, "danger"); }
    },
  });
}
