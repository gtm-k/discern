package ui

// compare.go renders the in-run candidate comparison: a dense, sortable heatmap
// tableau (primary) and an optional 2-series braille radar (toggle). It plots ONLY
// the numbers/labels already in the loaded *store.Comparison — it computes no score
// and no disqualification (that logic is single-sourced in Node's compare.mjs).
//
// Observability is normative here (spec §5): the tableau lists EVERY considered
// item, removed rows stay visible (struck-through, scores intact, dealbreaker rule
// + reason shown), the dealbreaker rules legend and the completeness line are
// always in the header, and radar mode still lists every cut beneath the polygons.

import (
	"fmt"
	"sort"
	"strings"

	"github.com/charmbracelet/lipgloss"

	"discern/viewer/store"
)

var (
	compareTitle = lipgloss.NewStyle().Bold(true)
	struck       = lipgloss.NewStyle().Strikethrough(true).Faint(true)
	removedTag   = lipgloss.NewStyle().Bold(true)
	colHead      = lipgloss.NewStyle().Faint(true).Underline(true)
	selectedAxis = lipgloss.NewStyle().Bold(true).Underline(true)
)

const (
	statusW = 13 // width of the status column
	axisW   = 11 // width of each of the four axis columns
	barW    = 4  // block-bar cells per axis
)

// axisTitles are the human column headers, in sidecar axis order.
var axisTitles = [4]string{"Fund", "Cons", "Evid", "Clean"}

// renderCompare is the compareView renderer. It never panics: a missing sidecar,
// an absent pick, or fewer than two eligible series each degrade to a clear
// message or a tableau-only view.
func renderCompare(m Model) string {
	if m.compareErr != "" {
		return m.compareErr + "\n\n" + helpStyle.Render("q/esc back · ctrl+c quit")
	}
	c := m.comparison
	if c == nil {
		return "No comparison loaded.\n\n" + helpStyle.Render("q/esc back · ctrl+c quit")
	}

	var b strings.Builder
	b.WriteString(compareTitle.Render(c.Need) + "\n")
	if len(c.DealbreakerRules) > 0 {
		b.WriteString(helpStyle.Render("dealbreaker rules:") + "\n")
		for _, r := range c.DealbreakerRules {
			b.WriteString(helpStyle.Render("  • "+oneLine(r)) + "\n")
		}
	}
	b.WriteString(completenessLine(c) + "\n\n")

	if m.radarOn && len(c.RadarDefault.Series) >= 2 {
		b.WriteString(renderRadarSection(m))
	} else {
		b.WriteString(renderTableau(m))
	}

	b.WriteString("\n" + helpStyle.Render(compareHelp(m)))
	return b.String()
}

// completenessLine is the one-glance summary (spec §5.5).
func completenessLine(c *store.Comparison) string {
	s := fmt.Sprintf("%d considered · %d eligible · %d removed",
		c.Counts.Considered, c.Counts.Eligible, c.Counts.Removed)
	if c.Counts.Removed > 0 {
		s += " (dealbreaker)"
	}
	return s
}

// renderTableau draws the heatmap: header row + one row per item, removed rows
// sunk to the bottom, struck-through, with their dealbreaker rule/reason shown.
func renderTableau(m Model) string {
	c := m.comparison
	items := sortItems(c.Items, m.sortCol)
	prodW := productWidth(m.width)

	var b strings.Builder

	// Header row: status | product | four axis columns (the sorted one marked).
	b.WriteString(pad("", statusW) + pad("product", prodW) + " ")
	for i, t := range axisTitles {
		title := padRight(t, axisW)
		if m.sortCol == i+1 {
			title = selectedAxis.Render(strings.TrimRight(title, " ")) +
				strings.Repeat(" ", axisW-len(strings.TrimRight(title, " ")))
		} else {
			title = colHead.Render(strings.TrimRight(title, " ")) +
				strings.Repeat(" ", axisW-len(strings.TrimRight(title, " ")))
		}
		b.WriteString(title)
	}
	b.WriteString("\n")

	for _, it := range items {
		b.WriteString(renderRow(it, prodW))
		// Removed rows: show the full dealbreaker rule + reason beneath, so no cut
		// is ever hidden or truncated away (spec §5.3, the observability rule).
		if it.Status == "disqualified" {
			if it.DealbreakerRule != nil && *it.DealbreakerRule != "" {
				b.WriteString(helpStyle.Render("      ↳ rule: "+oneLine(*it.DealbreakerRule)) + "\n")
			}
			if it.DisqualifiedReason != nil && *it.DisqualifiedReason != "" {
				b.WriteString(helpStyle.Render("      ↳ "+oneLine(*it.DisqualifiedReason)) + "\n")
			}
		}
	}
	return b.String()
}

