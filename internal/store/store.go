package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"ad-management/internal/security"

	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("not found")

// sqliteTimeFormat 与 SQLite CURRENT_TIMESTAMP 产出格式一致（UTC，空格分隔）。
// 写入 DATETIME 列且后续会用 `> CURRENT_TIMESTAMP` 比较时，必须用此格式——
// 否则 modernc 驱动默认把 time.Time 序列化为 RFC3339（如 2026-07-09T17:30:00+08:00），
// 与 CURRENT_TIMESTAMP（2026-07-09 09:30:00）做字符串比较时，
// 第 11 个字符 'T'(0x54) > ' '(0x20) 恒真，导致 session 永不过期。
const sqliteTimeFormat = "2006-01-02 15:04:05"

// sqliteNowUTC 返回当前 UTC 时间的 SQLite 格式字符串。
func sqliteNowUTC() string {
	return time.Now().UTC().Format(sqliteTimeFormat)
}

// sqliteTimeUTC 将 time.Time 转为 UTC 并格式化为 SQLite CURRENT_TIMESTAMP 兼容格式。
func sqliteTimeUTC(t time.Time) string {
	return t.UTC().Format(sqliteTimeFormat)
}

type Store struct {
	db     *sql.DB
	cipher *security.CredentialCipher // 凭据字段级加解密器（nil=明文模式）
}

// SetCipher 注入凭据加解密器。应在 Open 后、业务调用前执行。
func (s *Store) SetCipher(c *security.CredentialCipher) {
	s.cipher = c
}

type Admin struct {
	ID           int64     `json:"id"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"`
	Role         string    `json:"role"`
	Permissions  []string  `json:"permissions"`
	CreatedAt    time.Time `json:"createdAt"`
}

type AuditLog struct {
	ID         int64     `json:"id"`
	Actor      string    `json:"actor"`
	Action     string    `json:"action"`
	Role       string    `json:"role"`
	Target     string    `json:"target"`
	Detail     string    `json:"detail"`
	RemoteAddr string    `json:"remoteAddr"`
	UserAgent  string    `json:"userAgent"`
	Success    bool      `json:"success"`
	ErrorMsg   string    `json:"errorMsg"`
	DurationMs int64     `json:"durationMs"`
	CreatedAt  time.Time `json:"createdAt"`
}

type ADSettings struct {
	Host               string `json:"host"`
	Port               int    `json:"port"`
	DomainName         string `json:"domainName"`
	UseTLS             bool   `json:"useTLS"`
	InsecureSkipVerify bool   `json:"insecureSkipVerify"`
	BaseDN             string `json:"baseDN"`
	UserOU             string `json:"userOU"`
	DisabledOU         string `json:"disabledOU"`
	BindUsername       string `json:"bindUsername"`
	BindPassword       string `json:"bindPassword,omitempty"`
	DomainNetBIOS      string `json:"domainNetBIOS"`
	DomainUPNSuffix    string `json:"domainUPNSuffix"`
	OUScope           string `json:"ouScope"`
	GroupScope         string `json:"groupScope"`
	OUOptions          string `json:"ouOptions"`
	GroupOptions       string `json:"groupOptions"`
	// PasswordMaxAgeDays 域密码策略的最大密码有效期（天），默认 90。
	// 用于前端计算密码到期状态，需与域控实际策略一致。
	PasswordMaxAgeDays int    `json:"passwordMaxAgeDays"`
	UpdatedAt          string `json:"updatedAt,omitempty"`
}

// FeishuSettings 飞书应用配置（单行 id=1）
type FeishuSettings struct {
	AppID               string `json:"appId"`
	AppSecret           string `json:"appSecret,omitempty"` // 读取时脱敏
	RedirectURI         string `json:"redirectUri"`
	Enabled             bool   `json:"enabled"`
	SessionDurationHours int   `json:"sessionDurationHours"`
	UpdatedAt           string `json:"updatedAt,omitempty"`
}

type Option struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

const (
	RoleSuperAdmin = "super_admin"
	RoleHRAdmin    = "hr_admin"
	RoleHelpdesk   = "helpdesk"
	RoleCustom     = "custom" // 自定义权限勾选

	MaxLoginAttempts = 5
	LockoutDuration  = 30 * time.Minute
)

// ── 权限项 ──
// 与前端 PERMS 矩阵一一对应，是鉴权的最小粒度。
const (
	PermSearch        = "search"
	PermCreate        = "create"
	PermDelete        = "delete"
	PermDisable       = "disable"       // 禁用/启用
	PermUnlock        = "unlock"
	PermResetPwd      = "resetPwd"
	PermOffboard      = "offboard"
	PermModifyUser    = "modifyUser"
	PermAddGroup      = "addGroup"      // 加组/移组
	PermADSettings    = "adSettings"
	PermFeishuSettings = "feishuSettings"
	PermAudit         = "audit"
	PermTasks         = "tasks"
	PermAdminMgmt     = "adminMgmt"
)

