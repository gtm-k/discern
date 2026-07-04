package store

import (
	"bytes"
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
	// Strict decode: the sidecar is the seam contract and a shared/hand-edited store is
	// untrusted (parity with the path guards above), so reject unknown fields and then
	// enforce the contract invariants JSON alone can't — a malformed comparison must fail
	// closed rather than render a false completeness line or invalid statuses.
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var c Comparison
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("parse comparison %q: %w", compareRel, err)
	}
	if err := c.validate(); err != nil {
		return nil, fmt.Errorf("invalid comparison %q: %w", compareRel, err)
	}
	return &c, nil
}

// compareAxes is the canonical axis order every sidecar must carry (mirrors
// tools/compare.mjs AXES and schemas/store-compare.schema.json).
var compareAxes = [...]string{"fundamentals", "consensus", "evidence", "clean"}

// validStatus is the closed set of item statuses (mirrors the schema enum).
var validStatus = map[string]bool{
	"pick": true, "runner_up": true, "eligible": true, "not_shortlisted": true, "disqualified": true,
}

// validate enforces the store-compare contract invariants that decoding alone cannot:
// the fixed axes, the status enum, count consistency (considered == items, removed ==
// disqualified, eligible == considered-removed), and a radar overlaying at most two series
// that each name a real item. Returns an error (fail closed) on any breach, so a hand-edited
// or version-skewed sidecar surfaces as an error instead of a plausible-but-false comparison.
func (c *Comparison) validate() error {
	if len(c.Axes) != len(compareAxes) {
		return fmt.Errorf("axes: want %v, got %v", compareAxes, c.Axes)
	}
	for i, a := range compareAxes {
		if c.Axes[i] != a {
			return fmt.Errorf("axes[%d]: want %q, got %q", i, a, c.Axes[i])
		}
	}
	products := make(map[string]bool, len(c.Items))
	removed := 0
	for i, it := range c.Items {
		if it.Product == "" {
			return fmt.Errorf("items[%d]: empty product", i)
		}
		if !validStatus[it.Status] {
			return fmt.Errorf("items[%d] %q: invalid status %q", i, it.Product, it.Status)
		}
		if it.Status == "disqualified" {
			removed++
		}
		products[it.Product] = true
	}
	if c.Counts.Considered != len(c.Items) {
		return fmt.Errorf("counts.considered=%d but %d items", c.Counts.Considered, len(c.Items))
	}
	if c.Counts.Removed != removed {
		return fmt.Errorf("counts.removed=%d but %d disqualified items", c.Counts.Removed, removed)
	}
	if c.Counts.Eligible != c.Counts.Considered-c.Counts.Removed {
		return fmt.Errorf("counts not additive: considered=%d eligible=%d removed=%d",
			c.Counts.Considered, c.Counts.Eligible, c.Counts.Removed)
	}
	if len(c.RadarDefault.Series) > 2 {
		return fmt.Errorf("radar_default.series: at most 2, got %d", len(c.RadarDefault.Series))
	}
	for _, s := range c.RadarDefault.Series {
		if !products[s] {
			return fmt.Errorf("radar_default.series references unknown product %q", s)
		}
	}
	return nil
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