// renderRow renders a single tableau row: status marker + label, product (with
// maker), and the four axis cells. Removed rows are struck-through but keep their
// scores visible (spec §5.3: "removed by rule, regardless of merit").
func renderRow(it store.CompareItem, prodW int) string {
	label := statusLabel(it.Status)
	prod := it.Product
	if it.Maker != "" {
		prod = it.Product + " · " + it.Maker
	}
	if it.DurableUnresolved {
		prod += " (?)" // identity unresolved — flagged, never hidden
	}
	prod = truncate(prod, prodW)

	cells := axisCells(it)

	line := pad(label, statusW) + pad(prod, prodW) + " " + cells
	if it.Status == "disqualified" {
		// Strikethrough the label+product, keep the numeric cells legible.
		return struck.Render(pad(label, statusW)+pad(prod, prodW)) + " " + cells +
			"  " + removedTag.Render("[dealbreaker]") + "\n"
	}
	return line + "\n"
}

// axisCells renders the four axis columns for one item: a number and a block bar.
// Nulls render as "—" with an empty bar (never a misleading 0).
func axisCells(it store.CompareItem) string {
	s := it.Scores
	var b strings.Builder
	b.WriteString(axisCell(fmtScore(s.Fundamentals), valOr(s.Fundamentals, 0), s.Fundamentals != nil))
	b.WriteString(axisCell(fmt.Sprintf("%d", s.ConsensusRaw), valOr(s.ConsensusNorm, 0), s.ConsensusNorm != nil))
	b.WriteString(axisCell(fmtScore(&s.Evidence), s.Evidence, true))
	b.WriteString(axisCell(fmtScore(s.Clean), valOr(s.Clean, 0), s.Clean != nil))
	return b.String()
}

// axisCell formats one cell to axisW: right-padded "num bar".
func axisCell(num string, v float64, hasBar bool) string {
	bar := strings.Repeat(" ", barW)
	if hasBar {
		bar = blockBar(v, barW)
	}
	cell := fmt.Sprintf("%-4s %s", num, bar)
	return padRight(cell, axisW)
}

// blockBar returns a width-cell block bar for v in 0..1.
func blockBar(v float64, width int) string {
	v = clamp01(v)
	filled := int(v*float64(width) + 0.5)
	if filled > width {
		filled = width
	}
	return strings.Repeat("█", filled) + strings.Repeat("░", width-filled)
}

// sortItems returns items in display order: non-removed first (canonical, or by
// the chosen axis descending when sortCol is 1..4), removed ALWAYS last in
// canonical order (spec §9: removed sink to the bottom regardless of sort).
func sortItems(items []store.CompareItem, sortCol int) []store.CompareItem {
	nonRemoved := make([]store.CompareItem, 0, len(items))
	removed := make([]store.CompareItem, 0)
	for _, it := range items {
		if it.Status == "disqualified" {
			removed = append(removed, it)
		} else {
			nonRemoved = append(nonRemoved, it)
		}
	}
	if sortCol >= 1 && sortCol <= 4 {
		sort.SliceStable(nonRemoved, func(i, j int) bool {
			return axisValue(nonRemoved[i], sortCol) > axisValue(nonRemoved[j], sortCol)
		})
	}
	return append(nonRemoved, removed...)
}

// axisValue is the sortable numeric for a column; nulls sort last (-1).
func axisValue(it store.CompareItem, col int) float64 {
	switch col {
	case 1:
		return valOr(it.Scores.Fundamentals, -1)
	case 2:
		return float64(it.Scores.ConsensusRaw)
	case 3:
		return it.Scores.Evidence
	case 4:
		return valOr(it.Scores.Clean, -1)
	}
	return 0
}

