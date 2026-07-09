package api

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"ad-management/internal/ad"
	"ad-management/internal/store"

	"github.com/google/uuid"
)

type ScheduledTask struct {
	ID          string    `json:"id"`
	Account     string    `json:"account"`
	Action      string    `json:"action"` // "disable", "enable"
	ScheduledAt time.Time `json:"scheduledAt"`
	CreatedAt   time.Time `json:"createdAt"`
}

type DisableScheduler struct {
	ad     ad.Directory
	logger *slog.Logger
	store  *store.Store
	mu     sync.RWMutex
	timers map[string]*time.Timer
	tasks  map[string]ScheduledTask
}

func NewDisableScheduler(directory ad.Directory, logger *slog.Logger, s *store.Store) *DisableScheduler {
	sched := &DisableScheduler{
		ad:     directory,
		logger: logger,
		store:  s,
		timers: map[string]*time.Timer{},
		tasks:  map[string]ScheduledTask{},
	}
	// Restore pending tasks from DB
	sched.restorePendingTasks()
	return sched
}

// restorePendingTasks loads pending (not completed) tasks from the database
// and re-schedules them. Tasks whose scheduled time has already passed
// are executed immediately.
func (s *DisableScheduler) restorePendingTasks() {
	if s.store == nil {
		return
	}
	ctx := context.Background()
	tasks, err := s.store.ListPendingScheduledTasks(ctx)
	if err != nil {
		s.logger.Error("failed to restore scheduled tasks from DB", "error", err)
		return
	}
	for _, t := range tasks {
		task := ScheduledTask{
			ID:          t.ID,
			Account:     t.Account,
			Action:      t.Action,
			ScheduledAt: t.ScheduledAt,
			CreatedAt:   t.CreatedAt,
		}
		delay := time.Until(task.ScheduledAt)
		if delay < 0 {
			delay = 0
		}
		s.startTimer(task.ID, task.Account, delay)
		s.mu.Lock()
		s.tasks[task.ID] = task
		s.mu.Unlock()
		s.logger.Info("restored scheduled task", "id", task.ID, "account", task.Account, "scheduledAt", task.ScheduledAt)
	}
}

func (s *DisableScheduler) startTimer(id, account string, delay time.Duration) {
	timer := time.AfterFunc(delay, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := s.ad.DisableUser(ctx, account); err != nil {
			s.logger.Error("scheduled disable failed", "account", account, "error", err)
			return
		}
		s.logger.Info("scheduled disable completed", "account", account)
		// Remove from memory
		s.mu.Lock()
		delete(s.timers, id)
		delete(s.tasks, id)
		s.mu.Unlock()
		// Mark completed in DB
		if s.store != nil {
			if err := s.store.MarkScheduledTaskCompleted(context.Background(), id); err != nil {
				s.logger.Error("failed to mark scheduled task completed in DB", "id", id, "error", err)
			}
		}
	})
	s.mu.Lock()
	s.timers[id] = timer
	s.mu.Unlock()
}

func (s *DisableScheduler) Schedule(account string, disableAt time.Time) string {
	id := uuid.NewString()
	delay := time.Until(disableAt)
	if delay < 0 {
		delay = 0
	}

	task := ScheduledTask{
		ID:          id,
		Account:     account,
		Action:      "disable",
		ScheduledAt: disableAt,
		CreatedAt:   time.Now(),
	}

	// Persist to DB
	if s.store != nil {
		if err := s.store.CreateScheduledTask(context.Background(), store.StoredScheduledTask{
			ID:          task.ID,
			Account:     task.Account,
			Action:      task.Action,
			ScheduledAt: task.ScheduledAt,
			CreatedAt:   task.CreatedAt,
		}); err != nil {
			s.logger.Error("failed to persist scheduled task to DB", "id", id, "error", err)
		}
	}

	// Start in-memory timer
	s.startTimer(id, account, delay)

	s.mu.Lock()
	s.tasks[id] = task
	s.mu.Unlock()
	return id
}

func (s *DisableScheduler) Cancel(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	timer, ok := s.timers[id]
	if !ok {
		return false
	}
	timer.Stop()
	delete(s.timers, id)
	delete(s.tasks, id)
	s.logger.Info("scheduled task cancelled", "id", id)

	// Delete from DB
	if s.store != nil {
		if err := s.store.DeleteScheduledTask(context.Background(), id); err != nil {
			s.logger.Error("failed to delete scheduled task from DB", "id", id, "error", err)
		}
	}
	return true
}

func (s *DisableScheduler) List() []ScheduledTask {
	s.mu.RLock()
	defer s.mu.RUnlock()

	tasks := make([]ScheduledTask, 0, len(s.tasks))
	for _, t := range s.tasks {
		tasks = append(tasks, t)
	}
	return tasks
}

func (s *DisableScheduler) GetByAccount(account string) []ScheduledTask {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var result []ScheduledTask
	for _, t := range s.tasks {
		if t.Account == account {
			result = append(result, t)
		}
	}
	return result
}
