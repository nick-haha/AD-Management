package ad

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"time"

	"ad-management/internal/config"
	"ad-management/internal/store"

	"github.com/go-ldap/ldap/v3"
	"golang.org/x/text/encoding/unicode"
)

const (
	uacAccountDisable   = 0x0002
	uacNormalAccount    = 0x0200
	uacDontExpirePasswd = 0x10000 // 密码永不过期标志位
)

type Client struct {
	cfg    config.ADConfig
	logger *slog.Logger
	dial   func(ctx context.Context) (*ldap.Conn, error)
}

type SettingsStore interface {
	GetADSettings(ctx context.Context) (store.ADSettings, error)
}

type DBClient struct {
	store  SettingsStore
	logger *slog.Logger
}

func NewDBClient(store SettingsStore, logger *slog.Logger) *DBClient {
	return &DBClient{store: store, logger: logger}
}

func (c *DBClient) SearchUsers(ctx context.Context, query string) ([]User, error) {
	client, err := c.client(ctx)
	if err != nil {
		return nil, err
	}
	return client.SearchUsers(ctx, query)
}

func (c *DBClient) FindUser(ctx context.Context, query string) (User, error) {
	client, err := c.client(ctx)
	if err != nil {
		return User{}, err
	}
	return client.FindUser(ctx, query)
}

func (c *DBClient) UnlockUser(ctx context.Context, account string) error {
	client, err := c.client(ctx)
	if err != nil {
		return err
	}
	return client.UnlockUser(ctx, account)
}

func (c *DBClient) ResetPassword(ctx context.Context, account string, newPassword string, mustChange bool) error {
	client, err := c.client(ctx)
	if err != nil {
		return err
	}
	return client.ResetPassword(ctx, account, newPassword, mustChange)
}

func (c *DBClient) CreateUser(ctx context.Context, input CreateUserInput) (User, error) {
	client, err := c.client(ctx)
	if err != nil {
		return User{}, err
	}
	return client.CreateUser(ctx, input)
}

func (c *DBClient) AddUserToGroups(ctx context.Context, account string, groups []string) error {
	client, err := c.client(ctx)
	if err != nil {
		return err
	}
	return client.AddUserToGroups(ctx, account, groups)
}

func (c *DBClient) DeleteUser(ctx context.Context, account string) error {
	client, err := c.client(ctx)
	if err != nil {
		return err
	}
	return client.DeleteUser(ctx, account)
}

func (c *DBClient) DisableUser(ctx context.Context, account string) error {
	client, err := c.client(ctx)
	if err != nil {
		return err
	}
	return client.DisableUser(ctx, account)
}

func (c *DBClient) EnableUser(ctx context.Context, account string) error {
	client, err := c.client(ctx)
	if err != nil {
		return err
	}
	return client.EnableUser(ctx, account)
}

func (c *DBClient) RemoveUserFromGroup(ctx context.Context, account string, groupDN string) error {
	client, err := c.client(ctx)
	if err != nil {
		return err
	}
	return client.RemoveUserFromGroup(ctx, account, groupDN)
}

func (c *DBClient) MoveUser(ctx context.Context, account string, targetOU string) error {
	client, err := c.client(ctx)
	if err != nil {
		return err
	}
	return client.MoveUser(ctx, account, targetOU)
}

func (c *DBClient) UpdateUserAttributes(ctx context.Context, account string, attrs map[string]string) error {
	client, err := c.client(ctx)
	if err != nil {
		return err
	}
	return client.UpdateUserAttributes(ctx, account, attrs)
}

func (c *DBClient) DiscoverOUs(ctx context.Context, baseDN string) ([]DirectoryEntry, error) {
	client, err := c.client(ctx)
	if err != nil {
		return nil, err
	}
	return client.DiscoverOUs(ctx, baseDN)
}

func (c *DBClient) DiscoverGroups(ctx context.Context, baseDN string) ([]DirectoryEntry, error) {
	client, err := c.client(ctx)
	if err != nil {
		return nil, err
	}
	return client.DiscoverGroups(ctx, baseDN)
}

func (c *DBClient) OffboardUser(ctx context.Context, account string, targetOU string) error {
	client, err := c.client(ctx)
	if err != nil {
		return err
	}
	return client.OffboardUser(ctx, account, targetOU)
}

func (c *DBClient) client(ctx context.Context) (*Client, error) {
	settings, err := c.store.GetADSettings(ctx)
	if err != nil {
		return nil, err
	}
	return NewClient(adConfigFromSettings(settings), c.logger), nil
}

