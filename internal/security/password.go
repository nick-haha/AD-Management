package security

import (
	"crypto/rand"
	"math/big"
)

const (
	upper            = "ABCDEFGHJKLMNPQRSTUVWXYZ"
	lower            = "abcdefghijkmnopqrstuvwxyz"
	digits           = "23456789"
	specials         = "!@#$%^&*"
	passwordAlphabet = upper + lower + digits + specials
)

func GeneratePassword(length int) (string, error) {
	if length < 12 {
		length = 12
	}
	out := make([]byte, length)
	required := []string{upper, lower, digits, specials}
	for i, alphabet := range required {
		ch, err := randomChar(alphabet)
		if err != nil {
			return "", err
		}
		out[i] = ch
	}
	for i := len(required); i < len(out); i++ {
		ch, err := randomChar(passwordAlphabet)
		if err != nil {
			return "", err
		}
		out[i] = ch
	}
	if err := shuffle(out); err != nil {
		return "", err
	}
	return string(out), nil
}

func randomChar(alphabet string) (byte, error) {
	max := big.NewInt(int64(len(passwordAlphabet)))
	if alphabet != passwordAlphabet {
		max = big.NewInt(int64(len(alphabet)))
	}
	n, err := rand.Int(rand.Reader, max)
	if err != nil {
		return 0, err
	}
	return alphabet[n.Int64()], nil
}

func shuffle(values []byte) error {
	for i := len(values) - 1; i > 0; i-- {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(i+1)))
		if err != nil {
			return err
		}
		j := int(n.Int64())
		values[i], values[j] = values[j], values[i]
	}
	return nil
}
