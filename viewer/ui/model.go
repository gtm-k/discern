// Package ui implements the terminal viewer for Discern run history.
//
// It is a bubbletea program with three states: a list of runs (a bubbles
// table), a detail view (a bubbles viewport showing one run's report), and a
// filter prompt (a bubbles textinput that narrows the list).
//
// Architecture boundary: the report markdown is PRE-RENDERED by the Node
// renderer (render.mjs) and read verbatim via store.ReadReport. glamour is used
// here ONLY as a terminal display renderer — it applies ANSI styling to that
// already-rendered markdown string. No report content, headings, or fields are
// constructed in Go; this preserves the single-renderer boundary.
package ui

import (
	"fmt"

	"github.com/charmbracelet/bubbles/table"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/lipgloss"

	"discern/viewer/store"
)

// state is the current screen the model is displaying.
type state int

const (
	listView state = iota
	detailView
	filterView
	compareView
)

const colGap = 7 // borders + inter-column padding

var helpStyle = lipgloss.NewStyle().Faint(true)

// Model is the bubbletea model for the viewer. It uses VALUE receivers
// throughout: Update returns the value `m` (not `&m`) so that callers can
// type-assert the result back to `Model`.
type Model struct {
	state state

	dir      string        // directory holding index.json + run reports
	entries  []store.Entry // full, unfiltered set
	filtered []store.Entry // current view (rows in the table mirror this)

	table    table.Model
	viewport viewport.Model
	filter   textinput.Model

	// Comparison view state. comparison is the loaded sidecar (nil until `c`
	// opens one); compareErr holds a user-facing message when a sidecar is
	// absent or unreadable (rendered instead of the tableau, never a panic).
	comparison *store.Comparison
	compareErr string
	sortCol    int  // 0 = status-grouped default; 1..4 = sort by that axis desc
	radarOn    bool // radar overlay vs tableau
	rivalIdx   int  // index into eligibleRivals for the radar's second series

	ready  bool // viewport has received a real size at least once
	width  int
	height int
}

// New constructs a Model in listView holding every entry, with the table
// populated from those entries and empty detail/filter components.
func New(dir string, es []store.Entry) Model {
	cols := columns(0)

	t := table.New(
		table.WithColumns(cols),
		table.WithRows(rows(es)),
		table.WithFocused(true),
		table.WithHeight(15),
	)

	ti := textinput.New()
	ti.Placeholder = "filter…"
	ti.Prompt = "/ "

	vp := viewport.New(80, 20)

	return Model{
		state:    listView,
		dir:      dir,
		entries:  es,
		filtered: es,
		table:    t,
		viewport: vp,
		filter:   ti,
	}
}

// Init implements tea.Model. The viewer drives itself from key/size messages,
// so no startup command is needed.
func (m Model) Init() tea.Cmd {
	return nil
}

// Update implements tea.Model. It dispatches on the current state and returns
// the updated model BY VALUE.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if ws, ok := msg.(tea.WindowSizeMsg); ok {
		m = m.resize(ws.Width, ws.Height)
		return m, nil
	}

	switch m.state {
	case listView:
		return m.updateList(msg)
	case detailView:
		return m.updateDetail(msg)
	case filterView:
		return m.updateFilter(msg)
	case compareView:
		return m.updateCompare(msg)
	}
	return m, nil
}

func (m Model) updateList(msg tea.Msg) (tea.Model, tea.Cmd) {
	if key, ok := msg.(tea.KeyMsg); ok {
		switch key.String() {
		case "ctrl+c", "q":
			return m, tea.Quit
		case "/":
			m.state = filterView
			cmd := m.filter.Focus()
			return m, cmd
		case "enter":
			return m.openDetail()
		case "c":
			return m.openCompare()
		}
	}
	var cmd tea.Cmd
	m.table, cmd = m.table.Update(msg)
	return m, cmd
}

