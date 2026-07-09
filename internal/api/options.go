package api

import (
	"strings"

	"ad-management/internal/config"
	"ad-management/internal/store"
)

func parseOptionList(raw string) []store.Option {
	var options []store.Option
	for _, part := range strings.Split(raw, "|") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		label, value, ok := strings.Cut(part, "=")
		if !ok {
			label = part
			value = part
		}
		label = strings.TrimSpace(label)
		value = strings.TrimSpace(value)
		if label != "" && value != "" {
			options = append(options, store.Option{Label: label, Value: value})
		}
	}
	return options
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
