package store

import (
	"context"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open in-memory db: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// TestRecordLoginAttempt_ColumnName verifies the INSERT into login_attempts
// succeeds — the regression being that store.go previously used column `ip`
// while the table defines `ip_address`, causing every insert to fail silently
// and disabling the brute-force lockout mechanism.
func TestRecordLoginAttempt_ColumnName(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// A single failed attempt must be recorded without SQL error.
	if err := s.RecordLoginAttempt(ctx, "alice", "10.0.0.1", false); err != nil {
		t.Fatalf("RecordLoginAttempt failed: %v (column name mismatch regression?)", err)
	}

	count, err := s.GetRecentFailedAttempts(ctx, "alice")
	if err != nil {
		t.Fatalf("GetRecentFailedAttempts: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected 1 failed attempt, got %d", count)
	}
}

// TestLockoutMechanism confirms the full brute-force protection path works
// end-to-end: recording failures, hitting the lockout threshold, and clearing
// on a successful login.
func TestLockoutMechanism(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	const user = "bob"

	// Record (MaxLoginAttempts - 1) failures — should NOT be locked yet.
	for i := 0; i < MaxLoginAttempts-1; i++ {
		if err := s.RecordLoginAttempt(ctx, user, "192.168.1.1", false); err != nil {
			t.Fatalf("RecordLoginAttempt #%d: %v", i, err)
		}
	}
	locked, count, err := s.IsLockedOut(ctx, user)
	if err != nil {
		t.Fatalf("IsLockedOut: %v", err)
	}
	if locked {
		t.Fatalf("user should NOT be locked after %d attempts", count)
	}
	if count != MaxLoginAttempts-1 {
		t.Fatalf("expected %d attempts, got %d", MaxLoginAttempts-1, count)
	}

	// One more failure crosses the threshold.
	if err := s.RecordLoginAttempt(ctx, user, "192.168.1.1", false); err != nil {
		t.Fatalf("RecordLoginAttempt final: %v", err)
	}
	locked, count, err = s.IsLockedOut(ctx, user)
	if err != nil {
		t.Fatalf("IsLockedOut after threshold: %v", err)
	}
	if !locked {
		t.Fatalf("user should be locked after %d failed attempts (got count=%d)", MaxLoginAttempts, count)
	}

	// A successful login clears the attempts.
	if err := s.RecordLoginAttempt(ctx, user, "192.168.1.1", true); err != nil {
		t.Fatalf("RecordLoginAttempt success: %v", err)
	}
	if err := s.ClearLoginAttempts(ctx, user); err != nil {
		t.Fatalf("ClearLoginAttempts: %v", err)
	}
	locked, _, err = s.IsLockedOut(ctx, user)
	if err != nil {
		t.Fatalf("IsLockedOut after clear: %v", err)
	}
	if locked {
		t.Fatalf("user should NOT be locked after successful login + clear")
	}
}

// TestLockoutWindowExpiry verifies old failures outside the lockout window
// don't count toward the lockout. The seeded row uses the same UTC RFC3339
// format that RecordLoginAttempt writes, ensuring the comparison is realistic.
func TestLockoutWindowExpiry(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	const user = "carol"

	// Insert a failed attempt that is older than the lockout window.
	oldTime := time.Now().Add(-(LockoutDuration + time.Minute)).UTC().Format(time.RFC3339)
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO login_attempts(username, ip_address, success, created_at) VALUES(?, ?, 0, ?)`,
		user, "172.16.0.1", oldTime)
	if err != nil {
		t.Fatalf("seed old attempt: %v", err)
	}

	count, err := s.GetRecentFailedAttempts(ctx, user)
	if err != nil {
		t.Fatalf("GetRecentFailedAttempts: %v", err)
	}
	if count != 0 {
		t.Fatalf("old attempt outside window should not count, got %d", count)
	}
}

// TestLockoutRemaining verifies GetLockoutRemaining returns a positive duration
// when the user is locked out, and that the remaining time is within the
// lockout window. This also confirms created_at can be scanned back into a
// Go time.Time from the stored RFC3339 string.
func TestLockoutRemaining(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	const user = "dave"

	// Trigger lockout.
	for i := 0; i < MaxLoginAttempts; i++ {
		if err := s.RecordLoginAttempt(ctx, user, "10.0.0.1", false); err != nil {
			t.Fatalf("RecordLoginAttempt #%d: %v", i, err)
		}
	}

	remaining, err := s.GetLockoutRemaining(ctx, user)
	if err != nil {
		t.Fatalf("GetLockoutRemaining: %v", err)
	}
	if remaining <= 0 {
		t.Fatalf("expected positive remaining lockout time, got %v", remaining)
	}
	if remaining > LockoutDuration {
		t.Fatalf("remaining %v should not exceed lockout duration %v", remaining, LockoutDuration)
	}
}

// TestCleanOldLoginAttempts verifies that the cleanup function removes old
// records using the same UTC RFC3339 comparison format.
func TestCleanOldLoginAttempts(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	const user = "eve"

	// Insert a recent attempt (should survive cleanup).
	if err := s.RecordLoginAttempt(ctx, user, "10.0.0.2", false); err != nil {
		t.Fatalf("RecordLoginAttempt: %v", err)
	}

	// Insert an old attempt (should be cleaned up).
	oldTime := time.Now().Add(-(30*24*time.Hour + time.Hour)).UTC().Format(time.RFC3339)
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO login_attempts(username, ip_address, success, created_at) VALUES(?, ?, 0, ?)`,
		user, "10.0.0.3", oldTime); err != nil {
		t.Fatalf("seed old attempt: %v", err)
	}

	// Before cleanup: 2 records.
	count, _ := s.GetRecentFailedAttempts(ctx, user)
	// GetRecentFailedAttempts only counts the recent one (old is outside window).
	if count != 1 {
		t.Fatalf("expected 1 recent attempt, got %d", count)
	}

	// Run cleanup for 30-day-old records.
	if err := s.CleanOldLoginAttempts(ctx, 30*24*time.Hour); err != nil {
		t.Fatalf("CleanOldLoginAttempts: %v", err)
	}

	// After cleanup: only the recent record remains.
	var total int
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM login_attempts WHERE username = ?`, user).Scan(&total)
	if total != 1 {
		t.Fatalf("expected 1 remaining record after cleanup, got %d", total)
	}
}
