#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# AD Management — 一键部署脚本（Linux x86_64）
# ─────────────────────────────────────────────────────────────
# 使用前提：
#   1. 以 root 或拥有 sudo 权限的用户执行
#   2. 已将以下文件上传到服务器同一目录：
#      - ad-server-linux-amd64  (二进制)
#      - frontend/              (前端静态资源目录)
#      - .env.example           (环境变量模板)
#      - ad-management.service  (systemd unit)
#      - Caddyfile              (Caddy 配置)
#      - deploy.sh              (本脚本)
#   3. 系统：Ubuntu 20.04+ / Debian 11+ / CentOS 8+ / RHEL 8+
#
# 执行：
#   sudo bash deploy.sh
#
# 如需重新部署，重复执行即可（保留数据与 .env）。
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# ===== 配置（按需修改） =====
APP_NAME="ad-management"
APP_USER="admgmt"
APP_GROUP="admgmt"
INSTALL_DIR="/opt/${APP_NAME}"
DATA_DIR="/var/lib/${APP_NAME}"
LOG_DIR="/var/log/${APP_NAME}"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
SERVICE_NAME="${APP_NAME}.service"

# 默认监听端口（仅本机，Caddy 反代）
HTTP_ADDR="127.0.0.1:8080"

# Caddy 域名（必改：替换为你的内网域名 / IP）
DOMAIN="${APP_DOMAIN:-ad.example.com}"

# ===== 日志函数 =====
log()  { echo -e "\033[32m[deploy]\033[0m $*"; }
warn() { echo -e "\033[33m[warn]\033[0m   $*" >&2; }
err()  { echo -e "\033[31m[error]\033[0m  $*" >&2; exit 1; }

# ===== 前置检查 =====
[[ $EUID -eq 0 ]] || err "请用 root 或 sudo 执行此脚本"

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  BIN_NAME="ad-server-linux-amd64" ;;
  aarch64) BIN_NAME="ad-server-linux-arm64" ;;
  *) err "不支持的架构: $ARCH（仅支持 amd64 / arm64）" ;;
esac
log "检测到架构: $ARCH → 使用二进制 $BIN_NAME"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/$BIN_NAME" ]] || err "找不到二进制 $SCRIPT_DIR/$BIN_NAME"
[[ -d "$SCRIPT_DIR/frontend" ]] || err "找不到 frontend 目录"
[[ -f "$SCRIPT_DIR/.env.example" ]] || err "找不到 .env.example"
log "部署源目录: $SCRIPT_DIR"

# ===== 1. 创建运行用户 =====
if ! id -u "$APP_USER" &>/dev/null; then
  log "创建运行用户 $APP_USER"
  useradd -r -s /usr/sbin/nologin -d "$INSTALL_DIR" -M "$APP_USER"
else
  log "用户 $APP_USER 已存在，跳过"
fi

# ===== 2. 创建目录 =====
log "创建目录"
mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$LOG_DIR"

# ===== 3. 安装二进制与前端 =====
log "安装二进制到 $INSTALL_DIR/ad-server"
install -m 0755 "$SCRIPT_DIR/$BIN_NAME" "$INSTALL_DIR/ad-server"

log "安装前端资源到 $INSTALL_DIR/frontend"
rm -rf "$INSTALL_DIR/frontend"
cp -r "$SCRIPT_DIR/frontend" "$INSTALL_DIR/frontend"

# ===== 4. 配置 .env（首次创建或保留） =====
ENV_FILE="$INSTALL_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  log ".env 已存在，保留现有配置"
else
  log "首次部署，从 .env.example 创建 .env"
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"

  # 生成强密码 bootstrap admin password
  ADMIN_PWD=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
  sed -i "s|^BOOTSTRAP_ADMIN_PASSWORD=.*|BOOTSTRAP_ADMIN_PASSWORD=${ADMIN_PWD}|" "$ENV_FILE"

  # 生成凭据加密密钥
  ENC_KEY=$(openssl rand -base64 32)
  sed -i "s|^AD_CRED_ENC_KEY=.*|AD_CRED_ENC_KEY=${ENC_KEY}|" "$ENV_FILE"

  # 写入路径与监听地址
  sed -i "s|^HTTP_ADDR=.*|HTTP_ADDR=${HTTP_ADDR}|" "$ENV_FILE"
  sed -i "s|^DB_PATH=.*|DB_PATH=${DATA_DIR}/ad-management.db|" "$ENV_FILE"
  if ! grep -q "^LOG_DIR=" "$ENV_FILE"; then
    echo "LOG_DIR=${LOG_DIR}" >> "$ENV_FILE"
  else
    sed -i "s|^LOG_DIR=.*|LOG_DIR=${LOG_DIR}|" "$ENV_FILE"
  fi

  # 删除保护账号
  if ! grep -q "^AD_DELETE_PROTECTED_ACCOUNTS=" "$ENV_FILE"; then
    echo "AD_DELETE_PROTECTED_ACCOUNTS=administrator,krbtgt" >> "$ENV_FILE"
  fi

  chmod 0640 "$ENV_FILE"
  log ""
  log "=========================================================="
  log "  已生成管理员密码与凭据加密密钥（请妥善保存）"
  log "  管理员账号: admin"
  log "  管理员密码: ${ADMIN_PWD}"
  log "  加密密钥  : ${ENC_KEY}"
  log "  配置文件  : ${ENV_FILE}"
  log "  >>> 请立即记录以上信息并删除本输出 <<<"
  log "=========================================================="
  log ""
