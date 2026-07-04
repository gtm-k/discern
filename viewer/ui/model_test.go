package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"discern/viewer/store"
)

const exampleDir = "../../store/example"

func runeKey(r rune) tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}} }

func exampleModel(t *testing.T) Model {
	t.Helper()
	es, err := store.Load(exampleDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(es) < 1 || es[0].Compare == nil {
		t.Fatalf("example store must have >=1 entry with a compare sidecar; got %d entries", len(es))
	}
	return New(exampleDir, es)
}

func TestEnterOpensDetail(t *testing.T) {
	m := New(exampleDir, []store.Entry{{ID: "x", Need: "n", Outcome: "RECOMMEND", MD: "runs/x.md"}})
	nm, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if nm.(Model).state != detailView {
		t.Fatal("Enter should open detail")
	}
}

// TestOpenCompareFromList: `c` on the highlighted run opens the loaded comparison.
func TestOpenCompareFromList(t *testing.T) {
	m := exampleModel(t)
	nm, _ := m.Update(runeKey('c'))
	mm := nm.(Model)
	if mm.state != compareView {
		t.Fatalf("`c` should open compareView, got %v", mm.state)
	}
	if mm.comparison == nil {
		t.Fatal("comparison should be loaded")
	}
	if mm.compareErr != "" {
		t.Fatalf("unexpected compareErr: %q", mm.compareErr)
	}
	// View renders without panic and includes the completeness line.
	out := mm.View()
	if !strings.Contains(out, "considered") {
		t.Fatalf("compare view missing completeness line:\n%s", out)
	}
}

// TestOpenCompareFromDetail: `c` is also reachable from a run's detail view (§9).
func TestOpenCompareFromDetail(t *testing.T) {
	m := exampleModel(t)
	nm, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter}) // -> detail
	if nm.(Model).state != detailView {
		t.Fatal("Enter should open detail")
	}
	nm2, _ := nm.(Model).Update(runeKey('c'))
	if nm2.(Model).state != compareView {
		t.Fatal("`c` from detail should open compareView")
	}
}

// TestCompareMissingSidecar: an entry with no `compare` (old store) degrades to a
// clear message, still enters compareView, and renders without panic.
func TestCompareMissingSidecar(t *testing.T) {
	m := New(exampleDir, []store.Entry{{ID: "x", Need: "n", Outcome: "RECOMMEND", MD: "runs/x.md"}})
	nm, _ := m.Update(runeKey('c'))
	mm := nm.(Model)
	if mm.state != compareView {
		t.Fatal("`c` should still enter compareView")
	}
	if mm.comparison != nil {
		t.Fatal("comparison should be nil when sidecar absent")
	}
	if !strings.Contains(mm.compareErr, "reindex") {
		t.Fatalf("want a reindex hint, got %q", mm.compareErr)
	}
	if out := mm.View(); !strings.Contains(out, "reindex") {
		t.Fatalf("view should show the missing-sidecar message:\n%s", out)
	}
}

// TestCompareRejectsMismatchedSidecar: a stale/hand-edited index row whose id does
// not match the (individually valid) sidecar it points at must be refused — the
// viewer must not render run B's comparison as run A's. compareErr is set instead.
func TestCompareRejectsMismatchedSidecar(t *testing.T) {
	real, err := store.Load(exampleDir)
	if err != nil || len(real) == 0 || real[0].Compare == nil {
		t.Fatalf("example store not loadable with a sidecar: %v", err)
	}
	// An index row for run "WRONG-ID" pointing at another run's valid sidecar.
	entry := store.Entry{ID: "WRONG-ID", Need: "n", Outcome: "RECOMMEND", MD: "runs/x.md", Compare: real[0].Compare}
	m := New(exampleDir, []store.Entry{entry})
	nm, _ := m.Update(runeKey('c'))
	mm := nm.(Model)
	if mm.state != compareView {
		t.Fatal("`c` should still enter compareView")
	}
	if mm.comparison != nil {
		t.Fatalf("mismatched sidecar must not be accepted, got %+v", mm.comparison)
	}
	if mm.compareErr == "" {
		t.Fatal("want compareErr set for id mismatch, got empty")
	}
}

