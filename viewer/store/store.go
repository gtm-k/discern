package store

import (
	"encoding/json"
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
}

// Load reads <dir>/index.json and returns all entries.
// If the file does not exist, Load returns nil, nil (not an error).
func Load(dir string) ([]Entry, error) {
	b, err := os.ReadFile(filepath.Join(dir, "index.json"))
	if err != nil {
		if os.IsNotExist(err) {
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
func ReadReport(dir, mdRel string) (string, error) {
	b, err := os.ReadFile(filepath.Join(dir, mdRel))
	return string(b), err
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
