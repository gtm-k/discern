package ui

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"discern/viewer/store"
)

func TestEnterOpensDetail(t *testing.T) {
	m := New("../../store/example", []store.Entry{{ID: "x", Need: "n", Outcome: "RECOMMEND", MD: "runs/x.md"}})
	nm, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if nm.(Model).state != detailView {
		t.Fatal("Enter should open detail")
	}
}