func (m Model) updateDetail(msg tea.Msg) (tea.Model, tea.Cmd) {
	if key, ok := msg.(tea.KeyMsg); ok {
		switch key.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "esc", "q":
			m.state = listView
			return m, nil
		case "c":
			return m.openCompare()
		}
	}
	var cmd tea.Cmd
	m.viewport, cmd = m.viewport.Update(msg)
	return m, cmd
}

// updateCompare handles keys in compareView: `r` toggle radar (only when the run
// has >=2 radar series), `tab` cycle the rival series, `1`-`4` sort by axis, `enter`
// open the full prose report for the same run, `q`/`esc` back to the list. None of
// these panic on a degenerate comparison (no pick / no eligible rivals).
func (m Model) updateCompare(msg tea.Msg) (tea.Model, tea.Cmd) {
	key, ok := msg.(tea.KeyMsg)
	if !ok {
		return m, nil
	}
	switch key.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "esc", "q":
		m.state = listView
		return m, nil
	case "enter":
		// Open the full prose report for the run currently being compared. The
		// table cursor is unchanged while in compareView, so openDetail targets
		// the same run.
		return m.openDetail()
	case "r":
		if m.comparison != nil && len(m.comparison.RadarDefault.Series) >= 2 {
			m.radarOn = !m.radarOn
		}
		return m, nil
	case "tab":
		if m.comparison != nil {
			if n := len(eligibleRivals(m.comparison)); n > 0 {
				m.rivalIdx = (m.rivalIdx + 1) % n
			}
		}
		return m, nil
	case "1", "2", "3", "4":
		m.sortCol = int(key.String()[0] - '0')
		return m, nil
	}
	return m, nil
}

func (m Model) updateFilter(msg tea.Msg) (tea.Model, tea.Cmd) {
	if key, ok := msg.(tea.KeyMsg); ok {
		switch key.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "enter", "esc":
			// Apply the current filter and return to the list.
			m.filter.Blur()
			m.state = listView
			return m, nil
		}
	}

	var cmd tea.Cmd
	m.filter, cmd = m.filter.Update(msg)

	// Recompute the filtered view and refresh the table rows on every change.
	m.filtered = store.Filter(m.entries, m.filter.Value())
	m.table.SetRows(rows(m.filtered))

	return m, cmd
}

// openDetail loads the selected entry's pre-rendered report, applies terminal
// ANSI styling with glamour (display-only), loads it into the viewport, and
// switches to detailView. A missing or unreadable report is shown as an error
// in the viewport — it never panics and never blocks the transition.
func (m Model) openDetail() (tea.Model, tea.Cmd) {
	m.state = detailView

	cursor := m.table.Cursor()
	if cursor < 0 || cursor >= len(m.filtered) {
		m.viewport.SetContent("No entry selected.")
		return m, nil
	}
	entry := m.filtered[cursor]

	raw, err := store.ReadReport(m.dir, entry.MD)
	if err != nil {
		m.viewport.SetContent(fmt.Sprintf("Could not read report %q: %v", entry.MD, err))
		return m, nil
	}

	out, rerr := glamour.Render(raw, "auto")
	if rerr != nil {
		// Fall back to the raw (already pre-rendered) markdown if ANSI styling fails.
		out = raw
	}
	m.viewport.SetContent(out)
	m.viewport.GotoTop()
	return m, nil
}

// openCompare loads the selected run's comparison sidecar and switches to
// compareView. It always transitions (never blocks): a missing `compare` field in
// the index (old store) or an unreadable/invalid sidecar sets compareErr, which
// the view renders as a clear message. Radar/sort/rival state is reset per open,
// with the rival defaulting to the sidecar's radar_default second series.
func (m Model) openCompare() (tea.Model, tea.Cmd) {
	m.state = compareView
	m.comparison = nil
	m.compareErr = ""
	m.radarOn = false
	m.sortCol = 0
	m.rivalIdx = 0

	cursor := m.table.Cursor()
	if cursor < 0 || cursor >= len(m.filtered) {
		m.compareErr = "No entry selected."
		return m, nil
	}
	entry := m.filtered[cursor]

	if entry.Compare == nil {
		m.compareErr = "no comparison — run `reindex` to generate"
		return m, nil
	}

	c, err := store.LoadComparison(m.dir, *entry.Compare)
	if err != nil {
		m.compareErr = fmt.Sprintf("could not read comparison %q: %v", *entry.Compare, err)
		return m, nil
	}
	m.comparison = c
	m.rivalIdx = defaultRivalIdx(c)
	return m, nil
}

