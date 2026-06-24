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
)

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
		m.resize(ws.Width, ws.Height)
		return m, nil
	}

	switch m.state {
	case listView:
		return m.updateList(msg)
	case detailView:
		return m.updateDetail(msg)
	case filterView:
		return m.updateFilter(msg)
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
		}
	}
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

	out, rerr := glamour.Render(raw, "auto")
	if rerr != nil {
		// Fall back to the raw (already pre-rendered) markdown if ANSI styling fails.
		out = raw
	}
	m.viewport.SetContent(out)
	m.viewport.GotoTop()
	return m, nil
}

// View implements tea.Model. It renders the component matching the current state.
func (m Model) View() string {
	switch m.state {
	case detailView:
		return m.viewport.View() + "\n" + helpStyle.Render("↑/↓ scroll · esc back · ctrl+c quit")
	case filterView:
		return m.filter.View() + "\n" + m.table.View() + "\n" +
			helpStyle.Render("type to filter · enter/esc apply · ctrl+c quit")
	default: // listView
		return m.table.View() + "\n" +
			helpStyle.Render("↑/↓ move · enter detail · / filter · q quit")
	}
}

// resize sizes the table and viewport to the terminal. Kept simple and
// defensive against tiny terminals.
func (m *Model) resize(w, h int) {
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
			{Title: "conf", Width: 6},
		}
	}
	// Distribute width: fixed columns get their share, "need" + "pick" flex.
	date, ben, out, conf := 16, 12, 12, 6
	rest := totalWidth - date - ben - out - conf - 7 // padding/borders fudge
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
		{Title: "conf", Width: conf},
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
