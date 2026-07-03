package ui

// radar.go is a small, self-contained braille-grid radar for EXACTLY 2 series
// across the 4 comparison axes. It has NO third-party dependency — it plots the
// already-computed axis values (0..1) from the sidecar onto a Unicode braille
// canvas. All geometry (scores -> cells) is pure and unit-tested; the model only
// hands it numbers, never computes them (the "Go plots, never computes" invariant).

import (
	"math"
	"strings"
)

// brailleDots maps a sub-cell dot position (dx in 0..1, dy in 0..3) to its bit in
// the Unicode braille byte. Each terminal character (base U+2800) packs a 2x4 dot
// grid, so a canvas of w*h characters addresses a 2w x 4h pixel field.
var brailleDots = [2][4]rune{
	{0x01, 0x02, 0x04, 0x40},
	{0x08, 0x10, 0x20, 0x80},
}

// brailleCanvas is a w x h grid of braille characters (a 2w x 4h pixel field).
type brailleCanvas struct {
	w, h  int    // character dimensions
	cells []rune // w*h dot-bit accumulators (0..0xFF), row-major
}

func newBrailleCanvas(w, h int) *brailleCanvas {
	if w < 1 {
		w = 1
	}
	if h < 1 {
		h = 1
	}
	return &brailleCanvas{w: w, h: h, cells: make([]rune, w*h)}
}

// Set turns on the dot at pixel (px, py). Out-of-range pixels are ignored so the
// caller never has to clip — a polygon vertex that rounds just off the edge is
// simply not drawn rather than panicking.
func (c *brailleCanvas) Set(px, py int) {
	if px < 0 || py < 0 || px >= c.w*2 || py >= c.h*4 {
		return
	}
	cx, cy := px/2, py/4
	dx, dy := px%2, py%4
	c.cells[cy*c.w+cx] |= brailleDots[dx][dy]
}

// line draws a straight line between two pixel points using integer Bresenham.
func (c *brailleCanvas) line(x0, y0, x1, y1 int) {
	dx := absInt(x1 - x0)
	dy := -absInt(y1 - y0)
	sx := 1
	if x0 > x1 {
		sx = -1
	}
	sy := 1
	if y0 > y1 {
		sy = -1
	}
	err := dx + dy
	for {
		c.Set(x0, y0)
		if x0 == x1 && y0 == y1 {
			break
		}
		e2 := 2 * err
		if e2 >= dy {
			err += dy
			x0 += sx
		}
		if e2 <= dx {
			err += dx
			y0 += sy
		}
	}
}

// String renders the canvas as h newline-joined rows of braille runes.
func (c *brailleCanvas) String() string {
	var b strings.Builder
	for row := 0; row < c.h; row++ {
		for col := 0; col < c.w; col++ {
			b.WriteRune(0x2800 + c.cells[row*c.w+col])
		}
		if row < c.h-1 {
			b.WriteByte('\n')
		}
	}
	return b.String()
}

// radarSeries is one polygon: a label and the four axis values (each 0..1, in the
// axis order fundamentals, consensus, evidence, clean).
type radarSeries struct {
	Label string
	V     [4]float64
}

// radarAngles places the four axes at up, right, down, left. Math convention (x
// right, y up); screen y is flipped when a vertex is placed (see axisVertex).
//
//	[0] fundamentals -> up
//	[1] consensus    -> right
//	[2] evidence     -> down
//	[3] clean        -> left
var radarAngles = [4]float64{
	math.Pi / 2,  // up
	0,            // right
	-math.Pi / 2, // down
	math.Pi,      // left
}

// axisVertex returns the pixel coordinate of axis i at value v (0..1), given the
// canvas center (cx, cy) and the maximum radius. Pure and exact for integer
// inputs at v in {0,1}, which is what the geometry test pins.
func axisVertex(cx, cy, radius, v float64, i int) (int, int) {
	a := radarAngles[i]
	x := cx + radius*v*math.Cos(a)
	y := cy - radius*v*math.Sin(a) // screen y grows downward, so subtract
	return int(math.Round(x)), int(math.Round(y))
}

// drawPolygon plots the 4-vertex polygon for one series onto the canvas.
func drawPolygon(c *brailleCanvas, cx, cy, radius float64, v [4]float64) {
	var pts [4][2]int
	for i := 0; i < 4; i++ {
		x, y := axisVertex(cx, cy, radius, clamp01(v[i]), i)
		pts[i] = [2]int{x, y}
	}
	for i := 0; i < 4; i++ {
		j := (i + 1) % 4
		c.line(pts[i][0], pts[i][1], pts[j][0], pts[j][1])
	}
}

// radarGrid draws both series onto a fresh w x h braille canvas and returns the
// grid string (no labels — the caller adds legend/labels). Exactly 2 series.
func radarGrid(s0, s1 radarSeries, w, h int) string {
	canvas := newBrailleCanvas(w, h)
	pw, ph := float64(canvas.w*2), float64(canvas.h*4)
	cx, cy := (pw-1)/2, (ph-1)/2
	radius := math.Min(cx, cy) - 1
	if radius < 1 {
		radius = 1
	}
	drawPolygon(canvas, cx, cy, radius, s0.V)
	drawPolygon(canvas, cx, cy, radius, s1.V)
	return canvas.String()
}

func clamp01(v float64) float64 {
	if math.IsNaN(v) || v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
