package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"ad-management/internal/ad"
	"ad-management/internal/config"
	"ad-management/internal/store"
)

func TestAdminCreateUser(t *testing.T) {
	fake := &fakeDirectory{}
	st, token := testStore(t)
	router := NewRouter(Dependencies{
		AD:    fake,
		Store: st,
	})

	body := bytes.NewBufferString(`{"cn":"张三","samAccountName":"zhangsan","password":"Password123!","mustChange":true}`)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/users", body)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	if fake.created.SAMAccountName != "zhangsan" || !fake.created.MustChange {
		t.Fatalf("unexpected create input: %+v", fake.created)
	}
}

func TestUserCannotUseAdminEndpoint(t *testing.T) {
	router := NewRouter(Dependencies{
		AD: &fakeDirectory{},
	})

	req := httptest.NewRequest(http.MethodDelete, "/api/admin/users?account=zhangsan", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestSelfResetForcesMustChange(t *testing.T) {
	fake := &fakeDirectory{}
	st, _ := testStore(t)
	// Create a self-service session so the middleware allows the POST
	ssToken := "test-ss-session"
	if err := st.CreateSelfServiceSession(context.Background(), ssToken, "ou_test", "张三", "zhangsan", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	router := NewRouter(Dependencies{
		AD:    fake,
		Store: st,
	})

	payload, _ := json.Marshal(passwordRequest{Account: "zhangsan", Password: "Password123!", MustChange: false})
	req := httptest.NewRequest(http.MethodPost, "/api/me/users/password", bytes.NewReader(payload))
	req.AddCookie(&http.Cookie{Name: "ss_token", Value: ssToken})
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !fake.mustChange {
		t.Fatalf("self reset should force mustChange")
	}
}

func TestDeleteProtectedAccount(t *testing.T) {
	st, token := testStore(t)
	router := NewRouter(Dependencies{
		AD:    &fakeDirectory{},
		Store: st,
		Config: config.Config{
			Safe: config.SafetyConfig{DeleteProtectedAccounts: map[string]struct{}{"san.zhang": {}}},
		},
	})

	req := httptest.NewRequest(http.MethodDelete, `/api/admin/users?account=ujoygames\san.zhang`, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
}

type fakeDirectory struct {
	created    ad.CreateUserInput
	mustChange bool
}

func (f *fakeDirectory) FindUser(_ context.Context, query string) (ad.User, error) {
	return ad.User{SAMAccountName: query, Enabled: true}, nil
}

func (f *fakeDirectory) SearchUsers(_ context.Context, query string) ([]ad.User, error) {
	return []ad.User{{SAMAccountName: query, Enabled: true}}, nil
}

func (f *fakeDirectory) UnlockUser(_ context.Context, _ string) error {
	return nil
}

func (f *fakeDirectory) ResetPassword(_ context.Context, _ string, _ string, mustChange bool) error {
	f.mustChange = mustChange
	return nil
}

func (f *fakeDirectory) CreateUser(_ context.Context, input ad.CreateUserInput) (ad.User, error) {
	f.created = input
	return ad.User{CN: input.CN, SAMAccountName: input.SAMAccountName, Enabled: true}, nil
}

func (f *fakeDirectory) AddUserToGroups(_ context.Context, _ string, _ []string) error {
	return nil
}

func (f *fakeDirectory) DeleteUser(_ context.Context, _ string) error {
	return nil
}

func (f *fakeDirectory) DisableUser(_ context.Context, _ string) error {
	return nil
}

func (f *fakeDirectory) EnableUser(_ context.Context, _ string) error {
	return nil
}

func (f *fakeDirectory) MoveUser(_ context.Context, _ string, _ string) error {
	return nil
}

func (f *fakeDirectory) RemoveUserFromGroup(_ context.Context, _ string, _ string) error {
	return nil
}

func (f *fakeDirectory) DiscoverOUs(_ context.Context, _ string) ([]ad.DirectoryEntry, error) {
	return nil, nil
}

func (f *fakeDirectory) DiscoverGroups(_ context.Context, _ string) ([]ad.DirectoryEntry, error) {
	return nil, nil
}

func (f *fakeDirectory) UpdateUserAttributes(_ context.Context, _ string, _ map[string]string) error {
	return nil
}

func (f *fakeDirectory) OffboardUser(_ context.Context, _ string, _ string) error {
	return nil
}

func testStore(t *testing.T) (*store.Store, string) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.EnsureAdmin(context.Background(), "admin", []byte("$2a$10$k4f8fMMw75spNekQ4HUgXeha0FYKOzvcSxVj0mHNiGe.eaHIanQf.")); err != nil {
		t.Fatal(err)
	}
	token := "test-admin-session"
	if err := st.CreateSession(context.Background(), token, 1, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	return st, token
}
