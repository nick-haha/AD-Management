package api

import (
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	admanagement "ad-management"
)

// staticFiles serves the frontend. If FRONTEND_DIR is set and the directory exists on disk,
// it serves from the filesystem (useful for development/live editing).
// Otherwise, it falls back to the embedded files compiled into the binary.
func staticFiles(frontendDir string) http.Handler {
	// Check if a real filesystem directory exists — development mode.
	if frontendDir != "" {
		if info, err := os.Stat(frontendDir); err == nil && info.IsDir() {
			return newDiskHandler(frontendDir)
		}
	}
	// Production: serve from embedded FS (compiled into the binary).
	sub, err := fs.Sub(admanagement.FrontendFS, "frontend")
	if err != nil {
		// Fallback: if embed somehow fails, try disk.
		return newDiskHandler("frontend")
	}
	return newEmbedHandler(sub)
}

// newDiskHandler serves files from a real directory on disk.
func newDiskHandler(root string) http.Handler {
	files := http.FileServer(http.Dir(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/admin" || path == "/admin/" {
			http.ServeFile(w, r, filepath.Join(root, "admin.html"))
			return
		}
		if path == "/" {
			http.ServeFile(w, r, filepath.Join(root, "index.html"))
			return
		}
		cleanPath := strings.TrimPrefix(filepath.Clean(path), string(filepath.Separator))
		fullPath := filepath.Join(root, cleanPath)
		if info, err := os.Stat(fullPath); err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
}

// newEmbedHandler serves files from an embedded fs.FS.
// For path routing (/admin → admin.html, / → index.html), we rewrite the URL
// and delegate to http.FileServer(http.FS(root)) which handles content types and caching.
func newEmbedHandler(root fs.FS) http.Handler {
	files := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		// Map virtual routes to actual HTML files, then let FileServer serve them.
		if path == "/admin" || path == "/admin/" {
			r.URL.Path = "/admin.html"
			files.ServeHTTP(w, r)
			return
		}
		if path == "/" {
			// 不改写成 /index.html——http.FileServer 对 /index.html 会 301 重定向回 /，
			// 造成「/ → /index.html → 301 / → ...」循环，首页打不开。
			// 直接让 FileServer 处理 /，它会返回 index.html 且不重定向。
			files.ServeHTTP(w, r)
			return
		}
		cleanPath := strings.TrimPrefix(filepath.Clean(path), string(filepath.Separator))
		if strings.Contains(cleanPath, "..") {
			http.NotFound(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
}