// RolePermissions 预设角色对应的权限集。
// 自定义勾选的管理员 role="custom"，权限完全由 permissions 字段决定。
var RolePermissions = map[string][]string{
	RoleSuperAdmin: {PermSearch, PermCreate, PermDelete, PermDisable, PermUnlock, PermResetPwd, PermOffboard, PermModifyUser, PermAddGroup, PermADSettings, PermFeishuSettings, PermAudit, PermTasks, PermAdminMgmt},
	RoleHRAdmin:    {PermSearch, PermCreate, PermDisable, PermOffboard, PermModifyUser, PermAddGroup, PermAudit, PermTasks},
	RoleHelpdesk:   {PermSearch, PermUnlock, PermResetPwd, PermAudit},
}

// AllPermissions 返回全部权限项，供前端渲染勾选清单。
func AllPermissions() []string {
	return []string{PermSearch, PermCreate, PermDelete, PermDisable, PermUnlock, PermResetPwd, PermOffboard, PermModifyUser, PermAddGroup, PermADSettings, PermFeishuSettings, PermAudit, PermTasks, PermAdminMgmt}
}

// EffectivePermissions 返回管理员的实际权限。
// 优先用 permissions 字段；为空时回退到 role 对应的预设权限集（兼容旧数据）。
func (a Admin) EffectivePermissions() []string {
	if len(a.Permissions) > 0 {
		return a.Permissions
	}
	if perms, ok := RolePermissions[a.Role]; ok {
		return perms
	}
	return nil
}

// HasPermission 检查管理员是否拥有指定权限。
func (a Admin) HasPermission(perm string) bool {
	for _, p := range a.EffectivePermissions() {
		if p == perm {
			return true
		}
	}
	return false
}

// permsToJSON 将权限列表序列化为 JSON 字符串存入数据库。空列表存空串。
func permsToJSON(perms []string) string {
	if len(perms) == 0 {
		return ""
	}
	b, err := json.Marshal(perms)
	if err != nil {
		return ""
	}
	return string(b)
}

