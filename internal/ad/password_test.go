package ad

import (
	"testing"

	"ad-management/internal/config"
)

func TestPasswordLooksUsable(t *testing.T) {
	if passwordLooksUsable("short") {
		t.Fatal("short password should be rejected")
	}
	if !passwordLooksUsable("Password123!") {
		t.Fatal("usable password should be accepted")
	}
}

func TestADPasswordValueIsUTF16LEQuoted(t *testing.T) {
	got := []byte(adPasswordValue("Ab1!"))
	want := []byte{'"', 0, 'A', 0, 'b', 0, '1', 0, '!', 0, '"', 0}
	if string(got) != string(want) {
		t.Fatalf("unexpected password encoding: %#v", got)
	}
}

func TestQueryTermsIncludesDomainAccountVariants(t *testing.T) {
	terms := queryTerms(`ujoygames\san.zhang`, testADConfig("ujoygames.local"))
	want := map[string]bool{
		`ujoygames\san.zhang`:       true,
		"san.zhang":                 true,
		"san.zhang@ujoygames.local": true,
	}
	for _, term := range terms {
		delete(want, term)
	}
	if len(want) != 0 {
		t.Fatalf("missing expected terms: %+v from %+v", want, terms)
	}
}

func testADConfig(upnSuffix string) config.ADConfig {
	return config.ADConfig{DomainUPNSuffix: upnSuffix}
}