// TestCompareTransitions exercises the compareView keys: sort, radar toggle, rival
// cycle, and back-to-list — none should panic and each should mutate state.
func TestCompareTransitions(t *testing.T) {
	m := exampleModel(t)
	nm, _ := m.Update(runeKey('c'))
	mm := nm.(Model)

	// `2` sorts by the consensus axis.
	nm, _ = mm.Update(runeKey('2'))
	mm = nm.(Model)
	if mm.sortCol != 2 {
		t.Fatalf("sortCol: want 2, got %d", mm.sortCol)
	}

	// `r` toggles the radar (example has 2 series, so it is enabled).
	nm, _ = mm.Update(runeKey('r'))
	mm = nm.(Model)
	if !mm.radarOn {
		t.Fatal("`r` should enable radar (>=2 series)")
	}
	if out := mm.View(); out == "" {
		t.Fatal("radar view rendered empty")
	}
	nm, _ = mm.Update(runeKey('r'))
	mm = nm.(Model)
	if mm.radarOn {
		t.Fatal("`r` should toggle radar back off")
	}

	// `tab` cycles the rival index without going out of range.
	before := mm.rivalIdx
	nm, _ = mm.Update(tea.KeyMsg{Type: tea.KeyTab})
	mm = nm.(Model)
	rivals := eligibleRivals(mm.comparison)
	if len(rivals) > 0 && mm.rivalIdx >= len(rivals) {
		t.Fatalf("rivalIdx out of range: %d >= %d", mm.rivalIdx, len(rivals))
	}
	_ = before

	// `esc` returns to the list.
	nm, _ = mm.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if nm.(Model).state != listView {
		t.Fatal("`esc` should return to listView")
	}

	// `q` also returns to the list.
	nm, _ = mm.Update(runeKey('c'))
	nm, _ = nm.(Model).Update(runeKey('q'))
	if nm.(Model).state != listView {
		t.Fatal("`q` should return to listView")
	}
}

// TestCompareEnterOpensReport: from compareView, `enter` opens the full prose
// report (detailView) for the same run.
func TestCompareEnterOpensReport(t *testing.T) {
	m := exampleModel(t)
	nm, _ := m.Update(runeKey('c'))
	nm2, _ := nm.(Model).Update(tea.KeyMsg{Type: tea.KeyEnter})
	if nm2.(Model).state != detailView {
		t.Fatal("`enter` in compareView should open the full report (detailView)")
	}
}

// TestRadarDisabledWhenFewSeries: a comparison with <2 radar series keeps the
// radar off even when `r` is pressed (degenerate case renders tableau-only).
func TestRadarDisabledWhenFewSeries(t *testing.T) {
	series := "Only Pick"
	m := New(exampleDir, []store.Entry{{ID: "x", Need: "n", MD: "runs/x.md"}})
	// Inject a single-series comparison directly (bypassing the store) to drive
	// the degenerate branch deterministically.
	m.state = compareView
	m.comparison = &store.Comparison{
		Need:         "n",
		Axes:         []string{"fundamentals", "consensus", "evidence", "clean"},
		Counts:       store.Counts{Considered: 1, Eligible: 1, Removed: 0},
		RadarDefault: store.RadarDefault{Series: []string{series}},
		Items: []store.CompareItem{{
			Product: series, Status: "pick",
			Scores: store.Scores{ConsensusRaw: 1, Evidence: 0.5},
		}},
	}
	nm, _ := m.Update(runeKey('r'))
	if nm.(Model).radarOn {
		t.Fatal("radar must stay disabled with <2 series")
	}
	if out := nm.(Model).View(); out == "" {
		t.Fatal("degenerate compare view rendered empty")
	}
}
