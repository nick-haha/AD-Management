/**
 * Shared 模块 — 跨模块共享的工具函数
 * formatTime / actionLabel / ACTION_LABELS / genRandomPassword
 */

function formatTime(t) {
  if (!t) return '-';
  try {
    const d = new Date(t);
    if (isNaN(d.getTime())) return t;
    return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch (e) { return t; }
}

const ACTION_LABELS = {
  login: '登录', logout: '登出', search_users: '搜索用户',
  create_user: '创建用户', delete_user: '删除用户', disable_user: '禁用用户',
  enable_user: '启用用户', unlock_user: '解锁用户', unlock_self: '自助解锁',
  reset_user_password: '重置密码', reset_self_password: '修改密码',
  change_password: '修改密码', offboard_user: '离职处理',
  schedule_disable_user: '定时禁用', cancel_scheduled_task: '取消定时任务',
  add_group: '加入组', remove_group: '移出组', update_user: '更新用户',
  save_ad_settings: '保存域控配置', test_ad_connection: '测试域控连接',
  create_admin: '创建管理员', delete_admin: '删除管理员', reset_admin_password: '重置管理员密码',
};

function actionLabel(action) {
  if (!action) return '-';
  return ACTION_LABELS[action] || action;
}

function genRandomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^&*';
  let pwd = '';
  const buf = new Uint32Array(16);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(buf);
    for (let i = 0; i < 16; i++) pwd += chars[buf[i] % chars.length];
  } else {
    for (let j = 0; j < 16; j++) pwd += chars[Math.floor(Math.random() * chars.length)];
  }
  return pwd;
}

// 相对时间："3分钟前" / "昨天 14:30" / hover 显示完整时间
function relativeTime(t) {
  if (!t) return '-';
  try {
    const d = new Date(t);
    if (isNaN(d.getTime())) return t;
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    const diffH = Math.floor(diffMs / 3600000);
    const diffD = Math.floor(diffMs / 86400000);
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return diffMin + '分钟前';
    if (diffH < 24) return diffH + '小时前';
    if (diffD === 1) return '昨天 ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    if (diffD < 7) return diffD + '天前';
    if (diffD < 30) return Math.floor(diffD / 7) + '周前';
    return d.toLocaleDateString('zh-CN');
  } catch (e) { return t; }
}

// 带完整时间的 title 属性值（用于 hover 提示）
function fullTimeStr(t) {
  if (!t) return '';
  try {
    const d = new Date(t);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

// 密码强度检测 → {score: 0-4, label, color}
function passwordStrength(pwd) {
  if (!pwd) return { score: 0, label: '', color: '' };
  let score = 0;
  if (pwd.length >= 8) score++;
  if (pwd.length >= 12) score++;
  if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score++;
  if (/\d/.test(pwd) && /[^a-zA-Z0-9]/.test(pwd)) score++;
  const labels = ['', '弱', '中', '强', '很强'];
  const colors = ['', 'var(--danger-500)', 'var(--warning-500)', 'var(--success-500)', 'var(--success-600)'];
  return { score, label: labels[score], color: colors[score] };
}

// 头像渐变配色：基于用户名 hash 生成稳定的不重复渐变色
// 返回 CSS background 值（linear-gradient）
const AVATAR_PALETTES = [
  ['#667eea', '#764ba2'], // 紫蓝
  ['#f093fb', '#f5576c'], // 粉红
  ['#4facfe', '#00f2fe'], // 青蓝
  ['#43e97b', '#38f9d7'], // 翠绿
  ['#fa709a', '#fee140'], // 橙粉
  ['#30cfd0', '#330867'], // 深青紫
  ['#a8edea', '#5b86e5'], // 薄荷蓝
  ['#ff9a9e', '#fad0c4'], // 樱花
  ['#ffecd2', '#fcb69f'], // 暖橙
  ['#84fab0', '#8fd3f4'], // 春天
  ['#ff6e7f', '#bfe9ff'], // 珊瑚
  ['#c471f5', '#fa71cd'], // 霓虹紫
];
function avatarGradient(name) {
  if (!name) return AVATAR_PALETTES[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const pair = AVATAR_PALETTES[Math.abs(hash) % AVATAR_PALETTES.length];
  return 'linear-gradient(135deg, ' + pair[0] + ', ' + pair[1] + ')';
}

export { formatTime, relativeTime, fullTimeStr, actionLabel, ACTION_LABELS, genRandomPassword, passwordStrength, avatarGradient };