func NewClient(cfg config.ADConfig, logger *slog.Logger) *Client {
	client := &Client{cfg: cfg, logger: logger}
	client.dial = client.defaultDial
	return client
}

func (c *Client) TestConnection(ctx context.Context) error {
	conn, err := c.bind(ctx)
	if err != nil {
		return err
	}
	conn.Close()
	return nil
}

func (c *Client) SearchUsers(ctx context.Context, query string) ([]User, error) {
	terms := queryTerms(query, c.cfg)
	if len(terms) == 0 {
		return nil, ErrInvalidInput
	}
	conn, err := c.bind(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	users, err := c.search(conn, userSearchFilter(terms))
	if err != nil {
		return nil, err
	}
	if len(users) == 0 {
		return nil, ErrNotFound
	}
	return users, nil
}

func (c *Client) FindUser(ctx context.Context, query string) (User, error) {
	terms := queryTerms(query, c.cfg)
	if len(terms) == 0 {
		return User{}, ErrInvalidInput
	}
	conn, err := c.bind(ctx)
	if err != nil {
		return User{}, err
	}
	defer conn.Close()

	filter := userSearchFilter(terms)
	return c.findOne(conn, filter)
}

func (c *Client) UnlockUser(ctx context.Context, account string) error {
	user, conn, err := c.findUserWithConn(ctx, account)
	if err != nil {
		return err
	}
	defer conn.Close()

	mod := ldap.NewModifyRequest(user.DN, nil)
	mod.Replace("lockoutTime", []string{"0"})
	return conn.Modify(mod)
}

func (c *Client) ResetPassword(ctx context.Context, account string, newPassword string, mustChange bool) error {
	if !passwordLooksUsable(newPassword) {
		return ErrUnsafePassword
	}
	user, err := c.FindUser(ctx, account)
	if err != nil {
		return err
	}
	conn, err := c.bindSecure(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	mod := ldap.NewModifyRequest(user.DN, nil)
	mod.Replace("unicodePwd", []string{adPasswordValue(newPassword)})
	if mustChange {
		mod.Replace("pwdLastSet", []string{"0"})
	} else {
		mod.Replace("pwdLastSet", []string{"-1"})
	}
	return conn.Modify(mod)
}

func (c *Client) CreateUser(ctx context.Context, input CreateUserInput) (User, error) {
	if err := input.validate(c.cfg); err != nil {
		return User{}, err
	}
	conn, err := c.bind(ctx)
	if err != nil {
		return User{}, err
	}
	defer conn.Close()

	ou := firstNonEmpty(input.OU, c.cfg.UserOU, c.cfg.BaseDN)
	dn := fmt.Sprintf("CN=%s,%s", escapeDN(input.CN), ou)
	upn := firstNonEmpty(input.UserPrincipalName, input.SAMAccountName+"@"+c.cfg.DomainUPNSuffix)
	displayName := firstNonEmpty(input.DisplayName, strings.TrimSpace(input.GivenName+" "+input.Surname), input.CN)

	add := ldap.NewAddRequest(dn, nil)
	add.Attribute("objectClass", []string{"top", "person", "organizationalPerson", "user"})
	add.Attribute("cn", []string{input.CN})
	add.Attribute("sn", []string{firstNonEmpty(input.Surname, input.CN)})
	add.Attribute("givenName", []string{input.GivenName})
	add.Attribute("displayName", []string{displayName})
	add.Attribute("sAMAccountName", []string{input.SAMAccountName})
	add.Attribute("userPrincipalName", []string{upn})
	add.Attribute("userAccountControl", []string{strconv.Itoa(uacNormalAccount | uacAccountDisable)})
	if input.Mail != "" {
		add.Attribute("mail", []string{input.Mail})
	}
	if err := conn.Add(add); err != nil {
		return User{}, err
	}

	// 后续步骤（重置密码 / 启用 / 加组）失败时，回滚删除已创建的用户，
	// 避免遗留"禁用 + 无密码"的脏账号——这种账号既无法使用，也无法用同名重新创建。
	// 回滚本身是 best-effort：失败只记录日志，不掩盖原始错误。
	if err := c.ResetPassword(ctx, input.SAMAccountName, input.Password, input.MustChange); err != nil {
		c.rollbackCreateUser(ctx, input.SAMAccountName, "reset password", err)
		return User{}, fmt.Errorf("create user: reset password failed: %w", err)
	}
	if err := c.EnableUser(ctx, input.SAMAccountName); err != nil {
		c.rollbackCreateUser(ctx, input.SAMAccountName, "enable user", err)
		return User{}, fmt.Errorf("create user: enable user failed: %w", err)
	}
	if err := c.AddUserToGroups(ctx, input.SAMAccountName, input.Groups); err != nil {
		c.rollbackCreateUser(ctx, input.SAMAccountName, "add to groups", err)
		return User{}, fmt.Errorf("create user: add to groups failed: %w", err)
	}
	return c.FindUser(ctx, input.SAMAccountName)
}

// rollbackCreateUser 尽最大努力删除刚创建的用户，使创建可以重试。
// 步骤名 step 和原始错误 originalErr 仅用于日志，不会改变返回的原始错误。
func (c *Client) rollbackCreateUser(ctx context.Context, account, step string, originalErr error) {
	if c.logger != nil {
		c.logger.Warn("create user step failed, rolling back",
			"account", account, "step", step, "error", originalErr.Error())
	}
	if err := c.DeleteUser(ctx, account); err != nil {
		if c.logger != nil {
			c.logger.Error("rollback create user failed: manual cleanup required",
				"account", account, "rollback_error", err.Error())
		}
	}
}

func (c *Client) AddUserToGroups(ctx context.Context, account string, groups []string) error {
	if len(groups) == 0 {
		return nil
	}
	user, conn, err := c.findUserWithConn(ctx, account)
	if err != nil {
		return err
	}
	defer conn.Close()

	for _, group := range groups {
		group = strings.TrimSpace(group)
		if group == "" {
			continue
		}
		groupDN := group
		if !looksLikeDN(group) {
			found, err := c.findGroupDN(conn, group)
			if err != nil {
				return err
			}
			groupDN = found
		}
		mod := ldap.NewModifyRequest(groupDN, nil)
		mod.Add("member", []string{user.DN})
		if err := conn.Modify(mod); err != nil && !ldap.IsErrorWithCode(err, ldap.LDAPResultAttributeOrValueExists) {
			return err
		}
	}
	return nil
}

func (c *Client) DeleteUser(ctx context.Context, account string) error {
	user, conn, err := c.findUserWithConn(ctx, account)
	if err != nil {
		return err
	}
	defer conn.Close()
	return conn.Del(ldap.NewDelRequest(user.DN, nil))
}

func (c *Client) DisableUser(ctx context.Context, account string) error {
	user, conn, err := c.findUserWithConn(ctx, account)
	if err != nil {
		return err
	}
	defer conn.Close()

	mod := ldap.NewModifyRequest(user.DN, nil)
	mod.Replace("userAccountControl", []string{strconv.Itoa(userControlDisabled(user))})
	return conn.Modify(mod)
}

func (c *Client) EnableUser(ctx context.Context, account string) error {
	user, conn, err := c.findUserWithConn(ctx, account)
	if err != nil {
		return err
	}
	defer conn.Close()
	// Clear the ACCOUNTDISABLE bit (0x0002) while preserving other flags
	newValue := user.UserAccountControl &^ uacAccountDisable
	if newValue == 0 {
		newValue = uacNormalAccount
	}
	mod := ldap.NewModifyRequest(user.DN, nil)
	mod.Replace("userAccountControl", []string{strconv.Itoa(newValue)})
	return conn.Modify(mod)
}

func (c *Client) UpdateUserAttributes(ctx context.Context, account string, attrs map[string]string) error {
	user, conn, err := c.findUserWithConn(ctx, account)
	if err != nil {
		return err
	}
	defer conn.Close()

	mod := ldap.NewModifyRequest(user.DN, nil)
	for attr, val := range attrs {
		mod.Replace(attr, []string{val})
	}
	return conn.Modify(mod)
}

func (c *Client) RemoveUserFromGroup(ctx context.Context, account string, groupDN string) error {
	user, conn, err := c.findUserWithConn(ctx, account)
	if err != nil {
		return err
	}
	defer conn.Close()
	mod := ldap.NewModifyRequest(groupDN, nil)
	mod.Delete("member", []string{user.DN})
	err = conn.Modify(mod)
	if err != nil && ldap.IsErrorWithCode(err, ldap.LDAPResultNoSuchAttribute) {
		return nil
	}
	return err
}

func (c *Client) DiscoverOUs(ctx context.Context, baseDN string) ([]DirectoryEntry, error) {
	conn, err := c.bind(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	searchBase := baseDN
	if searchBase == "" {
		searchBase = c.cfg.BaseDN
	}

	searchReq := ldap.NewSearchRequest(
		searchBase, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases,
		0, 0, false,
		"(objectClass=organizationalUnit)",
		[]string{"distinguishedName", "name", "ou"}, nil,
	)
	res, err := conn.Search(searchReq)
	if err != nil {
		return nil, err
	}
	var entries []DirectoryEntry
	for _, e := range res.Entries {
		name := firstNonEmpty(e.GetAttributeValue("name"), e.GetAttributeValue("ou"), e.DN)
		entries = append(entries, DirectoryEntry{Label: name, Value: e.DN})
	}
	return entries, nil
}

func (c *Client) DiscoverGroups(ctx context.Context, baseDN string) ([]DirectoryEntry, error) {
	conn, err := c.bind(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	searchBase := baseDN
	if searchBase == "" {
		searchBase = c.cfg.BaseDN
	}

	searchReq := ldap.NewSearchRequest(
		searchBase, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases,
		0, 0, false,
		"(&(objectClass=group)(groupType:1.2.840.113556.1.4.803:=2147483648))",
		[]string{"distinguishedName", "cn", "name", "description"}, nil,
	)
	// Fallback to all groups if security groups filter fails
	res, err := conn.Search(searchReq)
	if err != nil {
		searchReq.Filter = "(objectClass=group)"
		res, err = conn.Search(searchReq)
		if err != nil {
			return nil, err
		}
	}
	var entries []DirectoryEntry
	for _, e := range res.Entries {
		name := firstNonEmpty(e.GetAttributeValue("cn"), e.GetAttributeValue("name"), e.DN)
		desc := e.GetAttributeValue("description")
		entries = append(entries, DirectoryEntry{Label: name, Value: e.DN, Description: desc})
	}
	return entries, nil
}

func (c *Client) setUserAccountControl(ctx context.Context, account string, value int) error {
	user, conn, err := c.findUserWithConn(ctx, account)
	if err != nil {
		return err
	}
	defer conn.Close()

	mod := ldap.NewModifyRequest(user.DN, nil)
	mod.Replace("userAccountControl", []string{strconv.Itoa(value)})
	return conn.Modify(mod)
}

func (c *Client) MoveUser(ctx context.Context, account string, targetOU string) error {
	targetOU = strings.TrimSpace(targetOU)
	if targetOU == "" {
		return ErrInvalidInput
	}
	user, conn, err := c.findUserWithConn(ctx, account)
	if err != nil {
		return err
	}
	defer conn.Close()

	rdn := user.DN
	if idx := strings.Index(rdn, ","); idx >= 0 {
		rdn = rdn[:idx]
	}
	req := ldap.NewModifyDNRequest(user.DN, rdn, true, targetOU)
	return conn.ModifyDN(req)
}

func (c *Client) OffboardUser(ctx context.Context, account string, targetOU string) error {
	if strings.TrimSpace(targetOU) == "" {
		targetOU = c.cfg.DisabledOU
	}
	if err := c.DisableUser(ctx, account); err != nil {
		return err
	}
	return c.MoveUser(ctx, account, targetOU)
}

func (c *Client) bind(ctx context.Context) (*ldap.Conn, error) {
	conn, err := c.dial(ctx)
	if err != nil {
		return nil, err
	}
	if err := conn.Bind(c.cfg.BindUsername, c.cfg.BindPassword); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

func (c *Client) bindSecure(ctx context.Context) (*ldap.Conn, error) {
	conn, err := c.dialSecure(ctx)
	if err != nil {
		return nil, err
	}
	if err := conn.Bind(c.cfg.BindUsername, c.cfg.BindPassword); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

func (c *Client) defaultDial(ctx context.Context) (*ldap.Conn, error) {
	address := net.JoinHostPort(c.cfg.Host, strconv.Itoa(c.cfg.Port))
	if c.cfg.UseTLS {
		return ldap.DialURL("ldaps://"+address, ldap.DialWithTLSConfig(&tls.Config{
			ServerName:         c.cfg.Host,
			InsecureSkipVerify: c.cfg.InsecureSkipVerify,
			MinVersion:         tls.VersionTLS12,
			MaxVersion:         tls.VersionTLS12,
		}))
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	conn, err := ldap.DialURL("ldap://"+address, ldap.DialWithDialer(dialer))
	if err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		conn.Close()
		return nil, ctx.Err()
	default:
		return conn, nil
	}
}

func (c *Client) dialSecure(ctx context.Context) (*ldap.Conn, error) {
	address := net.JoinHostPort(c.cfg.Host, "636")
	conn, err := ldap.DialURL("ldaps://"+address, ldap.DialWithTLSConfig(&tls.Config{
		ServerName:         c.cfg.Host,
		InsecureSkipVerify: c.cfg.InsecureSkipVerify,
		MinVersion:         tls.VersionTLS12,
		MaxVersion:         tls.VersionTLS12,
	}))
	if err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		conn.Close()
		return nil, ctx.Err()
	default:
		return conn, nil
	}
}

func (c *Client) findUserWithConn(ctx context.Context, account string) (User, *ldap.Conn, error) {
	terms := queryTerms(account, c.cfg)
	if len(terms) == 0 {
		return User{}, nil, ErrInvalidInput
	}
	conn, err := c.bind(ctx)
	if err != nil {
		return User{}, nil, err
	}
	filter := userSearchFilter(terms)
	user, err := c.findOne(conn, filter)
	if err != nil {
		conn.Close()
		return User{}, nil, err
	}
	return user, conn, nil
}

func (c *Client) findOne(conn *ldap.Conn, filter string) (User, error) {
	users, err := c.search(conn, filter)
	if err != nil {
		return User{}, err
	}
	if len(users) == 0 {
		return User{}, ErrNotFound
	}
	return users[0], nil
}

func (c *Client) search(conn *ldap.Conn, filter string) ([]User, error) {
	req := ldap.NewSearchRequest(
		c.cfg.BaseDN,
		ldap.ScopeWholeSubtree,
		ldap.NeverDerefAliases,
		0,
		0,
		false,
		filter,
		[]string{"distinguishedName", "cn", "name", "displayName", "sAMAccountName", "userPrincipalName", "mail", "userAccountControl", "lockoutTime", "adminCount", "description", "department", "title", "manager", "telephoneNumber", "memberOf", "accountExpires", "whenCreated", "lastLogon", "pwdLastSet", "msDS-UserPasswordExpiryTimeComputed"},
		nil,
	)
	res, err := conn.Search(req)
	if err != nil {
		return nil, err
	}
	users := make([]User, 0, len(res.Entries))
	for _, entry := range res.Entries {
		users = append(users, entryToUser(entry))
	}
	return users, nil
}

func (c *Client) findGroupDN(conn *ldap.Conn, group string) (string, error) {
	escaped := ldap.EscapeFilter(group)
	filter := fmt.Sprintf("(&(objectClass=group)(|(cn=%[1]s)(sAMAccountName=%[1]s)(name=%[1]s)))", escaped)
	req := ldap.NewSearchRequest(
		c.cfg.BaseDN,
		ldap.ScopeWholeSubtree,
		ldap.NeverDerefAliases,
		2,
		30,
		false,
		filter,
		[]string{"distinguishedName"},
		nil,
	)
	res, err := conn.Search(req)
	if err != nil {
		return "", err
	}
	if len(res.Entries) == 0 {
		return "", ErrNotFound
	}
	return firstNonEmpty(res.Entries[0].GetAttributeValue("distinguishedName"), res.Entries[0].DN), nil
}

func userSearchFilter(terms []string) string {
	var parts []string
	for _, term := range terms {
		escaped := ldap.EscapeFilter(term)
		parts = append(parts,
			fmt.Sprintf("(sAMAccountName=%s)", escaped),
			fmt.Sprintf("(userPrincipalName=%s)", escaped),
			fmt.Sprintf("(mail=%s)", escaped),
			fmt.Sprintf("(cn=*%s*)", escaped),
			fmt.Sprintf("(displayName=*%s*)", escaped),
			fmt.Sprintf("(name=*%s*)", escaped),
		)
	}
	return fmt.Sprintf("(&(objectClass=user)(objectCategory=person)(|%s))", strings.Join(parts, ""))
}

func queryTerms(query string, cfg config.ADConfig) []string {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil
	}
	seen := map[string]struct{}{}
	add := func(value string, out *[]string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		key := strings.ToLower(value)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		*out = append(*out, value)
	}

	var terms []string
	add(query, &terms)
	if strings.Contains(query, `\`) {
		if _, account, ok := strings.Cut(query, `\`); ok {
			add(account, &terms)
			if cfg.DomainUPNSuffix != "" {
				add(account+"@"+cfg.DomainUPNSuffix, &terms)
			}
		}
	}
	if strings.Contains(query, "@") {
		if account, _, ok := strings.Cut(query, "@"); ok {
			add(account, &terms)
		}
	}
	return terms
}

func entryToUser(entry *ldap.Entry) User {
	uac, _ := strconv.Atoi(entry.GetAttributeValue("userAccountControl"))
	lockout, _ := strconv.ParseInt(entry.GetAttributeValue("lockoutTime"), 10, 64)
	// Parse manager DN to a more readable form (CN only)
	manager := entry.GetAttributeValue("manager")
	if cnIdx := strings.Index(manager, "CN="); cnIdx >= 0 {
		manager = manager[cnIdx+3:]
		if commaIdx := strings.Index(manager, ","); commaIdx >= 0 {
			manager = manager[:commaIdx]
		}
	}
	return User{
		DN:                firstNonEmpty(entry.GetAttributeValue("distinguishedName"), entry.DN),
		CN:                entry.GetAttributeValue("cn"),
		DisplayName:       entry.GetAttributeValue("displayName"),
		SAMAccountName:    entry.GetAttributeValue("sAMAccountName"),
		UserPrincipalName: entry.GetAttributeValue("userPrincipalName"),
		Mail:              entry.GetAttributeValue("mail"),
		Enabled:           uac&uacAccountDisable == 0,
		Locked:            lockout > 0,
		IsAdmin:           entry.GetAttributeValue("adminCount") == "1",

		Description:     entry.GetAttributeValue("description"),
		Department:      entry.GetAttributeValue("department"),
		Title:           entry.GetAttributeValue("title"),
		Manager:         manager,
		TelephoneNumber: entry.GetAttributeValue("telephoneNumber"),
		MemberOf:        entry.GetAttributeValues("memberOf"),
		AccountExpires:  entry.GetAttributeValue("accountExpires"),
		WhenCreated:     entry.GetAttributeValue("whenCreated"),
		LastLogon:       entry.GetAttributeValue("lastLogon"),
		PwdLastSet:      entry.GetAttributeValue("pwdLastSet"),

		// msDS-UserPasswordExpiryTimeComputed 为构造属性，需显式请求才返回，某些环境可能为空。
		PasswordExpiresAt: entry.GetAttributeValue("msDS-UserPasswordExpiryTimeComputed"),

		UserAccountControl:   uac,
		PasswordNeverExpires: uac&uacDontExpirePasswd != 0,
	}
}

func userControlDisabled(user User) int {
	value := user.UserAccountControl
	if value == 0 {
		value = uacNormalAccount
	}
	return value | uacAccountDisable
}

func (i CreateUserInput) validate(cfg config.ADConfig) error {
	if strings.TrimSpace(i.CN) == "" || strings.TrimSpace(i.SAMAccountName) == "" || strings.TrimSpace(i.Password) == "" {
		return ErrInvalidInput
	}
	if !passwordLooksUsable(i.Password) {
		return ErrUnsafePassword
	}
	if i.UserPrincipalName == "" && cfg.DomainUPNSuffix == "" {
		return ErrInvalidInput
	}
	return nil
}

func passwordLooksUsable(password string) bool {
	return len([]rune(password)) >= 8
}

func adPasswordValue(password string) string {
	encoder := unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewEncoder()
	value, _ := encoder.String(fmt.Sprintf(`"%s"`, password))
	return value
}

func escapeDN(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `,`, `\,`, `+`, `\+`, `"`, `\"`, `<`, `\<`, `>`, `\>`, `;`, `\;`, `=`, `\=`)
	return replacer.Replace(strings.TrimSpace(value))
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func looksLikeDN(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	return strings.Contains(value, "dc=") && (strings.HasPrefix(value, "cn=") || strings.HasPrefix(value, "ou="))
}

func adConfigFromSettings(settings store.ADSettings) config.ADConfig {
	return config.ADConfig{
		Host:               settings.Host,
		Port:               settings.Port,
		UseTLS:             settings.UseTLS,
		InsecureSkipVerify: settings.InsecureSkipVerify,
		BaseDN:             settings.BaseDN,
		UserOU:             settings.UserOU,
		DisabledOU:         settings.DisabledOU,
		BindUsername:       settings.BindUsername,
		BindPassword:       settings.BindPassword,
		DomainNetBIOS:      settings.DomainNetBIOS,
		DomainUPNSuffix:    settings.DomainUPNSuffix,
	}
}
