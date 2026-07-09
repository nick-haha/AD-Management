package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"ad-management/internal/ad"
	"ad-management/internal/config"
	"ad-management/internal/envfile"
	"ad-management/internal/store"
)

func main() {
	envPath := flag.String("env", ".env.local", "env file path")
	account := flag.String("account", "", "AD account or name to look up")
	unlock := flag.Bool("unlock", false, "unlock the account after lookup; safe but changes AD lockoutTime")
	flag.Parse()

	if *envPath != "" {
		if err := envfile.Load(*envPath); err != nil {
			fmt.Fprintf(os.Stderr, "load env file failed: %v\n", err)
			os.Exit(1)
		}
	}

	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config failed: %v\n", err)
		os.Exit(1)
	}
	query := *account
	if query == "" {
		query = os.Getenv("AD_TEST_ACCOUNT")
	}
	if query == "" {
		fmt.Fprintln(os.Stderr, "missing -account or AD_TEST_ACCOUNT")
		os.Exit(1)
	}

	db, err := store.Open(cfg.DB.Path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open database failed: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()

	client := ad.NewDBClient(db, slog.New(slog.NewTextHandler(os.Stderr, nil)))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	user, err := client.FindUser(ctx, query)
	if err != nil {
		fmt.Fprintf(os.Stderr, "lookup failed: %v\n", err)
		os.Exit(1)
	}

	if *unlock {
		if err := client.UnlockUser(ctx, user.SAMAccountName); err != nil {
			fmt.Fprintf(os.Stderr, "unlock failed: %v\n", err)
			os.Exit(1)
		}
		user, _ = client.FindUser(ctx, user.SAMAccountName)
	}

	payload, _ := json.MarshalIndent(struct {
		Query string  `json:"query"`
		User  ad.User `json:"user"`
	}{
		Query: query,
		User:  user,
	}, "", "  ")
	fmt.Println(string(payload))
}