// permsFromJSON 从数据库 JSON 字符串反序列化权限列表。
func permsFromJSON(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	var perms []string
	if err := json.Unmarshal([]byte(s), &perms); err != nil {
		return nil
	}
	return perms
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &Store{db: db}
	if err := store.migrate(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	// Start background cleanup goroutine for expired sessions, old login attempts, and completed tasks
	go store.periodicCleanup()
	return store, nil
}

// periodicCleanup runs every 10 minutes to remove expired sessions,
// old login attempts (>30 days), and completed scheduled tasks (>7 days).
func (s *Store) periodicCleanup() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		if err := s.CleanExpiredSessions(ctx); err != nil {
			_ = cancel
			continue
		}
		_ = s.CleanOldLoginAttempts(ctx, 30*24*time.Hour)
		_ = s.CleanCompletedTasks(ctx, 7*24*time.Hour)
		_ = s.CleanExpiredSelfServiceSessions(ctx)
		cancel()
	}
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
	CREATE TABLE IF NOT EXISTS admins (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL UNIQUE,
		password_hash TEXT NOT NULL,
		role TEXT NOT NULL DEFAULT 'super_admin',
		created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE IF NOT EXISTS sessions (
		token TEXT PRIMARY KEY,
		admin_id INTEGER NOT NULL,
		expires_at DATETIME NOT NULL,
		created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY(admin_id) REFERENCES admins(id)
	);
	CREATE TABLE IF NOT EXISTS audit_logs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		actor TEXT NOT NULL,
		action TEXT NOT NULL,
		target TEXT NOT NULL,
		detail TEXT NOT NULL,
		created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE IF NOT EXISTS ad_settings (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		host TEXT NOT NULL,
		port INTEGER NOT NULL DEFAULT 389,
		use_tls INTEGER NOT NULL DEFAULT 0,
		insecure_skip_verify INTEGER NOT NULL DEFAULT 1,
		base_dn TEXT NOT NULL,
		user_ou TEXT NOT NULL,
		disabled_ou TEXT NOT NULL,
		bind_username TEXT NOT NULL,
		bind_password TEXT NOT NULL,
		domain_netbios TEXT NOT NULL,
		domain_upn_suffix TEXT NOT NULL,
		ou_options TEXT NOT NULL DEFAULT '',
		group_options TEXT NOT NULL DEFAULT '',
		updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
	);
	CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
	CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
	CREATE TABLE IF NOT EXISTS login_attempts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL,
		ip_address TEXT NOT NULL,
		success INTEGER NOT NULL DEFAULT 0,
		created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
	);
	CREATE INDEX IF NOT EXISTS idx_login_attempts_username ON login_attempts(username, created_at DESC);
	CREATE TABLE IF NOT EXISTS scheduled_tasks (
		id TEXT PRIMARY KEY,
		account TEXT NOT NULL,
		action TEXT NOT NULL DEFAULT 'disable',
		scheduled_at DATETIME NOT NULL,
		created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		completed INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_account ON scheduled_tasks(account);
	CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_scheduled_at ON scheduled_tasks(scheduled_at);
	CREATE TABLE IF NOT EXISTS self_service_sessions (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		token       TEXT    NOT NULL UNIQUE,
		open_id     TEXT    NOT NULL,
		feishu_name TEXT    NOT NULL DEFAULT '',
		ad_account  TEXT    NOT NULL DEFAULT '',
		created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
		expires_at  DATETIME NOT NULL,
		last_seen   DATETIME NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX IF NOT EXISTS idx_ss_sessions_token ON self_service_sessions(token);
	CREATE INDEX IF NOT EXISTS idx_ss_sessions_expires ON self_service_sessions(expires_at);
	CREATE TABLE IF NOT EXISTS feishu_settings (
		id                       INTEGER PRIMARY KEY CHECK (id = 1),
		app_id                   TEXT    NOT NULL DEFAULT '',
		app_secret               TEXT    NOT NULL DEFAULT '',
		redirect_uri             TEXT    NOT NULL DEFAULT '',
		enabled                  INTEGER NOT NULL DEFAULT 0,
		session_duration_hours   INTEGER NOT NULL DEFAULT 8,
		updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
	);
	`)
	if err != nil {
		return err
	}
	// Add role column if missing (migration for existing databases)
	_, _ = s.db.ExecContext(ctx, `ALTER TABLE ad_settings ADD COLUMN ou_scope TEXT NOT NULL DEFAULT ''`)
	_, _ = s.db.ExecContext(ctx, `ALTER TABLE ad_settings ADD COLUMN group_scope TEXT NOT NULL DEFAULT ''`)
	_, _ = s.db.ExecContext(ctx, `ALTER TABLE audit_logs ADD COLUMN remote_addr TEXT NOT NULL DEFAULT ''`)
	_, _ = s.db.ExecContext(ctx, `ALTER TABLE audit_logs ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''`)
	_, _ = s.db.ExecContext(ctx, `ALTER TABLE audit_logs ADD COLUMN success INTEGER NOT NULL DEFAULT 1`)
	_, _ = s.db.ExecContext(ctx, `ALTER TABLE audit_logs ADD COLUMN error_msg TEXT NOT NULL DEFAULT ''`)
	_, _ = s.db.ExecContext(ctx, `ALTER TABLE audit_logs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0`)
	_, _ = s.db.ExecContext(ctx, `ALTER TABLE audit_logs ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`)
	_, _ = s.db.ExecContext(ctx, `ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'super_admin'`)
	_, _ = s.db.ExecContext(ctx, `ALTER TABLE admins ADD COLUMN permissions TEXT NOT NULL DEFAULT ''`)
	_, _ = s.db.ExecContext(ctx, `ALTER TABLE ad_settings ADD COLUMN password_max_age_days INTEGER NOT NULL DEFAULT 90`)
	return nil
}

// ── Admin CRUD ──

func (s *Store) EnsureAdmin(ctx context.Context, username string, passwordHash []byte) error {
	var exists int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM admins WHERE username = ?`, username).Scan(&exists)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO admins(username, password_hash, role) VALUES(?, ?, ?)`, username, string(passwordHash), RoleSuperAdmin)
	return err
}

// ListAdmins 返回所有管理员列表（不含密码哈希），按创建时间升序。
func (s *Store) ListAdmins(ctx context.Context) ([]Admin, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, username, role, permissions, created_at FROM admins ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var admins []Admin
	for rows.Next() {
		var a Admin
		var permsStr string
		if err := rows.Scan(&a.ID, &a.Username, &a.Role, &permsStr, &a.CreatedAt); err != nil {
			return nil, err
		}
		a.Permissions = permsFromJSON(permsStr)
		admins = append(admins, a)
	}
	return admins, rows.Err()
}

// CreateAdminWithRole 创建指定角色的管理员。用户名已存在时返回 ErrNotFound 的反向：
// 这里返回 nil 表示幂等（已存在则不创建），由 handler 层做唯一性校验。
func (s *Store) CreateAdminWithRole(ctx context.Context, username string, passwordHash []byte, role string) error {
	perms := RolePermissions[role]
	_, err := s.db.ExecContext(ctx, `INSERT INTO admins(username, password_hash, role, permissions) VALUES(?, ?, ?, ?)`, username, string(passwordHash), role, permsToJSON(perms))
	return err
}

// CreateAdminWithPermissions 创建带自定义权限的管理员。role 会被设为 "custom"。
func (s *Store) CreateAdminWithPermissions(ctx context.Context, username string, passwordHash []byte, role string, permissions []string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO admins(username, password_hash, role, permissions) VALUES(?, ?, ?, ?)`, username, string(passwordHash), role, permsToJSON(permissions))
	return err
}

