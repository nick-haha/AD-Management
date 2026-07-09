package ad

import (
	"context"
	"time"
)

type Directory interface {
	SearchUsers(ctx context.Context, query string) ([]User, error)
	FindUser(ctx context.Context, query string) (User, error)
	UnlockUser(ctx context.Context, account string) error
	ResetPassword(ctx context.Context, account string, newPassword string, mustChange bool) error
	CreateUser(ctx context.Context, input CreateUserInput) (User, error)
	AddUserToGroups(ctx context.Context, account string, groups []string) error
	RemoveUserFromGroup(ctx context.Context, account string, groupDN string) error
	DeleteUser(ctx context.Context, account string) error
	DisableUser(ctx context.Context, account string) error
	EnableUser(ctx context.Context, account string) error
	MoveUser(ctx context.Context, account string, targetOU string) error
	OffboardUser(ctx context.Context, account string, targetOU string) error
	UpdateUserAttributes(ctx context.Context, account string, attrs map[string]string) error
	DiscoverOUs(ctx context.Context, baseDN string) ([]DirectoryEntry, error)
	DiscoverGroups(ctx context.Context, baseDN string) ([]DirectoryEntry, error)
}

type DirectoryEntry struct {
	Label       string `json:"label"`
	Value       string `json:"value"`
	Description string `json:"description"`
}

type User struct {
	DN                string `json:"dn"`
	CN                string `json:"cn"`
	DisplayName       string `json:"displayName"`
	SAMAccountName    string `json:"samAccountName"`
	UserPrincipalName string `json:"userPrincipalName"`
	Mail              string `json:"mail"`
	Enabled           bool   `json:"enabled"`
	Locked            bool   `json:"locked"`
	IsAdmin           bool   `json:"isAdmin"`

	// Extended attributes
	Description     string   `json:"description"`
	Department      string   `json:"department"`
	Title           string   `json:"title"`
	Manager         string   `json:"manager"`
	TelephoneNumber string   `json:"telephoneNumber"`
	MemberOf        []string `json:"memberOf"`

	// Timestamps (as string since LDAP returns them as formatted values)
	AccountExpires string `json:"accountExpires"`
	WhenCreated    string `json:"whenCreated"`
	LastLogon      string `json:"lastLogon"`
	PwdLastSet     string `json:"pwdLastSet"`

	// PasswordExpiresAt 来自 AD 构造属性 msDS-UserPasswordExpiryTimeComputed（FILETIME ticks 字符串）。
	// 由域控综合域策略 maxPwdAge、用户 pwdLastSet、UAC 标志位与细粒度密码策略(PSO)计算得出，是密码到期权威值。
	// 特殊值：0 / 9223372036854775807 → 永不过期；-1 → 用户须改密；正数 → 真实到期时间。
	// 前端优先用它判断，取不到时回退到 pwdLastSet + 配置天数估算。
	PasswordExpiresAt string `json:"passwordExpiresAt"`

	UserAccountControl int `json:"-"`

	// PasswordNeverExpires 解析自 userAccountControl 的 0x10000 标志位。
	// 前端用它判断密码是否永不过期，避免仅凭 pwdLastSet 误算到期时间。
	PasswordNeverExpires bool `json:"passwordNeverExpires"`
}

type CreateUserInput struct {
	CN                string   `json:"cn"`
	GivenName         string   `json:"givenName"`
	Surname           string   `json:"surname"`
	DisplayName       string   `json:"displayName"`
	SAMAccountName    string   `json:"samAccountName"`
	UserPrincipalName string   `json:"userPrincipalName"`
	Mail              string   `json:"mail"`
	Password          string   `json:"password"`
	MustChange        bool     `json:"mustChange"`
	OU                string   `json:"ou"`
	Groups            []string `json:"groups"`
}

type ScheduledDisable struct {
	Account   string    `json:"account"`
	DisableAt time.Time `json:"disableAt"`
}
