package feishu

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// UserInfo 飞书用户信息
type UserInfo struct {
	Name            string `json:"name"`             // 用户姓名 → 用于匹配 AD displayName
	OpenID          string `json:"open_id"`          // 应用内唯一标识
	UnionID         string `json:"union_id"`         // ISV 跨应用唯一标识
	Email           string `json:"email"`            // 邮箱 (需权限)
	EnterpriseEmail string `json:"enterprise_email"` // 企业邮箱 (需权限)
	UserID          string `json:"user_id"`          // 用户 user_id (需权限)
	Mobile          string `json:"mobile"`           // 手机号 (需权限)
	EmployeeNo      string `json:"employee_no"`      // 工号 (需权限)
	AvatarURL       string `json:"avatar_url"`       // 头像
}

// userInfoAPIResponse 飞书用户信息 API 的完整响应结构
type userInfoAPIResponse struct {
	Code int      `json:"code"`
	Msg  string   `json:"msg"`
	Data UserInfo `json:"data"`
}

// GetUserInfo 通过 user_access_token 获取用户信息
// GET https://open.feishu.cn/open-apis/authen/v1/user_info
// Header: Authorization: Bearer {user_access_token}
func GetUserInfo(ctx context.Context, accessToken string) (*UserInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://open.feishu.cn/open-apis/authen/v1/user_info", nil)
	if err != nil {
		return nil, fmt.Errorf("create userinfo request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get userinfo network error: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)

	// 非 200 状态码，返回包含原始响应的详细错误
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("userinfo API HTTP %d: %s", resp.StatusCode, string(raw))
	}

	var result userInfoAPIResponse
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("decode userinfo response failed: %w, raw=%s", err, string(raw))
	}
	if result.Code != 0 {
		return nil, fmt.Errorf("userinfo API error code=%d msg=%s (raw=%s)", result.Code, result.Msg, string(raw))
	}

	return &result.Data, nil
}