// AdminExists 检查用户名是否已存在。
func (s *Store) AdminExists(ctx context.Context, username string) (bool, error) {
	var exists int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM admins WHERE username = ?`, username).Scan(&exists)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return false, err
}

// DeleteAdmin 按 username 删除管理员。返回是否实际删除了行。
func (s *Store) DeleteAdmin(ctx context.Context, username string) (bool, error) {
	result, err := s.db.ExecContext(ctx, `DELETE FROM admins WHERE username = ?`, username)
	if err != nil {
		return false, err
	}
	rows, _ := result.RowsAffected()
	return rows > 0, nil
}

// CountSuperAdmins 统计拥有管理员管理权限的管理员数量，
// 用于防止误删最后一个能管理管理员的人。
//
// 统计口径（与 EffectivePermissions 一致）：
//   1. permissions 字段显式包含 adminMgmt 的（custom 角色或显式赋权的预设角色）
//   2. role = super_admin 的（无论 permissions 字段是空串、'[]' 还是完整 JSON，
//      super_admin 按 RolePermissions 定义一定拥有 adminMgmt）
//
// 旧实现 `permissions = '' AND role = ?` 会漏掉 permissions 为 '[]'（空数组序列化）
// 的 super_admin，导致最后一个 super_admin 可能被误删。
func (s *Store) CountSuperAdmins(ctx context.Context) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM admins WHERE permissions LIKE '%"adminMgmt"%' OR role = ?`,
		RoleSuperAdmin,
	).Scan(&count)
	return count, err
}

func (s *Store) UpdateAdminPassword(ctx context.Context, adminID int64, passwordHash string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE admins SET password_hash = ? WHERE id = ?`, passwordHash, adminID)
	return err
}
func (s *Store) ResetAdminPasswordByUsername(ctx context.Context, username string, passwordHash string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE admins SET password_hash = ? WHERE username = ?`, passwordHash, username)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return ErrNotFound
	}
	return nil
}

// RecordLoginAttempt records a login attempt.
// The created_at is set explicitly as a UTC RFC3339 string rather than relying
// on DEFAULT CURRENT_TIMESTAMP. The login_attempts column is declared DATETIME,
// which gives it NUMERIC affinity in SQLite; a value produced by CURRENT_TIMESTAMP
// (even though it renders as RFC3339) is stored with a different internal type than
// an explicitly-bound text parameter, so `created_at > ?` string comparisons silently
// return false against CURRENT_TIMESTAMP rows. Writing the timestamp ourselves
// guarantees the stored and compared values share the same type and format.
func (s *Store) RecordLoginAttempt(ctx context.Context, username, ip string, success bool) error {
	var successInt int
	if success {
		successInt = 1
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.ExecContext(ctx, `INSERT INTO login_attempts(username, ip_address, success, created_at) VALUES(?, ?, ?, ?)`, username, ip, successInt, now)
	return err
}

// GetRecentFailedAttempts returns the count of failed login attempts in the lockout window.
// The cutoff is formatted as UTC RFC3339 to match the timestamp format written by
// RecordLoginAttempt (time.Now().UTC().Format(time.RFC3339)), ensuring the lexicographic
// string comparison in the WHERE clause is correct. Passing a Go time.Time directly would
// serialize in the local timezone (e.g. "...T16:35:05+08:00"), causing "09..." < "16..."
// and making every recent attempt invisible — silently disabling brute-force protection.
func (s *Store) GetRecentFailedAttempts(ctx context.Context, username string) (int, error) {
	cutoff := time.Now().Add(-LockoutDuration).UTC().Format(time.RFC3339)
	var count int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM login_attempts WHERE username = ? AND success = 0 AND created_at > ?`,
		username, cutoff,
	).Scan(&count)
	return count, err
}

// ClearLoginAttempts clears all login attempts for a username (on successful login)
func (s *Store) ClearLoginAttempts(ctx context.Context, username string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM login_attempts WHERE username = ?`, username)
	return err
}

// IsLockedOut checks if the account is locked out due to too many failed attempts
func (s *Store) IsLockedOut(ctx context.Context, username string) (bool, int, error) {
	count, err := s.GetRecentFailedAttempts(ctx, username)
	if err != nil {
		return false, 0, err
	}
	return count >= MaxLoginAttempts, count, nil
}

// GetLockoutRemaining returns remaining lockout time
func (s *Store) GetLockoutRemaining(ctx context.Context, username string) (time.Duration, error) {
	var lastAttempt time.Time
	err := s.db.QueryRowContext(ctx,
		`SELECT created_at FROM login_attempts WHERE username = ? AND success = 0 ORDER BY created_at DESC LIMIT 1`,
		username,
	).Scan(&lastAttempt)
	if err != nil {
		return 0, err
	}
	remaining := LockoutDuration - time.Since(lastAttempt)
	if remaining < 0 {
		return 0, nil
	}
	return remaining, nil
}

func (s *Store) FindAdminByUsername(ctx context.Context, username string) (Admin, error) {
	return s.findAdmin(ctx, `SELECT id, username, password_hash, role, permissions, created_at FROM admins WHERE username = ?`, username)
}

func (s *Store) FindAdminBySession(ctx context.Context, token string) (Admin, error) {
	admin, err := s.findAdmin(ctx, `
	SELECT a.id, a.username, a.password_hash, a.role, a.permissions, a.created_at
	FROM sessions s
	JOIN admins a ON a.id = s.admin_id
	WHERE s.token = ? AND s.expires_at > CURRENT_TIMESTAMP`, token)
	if err != nil {
		return Admin{}, err
	}
	return admin, nil
}

