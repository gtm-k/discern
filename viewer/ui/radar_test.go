package ui

import "testing"

// TestBrailleSet pins the dot-bit mapping: Set(0,0) is dot 1 (0x01), so the cell
// renders as U+2801 "⠁". A canvas is otherwise all blank braille (U+2800).
func TestBrailleSet(t *testing.T) {
	c := newBrailleCanvas(1, 1)
	if got := c.String(); got != "⠀" {
		t.Fatalf("empty 1x1: want U+2800, got %q (%U)", got, []rune(got)[0])
	}
	c.Set(0, 0)
	if got := c.String(); got != "⠁" {
		t.Fatalf("Set(0,0): want U+2801, got %q (%U)", got, []rune(got)[0])
	}
	// Set the bottom-right dot of the same cell: dot 8 (0x80) -> U+2881 combined.
	c.Set(1, 3)
	if got := c.String(); got != "⢁" {
		t.Fatalf("Set(0,0)+Set(1,3): want U+2881, got %q (%U)", got, []rune(got)[0])
	}
}

// TestBrailleSetIgnoresOutOfRange verifies clipping: off-canvas pixels are dropped
// silently (a rounded-off polygon vertex must not panic).
func TestBrailleSetIgnoresOutOfRange(t *testing.T) {
	c := newBrailleCanvas(1, 1)
	c.Set(-1, 0)
	c.Set(0, -1)
	c.Set(2, 0) // px == w*2, out of range
	c.Set(0, 4) // py == h*4, out of range
	if got := c.String(); got != "⠀" {
		t.Fatalf("out-of-range sets leaked: got %q", got)
	}
}

// TestBrailleLine draws a horizontal line across a 2x1 canvas (pixels (0,0)->(3,0)).
// Row 0 in each cell = dots 1 and 4 (0x01|0x08 = 0x09) -> U+2809 "⠉" in both cells.
func TestBrailleLine(t *testing.T) {
	c := newBrailleCanvas(2, 1)
	c.line(0, 0, 3, 0)
	if got := c.String(); got != "⠉⠉" {
		t.Fatalf("horizontal line: want ⠉⠉, got %q", got)
	}
}

// TestAxisVertex pins the geometry (scores -> pixel cells): v=0 is the center for
// every axis; v=1 lands at up/right/down/left exactly for integer center+radius.
func TestAxisVertex(t *testing.T) {
	const cx, cy, r = 10.0, 10.0, 8.0

	// v=0 collapses every axis to the (rounded) center.
	for i := 0; i < 4; i++ {
		x, y := axisVertex(cx, cy, r, 0, i)
		if x != 10 || y != 10 {
			t.Fatalf("axis %d at v=0: want (10,10), got (%d,%d)", i, x, y)
		}
	}
	// v=1 endpoints. Screen y grows downward, so "up" subtracts from cy.
	want := [4][2]int{
		{10, 2},  // fundamentals -> up
		{18, 10}, // consensus    -> right
		{10, 18}, // evidence     -> down
		{2, 10},  // clean        -> left
	}
	for i, w := range want {
		x, y := axisVertex(cx, cy, r, 1, i)
		if x != w[0] || y != w[1] {
			t.Fatalf("axis %d at v=1: want (%d,%d), got (%d,%d)", i, w[0], w[1], x, y)
		}
	}
}

// TestRadarGridGolden locks the full rendered geometry for two known series. The
// golden was captured from the reviewed implementation; a geometry regression
// (angle table, Bresenham, canvas packing) changes this string.
func TestRadarGridGolden(t *testing.T) {
	s0 := radarSeries{Label: "pick", V: [4]float64{1, 1, 1, 1}}   // full diamond
	s1 := radarSeries{Label: "rival", V: [4]float64{0.5, 0.5, 0.5, 0.5}} // half diamond
	got := radarGrid(s0, s1, 8, 4)

	// Structural invariants (dimension + no panic) — always checked.
	rows := 0
	for _, r := range got {
		if r == '\n' {
			rows++
		}
	}
	if rows != 3 { // h=4 -> 3 newlines
		t.Fatalf("radar grid: want 4 rows (3 newlines), got %d newlines in %q", rows, got)
	}

	const want = "⠀⠀⠀⡠⠢⡀⠀⠀\n" +
		"⢀⠔⢉⠔⠑⡜⢄⠀\n" +
		"⠀⠑⢕⠢⡠⢊⠔⠁\n" +
		"⠀⠀⠀⠑⠔⠁⠀⠀"
	if got != want {
		t.Errorf("radar grid golden mismatch:\n got %q\nwant %q", got, want)
	}
}
