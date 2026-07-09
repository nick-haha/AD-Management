package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func staticFiles(root string) http.Handler {
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
