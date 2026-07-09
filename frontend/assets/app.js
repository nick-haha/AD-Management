/**
 * AD Self-Service — 域账户自助查询
 * 响应式 + 良好交互体验 + 飞书 OAuth 认证
 */
(function() {
  "use strict";

  var API = window.API_BASE || "";
  var queryInput = document.getElementById("query");
  var searchBtn = document.getElementById("searchBtn");
  var loader = document.getElementById("loader");
  var skeletons = document.getElementById("skeletons");
  var results = document.getElementById("results");
  var pwdModal = document.getElementById("pwdModal");
  var pwdDisplay = document.getElementById("pwdDisplay");
  var copyPwdBtn = document.getElementById("copyPwdBtn");
  var closePwdBtn = document.getElementById("closePwdBtn");
  var confirmModal = document.getElementById("confirmModal");
  var confirmIcon = document.getElementById("confirmIcon");
  var confirmTitle = document.getElementById("confirmTitle");
  var confirmDesc = document.getElementById("confirmDesc");
  var confirmCancel = document.getElementById("confirmCancel");
  var confirmOk = document.getElementById("confirmOk");
  var toastWrap = document.getElementById("toastWrap");
  var authOverlay = document.getElementById("authOverlay");
  var authStatus = document.getElementById("authStatus");
  var feishuLoginBtn = document.getElementById("feishuLoginBtn");
  var userWelcome = document.getElementById("userWelcome");
  var logoutBtn = document.getElementById("logoutBtn");

  var lastPwd = "";
  var pwdCountdownTimer = null;
  var pwdCountdownSec = 0;
  var currentResetAccount = "";
  var debounceTimer = null;
  var currentQuery = "";
  var pendingConfirm = null;
  var currentUser = null; // { name, account, openId }

  // ─── HTML 转义 ───
  function esc(s) {
    if (s == null) return "";
    var d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }

  // ─── Toast ───
  function toast(msg, type) {
    type = type || "info";
    var el = document.createElement("div");
    el.className = "ss-toast " + type;
    el.textContent = msg;
    toastWrap.appendChild(el);
    setTimeout(function() {
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      el.style.transition = "all 0.25s";
      setTimeout(function() { el.remove(); }, 260);
    }, 4000);
  }

  // ─── API 请求 ───
  function api(path, opts) {
    opts = opts || {};
    return fetch(API + path, {
      method: opts.method || "GET",
      body: opts.body,
      credentials: "include",
      headers: Object.assign({ "Content-Type": "application/json" }, opts.headers || {})
    }).then(function(res) {
      if (res.status === 401) {
        // Session 过期，跳转飞书登录
        window.location.href = API + "/api/auth/feishu/login";
        throw new Error("认证已过期，正在跳转登录...");
      }
      return res.json().then(function(d) {
        if (!res.ok) {
          var msg = d.error || "请求失败";
          if (msg === "ad_operation_failed" || msg === "ldap_connection_failed") msg = "目录服务连接失败，请联系管理员";
          else if (msg === "ad_not_configured") msg = "系统尚未配置，请联系管理员";
          else if (msg === "invalid_credentials") msg = "认证失败，请联系管理员";
          else if (msg === "user_not_found" || msg === "ad user not found") msg = "未找到该用户";
          else if (msg === "rate_limit_exceeded") msg = d.detail || "操作过于频繁，请稍后再试";
          else if (msg === "cannot_operate_other_account") msg = "仅可操作本人账户";
          else if (msg === "no_ad_account_linked") msg = "未找到关联的域账户，请联系管理员";
          else if (msg === "self_service_auth_required") msg = "请先通过飞书登录";
          else if (msg === "invalid input") msg = "输入无效，请检查后重试";
          else if (msg === "password does not meet the local policy") msg = "密码不符合安全策略";
          throw new Error(msg);
        }
        return d;
      });
    });
  }

  // ─── 认证检查 ───
  function checkAuth() {
    fetch(API + "/api/auth/feishu/session", { credentials: "include" })
      .then(function(res) {
        if (res.status === 401) {
          // 未认证 → 展示登录卡片
          showLoginCard();
          return null;
        }
        return res.json();
      })
      .then(function(data) {
        if (data) {
          currentUser = data;
          updateNavWithUser(data);
          var page = document.getElementById("ssPage");
          if (page) page.style.display = "";
          hideAuthOverlay();
          autoSearchAfterAuth(data);
        }
      })
      .catch(function(err) {
        // 飞书未配置 → 显示提示页
        var page = document.getElementById("ssPage");
        if (page) {
          page.style.display = "";
          page.innerHTML = '<div class="ss-wrap"><div class="ss-feishu-warning">' +
            '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:16px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
            '<h3>飞书登录未配置</h3><p>自助服务需要飞书账号认证。请联系管理员在管理控制台中配置飞书集成后再使用。</p>' +
            '<a href="/admin" style="display:inline-flex;align-items:center;gap:6px;margin-top:20px;padding:10px 24px;font-size:14px;font-weight:600;border-radius:var(--ss-radius-sm);border:0;cursor:pointer;background:var(--ss-cyan);color:#fff;text-decoration:none">前往管理控制台</a>' +
            '</div></div>';
        }
        authOverlay.style.opacity = "0";
        setTimeout(function() { authOverlay.style.display = "none"; }, 300);
      });
  }

  // 登录成功后自动搜索：优先用飞书姓名（中文），其次用 AD 账户名
  function autoSearchAfterAuth(data) {
    var query = data.name || data.account || "";
    if (!query) return;
    // 填入搜索框并触发搜索
    queryInput.value = query;
    // 延迟一点确保 UI 已就绪
    setTimeout(function() {
      doSearch();
      if (data.account) {
        toast("已登录，正在加载您的账户信息", "success");
      } else {
        toast("已登录，未找到关联域账户，请手动搜索", "info");
      }
    }, 300);
  }

  function updateNavWithUser(data) {
    if (!data) return;
    var displayName = data.name || data.account || "用户";
    userWelcome.textContent = "欢迎, " + displayName;
    userWelcome.style.display = "inline-flex";
    logoutBtn.style.display = "inline-flex";
  }

  // ─── 显示登录卡片（隐藏 spinner，显示登录卡片）───
  function showLoginCard() {
    var loading = document.getElementById("authLoading");
    var card = document.getElementById("loginCard");
    if (loading) loading.style.display = "none";
    if (card) card.classList.add("visible");
  }

  // ─── 重新显示登录遮罩（退出登录时调用）───
  function showAuthOverlay() {
    authOverlay.style.display = "flex";
    authOverlay.style.opacity = "1";
    var page = document.getElementById("ssPage");
    if (page) page.style.display = "none";
    showLoginCard();
  }

  function hideAuthOverlay() {
    authOverlay.style.opacity = "0";
    authOverlay.style.transition = "opacity 0.25s";
    setTimeout(function() { authOverlay.style.display = "none"; }, 260);
    // 自动聚焦搜索框
    if (queryInput) queryInput.focus();
  }

  // ─── 登出 ───
  window.__logout = function() {
    fetch(API + "/api/auth/feishu/logout", { method: "POST", credentials: "include" })
      .then(function() {
        // 清除用户状态，回到登录卡片
        currentUser = null;
        userWelcome.style.display = "none";
        logoutBtn.style.display = "none";
        results.innerHTML = "";
        queryInput.value = "";
        currentQuery = "";
        showAuthOverlay();
        toast("已退出登录", "info");
      })
      .catch(function() {
        // 即使登出接口失败，也回到登录页
        currentUser = null;
        showAuthOverlay();
      });
  };

  // ─── URL 参数检测 ───
  var urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("auth") === "ok") {
    // 登录成功回调，清除 URL 参数
    window.history.replaceState({}, "", "/");
    if (urlParams.get("no_ad") === "1") {
      setTimeout(function() {
        toast("登录成功，但未找到关联的域账户，仅可使用搜索功能", "error");
      }, 500);
    }
  }

  // ─── 状态判断 ───
  function statusBadge(u) {
    if (u.locked) return '<span class="ss-badge ss-badge-locked">已锁定</span>';
    if (u.enabled) return '<span class="ss-badge ss-badge-ok">正常</span>';
    return '<span class="ss-badge ss-badge-disabled">已禁用</span>';
  }

  // ─── 详情行 ───
  function detailRow(label, value) {
    if (!value) value = "—";
    return '<div class="ss-detail-label">' + esc(label) + '</div><div class="ss-detail-value">' + esc(value) + '</div>';
  }

  // ─── 格式化时间 ───
  function fmtTime(s) {
    if (!s) return "—";
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    var pad = function(n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  // ─── 获取姓名首字 ───
  function initial(name) {
    if (!name) return "?";
    var ch = name.charAt(0);
    if (ch.charCodeAt(0) > 127) return ch;
    return ch.toUpperCase();
  }

  // ─── 是否为本人账户 ───
  function isSelf(u) {
    return currentUser && currentUser.account && u.samAccountName &&
           currentUser.account.toLowerCase() === u.samAccountName.toLowerCase();
  }

  // ─── 渲染用户卡片 ───
  function renderUsers(users) {
    if (users.length === 0) {
      results.innerHTML =
        '<div class="ss-empty">' +
          '<div class="ss-empty-icon"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg></div>' +
          '<h3>未找到匹配的用户</h3>' +
          '<p>请检查输入的姓名、用户名或邮箱是否正确，然后重新搜索</p>' +
        '</div>';
      return;
    }

    var html = "";
    for (var i = 0; i < users.length; i++) {
      var u = users[i];
      var name = u.displayName || u.cn || u.samAccountName;
      var delay = Math.min(i * 60, 300);
      var self = isSelf(u);

      html += '<div class="ss-card' + (self ? ' ss-card-self' : '') + '" style="animation-delay:' + delay + 'ms" data-account="' + esc(u.samAccountName) + '">';

      // 卡片头部（可点击展开）
      html += '<div class="ss-card-head" onclick="window.__toggleCard(this)">';
      html += '<div class="ss-card-avatar">' + esc(initial(name)) + '</div>';
      html += '<div class="ss-card-info">';
      html += '<div class="ss-card-name">' + esc(name);
      if (self) {
        html += ' <span class="ss-card-self-tag">本人</span>';
      }
      html += '</div>';
      html += '<div class="ss-card-acct">' + esc(u.samAccountName) + '</div>';
      html += '</div>';
      html += statusBadge(u);
      html += '<svg class="ss-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
      html += '</div>';

      // 展开内容
      html += '<div class="ss-card-body"><div class="ss-card-body-inner">';

      html += '<div class="ss-detail-grid">';
      html += detailRow("域用户名", u.samAccountName);
      html += detailRow("账户状态", u.locked ? "已锁定" : (u.enabled ? "正常" : "已禁用"));
      html += '</div>';

      // 操作按钮 — 仅本人账户可操作
      html += '<div class="ss-actions">';
      if (self) {
        if (u.locked) {
          html += '<button class="ss-btn ss-btn-primary" onclick="window.__doAction(\'unlock\',\'' + esc(u.samAccountName) + '\')">';
          html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
          html += ' 解锁账号</button>';
        }
        html += '<button class="ss-btn ss-btn-danger" onclick="window.__doAction(\'reset\',\'' + esc(u.samAccountName) + '\')">';
        html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';
        html += ' 重置密码</button>';
      } else if (currentUser) {
        // 已登录但非本人
        html += '<span class="ss-actions-hint" style="color:var(--ss-red);font-weight:600;">仅可查看其他用户，不可操作</span>';
      }
      html += '</div>';

      html += '</div></div>';
      html += '</div>';
    }
    results.innerHTML = html;
  }

  // ─── 渲染搜索中骨架屏 ───
  function showSkeletons() {
    loader.classList.remove("active");
    skeletons.style.display = "grid";
    results.innerHTML = "";
  }
  function hideSkeletons() {
    skeletons.style.display = "none";
  }

  // ─── 渲染管理员提示 ───
  function renderAdminsOnly() {
    results.innerHTML =
      '<div class="ss-empty">' +
        '<div class="ss-empty-icon"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>' +
        '<h3>无法操作管理员账号</h3>' +
        '<p>该账户为系统管理员，请通过<a href="/admin">管理控制台</a>进行操作</p>' +
      '</div>';
  }

  // ─── 搜索 ───
  function doSearch() {
    var q = queryInput.value.trim();
    if (!q) return;
    if (q === currentQuery) return;
    currentQuery = q;

    showSkeletons();

    fetch(API + "/api/me/users?q=" + encodeURIComponent(q), { credentials: "include" })
      .then(function(res) {
        if (res.status === 401) {
          window.location.href = API + "/api/auth/feishu/login";
          throw new Error("认证已过期");
        }
        return res.json().then(function(d) { return { ok: res.ok, data: d }; });
      })
      .then(function(result) {
        hideSkeletons();

        if (!result.ok) {
          var errMsg = result.data.error || "查询失败";
          if (errMsg === "ad_operation_failed" || errMsg === "ldap_connection_failed") errMsg = "目录服务连接失败，请联系管理员";
          else if (errMsg === "ad_not_configured") errMsg = "系统尚未配置，请联系管理员";
          else if (errMsg === "user_not_found" || errMsg === "ad user not found") errMsg = "未找到该用户，请检查姓名或用户名是否正确";
          else if (errMsg === "rate_limit_exceeded") errMsg = result.data.detail || "操作过于频繁，请稍后再试";
          else if (errMsg === "self_service_auth_required") errMsg = "请先通过飞书登录";
          toast(errMsg, "error");
          currentQuery = "";
          return;
        }

        if (result.data.adminsOnly) {
          renderAdminsOnly();
          return;
        }

        var users = Array.isArray(result.data) ? result.data : (result.data.users || []);
        renderUsers(users);
      })
      .catch(function(err) {
        hideSkeletons();
        if (err.message !== "认证已过期") {
          toast(err.message || "网络异常，请稍后重试", "error");
        }
        currentQuery = "";
      });
  }

  // ─── 操作确认 ───
  function showConfirm(type, account) {
    return new Promise(function(resolve) {
      if (type === "unlock") {
        confirmIcon.innerHTML = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--ss-cyan)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0"/></svg>';
        confirmTitle.textContent = "确认解锁账号";
        confirmDesc.innerHTML = '即将解锁你的账号 <strong>' + esc(account) + '</strong>，解锁后即可正常登录。';
        confirmOk.className = "ss-btn ss-btn-primary";
        confirmOk.textContent = "确认解锁";
      } else {
        confirmIcon.innerHTML = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--ss-red)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';
        confirmTitle.textContent = "确认重置密码";
        confirmDesc.innerHTML = '即将重置你的账号 <strong>' + esc(account) + '</strong> 的密码，新密码将在弹窗中显示且仅展示一次。';
        confirmOk.className = "ss-btn ss-btn-danger";
        confirmOk.textContent = "确认重置";
      }
      confirmModal.classList.add("open");
      pendingConfirm = resolve;
    });
  }

  confirmCancel.addEventListener("click", function() {
    confirmModal.classList.remove("open");
    if (pendingConfirm) { pendingConfirm(false); pendingConfirm = null; }
  });

  confirmOk.addEventListener("click", function() {
    confirmModal.classList.remove("open");
    if (pendingConfirm) { pendingConfirm(true); pendingConfirm = null; }
  });

  confirmModal.addEventListener("click", function(e) {
    if (e.target === confirmModal) {
      confirmModal.classList.remove("open");
      if (pendingConfirm) { pendingConfirm(false); pendingConfirm = null; }
    }
  });

  // ─── 执行操作 ───
  function doAction(type, account) {
    showConfirm(type, account).then(function(confirmed) {
      if (!confirmed) return;

      if (type === "unlock") {
        api("/api/me/users/unlock", { method: "POST", body: JSON.stringify({ account: account }) })
          .then(function() {
            toast("账号 " + account + " 已解锁", "success");
            // 刷新搜索结果
            currentQuery = "";
            doSearch();
          })
          .catch(function(e) { toast(e.message, "error"); });
      } else {
        currentResetAccount = account;
        api("/api/me/users/password", { method: "POST", body: JSON.stringify({ account: account }) })
          .then(function(d) {
            showPwdModal(d.password);
          })
          .catch(function(e) { toast(e.message, "error"); });
      }
    });
  }

  // ─── 卡片展开/折叠 ───
  window.__toggleCard = function(headEl) {
    var card = headEl.closest(".ss-card");
    if (card) card.classList.toggle("expanded");
  };

  // ─── 操作入口 ───
  window.__doAction = function(type, account) {
    doAction(type, account);
  };

  // ─── 密码弹窗（60秒倒计时 + 补救入口）───
  // 倒计时内密码可见、复制可反复点击；归零后密码变星号，提供"已复制关闭"和"重新生成"两个补救按钮。
  function showPwdModal(password) {
    lastPwd = password;
    var display = document.getElementById("pwdDisplay");
    var footerActive = document.getElementById("pwdFooterActive");
    var footerExpired = document.getElementById("pwdFooterExpired");
    if (display) {
      display.textContent = password;
      display.classList.remove("masked");
    }
    if (footerActive) footerActive.style.display = "";
    if (footerExpired) footerExpired.style.display = "none";
    pwdModal.classList.add("open");
    startPwdCountdown();
  }

  function startPwdCountdown() {
    clearPwdCountdown();
    pwdCountdownSec = 60;
    updateCountdownText();
    pwdCountdownTimer = setInterval(function() {
      pwdCountdownSec--;
      if (pwdCountdownSec <= 0) {
        clearPwdCountdown();
        expirePwdModal();
      } else {
        updateCountdownText();
      }
    }, 1000);
  }

  function updateCountdownText() {
    var el = document.getElementById("pwdCountdown");
    if (!el) return;
    el.textContent = "密码将在 " + pwdCountdownSec + " 秒后隐藏";
    if (pwdCountdownSec <= 10) el.classList.add("urgent");
    else el.classList.remove("urgent");
  }

  function expirePwdModal() {
    var display = document.getElementById("pwdDisplay");
    var countdown = document.getElementById("pwdCountdown");
    var footerActive = document.getElementById("pwdFooterActive");
    var footerExpired = document.getElementById("pwdFooterExpired");
    if (display) {
      display.textContent = "••••••••";
      display.classList.add("masked");
    }
    if (countdown) {
      countdown.textContent = "密码已隐藏，如未复制可重新生成";
      countdown.classList.remove("urgent");
    }
    if (footerActive) footerActive.style.display = "none";
    if (footerExpired) footerExpired.style.display = "flex";
  }

  function clearPwdCountdown() {
    if (pwdCountdownTimer) { clearInterval(pwdCountdownTimer); pwdCountdownTimer = null; }
  }

  function closePwdModal() {
    clearPwdCountdown();
    pwdModal.classList.remove("open");
  }

  copyPwdBtn.addEventListener("click", function() {
    navigator.clipboard.writeText(lastPwd).then(function() {
      toast("密码已复制，首次登录请务必修改", "success");
    }).catch(function() {
      toast("复制失败，请手动记录密码", "error");
    });
  });

  closePwdBtn.addEventListener("click", closePwdModal);

  var pwdExpiredCloseBtn = document.getElementById("pwdExpiredClose");
  if (pwdExpiredCloseBtn) pwdExpiredCloseBtn.addEventListener("click", closePwdModal);

  var pwdRegenerateBtn = document.getElementById("pwdRegenerate");
  if (pwdRegenerateBtn) {
    pwdRegenerateBtn.addEventListener("click", function() {
      if (!currentResetAccount) return;
      // 轻量确认：直接调重置接口生成新密码并重新开始倒计时
      this.disabled = true;
      var self = this;
      api("/api/me/users/password", { method: "POST", body: JSON.stringify({ account: currentResetAccount }) })
        .then(function(d) {
          self.disabled = false;
          showPwdModal(d.password);
          toast("已重新生成密码", "success");
        })
        .catch(function(e) {
          self.disabled = false;
          toast(e.message, "error");
        });
    });
  }

  pwdModal.addEventListener("click", function(e) {
    if (e.target === pwdModal) closePwdModal();
  });

  // ─── 搜索事件（仅点击搜索按钮或按回车触发，不做输入自动搜索）───
  searchBtn.addEventListener("click", function(e) {
    e.preventDefault();
    doSearch();
  });

  queryInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      doSearch();
    }
  });

  // ─── 全局快捷键 ───
  document.addEventListener("keydown", function(e) {
    // "/" 聚焦搜索框
    if (e.key === "/" && document.activeElement !== queryInput) {
      e.preventDefault();
      queryInput.focus();
    }
    // Esc 关闭弹窗
    if (e.key === "Escape") {
      closePwdModal();
      confirmModal.classList.remove("open");
      if (pendingConfirm) { pendingConfirm(false); pendingConfirm = null; }
    }
  });

  // ─── 页面加载：检查认证状态 ───
  checkAuth();

})();