// renderRadarSection draws the pick-vs-rival radar and, beneath it, every cut as
// "removed — <reason>" so radar mode never hides a dealbreaker (spec §5.6).
func renderRadarSection(m Model) string {
	c := m.comparison
	pick := findItem(c, c.RadarDefault.Series[0])
	rivals := eligibleRivals(c)
	if pick == nil || len(rivals) == 0 {
		return renderTableau(m) // defensive: fall back to the tableau
	}
	rival := rivals[m.rivalIdx%len(rivals)]

	s0 := seriesOf(*pick)
	s1 := seriesOf(rival)

	var b strings.Builder
	b.WriteString(radarGrid(s0, s1, 24, 12) + "\n\n")
	b.WriteString("axes: ↑Fund →Cons ↓Evid ←Clean\n")
	b.WriteString("  ◆ " + s0.Label + "   ◇ " + s1.Label + "\n")

	// Every removed item is listed beneath — cuts are never invisible.
	first := true
	for _, it := range c.Items {
		if it.Status != "disqualified" {
			continue
		}
		if first {
			b.WriteString("\nremoved:\n")
			first = false
		}
		reason := ""
		if it.DisqualifiedReason != nil {
			reason = " — " + oneLine(*it.DisqualifiedReason)
		}
		b.WriteString(struck.Render("  ✗ "+it.Product) + helpStyle.Render(reason) + "\n")
	}
	return b.String()
}

// seriesOf maps an item's scores to the 4-axis radar vector (nulls -> 0, since a
// disqualified/unscored item cannot contribute a vertex).
func seriesOf(it store.CompareItem) radarSeries {
	return radarSeries{
		Label: it.Product,
		V: [4]float64{
			valOr(it.Scores.Fundamentals, 0),
			valOr(it.Scores.ConsensusNorm, 0),
			it.Scores.Evidence,
			valOr(it.Scores.Clean, 0),
		},
	}
}

// eligibleRivals is the set the radar rival can cycle over: shortlisted, non-pick,
// non-disqualified items (those with a plottable fundamentals axis).
func eligibleRivals(c *store.Comparison) []store.CompareItem {
	out := make([]store.CompareItem, 0, len(c.Items))
	for _, it := range c.Items {
		if it.Status == "runner_up" || it.Status == "eligible" {
			out = append(out, it)
		}
	}
	return out
}

// findItem returns the item with the given product name, or nil.
func findItem(c *store.Comparison, product string) *store.CompareItem {
	for i := range c.Items {
		if c.Items[i].Product == product {
			return &c.Items[i]
		}
	}
	return nil
}

// statusLabel renders the status marker AND label (never color alone — spec §5.2,
// accessibility): a glyph plus the word.
func statusLabel(status string) string {
	switch status {
	case "pick":
		return "◄ PICK"
	case "runner_up":
		return "▲ runner-up"
	case "eligible":
		return "· eligible"
	case "not_shortlisted":
		return "○ considered"
	case "disqualified":
		return "✗ REMOVED"
	}
	return status
}

// compareHelp is the per-state help line, tuned to what is actionable now.
func compareHelp(m Model) string {
	radar := "r radar"
	if m.radarOn {
		radar = "r tableau"
		return radar + " · tab rival · enter report · q/esc back · ctrl+c quit"
	}
	return radar + " · 1-4 sort · enter report · q/esc back · ctrl+c quit"
}

// --- small formatting helpers ---

// fmtScore renders a 0..1 score as ".82"; nil renders as "—" (never 0).
func fmtScore(p *float64) string {
	if p == nil {
		return "—"
	}
	s := fmt.Sprintf("%.2f", *p)
	if strings.HasPrefix(s, "0.") {
		return s[1:] // ".82"
	}
	return s // "1.00"
}

func valOr(p *float64, def float64) float64 {
	if p == nil {
		return def
	}
	return *p
}

// productWidth flexes the product column to the terminal, with a sane default and
// floor for tiny/unset widths.
func productWidth(total int) int {
	if total <= 0 {
		return 32
	}
	w := total - statusW - 1 - axisW*4
	if w < 16 {
		w = 16
	}
	if w > 48 {
		w = 48
	}
	return w
}

// oneLine collapses whitespace/newlines so a reason never breaks the layout.
func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// truncate hard-limits a string to n display cells, adding an ellipsis.
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	if n <= 1 {
		return string(r[:n])
	}
	return string(r[:n-1]) + "…"
}

// pad left-justifies s to width w (truncating if longer).
func pad(s string, w int) string {
	s = truncate(s, w)
	if len([]rune(s)) >= w {
		return s
	}
	return s + strings.Repeat(" ", w-len([]rune(s)))
}

// padRight is pad without truncation (assumes s already fits).
func padRight(s string, w int) string {
	if len([]rune(s)) >= w {
		return s
	}
	return s + strings.Repeat(" ", w-len([]rune(s)))
}
