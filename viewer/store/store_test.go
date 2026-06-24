package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadExample(t *testing.T) {
	es, err := Load(filepath.Join("..", "..", "store", "example"))
	if err != nil {
		t.Fatal(err)
	}
	if len(es) < 1 {
		t.Fatalf("want >=1 entry, got %d", len(es))
	}
	if es[0].Outcome == "" || es[0].JSON == "" {
		t.Fatalf("entry not parsed: %+v", es[0])
	}
}

func TestFilter(t *testing.T) {
	// Build 3 entries for testing
	pick1 := "laptop"
	pick3 := "keyboard"
	es := []Entry{
		{Need: "work", Category: "electronics", Pick: &pick1, Outcome: "purchased"},
		{Need: "study", Category: "books", Pick: nil, Outcome: "deferred"},
		{Need: "gaming", Category: "ldac-headphones", Pick: &pick3, Outcome: "waiting"},
	}

	// Test filter with "ldac" (should match entry 2 by category)
	filtered := Filter(es, "ldac")
	if len(filtered) != 1 {
		t.Fatalf("Filter(es, \"ldac\"): want 1, got %d", len(filtered))
	}
	if filtered[0].Category != "ldac-headphones" {
		t.Fatalf("Filter(es, \"ldac\"): want category 'ldac-headphones', got %q", filtered[0].Category)
	}

	// Test filter with empty string (should return all)
	filtered = Filter(es, "")
	if len(filtered) != 3 {
		t.Fatalf("Filter(es, \"\"): want 3, got %d", len(filtered))
	}

	// Test filter with whitespace (should return all)
	filtered = Filter(es, "   ")
	if len(filtered) != 3 {
		t.Fatalf("Filter(es, \"   \"): want 3, got %d", len(filtered))
	}
}

// TestReadReportRejectsTraversal verifies ReadReport contains the index-supplied
// md path within the store dir: relative-escape and absolute paths must be
// rejected with an error and empty content, while a safe in-store path reads
// normally (a safe-but-missing path surfaces a read error, not an escape error).
func TestReadReportRejectsTraversal(t *testing.T) {
	dir := t.TempDir()

	// Lay down a real secret OUTSIDE the store and a safe report INSIDE it.
	parent := filepath.Dir(dir)
	secret := filepath.Join(parent, "discern-secret.txt")
	if err := os.WriteFile(secret, []byte("TOP SECRET"), 0o600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(secret)

	if err := os.MkdirAll(filepath.Join(dir, "runs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "runs", "x.md"), []byte("# report"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Relative traversal escape -> error, no content.
	if got, err := ReadReport(dir, filepath.Join("..", "discern-secret.txt")); err == nil || got != "" {
		t.Fatalf("relative traversal: want error+empty, got content=%q err=%v", got, err)
	}
	// Backslash-style traversal (untrusted index could carry Windows separators).
	if got, err := ReadReport(dir, `..\discern-secret.txt`); err == nil || got != "" {
		t.Fatalf("backslash traversal: want error+empty, got content=%q err=%v", got, err)
	}
	// Absolute path -> error, no content.
	if got, err := ReadReport(dir, secret); err == nil || got != "" {
		t.Fatalf("absolute path: want error+empty, got content=%q err=%v", got, err)
	}

	// Safe in-store path still reads.
	got, err := ReadReport(dir, filepath.Join("runs", "x.md"))
	if err != nil {
		t.Fatalf("safe path: unexpected error: %v", err)
	}
	if got != "# report" {
		t.Fatalf("safe path: want %q, got %q", "# report", got)
	}

	// Safe-but-missing path surfaces a read error (NOT the escape error) and empty content.
	if got, err := ReadReport(dir, filepath.Join("runs", "nope.md")); err == nil || got != "" {
		t.Fatalf("safe-but-missing: want read error+empty, got content=%q err=%v", got, err)
	}
}

// TestReadReportRejectsSymlink verifies that a symlink INSIDE the store that
// points OUTSIDE it cannot be used to read the external target. The lexical
// containment check passes for "runs/evil.md" (no ".." in the path string), so
// the symlink must be resolved and re-contained before the read.
func TestReadReportRejectsSymlink(t *testing.T) {
	store := t.TempDir()
	if err := os.MkdirAll(filepath.Join(store, "runs"), 0o755); err != nil {
		t.Fatal(err)
	}

	// A secret OUTSIDE the store (parent temp dir), and a symlink inside the
	// store pointing at it.
	secret := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(secret, []byte("TOP SECRET"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(store, "runs", "evil.md")
	if err := os.Symlink(secret, link); err != nil {
		// Windows without privilege / unsupported FS — standard Go practice.
		t.Skip("symlinks unsupported on this platform")
	}

	// The symlink escape must be blocked: non-nil error AND empty content.
	if got, err := ReadReport(store, filepath.Join("runs", "evil.md")); err == nil || got != "" {
		t.Fatalf("symlink escape: want error+empty, got content=%q err=%v", got, err)
	}

	// Sanity: a real in-store report still reads normally.
	if err := os.WriteFile(filepath.Join(store, "runs", "ok.md"), []byte("# ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := ReadReport(store, filepath.Join("runs", "ok.md"))
	if err != nil || got != "# ok" {
		t.Fatalf("safe in-store path: want %q+nil, got content=%q err=%v", "# ok", got, err)
	}
}