func (s *Store) findAdmin(ctx context.Context, query string, args ...any) (Admin, error) {
	var admin Admin
	var permsStr string
	err := s.db.QueryRowContext(ctx, query, args...).Scan(&admin.ID, &admin.Username, &admin.PasswordHash, &admin.Role, &permsStr, &admin.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Admin{}, ErrNotFound
	}
	if err != nil {
		return Admin{}, err
	}
	admin.Permissions = permsFromJSON(permsStr)
	return admin, nil
}

// UpdateAdminPermissions 更新管理员的权限列表，同时把 role 设为 "custom"。
func (s *Store) UpdateAdminPermissions(ctx context.Context, username string, permissions []string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE admins SET permissions = ?, role = ? WHERE username = ?`, permsToJSON(permissions), RoleCustom, username)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) CreateSession(ctx context.Context, token string, adminID int64, expiresAt time.Time) error {
	// 用 UTC + SQLite 格式写入，确保与 FindAdminBySession 的 `> CURRENT_TIMESTAMP` 比较格式一致。
	// 直接传 time.Time 会被驱动序列化为带时区的 RFC3339，导致字符串比较恒真、session 永不过期。
	_, err := s.db.ExecContext(ctx, `INSERT INTO sessions(token, admin_id, expires_at) VALUES(?, ?, ?)`, token, adminID, sqliteTimeUTC(expiresAt))
	return err
}

func (s *Store) AddAuditLog(ctx context.Context, actor string, role string, action string, target string, detail string, remoteAddr string, userAgent string, success bool, errorMsg string, durationMs int64) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO audit_logs(actor, role, action, target, detail, remote_addr, user_agent, success, error_msg, duration_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, actor, role, action, target, detail, remoteAddr, userAgent, boolInt(success), errorMsg, durationMs)
	return err
}

func (s *Store) ListAuditLogs(ctx context.Context, limit int, startDate string, endDate string) ([]AuditLog, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var where string
	var args []any
	if startDate != "" {
		where += " AND created_at >= ?"
		args = append(args, startDate)
	}
	if endDate != "" {
		where += " AND created_at <= ?"
		args = append(args, endDate)
	}
	query := `SELECT id, actor, role, action, target, detail, remote_addr, user_agent, success, error_msg, duration_ms, created_at FROM audit_logs WHERE 1=1` + where + ` ORDER BY created_at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []AuditLog
	for rows.Next() {
		var item AuditLog
		if err := rows.Scan(&item.ID, &item.Actor, &item.Role, &item.Action, &item.Target, &item.Detail, &item.RemoteAddr, &item.UserAgent, &item.Success, &item.ErrorMsg, &item.DurationMs, &item.CreatedAt); err != nil {
			return nil, err
		}
		logs = append(logs, item)
	}
	return logs, rows.Err()
}

// ListAuditLogsByTarget returns audit logs where target matches the given account,
// excluding search_users logs (which use target as search query, not account name).
func (s *Store) ListAuditLogsByTarget(ctx context.Context, account string, limit int) ([]AuditLog, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	query := `SELECT id, actor, role, action, target, detail, remote_addr, user_agent, success, error_msg, duration_ms, created_at FROM audit_logs WHERE target = ? AND action != 'search_users' ORDER BY created_at DESC LIMIT ?`
	rows, err := s.db.QueryContext(ctx, query, account, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var logs []AuditLog
	for rows.Next() {
		var item AuditLog
		if err := rows.Scan(&item.ID, &item.Actor, &item.Role, &item.Action, &item.Target, &item.Detail, &item.RemoteAddr, &item.UserAgent, &item.Success, &item.ErrorMsg, &item.DurationMs, &item.CreatedAt); err != nil {
			return nil, err
		}
		logs = append(logs, item)
	}
	return logs, rows.Err()
}

// AuditLogFilter 审计日志筛选条件。Actor/Action 精确匹配，Target 模糊匹配。
// Actions 非空时按多选 IN 查询（与 Action 互斥，优先 Actions）。
type AuditLogFilter struct {
	Actor     string
	Action    string
	Actions   []string
	Target    string
	StartDate string
	EndDate   string
	Page      int
	PageSize  int
}

// AuditLogResult 审计日志分页结果。
type AuditLogResult struct {
	Logs  []AuditLog `json:"logs"`
	Total int        `json:"total"`
}

// ListAuditLogsFiltered 按筛选条件分页查询审计日志，返回日志列表与总数。
// 时间戳比较沿用 ListAuditLogs 的字符串比较方式（created_at 与传入的 startDate/endDate 文本比较）。
func (s *Store) ListAuditLogsFiltered(ctx context.Context, f AuditLogFilter) (AuditLogResult, error) {
	if f.PageSize <= 0 || f.PageSize > 200 {
		f.PageSize = 50
	}
	if f.Page <= 0 {
		f.Page = 1
	}
	offset := (f.Page - 1) * f.PageSize

	var where string
	var args []any
	if f.Actor != "" {
		where += " AND actor = ?"
		args = append(args, f.Actor)
	}
	if len(f.Actions) > 0 {
		placeholders := make([]string, len(f.Actions))
		for i, a := range f.Actions {
			placeholders[i] = "?"
			args = append(args, a)
		}
		where += " AND action IN (" + strings.Join(placeholders, ",") + ")"
	} else if f.Action != "" {
		where += " AND action = ?"
		args = append(args, f.Action)
	}
	if f.Target != "" {
		where += " AND target LIKE ?"
		args = append(args, "%"+f.Target+"%")
	}
	if f.StartDate != "" {
		where += " AND created_at >= ?"
		args = append(args, f.StartDate)
	}
	if f.EndDate != "" {
		where += " AND created_at <= ?"
		args = append(args, f.EndDate)
	}

	// 先查总数
	countQuery := "SELECT COUNT(*) FROM audit_logs WHERE 1=1" + where
	var total int
	if err := s.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return AuditLogResult{}, err
	}

	// 再查当前页数据
	query := `SELECT id, actor, role, action, target, detail, remote_addr, user_agent, success, error_msg, duration_ms, created_at FROM audit_logs WHERE 1=1` + where + ` ORDER BY created_at DESC LIMIT ? OFFSET ?`
	pageArgs := append(args, f.PageSize, offset)
	rows, err := s.db.QueryContext(ctx, query, pageArgs...)
	if err != nil {
		return AuditLogResult{}, err
	}
	defer rows.Close()

	logs := []AuditLog{}
	for rows.Next() {
		var item AuditLog
		if err := rows.Scan(&item.ID, &item.Actor, &item.Role, &item.Action, &item.Target, &item.Detail, &item.RemoteAddr, &item.UserAgent, &item.Success, &item.ErrorMsg, &item.DurationMs, &item.CreatedAt); err != nil {
			return AuditLogResult{}, err
		}
		logs = append(logs, item)
	}
	return AuditLogResult{Logs: logs, Total: total}, rows.Err()
}

