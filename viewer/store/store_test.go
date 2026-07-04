package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestLoadComparisonExample is the §10 seam test: a Go reader parses a sidecar
// WRITTEN BY the Node writer (store/example/runs/<id>.compare.json, produced by
// tools/compare.mjs via seed-example.mjs) and asserts field-for-field agreement.
// If the Node writer and these Go structs ever drift, this fails.
func TestLoadComparisonExample(t *testing.T) {
	dir := filepath.Join("..", "..", "store", "example")
	es, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(es) < 1 {
		t.Fatalf("want >=1 entry, got %d", len(es))
	}
	if es[0].Compare == nil {
		t.Fatalf("example entry missing compare sidecar reference")
	}

	c, err := LoadComparison(dir, *es[0].Compare)
	if err != nil {
		t.Fatal(err)
	}

	// Top-level seam assertions.
	if c.ID == "" {
		t.Fatalf("comparison id empty")
	}
	if c.Need == "" {
		t.Fatalf("comparison need empty")
	}
	wantAxes := []string{"fundamentals", "consensus", "evidence", "clean"}
	if len(c.Axes) != len(wantAxes) {
		t.Fatalf("axes: want %d, got %v", len(wantAxes), c.Axes)
	}
	for i, a := range wantAxes {
		if c.Axes[i] != a {
			t.Fatalf("axes[%d]: want %q, got %q", i, a, c.Axes[i])
		}
	}
	if len(c.Items) < 1 {
		t.Fatalf("want >=1 item, got %d", len(c.Items))
	}
	// counts.considered must equal the number of item rows (full considered set).
	if c.Counts.Considered != len(c.Items) {
		t.Fatalf("counts.considered=%d but %d items", c.Counts.Considered, len(c.Items))
	}
	if c.Counts.Considered != c.Counts.Eligible+c.Counts.Removed {
		t.Fatalf("counts not additive: considered=%d eligible=%d removed=%d",
			c.Counts.Considered, c.Counts.Eligible, c.Counts.Removed)
	}

	// First item is the pick, fully scored (fundamentals + clean non-null).
	pick := c.Items[0]
	if pick.Status != "pick" {
		t.Fatalf("items[0].status: want \"pick\", got %q", pick.Status)
	}
	if pick.Product == "" {
		t.Fatalf("pick product empty")
	}
	if pick.Scores.Fundamentals == nil {
		t.Fatalf("pick fundamentals: want non-null (shortlisted)")
	}
	if pick.Scores.ConsensusNorm == nil || *pick.Scores.ConsensusNorm != 1.0 {
		t.Fatalf("pick consensus_norm: want 1.0, got %v", pick.Scores.ConsensusNorm)
	}
	if pick.Scores.Clean == nil {
		t.Fatalf("pick clean: want non-null (not disqualified)")
	}
	// The pick is the first radar series.
	if len(c.RadarDefault.Series) < 1 || c.RadarDefault.Series[0] != pick.Product {
		t.Fatalf("radar_default.series[0]: want pick %q, got %v", pick.Product, c.RadarDefault.Series)
	}
}

