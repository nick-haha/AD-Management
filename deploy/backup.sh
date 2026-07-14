#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# AD Management — SQLite 定时备份脚本
# ─────────────────────────────────────────────────────────────
# 用法：crontab 每日凌晨 3 点执行
#   0 3 * * * /opt/ad-management/deploy/backup.sh >> /var/log/ad-management/backup.log 2>&1
#
# 备份策略：
#   - 使用 sqlite3 .backup 命令做热备份（不阻塞写入）
#   - 按日期归档：ad-management-YYYY-MM-DD.db.gz
#   - 默认保留近 30 天
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# ===== 配置 =====
DB_PATH="${DB_PATH:-/var/lib/ad-management/ad-management.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/ad-management/backup}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"

TS=$(date +%Y-%m-%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/ad-management-${TS}.db"
COMPRESSED_FILE="${BACKUP_FILE}.gz"

# ===== 检查 =====
[[ -f "$DB_PATH" ]] || { echo "[backup] error: DB not found: $DB_PATH" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "[backup] error: sqlite3 not installed" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"

# ===== 备份 =====
echo "[backup] $(date -Iseconds) start: $DB_PATH"

# 使用 sqlite3 .backup 命令做在线热备份（不会阻塞写操作）
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# 校验备份完整性
if ! sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" | grep -q "^ok$"; then
  echo "[backup] error: integrity check failed for $BACKUP_FILE" >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi

# 压缩
gzip -9 "$BACKUP_FILE"
SIZE=$(du -h "$COMPRESSED_FILE" | cut -f1)
echo "[backup] done: $COMPRESSED_FILE ($SIZE)"

# ===== 清理旧备份 =====
DELETED=$(find "$BACKUP_DIR" -name "ad-management-*.db.gz" -mtime +${RETAIN_DAYS} -print -delete | wc -l)
if [[ $DELETED -gt 0 ]]; then
  echo "[backup] cleaned $DELETED old backup(s) older than ${RETAIN_DAYS} days"
fi

echo "[backup] $(date -Iseconds) finish"
