# AD Management 部署指南

> 适用于 **Linux x86_64 / arm64** 服务器，**二进制 + systemd + Caddy** 方案。
> **纯内网部署**：管理员控制台与飞书 OAuth 自助端均可启用（飞书回调走浏览器跳转，不需公网入口）。

---

## 目录

- [一、部署架构](#一部署架构)
- [二、前置条件](#二前置条件)
- [三、部署步骤](#三部署步骤)
- [四、飞书 OAuth 自助端（纯内网可启用）](#四飞书-oauth-自助端纯内网可启用)
- [五、安全清单](#五安全清单)
- [六、日常运维](#六日常运维)
- [七、回滚步骤](#七回滚步骤)
- [八、常见问题](#八常见问题)

---

## 一、部署架构

```
浏览器（内网）──HTTPS──▶ Caddy :443 ──HTTP──▶ ad-server :8080 (systemd)
                                            │
                                            ├──▶ SQLite (/var/lib/ad-management/)
                                            ├──▶ 日志   (/var/log/ad-management/)
                                            ├──▶ AD 域控 (LDAP 389 / LDAPS 636)
                                            └──▶ 飞书 API (open.feishu.cn，服务器出网)

   飞书 OAuth 回调走浏览器 302 跳转，非服务器间请求，内网可正常使用
```

| 组件 | 路径 / 端口 | 说明 |
|---|---|---|
| 二进制 | `/opt/ad-management/ad-server` | 静态编译，~10MB |
| 前端 | `/opt/ad-management/frontend/` | 静态资源，由 Go 服务托管 |
| 配置 | `/opt/ad-management/.env` | 环境变量，权限 0640 |
| 数据 | `/var/lib/ad-management/ad-management.db` | SQLite 单文件 |
| 日志 | `/var/log/ad-management/` | 应用日志，按日期轮转 |
| 备份 | `/var/lib/ad-management/backup/` | SQLite 热备份归档 |
| systemd | `/etc/systemd/system/ad-management.service` | 服务托管 |
| Caddy | `/etc/caddy/Caddyfile` | HTTPS 反向代理 |

---

## 二、前置条件

### 2.1 服务器要求

- **OS**：Ubuntu 20.04+ / Debian 11+ / CentOS 8+ / RHEL 8+（任意 systemd-based Linux）
- **架构**：x86_64 或 aarch64
- **资源**：1 vCPU / 512MB 内存 / 5GB 磁盘（最低）
- **网络**：
  - 入站：443（HTTPS）
  - 出站：AD 域控 389 / 636，飞书 API 443

### 2.2 必备软件

```bash
# Debian / Ubuntu
sudo apt update
sudo apt install -y caddy sqlite3 curl openssl

# CentOS / RHEL
sudo dnf install -y caddy sqlite curl openssl
```

### 2.3 准备文件

从开发机上传以下文件到服务器（如 `/tmp/ad-management-deploy/`）：

```bash
# 在开发机执行
cd "/path/to/AD Management"

# 打包部署文件（不含源码与 .git）
tar -czf ad-management-deploy.tar.gz \
    ad-server-linux-amd64 \
    frontend/ \
    .env.example \
    deploy/

# 上传到服务器
scp ad-management-deploy.tar.gz user@your-server:/tmp/

# 在服务器解压
ssh user@your-server
mkdir -p /tmp/ad-management-deploy
tar -xzf /tmp/ad-management-deploy.tar.gz -C /tmp/ad-management-deploy
cd /tmp/ad-management-deploy
```

> 如果服务器是 arm64 架构，把 `ad-server-linux-amd64` 替换为 `ad-server-linux-arm64`。

---

## 三、部署步骤

### 3.1 一键部署

```bash
cd /tmp/ad-management-deploy

# 设置域名（必改）
export APP_DOMAIN=ad.internal.company.com

# 执行部署
sudo -E bash deploy.sh
```

脚本会自动完成：
1. 创建 `admgmt` 系统用户（无登录权限）
2. 创建 `/opt/ad-management`、`/var/lib/ad-management`、`/var/log/ad-management` 目录
3. 安装二进制与前端文件
4. 生成 `.env`，含：
   - 随机生成的强密码 `BOOTSTRAP_ADMIN_PASSWORD`
   - 随机生成的 `AD_CRED_ENC_KEY`（AES-256-GCM 凭据加密密钥）
5. 安装 systemd unit 并设置开机自启
6. 安装 Caddy 配置（如已安装 Caddy）
7. 启动服务并执行健康检查

**部署成功输出示例**：

```
[deploy] 服务健康检查通过 ✓
[deploy] 部署完成！
[deploy]   访问地址: https://ad.internal.company.com/admin
[warn] 重要提醒：
[warn]   1. 立即修改 admin 密码
[warn]   2. 备份 .env 中的 AD_CRED_ENC_KEY
[warn]   3. 配置 SQLite 定时备份
```

### 3.2 验证

```bash
# 服务状态
sudo systemctl status ad-management

# 健康检查
curl http://127.0.0.1:8080/healthz
# {"status":"ok"}

# 实时日志
sudo journalctl -u ad-management -f
```

### 3.3 配置定时备份

```bash
# 安装备份脚本
sudo cp /tmp/ad-management-deploy/deploy/backup.sh /opt/ad-management/backup.sh
sudo chmod +x /opt/ad-management/backup.sh
sudo chown admgmt:admgmt /opt/ad-management/backup.sh

# 配置 cron（每天凌晨 3 点备份）
sudo crontab -u admgmt -e
# 添加一行：
0 3 * * * /opt/ad-management/backup.sh >> /var/log/ad-management/backup.log 2>&1
```

### 3.4 信任 Caddy 内部 CA 证书

内网 HTTPS 使用 `tls internal` 自动签发证书，浏览器首次访问会报"不安全"。**将 Caddy 根证书导入客户端信任列表**：

```bash
# 在服务器导出根证书
sudo cat /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt > /tmp/caddy-root-ca.crt

# 下载到客户端机器，导入到系统信任证书存储
# macOS：双击 .crt → 添加到"系统"钥匙串 → 设为"始终信任"
# Windows：双击 .crt → 安装证书 → 本地计算机 → 受信任的根证书颁发机构
```

> 也可以让用户访问 `https://ad.internal.company.com` 时点击"高级 → 继续访问"跳过警告（仅开发/测试用）。

---

## 四、飞书 OAuth 自助端（纯内网可启用）

> ✅ **纯内网环境下飞书 OAuth 可以正常启用**。
> 飞书 OAuth 回调是**浏览器端 302 跳转**，不是飞书服务器主动请求回调地址。只要内网用户浏览器和服务器都能出网访问飞书即可。

### 启用条件

| 条件 | 说明 | 通常满足 |
|---|---|---|
| 内网用户浏览器能访问飞书 | 用户在飞书授权页登录同意 | ✅ 企业内网通常允许出网 |
| 应用服务器能访问飞书 API | 用授权 `code` 换取用户信息 | ✅ 服务器出网到 `open.feishu.cn` |
| 飞书应用后台配置重定向 URL | 与内网应用地址一致 | 手动配置 |

### 工作流程

```
用户浏览器(内网) → 应用 /api/auth/feishu/login
    ↓ 302 重定向
飞书授权页 (浏览器访问 open.feishu.cn，需出网)
    ↓ 用户同意授权
浏览器 302 跳转到 https://ad.internal.company.com/api/auth/feishu/callback?code=xxx
    ↓ (浏览器在内网，能访问内网应用地址)
应用服务器用 code 调飞书 API 获取用户信息 (服务器出网到 open.feishu.cn)
    ↓
设置 ss_token Cookie，302 跳转 /?auth=ok
```

关键点：**飞书服务器不主动请求回调地址**，所有跳转都在用户浏览器完成。所以回调地址可以是内网地址。

### 配置步骤

1. **飞书开放平台创建自建应用**，获取 App ID 和 App Secret
2. **应用的"安全设置" → 重定向 URL** 中添加：
   ```
   https://ad.internal.company.com/api/auth/feishu/callback
   ```
   > 把 `ad.internal.company.com` 替换为实际内网域名或 IP
3. **部署后登录管理控制台** → 飞书配置页面，填入：
   - App ID
   - App Secret
   - 重定向 URI：`https://ad.internal.company.com/api/auth/feishu/callback`
   - 启用：开
4. **保存后重启服务**：
   ```bash
   sudo systemctl restart ad-management
   ```

> 也可以在部署时直接写入 `.env`，服务启动时自动加载：
> ```bash
> FEISHU_APP_ID=cli_xxxxx
> FEISHU_APP_SECRET=xxxxx
> FEISHU_REDIRECT_URI=https://ad.internal.company.com/api/auth/feishu/callback
> ```

### 功能可用性

| 功能 | 状态 | 说明 |
|---|---|---|
| 管理员控制台 `/admin` | ✅ 可用 | Bearer Token 认证，不依赖飞书 |
| 自助端 `/`（飞书 OAuth 登录） | ✅ 可用 | 满足上述启用条件即可 |
| AD 域控操作 | ✅ 可用 | 走内网 LDAP/LDAPS |

### HTTPS 仍然必要

纯内网不代表可以省掉 HTTPS：

- 管理员 Bearer Token / 密码在内网明文传输可被嗅探（ARP 欺骗 / 抓包）
- 飞书 OAuth 要求 `redirect_uri` 必须是 https://（飞书平台限制）
- Caddy `tls internal` 自动用内置 CA 签发证书，无需公网域名验证

证书信任方案二选一：

1. **信任 Caddy 内部 CA**（推荐，零成本）：把 Caddy 根证书通过组策略 / MDM 下发到所有客户端浏览器
2. **企业内部 CA 签发**：如企业已有内部 PKI，用企业 CA 签证书，浏览器已信任

---

## 五、安全清单

部署后逐项检查：

- [ ] **管理员密码**：登录 `/admin`，立即在控制台修改 admin 密码
- [ ] **`AD_CRED_ENC_KEY` 备份**：从 `.env` 复制密钥到密码管理器（1Password / KeePass 等），与数据库文件**物理分离**
- [ ] **`.env` 权限**：`sudo chmod 0640 /opt/ad-management/.env`，所有者 `admgmt:admgmt`
- [ ] **防火墙**：仅开 22 / 443 端口；8080 仅本机访问
  ```bash
  sudo ufw allow 22/tcp
  sudo ufw allow 443/tcp
  sudo ufw enable
  ```
- [ ] **AD Bind 账号最小权限**：仅授予目标 OU 的读写权限，不要用 Domain Admin
- [ ] **LDAPS 证书**：域控已安装证书，636 端口可达
- [ ] **删除保护账号**：`.env` 中 `AD_DELETE_PROTECTED_ACCOUNTS=administrator,krbtgt`
- [ ] **会话时效**：根据安全要求调整 `ADMIN_SESSION_DURATION`（默认 12h）
- [ ] **日志轮转**：应用日志按日期生成，配合 logrotate
  ```bash
  sudo tee /etc/logrotate.d/ad-management > /dev/null <<EOF
  /var/log/ad-management/*.log {
      daily
      rotate 30
      compress
      missingok
      notifempty
      copytruncate
  }
  EOF
  ```
- [ ] **SQLite 备份**：已配置 cron 定时备份，备份文件定期异地归档

---

## 六、日常运维

### 6.1 服务管理

```bash
sudo systemctl start ad-management      # 启动
sudo systemctl stop ad-management       # 停止
sudo systemctl restart ad-management    # 重启
sudo systemctl status ad-management     # 状态
```

### 6.2 查看日志

```bash
# systemd 日志（启动 / 崩溃 / 重启记录）
sudo journalctl -u ad-management -f

# 应用日志（业务日志，JSON 格式）
sudo tail -f /var/log/ad-management/server-$(date +%Y-%m-%d).log

# 搜索特定错误
sudo journalctl -u ad-management --since "1 hour ago" | grep -i error
```

### 6.3 修改配置

```bash
# 编辑 .env
sudo -e /opt/ad-management/.env

# 重启生效
sudo systemctl restart ad-management
```

### 6.4 升级版本

```bash
# 1. 备份数据库
sudo -u admgmt sqlite3 /var/lib/ad-management/ad-management.db ".backup '/var/lib/ad-management/backup/pre-upgrade.db'"

# 2. 停止服务
sudo systemctl stop ad-management

# 3. 替换二进制与前端
sudo install -m 0755 ad-server-linux-amd64 /opt/ad-management/ad-server
sudo rm -rf /opt/ad-management/frontend
sudo cp -r frontend /opt/ad-management/frontend

# 4. 启动服务
sudo systemctl start ad-management

# 5. 健康检查
curl http://127.0.0.1:8080/healthz
```

### 6.5 重置管理员密码

忘记密码时，通过环境变量一次性重置：

```bash
# 设置临时环境变量
echo 'ADMIN_RESET_PASSWORD=NewStrongPwd123!' | sudo tee -a /opt/ad-management/.env

# 重启服务（启动时自动重置并清除该变量）
sudo systemctl restart ad-management

# 验证日志
sudo journalctl -u ad-management --since "1 min ago" | grep "admin password reset"
```

### 6.6 备份与恢复

```bash
# 手动备份
sudo -u admgmt /opt/ad-management/backup.sh

# 恢复备份
sudo systemctl stop ad-management
sudo cp /var/lib/ad-management/backup/ad-management-2026-07-13_030000.db /var/lib/ad-management/ad-management.db
sudo chown admgmt:admgmt /var/lib/ad-management/ad-management.db
sudo systemctl start ad-management
```

---

## 七、回滚步骤

部署失败或新版本有问题时：

```bash
# 1. 停止服务
sudo systemctl stop ad-management

# 2. 恢复旧二进制（建议部署前备份）
sudo cp /opt/ad-management/backup/ad-server.bak /opt/ad-management/ad-server

# 3. 恢复旧前端
sudo rm -rf /opt/ad-management/frontend
sudo cp -r /opt/ad-management/backup/frontend.bak /opt/ad-management/frontend

# 4. 恢复数据库（如需要）
sudo cp /var/lib/ad-management/backup/pre-upgrade.db /var/lib/ad-management/ad-management.db
sudo chown admgmt:admgmt /var/lib/ad-management/ad-management.db

# 5. 启动服务
sudo systemctl start ad-management
```

---

## 八、常见问题

### Q1: 浏览器访问 HTTPS 报"不安全"

内网部署使用 Caddy `tls internal` 自动签发证书，浏览器需信任 Caddy 根 CA。参考 [3.4 信任 Caddy 内部 CA 证书](#34-信任-caddy-内部-ca-证书)。

### Q2: 飞书登录回调失败

飞书 OAuth 回调走浏览器 302 跳转，纯内网可正常使用。回调失败时检查：
1. 飞书应用后台"安全设置"中的重定向 URL 是否与 `.env` / 控制台配置一致
2. 内网用户浏览器是否能访问飞书（`open.feishu.cn`，需出网）
3. 应用服务器是否能访问飞书 API（`curl https://open.feishu.cn`，需出网）
4. `redirect_uri` 是否为 https://（飞书平台要求）

详见 [四、飞书 OAuth 自助端](#四飞书-oauth-自助端纯内网可启用)。

### Q3: 重置密码报 LDAPS 连接失败

1. 确认域控已启用 LDAPS（636 端口，需安装域控证书）
2. 防火墙开放本服务器到域控的 636 出站
3. 域控配置中 `insecureSkipVerify=false` 时，证书需被服务器信任；测试环境可设 `true`

### Q4: 服务启动失败

```bash
# 查看详细错误
sudo journalctl -u ad-management -n 50 --no-pager

# 常见原因：
# - .env 中 AD_CRED_ENC_KEY 格式错误（应为 base64 编码 32 字节）
# - 数据库目录权限不对（应 admgmt:admgmt）
# - 8080 端口被占用（netstat -tlnp | grep 8080）
```

### Q5: Caddy 启动失败

```bash
# 检查配置语法
sudo caddy validate --config /etc/caddy/Caddyfile

# 查看日志
sudo journalctl -u caddy -n 50
```

### Q6: 如何查看审计日志

登录管理控制台 → 审计日志页面，支持按操作者 / 动作 / 目标 / 时间筛选。

### Q7: 定时禁用任务重启后丢失

当前定时禁用使用进程内调度器，服务重启后未完成任务不会自动恢复（已列入路线图）。如需保留，可改为先在控制台手动取消任务再重启。

---

## 附录：文件清单

```
deploy/
├── deploy.sh                # 一键部署脚本
├── backup.sh                # SQLite 备份脚本
├── ad-management.service    # systemd unit 文件
├── Caddyfile                # Caddy 反向代理配置
└── README.md                # 本文档
```