// TestLoadComparisonRejectsTraversal mirrors TestReadReportRejectsTraversal: the
// index-supplied compare path is equally untrusted, so relative/backslash/absolute
// escapes must all error with a nil comparison, while a safe in-store path parses.
func TestLoadComparisonRejectsTraversal(t *testing.T) {
	dir := t.TempDir()

	parent := filepath.Dir(dir)
	secret := filepath.Join(parent, "discern-secret.compare.json")
	if err := os.WriteFile(secret, []byte(`{"id":"leak"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(secret)

	if err := os.MkdirAll(filepath.Join(dir, "runs"), 0o755); err != nil {
		t.Fatal(err)
	}
	safe := `{"id":"ok","need":"n","axes":["fundamentals","consensus","evidence","clean"],` +
		`"dealbreaker_rules":[],"counts":{"considered":0,"eligible":0,"removed":0},` +
		`"radar_default":{"series":[]},"items":[]}`
	if err := os.WriteFile(filepath.Join(dir, "runs", "x.compare.json"), []byte(safe), 0o600); err != nil {
		t.Fatal(err)
	}

	// Relative traversal escape -> error, nil comparison.
	if got, err := LoadComparison(dir, filepath.Join("..", "discern-secret.compare.json")); err == nil || got != nil {
		t.Fatalf("relative traversal: want error+nil, got %v err=%v", got, err)
	}
	// Backslash-style traversal (untrusted index could carry Windows separators).
	if got, err := LoadComparison(dir, `..\discern-secret.compare.json`); err == nil || got != nil {
		t.Fatalf("backslash traversal: want error+nil, got %v err=%v", got, err)
	}
	// Absolute path -> error, nil comparison.
	if got, err := LoadComparison(dir, secret); err == nil || got != nil {
		t.Fatalf("absolute path: want error+nil, got %v err=%v", got, err)
	}

	// Safe in-store path parses.
	got, err := LoadComparison(dir, filepath.Join("runs", "x.compare.json"))
	if err != nil {
		t.Fatalf("safe path: unexpected error: %v", err)
	}
	if got == nil || got.ID != "ok" {
		t.Fatalf("safe path: want id=ok, got %v", got)
	}

	// Safe-but-missing path surfaces a read/resolve error (NOT the escape error) and nil.
	if got, err := LoadComparison(dir, filepath.Join("runs", "nope.compare.json")); err == nil || got != nil {
		t.Fatalf("safe-but-missing: want error+nil, got %v err=%v", got, err)
	}
}

// TestLoadComparisonRejectsSymlink mirrors TestReadReportRejectsSymlink: a symlink
// INSIDE the store pointing OUTSIDE it passes the lexical check (no ".." in the
// path string), so it must be resolved and re-contained before the read.
func TestLoadComparisonRejectsSymlink(t *testing.T) {
	store := t.TempDir()
	if err := os.MkdirAll(filepath.Join(store, "runs"), 0o755); err != nil {
		t.Fatal(err)
	}

	secret := filepath.Join(t.TempDir(), "secret.compare.json")
	if err := os.WriteFile(secret, []byte(`{"id":"leak"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(store, "runs", "evil.compare.json")
	if err := os.Symlink(secret, link); err != nil {
		t.Skip("symlinks unsupported on this platform")
	}

	// The symlink escape must be blocked: non-nil error AND nil comparison.
	if got, err := LoadComparison(store, filepath.Join("runs", "evil.compare.json")); err == nil || got != nil {
		t.Fatalf("symlink escape: want error+nil, got %v err=%v", got, err)
	}

	// Sanity: a real in-store sidecar still parses.
	ok := `{"id":"ok","need":"n","axes":["fundamentals","consensus","evidence","clean"],` +
		`"dealbreaker_rules":[],"counts":{"considered":0,"eligible":0,"removed":0},` +
		`"radar_default":{"series":[]},"items":[]}`
	if err := os.WriteFile(filepath.Join(store, "runs", "ok.compare.json"), []byte(ok), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := LoadComparison(store, filepath.Join("runs", "ok.compare.json"))
	if err != nil || got == nil || got.ID != "ok" {
		t.Fatalf("safe in-store path: want id=ok+nil err, got %v err=%v", got, err)
	}
}

// TestLoadComparisonRejectsInvalid verifies LoadComparison fails closed on a sidecar
// that parses as JSON but breaks the store-compare contract. The sidecar is the seam
// contract and a shared/hand-edited store is untrusted, so an unknown field or a broken
// invariant must error rather than render a plausible-but-false comparison (Codex review).
func TestLoadComparisonRejectsInvalid(t *testing.T) {
	dir := t.TempDir()
	runs := filepath.Join(dir, "runs")
	if err := os.MkdirAll(runs, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) string {
		if err := os.WriteFile(filepath.Join(runs, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return filepath.Join("runs", name)
	}

	base := `{"id":"x","need":"n","axes":["fundamentals","consensus","evidence","clean"],` +
		`"dealbreaker_rules":[],"counts":{"considered":1,"eligible":1,"removed":0},` +
		`"radar_default":{"series":["A"]},` +
		`"items":[{"product":"A","maker":"M","status":"pick","disqualified_reason":null,` +
		`"dealbreaker_rule":null,"durable_unresolved":false,` +
		`"scores":{"fundamentals":0.5,"consensus_raw":1,"consensus_norm":1,"evidence":0.5,"clean":1}}]}`

	// The base document is valid and loads.
	if got, err := LoadComparison(dir, write("ok.compare.json", base)); err != nil || got == nil {
		t.Fatalf("valid sidecar: want load, got %v err=%v", got, err)
	}

	// Each mutation breaks exactly one part of the contract and must fail closed (error + nil):
	// unknown fields, bad enums, inconsistent counts, wrong axes, bad radar, trailing data, and
	// every omitted required top-level field (which would otherwise zero-value into a blank view).
	cases := map[string]string{
		"unknown field":              strings.Replace(base, `"items":[`, `"bogus":1,"items":[`, 1),
		"bad status":                 strings.Replace(base, `"status":"pick"`, `"status":"nope"`, 1),
		"inconsistent counts":        strings.Replace(base, `"considered":1`, `"considered":2`, 1),
		"wrong axes":                 strings.Replace(base, `,"consensus","evidence","clean"]`, `,"consensus","evidence"]`, 1),
		"oversized radar":            strings.Replace(base, `"series":["A"]`, `"series":["A","A","A"]`, 1),
		"dangling radar":             strings.Replace(base, `"series":["A"]`, `"series":["ZZZ"]`, 1),
		"trailing data":              base + " {}",
		"missing id":                 strings.Replace(base, `"id":"x",`, "", 1),
		"missing need":               strings.Replace(base, `"need":"n",`, "", 1),
		"missing dealbreaker_rules":  strings.Replace(base, `"dealbreaker_rules":[],`, "", 1),
		"missing radar_default":      strings.Replace(base, `"radar_default":{"series":["A"]},`, "", 1),
		// Nested omissions (a hand-edited store dropping a required field below the top level).
		"missing items[].scores":     strings.Replace(base, `,"scores":{"fundamentals":0.5,"consensus_raw":1,"consensus_norm":1,"evidence":0.5,"clean":1}`, "", 1),
		"missing a score field":      strings.Replace(base, `"consensus_norm":1,`, "", 1),
		"missing counts field":       strings.Replace(base, `"eligible":1,`, "", 1),
		"missing radar series":       strings.Replace(base, `{"series":["A"]}`, `{}`, 1),
		// Out-of-range numeric scores (a hand-edited sidecar could sort an item to the top).
		"fundamentals out of range":  strings.Replace(base, `"fundamentals":0.5`, `"fundamentals":2`, 1),
		"negative consensus_raw":     strings.Replace(base, `"consensus_raw":1`, `"consensus_raw":-3`, 1),
	}
	i := 0
	for name, body := range cases {
		i++
		rel := write(fmt.Sprintf("bad%d.compare.json", i), body)
		if got, err := LoadComparison(dir, rel); err == nil || got != nil {
			t.Fatalf("%s: want error+nil comparison, got %v err=%v", name, got, err)
		}
	}
}

// TestLoadComparisonRejectsBadRadar verifies the radar/identity invariants a hand-edited
// store could break even with a schema-shaped sidecar: a removed (dealbreaker) item must
// never be a plotted series, series[0] must be the pick, and item product keys are unique.
func TestLoadComparisonRejectsBadRadar(t *testing.T) {
	dir := t.TempDir()
	runs := filepath.Join(dir, "runs")
	if err := os.MkdirAll(runs, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) string {
		if err := os.WriteFile(filepath.Join(runs, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return filepath.Join("runs", name)
	}
	pick := `{"product":"P","maker":"M","status":"pick","disqualified_reason":null,"dealbreaker_rule":null,"durable_unresolved":false,"scores":{"fundamentals":0.8,"consensus_raw":2,"consensus_norm":1,"evidence":0.6,"clean":1}}`
	disq := `{"product":"X","maker":"M","status":"disqualified","disqualified_reason":"bad","dealbreaker_rule":"r","durable_unresolved":false,"scores":{"fundamentals":0.4,"consensus_raw":1,"consensus_norm":null,"evidence":0.5,"clean":null}}`
	runner := `{"product":"R","maker":"M","status":"runner_up","disqualified_reason":null,"dealbreaker_rule":null,"durable_unresolved":false,"scores":{"fundamentals":0.7,"consensus_raw":1,"consensus_norm":0.5,"evidence":0.6,"clean":1}}`
	dupP := `{"product":"P","maker":"N","status":"eligible","disqualified_reason":null,"dealbreaker_rule":null,"durable_unresolved":false,"scores":{"fundamentals":0.6,"consensus_raw":1,"consensus_norm":0.5,"evidence":0.5,"clean":1}}`
	doc := func(counts, series, items string) string {
		return `{"id":"x","need":"n","axes":["fundamentals","consensus","evidence","clean"],` +
			`"dealbreaker_rules":["r"],"counts":` + counts + `,"radar_default":{"series":` + series + `},"items":[` + items + `]}`
	}

	cases := map[string]string{
		"disqualified in radar":  doc(`{"considered":2,"eligible":1,"removed":1}`, `["X"]`, pick+","+disq),
		"non-pick radar lead":    doc(`{"considered":2,"eligible":2,"removed":0}`, `["R","P"]`, runner+","+pick),
		"duplicate item product": doc(`{"considered":2,"eligible":2,"removed":0}`, `[]`, pick+","+dupP),
	}
	i := 0
	for name, body := range cases {
		i++
		if got, err := LoadComparison(dir, write(fmt.Sprintf("r%d.compare.json", i), body)); err == nil || got != nil {
			t.Fatalf("%s: want error+nil comparison, got %v err=%v", name, got, err)
		}
	}
}

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
