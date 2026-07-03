package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Entry mirrors the writer↔reader contract field-for-field (reader side).
// JSON tags match the keys written by the Node writer (B2) and defined in the B1 schema.
type Entry struct {
	ID          string   `json:"id"`
	Timestamp   string   `json:"timestamp"`
	Need        string   `json:"need"`
	Category    string   `json:"category_taxonomy"`
	Beneficiary string   `json:"beneficiary_type"`
	Outcome     string   `json:"outcome"`
	ReasonCode  string   `json:"reason_code"`
	Pick        *string  `json:"pick"`
	Confidence  *float64 `json:"confidence_overall"`
	JSON        string   `json:"json"`
	MD          string   `json:"md"`
	// Compare points at the runs/<id>.compare.json sidecar (the comparison
	// view artifact). Optional in the index: an old store written before the
	// sidecar existed unmarshals this to nil ("no comparison — reindex").
	Compare *string `json:"compare"`
}

// Comparison mirrors runs/<id>.compare.json field-for-field (reader side of the
// seam). The Node writer (tools/compare.mjs) is the sole author; Go only plots.
// It is governed by schemas/store-compare.schema.json — the two sides agree by
// construction, and the seam test parses a Node-written sidecar to prove it.
type Comparison struct {
	ID               string        `json:"id"`
	Need             string        `json:"need"`
	Axes             []string      `json:"axes"`
	DealbreakerRules []string      `json:"dealbreaker_rules"`
	Counts           Counts        `json:"counts"`
	RadarDefault     RadarDefault  `json:"radar_default"`
	Items            []CompareItem `json:"items"`
}

// Counts is the completeness summary: considered = eligible + removed.
type Counts struct {
	Considered int `json:"considered"`
	Eligible   int `json:"eligible"`
	Removed    int `json:"removed"`
}

// RadarDefault names the series the radar overlays by default (pick + rival).
// 0..2 entries; fewer than 2 means the radar is disabled for this run.
type RadarDefault struct {
	Series []string `json:"series"`
}

// CompareItem is one row of the tableau — one candidate considered by the run.
type CompareItem struct {
	Product            string  `json:"product"`
	Maker              string  `json:"maker"`
	Status             string  `json:"status"`
	DisqualifiedReason *string `json:"disqualified_reason"`
	DealbreakerRule    *string `json:"dealbreaker_rule"`
	DurableUnresolved  bool    `json:"durable_unresolved"`
	Scores             Scores  `json:"scores"`
}

// Scores holds the four derived axis values. Nullable fields are pointers so an
// honest null (not scored / not plotted) survives the round-trip and is not
// silently coerced to 0: fundamentals is nil when not shortlisted; consensus_norm
// and clean are nil for disqualified items.
type Scores struct {
	Fundamentals  *float64 `json:"fundamentals"`
	ConsensusRaw  int      `json:"consensus_raw"`
	ConsensusNorm *float64 `json:"consensus_norm"`
	Evidence      float64  `json:"evidence"`
	Clean         *float64 `json:"clean"`
}

// Load reads <dir>/index.json and returns all entries.
// If the file does not exist, Load returns nil, nil (not an error).
func Load(dir string) ([]Entry, error) {
	b, err := os.ReadFile(filepath.Join(dir, "index.json"))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var es []Entry
	if err := json.Unmarshal(b, &es); err != nil {
		return nil, err
	}
	return es, nil
}

// ReadReport returns the contents of the markdown report at <dir>/<mdRel>.
// mdRel comes from the index.json `md` field, which is untrusted on a shared or
// hand-edited store; ReadReport contains it within dir and rejects any path that
// is absolute or escapes the store (e.g. "../../etc/passwd", "..\\x").
func ReadReport(dir, mdRel string) (string, error) {
	realFull, err := containedPath(dir, mdRel)
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(realFull)
	if err != nil {
		return "", fmt.Errorf("read report %q: %w", mdRel, err)
	}
	return string(b), nil
}

// LoadComparison reads and parses the comparison sidecar at <dir>/<compareRel>.
// compareRel comes from the index.json `compare` field and is untrusted exactly
// like `md`, so LoadComparison reuses the SAME containment + symlink guards as
// ReadReport (via containedPath) — a compare path is equally capable of trying
// to escape a shared or hand-edited store. Returns nil + error on any escape,
// missing file, or malformed JSON.
func LoadComparison(dir, compareRel string) (*Comparison, error) {
	realFull, err := containedPath(dir, compareRel)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(realFull)
	if err != nil {
		return nil, fmt.Errorf("read comparison %q: %w", compareRel, err)
	}
	var c Comparison
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("parse comparison %q: %w", compareRel, err)
	}
	return &c, nil
}

// containedPath validates that rel is a store-relative path staying within dir —
// both lexically and after symlink resolution — and returns the real (symlink-
// resolved) absolute path safe to read. rel is untrusted (from index.json). The
// four gates are the SINGLE source of "inside the store" containment, shared by
// ReadReport and LoadComparison so the two readers can never drift on it.
func containedPath(dir, rel string) (string, error) {
	if filepath.IsAbs(rel) {
		return "", fmt.Errorf("store path must be relative: %q", rel)
	}
	full := filepath.Join(dir, rel)
	// First gate: lexical containment rejects ".."-escaping path strings.
	if !contained(dir, full) {
		return "", fmt.Errorf("store path escapes store: %q", rel)
	}
	// Second gate: resolve symlinks and re-verify containment, so a symlink
	// INSIDE the store cannot redirect the read to a target OUTSIDE it. The
	// lexical check on "runs/x.json" passes for a symlink (no ".." in the string),
	// so this resolved-path check is what actually blocks the escape.
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", fmt.Errorf("resolve store dir: %w", err)
	}
	realFull, err := filepath.EvalSymlinks(full)
	if err != nil {
		// Missing file or broken symlink: nothing to leak. Surface as a normal
		// read error, not the escape error, so a safe-but-missing path is not
		// mislabeled as a traversal attempt.
		return "", fmt.Errorf("resolve store path %q: %w", rel, err)
	}
	if !contained(realDir, realFull) {
		return "", fmt.Errorf("store path escapes store (symlink): %q", rel)
	}
	return realFull, nil
}

// contained reports whether p resolves to base or a descendant of base — i.e.
// the relative path from base to p does not start with "..". Used for both the
// lexical gate (on the joined path) and the resolved gate (on EvalSymlinks output).
func contained(base, p string) bool {
	rel, err := filepath.Rel(base, p)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// Filter returns entries matching q (case-insensitive substring search across need, category, pick, outcome).
// Empty or whitespace-only q returns all entries unchanged.
func Filter(es []Entry, q string) []Entry {
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return es
	}
	out := []Entry{}
	for _, e := range es {
		pick := ""
		if e.Pick != nil {
			pick = *e.Pick
		}
		hay := strings.ToLower(e.Need + " " + e.Category + " " + pick + " " + e.Outcome)
		if strings.Contains(hay, q) {
			out = append(out, e)
		}
	}
	return out
}