func (s *Store) GetADSettings(ctx context.Context) (ADSettings, error) {
	var settings ADSettings
	var useTLS, insecure int
	err := s.db.QueryRowContext(ctx, `
	SELECT host, port, use_tls, insecure_skip_verify, base_dn, user_ou, disabled_ou,
	bind_username, bind_password, domain_netbios, domain_upn_suffix, ou_options, group_options, ou_scope, group_scope, password_max_age_days, updated_at
	FROM ad_settings WHERE id = 1`).Scan(
		&settings.Host,
		&settings.Port,
		&useTLS,
		&insecure,
		&settings.BaseDN,
		&settings.UserOU,
		&settings.DisabledOU,
		&settings.BindUsername,
		&settings.BindPassword,
		&settings.DomainNetBIOS,
		&settings.DomainUPNSuffix,
		&settings.OUOptions,
		&settings.GroupOptions,
		&settings.OUScope,
		&settings.GroupScope,
		&settings.PasswordMaxAgeDays,
		&settings.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ADSettings{}, ErrNotFound
	}
	if err != nil {
		return settings, err
	}
	if settings.PasswordMaxAgeDays == 0 {
		settings.PasswordMaxAgeDays = 90
	}
	settings.UseTLS = useTLS == 1
	settings.InsecureSkipVerify = insecure == 1
	// 解密 bindPassword（兼容旧明文）
	if settings.BindPassword != "" && s.cipher != nil {
		dec, derr := s.cipher.Decrypt(settings.BindPassword)
		if derr != nil {
			return settings, derr
		}
		settings.BindPassword = dec
	}
	return settings, nil
}

func (s *Store) SaveADSettings(ctx context.Context, settings ADSettings) error {
	if settings.Port == 0 {
		settings.Port = 389
	}
	if settings.PasswordMaxAgeDays == 0 {
		settings.PasswordMaxAgeDays = 90
	}
	// 加密 bindPassword（明文 → 密文存储）
	bindPwd := settings.BindPassword
	if s.cipher != nil && bindPwd != "" {
		enc, err := s.cipher.Encrypt(bindPwd)
		if err != nil {
			return err
		}
		bindPwd = enc
	}
	_, err := s.db.ExecContext(ctx, `
	INSERT INTO ad_settings (
		id, host, port, use_tls, insecure_skip_verify, base_dn, user_ou, disabled_ou,
		bind_username, bind_password, domain_netbios, domain_upn_suffix, ou_options, group_options, ou_scope, group_scope, password_max_age_days, updated_at
	) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
	ON CONFLICT(id) DO UPDATE SET
		host = excluded.host,
		port = excluded.port,
		use_tls = excluded.use_tls,
		insecure_skip_verify = excluded.insecure_skip_verify,
		base_dn = excluded.base_dn,
		user_ou = excluded.user_ou,
		disabled_ou = excluded.disabled_ou,
		bind_username = excluded.bind_username,
		bind_password = excluded.bind_password,
		domain_netbios = excluded.domain_netbios,
		domain_upn_suffix = excluded.domain_upn_suffix,
		ou_options = excluded.ou_options,
		group_options = excluded.group_options,
		ou_scope = excluded.ou_scope,
		group_scope = excluded.group_scope,
		password_max_age_days = excluded.password_max_age_days,
		updated_at = CURRENT_TIMESTAMP`,
		settings.Host,
		settings.Port,
		boolInt(settings.UseTLS),
		boolInt(settings.InsecureSkipVerify),
		settings.BaseDN,
		settings.UserOU,
		settings.DisabledOU,
		settings.BindUsername,
		bindPwd,
		settings.DomainNetBIOS,
		settings.DomainUPNSuffix,
		settings.OUOptions,
		settings.GroupOptions,
		settings.OUScope,
		settings.GroupScope,
		settings.PasswordMaxAgeDays,
	)
	return err
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

// ── Scheduled Task CRUD ──

type StoredScheduledTask struct {
	ID          string    `json:"id"`
	Account     string    `json:"account"`
	Action      string    `json:"action"`
	ScheduledAt time.Time `json:"scheduledAt"`
	CreatedAt   time.Time `json:"createdAt"`
}

func (s *Store) CreateScheduledTask(ctx context.Context, task StoredScheduledTask) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO scheduled_tasks(id, account, action, scheduled_at, created_at) VALUES(?, ?, ?, ?, ?)`,
		task.ID, task.Account, task.Action, task.ScheduledAt, task.CreatedAt)
	return err
}

func (s *Store) DeleteScheduledTask(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM scheduled_tasks WHERE id = ?`, id)
	return err
}

