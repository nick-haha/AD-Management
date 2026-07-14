// Package admanagement holds the embedded frontend assets for the AD Management server.
// The frontend/ directory is embedded at compile time via Go's embed directive,
// producing a single self-contained binary that serves its own UI without requiring
// a separate frontend directory on disk.
package admanagement

import "embed"

// FrontendFS embeds the entire frontend/ directory at compile time.
// When FRONTEND_DIR is set and points to a real directory on disk,
// the filesystem version takes precedence (useful for live development).
// Otherwise the embedded files are used.
//
//go:embed frontend
var FrontendFS embed.FS