fi

# ===== 5. 迁移遗留 DB + 设置权限 =====
# 如果 /opt 下有 DB（曾手动 ./ad-server 在当前目录创建的），迁移到规范路径 /var/lib
if [[ -f "$INSTALL_DIR/ad-management.db" ]]; then
  if [[ ! -f "$DATA_DIR/ad-management.db" ]]; then
    cp "$INSTALL_DIR/ad-management.db" "$DATA_DIR/ad-management.db"
    log "迁移 DB: $INSTALL_DIR/ad-management.db → $DATA_DIR/ad-management.db"
  fi
  rm -f "$INSTALL_DIR/ad-management.db"
  log "已清理 $INSTALL_DIR 下的遗留 DB（规范路径：$DATA_DIR）"
fi

log "设置目录权限"
chown -R "$APP_USER:$APP_GROUP" "$INSTALL_DIR" "$DATA_DIR" "$LOG_DIR"
chmod 0750 "$INSTALL_DIR" "$DATA_DIR" "$LOG_DIR"
chmod 0640 "$ENV_FILE"
# 显式确保 DB 文件属主（chown -R 已覆盖，这里双保险）
[[ -f "$DATA_DIR/ad-management.db" ]] && chown "$APP_USER:$APP_GROUP" "$DATA_DIR/ad-management.db"
warn "切勿以 root 手动跑 ./ad-server——会创建 root 属主的 DB 导致服务账号(admgmt)只读写入失败。始终用 systemctl 管理服务。"

# ===== 6. 安装 systemd unit =====
log "安装 systemd unit"
if [[ -f "$SCRIPT_DIR/ad-management.service" ]]; then
  cp "$SCRIPT_DIR/ad-management.service" "$SERVICE_FILE"
else
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=AD Management Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
# 每次启动前以 root 修复 DB/logs 属主（+ 前缀绕过 User= 以 root 执行）
ExecStartPre=+/bin/sh -c 'for d in ${DATA_DIR} ${LOG_DIR} ${INSTALL_DIR}/logs; do [ -e "\$d" ] && chown -R ${APP_USER}:${APP_GROUP} "\$d" 2>/dev/null; done; for f in ${INSTALL_DIR}/ad-management.db ${DATA_DIR}/ad-management.db; do [ -f "\$f" ] && chown ${APP_USER}:${APP_GROUP} "\$f" 2>/dev/null; done; exit 0'
ExecStart=${INSTALL_DIR}/ad-server
Restart=on-failure
RestartSec=5s
TimeoutStopSec=15s
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR} ${LOG_DIR} ${INSTALL_DIR}/logs

[Install]
WantedBy=multi-user.target
EOF
fi

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
log "systemd unit 已安装并设置开机自启"

# ===== 7. （可选）安装 Caddy 配置 =====
if [[ -f "$SCRIPT_DIR/Caddyfile" ]]; then
  if command -v caddy &>/dev/null; then
    log "检测到 Caddy，安装配置"
    mkdir -p /etc/caddy
    # 替换域名
    sed "s|ad.example.com|${DOMAIN}|g" "$SCRIPT_DIR/Caddyfile" > /etc/caddy/Caddyfile
    mkdir -p /var/log/caddy
    chown -R caddy:caddy /var/log/caddy 2>/dev/null || true
    systemctl reload caddy 2>/dev/null || systemctl restart caddy
    log "Caddy 配置已安装，域名: $DOMAIN"
  else
    warn "未检测到 Caddy，跳过配置（请手动安装 Caddy 或使用其他反代）"
    warn "Caddyfile 已在 $SCRIPT_DIR/ 备用"
  fi
fi

# ===== 8. 启动服务 =====
log "启动 $SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# ===== 9. 健康检查 =====
log "等待服务启动..."
sleep 2
for i in {1..10}; do
  if curl -sf "http://127.0.0.1:8080/healthz" >/dev/null 2>&1; then
    log "服务健康检查通过 ✓"
    break
  fi
  [[ $i -eq 10 ]] && {
    err "健康检查失败，请检查: journalctl -u $SERVICE_NAME -n 50"
  }
  sleep 1
done

# ===== 10. 输出 =====
log ""
log "部署完成！"
log "  服务状态:   systemctl status $SERVICE_NAME"
log "  服务日志:   journalctl -u $SERVICE_NAME -f"
log "  应用日志:   tail -f $LOG_DIR/server-\$(date +%Y-%m-%d).log"
log "  配置文件:   $ENV_FILE"
log "  数据库:     $DATA_DIR/ad-management.db"
if command -v caddy &>/dev/null; then
  log "  访问地址:   https://$DOMAIN/admin"
  log "  首次访问浏览器需信任 Caddy 内部 CA 证书"
else
  log "  访问地址:   http://127.0.0.1:8080/admin （请配置反向代理后对外）"
fi
log ""
warn "重要提醒："
warn "  1. 立即修改 admin 密码（首次登录后）"
warn "  2. 备份 .env 中的 AD_CRED_ENC_KEY（密钥丢失则域控凭据不可解密）"
warn "  3. 配置 SQLite 定时备份（参考 backup.sh）"
warn "  4. 飞书 OAuth 可在管理控制台配置后启用（回调走浏览器跳转，内网可用）"
warn "  5. 浏览器首次访问需信任 Caddy 内部 CA 证书（见 README 3.4 节）"
