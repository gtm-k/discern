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
		case "enter", "c":
			// Enter opens the comparison GRID first (the scannable overview); the
			// prose report is reached from the grid via Enter.
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
			// Drill back to the comparison grid we came in from. The shared viewport
			// currently holds the prose report, so re-render the grid into it. If no
			// grid is loaded (defensive), fall back to the list.
			if m.comparison != nil {
				m.state = compareView
				m.viewport.SetContent(renderCompare(m))
				m.viewport.GotoTop()
				return m, nil
			}
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
// open the full prose report for the same run, `q`/`esc` back to the list. Any other
// key (↑/↓, pgup/pgdn, home/end, j/k) SCROLLS the content through the viewport, so
// removed rows sorted to the bottom of a large run stay reachable. State-changing keys
// re-render the viewport content. None panic on a degenerate comparison.
func (m Model) updateCompare(msg tea.Msg) (tea.Model, tea.Cmd) {
	key, ok := msg.(tea.KeyMsg)
	if !ok {
		// Non-key messages (e.g. mouse wheel) drive the viewport scroll.
		var cmd tea.Cmd
		m.viewport, cmd = m.viewport.Update(msg)
		return m, cmd
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
			m.viewport.SetContent(renderCompare(m))
			m.viewport.GotoTop()
		}
		return m, nil
	case "tab":
		if m.comparison != nil {
			if n := len(eligibleRivals(m.comparison)); n > 0 {
				m.rivalIdx = (m.rivalIdx + 1) % n
				m.viewport.SetContent(renderCompare(m))
			}
		}
		return m, nil
	case "1", "2", "3", "4":
		m.sortCol = int(key.String()[0] - '0')
		m.viewport.SetContent(renderCompare(m))
		return m, nil
	}
	// Everything else scrolls the content (keeps bottom-sorted removed rows reachable).
	var cmd tea.Cmd
	m.viewport, cmd = m.viewport.Update(msg)
	return m, cmd
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

	m.viewport.SetContent(renderMarkdown(raw, m.width))
	m.viewport.GotoTop()
	return m, nil
}

// renderMarkdown applies glamour's theme-aware ANSI styling to the pre-rendered report
// markdown (display-only — no report content is authored here, preserving render.mjs as the
// single renderer), word-wrapped to the terminal width so long lines read naturally instead
// of glamour's default 80-column wrap. Falls back to the raw markdown if styling fails.
func renderMarkdown(raw string, width int) string {
	w := width - 2 // small right margin
	if w < 40 {
		w = 80
	}
	if w > 120 {
		w = 120
	}
	r, err := glamour.NewTermRenderer(glamour.WithAutoStyle(), glamour.WithWordWrap(w))
	if err != nil {
		return raw
	}
	out, err := r.Render(raw)
	if err != nil {
		return raw
	}
	return out
}

// openCompare loads the selected run's comparison sidecar and switches to
// compareView. It always transitions (never blocks): a missing `compare` field in
// the index (old store), an unreadable/invalid sidecar, or a sidecar whose id does
// not match the selected run sets compareErr, which the view renders as a clear
// message. Radar/sort/rival state is reset per open, with the rival defaulting to
// the sidecar's radar_default second series.
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
	// Bind the sidecar to the selected run: a stale or hand-edited index could point
	// this entry at another run's (individually valid) sidecar, which would render B's
	// data as A. The internal sidecar validation can't see this cross-file mismatch.
	if c.ID != entry.ID {
		m.compareErr = fmt.Sprintf("comparison %q is for run %q, not %q (stale or corrupt index)", *entry.Compare, c.ID, entry.ID)
		return m, nil
	}
	m.comparison = c
	m.rivalIdx = defaultRivalIdx(c)
	// Render into the (scrollable) viewport so a run with more rows than the terminal
	// height keeps its removed rows reachable rather than clipped off-screen.
	m.viewport.SetContent(renderCompare(m))
	m.viewport.GotoTop()
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
		return m.viewport.View() + "\n" + helpStyle.Render("↑/↓ scroll · esc back to grid · ctrl+c quit")
	case filterView:
		return m.filter.View() + "\n" + m.table.View() + "\n" +
			helpStyle.Render("type to filter · enter/esc apply · ctrl+c quit")
	case compareView:
		if m.comparison == nil {
			// Error / missing / mismatch — a short message; no scrolling needed.
			return renderCompare(m) + "\n" + helpStyle.Render("q/esc back · ctrl+c quit")
		}
		return m.viewport.View() + "\n" + helpStyle.Render(compareHelp(m))
	default: // listView
		return m.table.View() + "\n" +
			helpStyle.Render("↑/↓ move · enter compare · / filter · q quit")
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