// defaultRivalIdx returns the index (within eligibleRivals) of the sidecar's
// default radar rival — radar_default.series[1] — or 0 when absent.
func defaultRivalIdx(c *store.Comparison) int {
	if len(c.RadarDefault.Series) < 2 {
		return 0
	}
	rivals := eligibleRivals(c)
	for i, r := range rivals {
		if r.Product == c.RadarDefault.Series[1] {
			return i
		}
	}
	return 0
}

// View implements tea.Model. It renders the component matching the current state.
func (m Model) View() string {
	switch m.state {
	case detailView:
		return m.viewport.View() + "\n" + helpStyle.Render("↑/↓ scroll · c compare · esc back · ctrl+c quit")
	case filterView:
		return m.filter.View() + "\n" + m.table.View() + "\n" +
			helpStyle.Render("type to filter · enter/esc apply · ctrl+c quit")
	case compareView:
		return renderCompare(m)
	default: // listView
		return m.table.View() + "\n" +
			helpStyle.Render("↑/↓ move · enter detail · c compare · / filter · q quit")
	}
}

// resize sizes the table and viewport to the terminal. Kept simple and
// defensive against tiny terminals.
func (m Model) resize(w, h int) Model {
	m.width = w
	m.height = h
	m.ready = true

	tableHeight := h - 4
	if tableHeight < 3 {
		tableHeight = 3
	}
	m.table.SetWidth(w)
	m.table.SetHeight(tableHeight)
	m.table.SetColumns(columns(w))

	vpHeight := h - 2
	if vpHeight < 3 {
		vpHeight = 3
	}
	m.viewport.Width = w
	m.viewport.Height = vpHeight
	return m
}

// columns returns the table columns sized to the given total width. A width of
// 0 (before the first WindowSizeMsg) yields sensible defaults.
func columns(totalWidth int) []table.Column {
	if totalWidth <= 0 {
		return []table.Column{
			{Title: "date", Width: 16},
			{Title: "need", Width: 24},
			{Title: "beneficiary", Width: 12},
			{Title: "outcome", Width: 12},
			{Title: "pick", Width: 18},
			{Title: "confidence", Width: 10},
		}
	}
	// Distribute width: fixed columns get their share, "need" + "pick" flex.
	date, ben, out, conf := 16, 12, 12, 10
	rest := totalWidth - date - ben - out - conf - colGap // borders + inter-column padding
	if rest < 20 {
		rest = 20
	}
	need := rest * 6 / 10
	pick := rest - need
	return []table.Column{
		{Title: "date", Width: date},
		{Title: "need", Width: need},
		{Title: "beneficiary", Width: ben},
		{Title: "outcome", Width: out},
		{Title: "pick", Width: pick},
		{Title: "confidence", Width: conf},
	}
}

// rows converts entries into table rows: date · need · beneficiary · outcome · pick · confidence.
func rows(es []store.Entry) []table.Row {
	out := make([]table.Row, 0, len(es))
	for _, e := range es {
		pick := ""
		if e.Pick != nil {
			pick = *e.Pick
		}
		conf := ""
		if e.Confidence != nil {
			conf = fmt.Sprintf("%.2f", *e.Confidence)
		}
		out = append(out, table.Row{e.Timestamp, e.Need, e.Beneficiary, e.Outcome, pick, conf})
	}
	return out
}
