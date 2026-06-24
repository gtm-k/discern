package store

import (
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
