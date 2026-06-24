// Command discern-view is the single-binary terminal viewer for Discern run history.
// It loads a store directory and launches an interactive bubbletea UI.
//
// Usage:
//
//	discern-view [--store <dir>]
//
// Flags:
//
//	--store   path to the store directory (default: ./store)
package main

import (
	"flag"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"

	"discern/viewer/store"
	"discern/viewer/ui"
)

func main() {
	dir := flag.String("store", "./store", "path to the store directory")
	flag.Parse()

	entries, err := store.Load(*dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "discern-view: failed to load store %q: %v\n", *dir, err)
		os.Exit(1)
	}

	if len(entries) == 0 {
		fmt.Printf("No runs found in %s. Record one with:\n  node tools/store.mjs record <rec.json>\n", *dir)
		os.Exit(0)
	}

	p := tea.NewProgram(ui.New(*dir, entries), tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "discern-view: UI error: %v\n", err)
		os.Exit(1)
	}
}