func (s *Store) MarkScheduledTaskCompleted(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE scheduled_tasks SET completed = 1 WHERE id = ?`, id)
	return err
}

func (s *Store) ListPendingScheduledTasks(ctx context.Context) ([]StoredScheduledTask, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, account, action, scheduled_at, created_at FROM scheduled_tasks WHERE completed = 0 ORDER BY scheduled_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []StoredScheduledTask
	for rows.Next() {
		var t StoredScheduledTask
		if err := rows.Scan(&t.ID, &t.Account, &t.Action, &t.ScheduledAt, &t.CreatedAt); err != nil {
			return nil, err
		}
		tasks = append(tasks, t)
	}
	return tasks, rows.Err()
}

// CleanCompletedTasks removes completed tasks older than the given duration.
func (s *Store) CleanCompletedTasks(ctx context.Context, olderThan time.Duration) error {
	cutoff := time.Now().Add(-olderThan)
	_, err := s.db.ExecContext(ctx, `DELETE FROM scheduled_tasks WHERE completed = 1 AND created_at < ?`, cutoff)
	return err
}

// CleanExpiredSessions removes expired sessions from the database.
func (s *Store) CleanExpiredSessions(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP`)
	return err
}

// CleanOldLoginAttempts removes login attempts older than the given duration.
// Uses UTC RFC3339 format to match the format written by RecordLoginAttempt,
// so the string comparison in the WHERE clause is correct.
func (s *Store) CleanOldLoginAttempts(ctx context.Context, olderThan time.Duration) error {
	cutoff := time.Now().Add(-olderThan).UTC().Format(time.RFC3339)
	_, err := s.db.ExecContext(ctx, `DELETE FROM login_attempts WHERE created_at < ?`, cutoff)
	return err
}

// ── Self-Service Session CRUD ──

type SelfServiceSession struct {
	ID          int64     `json:"id"`
	Token       string    `json:"-"`
	OpenID      string    `json:"openId"`
	FeishuName  string    `json:"feishuName"`
	ADAccount   string    `json:"adAccount"`
	CreatedAt   time.Time `json:"createdAt"`
	ExpiresAt   time.Time `json:"expiresAt"`
	LastSeen    time.Time `json:"lastSeen"`
}

// CreateSelfServiceSession creates a new self-service session.
func (s *Store) CreateSelfServiceSession(ctx context.Context, token, openID, feishuName, adAccount string, expiresAt time.Time) error {
	// 用 UTC + SQLite 格式写入，与 FindSelfServiceSession 的 `> CURRENT_TIMESTAMP` 比较格式一致。
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO self_service_sessions(token, open_id, feishu_name, ad_account, expires_at) VALUES(?, ?, ?, ?, ?)`,
		token, openID, feishuName, adAccount, sqliteTimeUTC(expiresAt))
	return err
}

// FindSelfServiceSession finds a session by token that hasn't expired.
func (s *Store) FindSelfServiceSession(ctx context.Context, token string) (SelfServiceSession, error) {
	var sess SelfServiceSession
	err := s.db.QueryRowContext(ctx,
		`SELECT id, token, open_id, feishu_name, ad_account, created_at, expires_at, last_seen
		 FROM self_service_sessions
		 WHERE token = ? AND expires_at > CURRENT_TIMESTAMP`,
		token,
	).Scan(&sess.ID, &sess.Token, &sess.OpenID, &sess.FeishuName, &sess.ADAccount,
		&sess.CreatedAt, &sess.ExpiresAt, &sess.LastSeen)
	if errors.Is(err, sql.ErrNoRows) {
		return SelfServiceSession{}, ErrNotFound
	}
	return sess, err
}

// TouchSelfServiceSession updates last_seen for a session.
func (s *Store) TouchSelfServiceSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE self_service_sessions SET last_seen = CURRENT_TIMESTAMP WHERE token = ?`,
		token)
	return err
}

