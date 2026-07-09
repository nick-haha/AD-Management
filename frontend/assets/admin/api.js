/**
 * API 模块 — fetch 封装 + token 管理 + 错误处理
 */
import { showToast } from './ui.js';

const API_BASE = window.API_BASE || '';
const TOKEN_KEY = 'ad_admin_token';
const USERNAME_KEY = 'ad_admin_username';
const ROLE_KEY = 'ad_admin_role';
const PERMS_KEY = 'ad_admin_perms';
const THEME_KEY = 'ad_theme';

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USERNAME_KEY);
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(PERMS_KEY);
}

// 401 时的回调，由 app.js 设置
let _onAuthExpired = null;
function onAuthExpired(cb) { _onAuthExpired = cb; }

async function api(path, opts = {}) {
  const token = getToken();
  try {
    const res = await fetch(API_BASE + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        ...(opts.headers || {}),
      },
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) {
        clearAuth();
        if (_onAuthExpired) _onAuthExpired();
      }
      let errMsg = d.error || '请求失败';
      if (errMsg === 'invalid_credentials') errMsg = '用户名或密码错误';
      else if (errMsg === 'account_locked') errMsg = '账号已被锁定，请30分钟后再试';
      else if (errMsg === 'invalid_token' || errMsg === 'missing_bearer_token') errMsg = '登录已过期，请重新登录';
      else if (d.detail) errMsg = d.detail;
      const err = new Error(errMsg);
      err.code = d.error;
      err.status = res.status;
      throw err;
    }
    return d;
  } catch (e) {
    if (e.message === 'Failed to fetch') {
      throw new Error('网络连接失败，请检查网络');
    }
    throw e;
  }
}

export {
  API_BASE, TOKEN_KEY, USERNAME_KEY, ROLE_KEY, PERMS_KEY, THEME_KEY,
  getToken, setToken, clearAuth, api, onAuthExpired,
};
