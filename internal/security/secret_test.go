package security

import (
	"strings"
	"testing"
)

func TestCredentialCipher_RoundTrip(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	if len(key) < 40 {
		t.Fatalf("key too short: %d", len(key))
	}
	c, err := NewCredentialCipher(key)
	if err != nil {
		t.Fatalf("NewCredentialCipher: %v", err)
	}
	if !c.Enabled() {
		t.Fatal("expected Enabled=true")
	}
	cases := []string{"P@ssw0rd123!", "simple", "", "中文密码🔐", strings.Repeat("a", 100)}
	for _, plain := range cases {
		enc, err := c.Encrypt(plain)
		if err != nil {
			t.Fatalf("Encrypt(%q): %v", plain, err)
		}
		if plain == "" {
			if enc != "" {
				t.Fatalf("empty plaintext should encrypt to empty, got %q", enc)
			}
			continue
		}
		if !IsEncrypted(enc) {
			t.Fatalf("result not encrypted format: %q", enc)
		}
		// 同一明文两次加密结果不同（随机 nonce）
		enc2, _ := c.Encrypt(plain)
		if enc == enc2 {
			t.Fatalf("nonce should be random, got identical ciphertext")
		}
		dec, err := c.Decrypt(enc)
		if err != nil {
			t.Fatalf("Decrypt: %v", err)
		}
		if dec != plain {
			t.Fatalf("round-trip mismatch: got %q want %q", dec, plain)
		}
	}
}

func TestCredentialCipher_PlaintextMode(t *testing.T) {
	// 未配置密钥 → 明文模式
	c, err := NewCredentialCipher("")
	if err != nil {
		t.Fatalf("NewCredentialCipher: %v", err)
	}
	if c.Enabled() {
		t.Fatal("expected Enabled=false for empty key")
	}
	enc, err := c.Encrypt("secret")
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if enc != "secret" {
		t.Fatalf("plaintext mode should return as-is, got %q", enc)
	}
}

func TestCredentialCipher_CompatPlaintext(t *testing.T) {
	// 已配置密钥，但 DB 里是旧明文（无前缀）→ 兼容返回明文
	key, _ := GenerateKey()
	c, _ := NewCredentialCipher(key)
	dec, err := c.Decrypt("legacy-plaintext-password")
	if err != nil {
		t.Fatalf("Decrypt legacy: %v", err)
	}
	if dec != "legacy-plaintext-password" {
		t.Fatalf("legacy plaintext should return as-is, got %q", dec)
	}
}

func TestCredentialCipher_DecryptEncryptedWithoutKey(t *testing.T) {
	// 数据已加密但本进程无密钥 → 返回原文（不报错，降级）
	key, _ := GenerateKey()
	c1, _ := NewCredentialCipher(key)
	enc, _ := c1.Encrypt("topsecret")
	if !IsEncrypted(enc) {
		t.Fatal("expected encrypted format")
	}
	c2, _ := NewCredentialCipher("") // 无密钥
	dec, err := c2.Decrypt(enc)
	if err != nil {
		t.Fatalf("Decrypt without key: %v", err)
	}
	if dec != enc {
		t.Fatalf("without key should return stored as-is, got %q", dec)
	}
}

func TestCredentialCipher_BadKey(t *testing.T) {
	// 非 base64
	if _, err := NewCredentialCipher("!!!not-base64!!!"); err == nil {
		t.Fatal("expected error for non-base64 key")
	}
	// 长度不对
	short := "AAAA" // base64 解码后 < 32 字节
	if _, err := NewCredentialCipher(short); err == nil {
		t.Fatal("expected error for short key")
	}
}

func TestCredentialCipher_TamperDetection(t *testing.T) {
	// GCM 认证标签：篡改密文应解密失败
	key, _ := GenerateKey()
	c, _ := NewCredentialCipher(key)
	enc, _ := c.Encrypt("sensitive")
	tampered := enc[:len(enc)-4] + "AAAA"
	if _, err := c.Decrypt(tampered); err == nil {
		t.Fatal("expected error for tampered ciphertext")
	}
}
