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
