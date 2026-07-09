/**
 * State 模块 — 权限常量 + 当前管理员状态
 */

const ALL_PERMS = [
  { key: 'search', label: '搜索用户', desc: '查看用户列表和详情' },
  { key: 'create', label: '创建用户', desc: '新建 AD 账号' },
  { key: 'delete', label: '删除用户', desc: '永久删除 AD 账号（不可逆）' },
  { key: 'disable', label: '禁用/启用用户', desc: '切换账号启用状态' },
  { key: 'unlock', label: '解锁用户', desc: '解除账号锁定' },
  { key: 'resetPwd', label: '重置密码', desc: '重置用户密码' },
  { key: 'offboard', label: '离职处理', desc: '禁用并移至离职 OU' },
  { key: 'modifyUser', label: '修改用户属性', desc: '编辑用户基本信息' },
  { key: 'addGroup', label: '加组/移组', desc: '管理用户组成员关系' },
  { key: 'adSettings', label: '域控配置', desc: '修改 AD 连接设置' },
  { key: 'feishuSettings', label: '飞书配置', desc: '修改飞书登录设置' },
  { key: 'audit', label: '审计日志', desc: '查看操作审计记录' },
  { key: 'tasks', label: '定时任务', desc: '管理定时禁用任务' },
  { key: 'adminMgmt', label: '管理员管理', desc: '管理管理员账号和权限' },
];

const ROLE_PERMS = {
  super_admin: ALL_PERMS.map(function (p) { return p.key; }),
  hr_admin: ['search', 'create', 'disable', 'offboard', 'modifyUser', 'addGroup', 'audit', 'tasks'],
  helpdesk: ['search', 'unlock', 'resetPwd', 'audit'],
};

let myRole = '';
let myPerms = [];

function setMyRole(role) { myRole = role; }
function setMyPerms(perms) { myPerms = perms || []; }
function getMyRole() { return myRole; }
function getMyPerms() { return myPerms; }

function hasPerm(perm) {
  return myPerms.indexOf(perm) >= 0;
}

function applyRoleUI() {
  // 侧边栏导航项
  document.querySelectorAll('.sidebar-item[data-tab]').forEach(function (btn) {
    const tab = btn.getAttribute('data-tab');
    let show = true;
    if (tab === 'create' && !hasPerm('create')) show = false;
    if (tab === 'offboard' && !hasPerm('offboard')) show = false;
    if (tab === 'tasks' && !hasPerm('tasks')) show = false;
    if (tab === 'audit' && !hasPerm('audit')) show = false;
    if (tab === 'settings' && !hasPerm('adSettings') && !hasPerm('feishuSettings')) show = false;
    btn.style.display = show ? '' : 'none';
  });
  // 下拉菜单项
  document.querySelectorAll('.dropdown-item[data-action]').forEach(function (item) {
    const act = item.getAttribute('data-action');
    let show = true;
    if (act === 'settings' && !hasPerm('adSettings')) show = false;
    if (act === 'feishuSettings' && !hasPerm('feishuSettings')) show = false;
    if (act === 'adminMgmt' && !hasPerm('adminMgmt')) show = false;
    item.style.display = show ? '' : 'none';
  });
}

export { ALL_PERMS, ROLE_PERMS, hasPerm, applyRoleUI, setMyRole, setMyPerms, getMyRole, getMyPerms };
