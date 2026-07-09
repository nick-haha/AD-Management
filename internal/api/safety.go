package api

import "strings"

func normalizeAccount(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	if strings.Contains(value, `\`) {
		_, account, ok := strings.Cut(value, `\`)
		if ok {
			value = account
		}
	}
	if strings.Contains(value, "@") {
		account, _, ok := strings.Cut(value, "@")
		if ok {
			value = account
		}
	}
	return value
}