// DeleteSelfServiceSession deletes a session by token.
func (s *Store) DeleteSelfServiceSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM self_service_sessions WHERE token = ?`, token)
	return err
}

// CleanExpiredSelfServiceSessions removes expired self-service sessions.
func (s *Store) CleanExpiredSelfServiceSessions(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM self_service_sessions WHERE expires_at <= CURRENT_TIMESTAMP`)
	return err
}

// ── Feishu Settings CRUD ──

// GetFeishuSettings 读取飞书应用配置。未配置时返回空结构（非错误）。
func (s *Store) GetFeishuSettings(ctx context.Context) (FeishuSettings, error) {
	var settings FeishuSettings
	var enabled int
	err := s.db.QueryRowContext(ctx, `
	SELECT app_id, app_secret, redirect_uri, enabled, session_duration_hours, updated_at
	FROM feishu_settings WHERE id = 1`).Scan(
		&settings.AppID,
		&settings.AppSecret,
		&settings.RedirectURI,
		&enabled,
		&settings.SessionDurationHours,
		&settings.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return FeishuSettings{SessionDurationHours: 8}, nil
	}
	if err != nil {
		return settings, err
	}
	settings.Enabled = enabled == 1
	// 解密 appSecret（兼容旧明文）
	if settings.AppSecret != "" && s.cipher != nil {
		dec, derr := s.cipher.Decrypt(settings.AppSecret)
		if derr != nil {
			return settings, derr
		}
		settings.AppSecret = dec
	}
	return settings, nil
}

// GetFeishuSettingsRaw 读取飞书配置（含 secret），供认证流程使用。
func (s *Store) GetFeishuSettingsRaw(ctx context.Context) (FeishuSettings, error) {
	return s.GetFeishuSettings(ctx)
}

// SaveFeishuSettings 保存飞书应用配置（upsert）。
// 当 appSecret 为空时保留原值（避免前端脱敏回传覆盖）。
func (s *Store) SaveFeishuSettings(ctx context.Context, settings FeishuSettings) error {
	if settings.SessionDurationHours <= 0 {
		settings.SessionDurationHours = 8
	}
	// app_secret 为空时保留旧值
	if strings.TrimSpace(settings.AppSecret) == "" {
		current, err := s.GetFeishuSettings(ctx)
		if err == nil {
			settings.AppSecret = current.AppSecret
		}
	}
	// 加密 appSecret（明文 → 密文存储）
	appSecret := settings.AppSecret
	if s.cipher != nil && appSecret != "" {
		enc, err := s.cipher.Encrypt(appSecret)
		if err != nil {
			return err
		}
		appSecret = enc
	}
	_, err := s.db.ExecContext(ctx, `
	INSERT INTO feishu_settings (id, app_id, app_secret, redirect_uri, enabled, session_duration_hours, updated_at)
	VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
	ON CONFLICT(id) DO UPDATE SET
		app_id = excluded.app_id,
		app_secret = excluded.app_secret,
		redirect_uri = excluded.redirect_uri,
		enabled = excluded.enabled,
		session_duration_hours = excluded.session_duration_hours,
		updated_at = CURRENT_TIMESTAMP`,
		settings.AppID,
		appSecret,
		settings.RedirectURI,
		boolInt(settings.Enabled),
		settings.SessionDurationHours,
	)
	return err
}

// EnsureEncrypted 启动迁移：把存量明文凭据加密回写。
// 仅在 cipher 已启用时执行；识别明文依据"非 enc:v1: 前缀且非空"。
// 返回迁移的字段数量。调用方应在服务启动时（业务请求进入前）调用一次。
func (s *Store) EnsureEncrypted(ctx context.Context) (int, error) {
	if s.cipher == nil || !s.cipher.Enabled() {
		return 0, nil // 未启用加密，跳过
	}
	migrated := 0

	// ad_settings.bind_password
	var bindPwd string
	err := s.db.QueryRowContext(ctx, `SELECT bind_password FROM ad_settings WHERE id = 1`).Scan(&bindPwd)
	if err == nil && bindPwd != "" && !security.IsEncrypted(bindPwd) {
		enc, err := s.cipher.Encrypt(bindPwd)
		if err != nil {
			return migrated, err
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE ad_settings SET bind_password = ? WHERE id = 1`, enc); err != nil {
			return migrated, err
		}
		migrated++
	}

	// feishu_settings.app_secret
	var appSecret string
	err = s.db.QueryRowContext(ctx, `SELECT app_secret FROM feishu_settings WHERE id = 1`).Scan(&appSecret)
	if err == nil && appSecret != "" && !security.IsEncrypted(appSecret) {
		enc, err := s.cipher.Encrypt(appSecret)
		if err != nil {
			return migrated, err
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE feishu_settings SET app_secret = ? WHERE id = 1`, enc); err != nil {
			return migrated, err
		}
		migrated++
	}

	return migrated, nil
}
