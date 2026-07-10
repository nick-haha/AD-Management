package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// 凭据字段级加密（方案 B）。
//
// 背景：AD bindPassword 与飞书 appSecret 需要可逆还原（LDAP/OAuth 认证要明文），
// 不能用 bcrypt 哈希。这里用 AES-256-GCM 对称加密，密钥从环境变量
// AD_CRED_ENC_KEY 读取（base64 编码的 32 字节），与数据库文件物理分离。
//
// 存储格式：enc:v1:<base64(nonce || ciphertext+tag)>
//  - 有前缀：解密时按 v1 协议解密
//  - 无前缀：视为旧版明文，原样返回（平滑兼容升级）
//  - 密钥未配置（cipher 为 nil）：Encrypt 原样返回明文（降级为明文模式），
//    Decrypt 对密文返回原文（无法解密，不阻断服务）

const encPrefix = "enc:v1:"

// CredentialCipher 凭据加解密器。key 为 nil 时降级为明文模式。
type CredentialCipher struct {
	key []byte
}

// NewCredentialCipher 从 base64 编码的密钥构造加解密器。
// keyB64 为空时返回 nil 模式（明文模式，不加密）。
func NewCredentialCipher(keyB64 string) (*CredentialCipher, error) {
	keyB64 = strings.TrimSpace(keyB64)
	if keyB64 == "" {
		return &CredentialCipher{}, nil // 明文模式
	}
	key, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		return nil, fmt.Errorf("decode AD_CRED_ENC_KEY: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("AD_CRED_ENC_KEY must be 32 bytes (got %d)", len(key))
	}
	return &CredentialCipher{key: key}, nil
}

// Enabled 是否启用了加密（密钥已配置）。
func (c *CredentialCipher) Enabled() bool {
	return c != nil && len(c.key) == 32
}

// Encrypt 加密明文。返回带 enc:v1: 前缀的密文。
// 未启用加密或空串时原样返回（保证向后兼容）。
func (c *CredentialCipher) Encrypt(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	if !c.Enabled() {
		return plaintext, nil // 降级：明文存储
	}
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create gcm: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("gen nonce: %w", err)
	}
	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return encPrefix + base64.StdEncoding.EncodeToString(ciphertext), nil
}

// Decrypt 解密存储值。
//   - enc:v1: 前缀：解密返回明文；若未启用加密则返回原文（无法解密，降级）
//   - 无前缀：视为旧版明文，原样返回（兼容升级前数据）
//   - 空串：返回空串
func (c *CredentialCipher) Decrypt(stored string) (string, error) {
	if stored == "" {
		return "", nil
	}
	if !strings.HasPrefix(stored, encPrefix) {
		return stored, nil // 旧版明文，兼容返回
	}
	if !c.Enabled() {
		// 数据已加密但本进程未配置密钥：返回原文避免误用，调用方应配置密钥
		return stored, nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(stored, encPrefix))
	if err != nil {
		return "", fmt.Errorf("decode ciphertext: %w", err)
	}
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create gcm: %w", err)
	}
	nonceSize := gcm.NonceSize()
	if len(raw) < nonceSize {
		return "", errors.New("ciphertext too short")
	}
	nonce, ciphertext := raw[:nonceSize], raw[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}
	return string(plaintext), nil
}

// IsEncrypted 判断存储值是否为加密格式（供迁移逻辑识别明文存量）。
func IsEncrypted(stored string) bool {
	return strings.HasPrefix(stored, encPrefix)
}

// GenerateKey 生成 32 字节随机密钥并返回 base64 编码，供用户配置环境变量。
func GenerateKey() (string, error) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(key), nil
}
