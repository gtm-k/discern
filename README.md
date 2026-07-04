<div align="center">

# 🛒 Discern

### Find the *genuinely best* product for a specific person — not whatever ranks highest or pays the most commission.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node: ESM](https://img.shields.io/badge/node-ESM-339933.svg?logo=node.js&logoColor=white)](package.json)
[![Go: 1.25](https://img.shields.io/badge/go-1.25-00ADD8.svg?logo=go&logoColor=white)](viewer/go.mod)
[![CI](https://github.com/gtm-k/discern/actions/workflows/ci.yml/badge.svg)](https://github.com/gtm-k/discern/actions/workflows/ci.yml)
[![Release: v0.2.0](https://img.shields.io/badge/release-v0.2.0-blue.svg)](#status--roadmap)
[![Status: v2 · store + viewer](https://img.shields.io/badge/status-v2%20store%20%2B%20viewer-success.svg)](#status--roadmap)

</div>

---

Discern is a cross-platform **agentic-commerce skill** that runs a disciplined human buying method. It harvests
many sources, collapses affiliate/SEO echo into a **single** signal, tears down the fundamentals, applies *your*
preferences and a value-over-price gate, and emits a structured **Recommendation Object** carrying provenance,
per-claim confidence, counterevidence, and an explicit outcome:

> `RECOMMEND` · `RECOMMEND_WITH_CAVEATS` · `INSUFFICIENT_EVIDENCE`

It would rather say *"not enough evidence"* than launder a guess. The method, schemas, and a sequential
web-search/fetch path are a **portable core** that runs in any AI runtime; parallel subagents, browser
automation, and retailer APIs are optional boosters that widen breadth and speed where available — never hard
dependencies.

## The method

```mermaid
flowchart LR
  A["1 · Frame<br/>need + beneficiary"] --> B["2 · Triage<br/>research depth"]
  B --> C["3 · Harvest<br/>many sources"]
  C --> D["4 · Cluster<br/>echo = one signal"]
  D --> E["5 · Teardown<br/>fundamentals"]
  E --> F["6 · Value &<br/>preference filter"]
  F --> G["7 · Price/value<br/>gate (last)"]
  G --> H["8 · Source<br/>best offer"]
  H --> R{{"Recommendation<br/>Object"}}
  R --> S[("Durable store")]
  S --> V["Go TUI viewer"]
```

## Architecture

One **portable Node core** runs the whole method and emits the schema-validated **Recommendation Object** — the
stable contract every later stage consumes. Optional **capability tiers** only *widen* breadth: the run completes on
the baseline tier alone (the *portable-core guarantee*), and any tier it can't positively confirm is treated as absent
(fail-closed). A separate **Go TUI viewer** only *displays* what the core already rendered — no decision logic is
duplicated across the two-toolchain seam.

```mermaid
flowchart TB
  subgraph tiers["Capability tiers · gated boosters, fail-closed"]
    direction LR
    T0["baseline<br/>web search + fetch"]
    T1["subagents"]:::opt
    T2["browser"]:::opt
    T3["retailer API"]:::opt
  end

  subgraph core["Portable Node core · completes on baseline alone"]
    direction LR
    H["harvest"] --> CL["cluster<br/>independence"] --> GR["grid<br/>fundamentals"] --> DC["decide<br/>value → price gate"] --> CP["compare<br/>4 axes"]
  end

  tiers -. "widen breadth, never a crutch" .-> H
  core ==> RO{{"Recommendation Object<br/>schema-validated contract"}}
  RO ==> ST[("Durable store<br/>json · md · compare · index")]
  ST ==> V["Go TUI viewer<br/>lists · reads md · plots sidecar"]
  RO -. "next phases" .-> P2["checkout-prep · agentic purchase"]

  classDef opt stroke-dasharray:4 3;
  class T1,T2,T3 opt;
  classDef future stroke-dasharray:2 2,color:#868e96;
  class P2 future;
```

## Why it's different

Most shopping tools rank by price or star rating and have no taste. Discern encodes a real method:

- **Independence over volume.** Syndicated/affiliate listicles that copy each other count as **one** signal, not
  many — visibility can't masquerade as quality (union-find independence clustering, affiliate down-weighting).
- **Substance over marketing.** A teardown step weighs chips, materials, and genuine value propositions, not spin.
- **Value ≠ price ≠ markup.** Handmade/local *is* value; "good enough" can beat "best." The price gate is applied
  **last**, on value-per-dollar.
- **Hard filters bite, structurally.** A dealbreaker (e.g. *"natural materials only"*, *"must have LDAC"*) marks the
  offending option `DISQUALIFIED — dealbreaker` in the grid and removes it from contention — it can never win on
  fundamentals alone.
- **Explicit, calibrated outcomes.** Every recommendation states an outcome, per-claim/per-offer confidence on a
  0..1 scale, counterevidence, and a failed-source log. Scraped prices are flagged *verify-at-checkout*.
- **You + a gift switch.** A persistent preference profile, with a beneficiary switch (self vs. recipient) that
  swaps the active filters and value framework.

### How that compares

|  | Affiliate listicles | Marketplace star-sort | Generic LLM answer | **Discern** |
|---|---|---|---|---|
| **Ranks by** | commission / SEO | count of ratings | plausible recall | fundamentals, then independent recurrence |
| **Duplicate sources** | counted many times | — | blended silently | collapsed to **one** signal |
| **Dealbreakers** | ignored | filtered, then forgotten | soft-honored | structurally **disqualified** — can't win on merit |
| **Price** | often the whole point | a sort knob | ad hoc | value-per-dollar gate, applied **last** |
| **"Not enough evidence"** | never | never | rarely | a first-class outcome |
| **Shows its work** | no | partial | no | provenance · confidence · counterevidence · failed-source log |

## Quickstart

```bash
git clone https://github.com/gtm-k/discern.git && cd discern

# 1) Node tools + offline gate
npm install
npm test                                   # validates schemas + all golden/eval fixtures

# 2) Build the viewer (Go)
cd viewer && go build -o discern-view . && cd ..
#    (Windows PowerShell/cmd: use `-o discern-view.exe` — extensionless binaries run only from bash-like shells)

# 3) See it immediately on the bundled example run
viewer/discern-view --store store/example  # ↑/↓ navigate · Enter compare grid (Enter again: report) · / filter · q quit

# 4) Run a real recommendation — the engine is an agent *skill*, not a CLI binary. Open this repo in your
#    AI coding agent (e.g. Claude Code) and prompt it:
#    "Follow skills/discern/SKILL.md to recommend <need> for me (profiles/self.md)."
```

> Set up your private profile first: `cp profiles/self.example.md profiles/self.md` and edit it.
> Real profiles and live run history are git-ignored; only `*.example.md` and `store/example/` ship.

## Example output

A real run, rendered (`store/example/`):

```text
# Discern recommendation
**Outcome:** RECOMMEND  ·  **Overall confidence:** high (0.82)

## Pick — Sony WH-1000XM5 by Sony
Recurs across the most independent clusters AND leads on fundamentals (ANC processor, comfort, multipoint).
**Value:** Best value-per-dollar at ~$300 (value-per-dollar: high)

## The grid (ranked by fundamentals, then independent recurrence)
1. Sony WH-1000XM5 by Sony — fundamentals 0.86 · independent clusters 2
   - counterevidence (defect): Non-folding hinge reduces packability [ReviewOutletA]
2. Bose QuietComfort Ultra by Bose — fundamentals 0.82 · independent clusters 1

## Offers (where to buy)
- ExampleStore — 298 USD · provenance: fetch · confidence: moderate (0.60) · ⚠ verify at checkout

## Search universe
Angles swept: roundup, requirement, community   ·   Tiers unavailable: browser, api   ·   Fetches used: 7
```

## The Recommendation Object

The stable contract across every phase (`schemas/recommendation-object.schema.json`). One run object carries:
framed requirements + beneficiary, candidates with per-evidence **provenance** and source-independence clusters,
a fundamentals shortlist, per-claim/per-offer **confidence**, **counterevidence** (incl. typed `recall` /
`dealbreaker`), durable product IDs, a failed-source log, the chosen **pick** + outcome + `reason_code`, and a
`search_universe` (queries, tiers, budgets, **angles swept**). Later phases consume the *same* object to prep
checkout and, eventually, to buy via agentic-commerce rails.

## Durable run store + TUI viewer

Every completed run can be persisted and browsed locally.

- **Writer** (`tools/store.mjs`, Node) — validates the object, renders it via the single renderer
  (`tools/render.mjs`), and writes `store/runs/<id>.{json,md}` plus a navigable `index.json`. It refuses to store
  a malformed object.
- **Viewer** (`viewer/`, Go + [Bubble Tea](https://github.com/charmbracelet/bubbletea)) — a single binary that
  lists, filters, and reads runs. It only *displays* the pre-rendered Markdown (no rendering logic is duplicated in
  Go), and treats a shared/hand-edited store as untrusted (rejects path-escaping report references).
- **Comparison view** (`Enter` or `c` on any run — it opens first; the prose report is `Enter` again from the
  grid) — a scannable heatmap tableau over the *full considered set* on four derived
  axes (fundamentals · consensus · evidence · clean), with an optional pick-vs-rival radar (`r`). Every item removed by
  a dealbreaker stays visible — struck-through with its scores intact and the rule + reason shown — so nothing
  considered is invisible. The Node writer computes it (`tools/compare.mjs`) into a validated `runs/<id>.compare.json`
  sidecar; Go only plots.

The compare view (`c`) over the bundled example run — every considered item on four derived axes, block-bars for
glance-reading, `◄ PICK` / `▲ runner-up` markers (marker + word, never color alone):

```text
Over-ear noise-cancelling headphones for travel and focus
2 considered · 2 eligible · 0 removed

             product                          Fund       Cons       Evid       Clean
◄ PICK       Sony WH-1000XM5 · Sony           .86  ███░  2    ████  .77  ███░  .75  ███░
▲ runner-up  Bose QuietComfort Ultra · Bose   .82  ███░  1    ██░░  .79  ███░  1.00 ████
```

A dealbreaker doesn't merely filter — it **disqualifies structurally**, and the cut stays visible with its scores
intact and the rule + reason shown, so nothing considered is hidden *(illustrative row — the bundled run has none)*:

```text
             product                          Fund       Cons       Evid       Clean
✗ REMOVED    Acme Studio 3 · Acme             .88  ████  3    ████  .80  ███░  .90  ████   [dealbreaker]
      ↳ rule: must support LDAC
      ↳ SBC/AAC only — no LDAC codec
```

```bash
node tools/store.mjs record <rec.json>     # archive a run   ·   reindex rebuilds the index
viewer/discern-view --store store          # browse the live store
```

See [`docs/store.md`](docs/store.md) for the layout, id scheme, and index contract.

## Repository layout

| Path | What |
|------|------|
| `skills/discern/SKILL.md` | The buying method — the portable skill |
| `schemas/` | Recommendation Object · Preference Profile · subagent-output · store-index JSON Schemas (the contracts) |
| `docs/` | `triage`, `definitions`, `data-access`, `render`, `category-widening`, `live-smoke`, `store` — the normative specs |
| `tools/` | Node ESM: `validate`, `cluster`, `grid`, `decision`, `render`, `compare`, `coverage`, `orchestration`, `category-gate`, `store` |
| `agents/` | Capability-gated research subagents (harvester / teardown / sourcing) + their contract |
| `profiles/` | `*.example.md` reference profiles (real profiles are git-ignored) |
| `evals/` | Offline golden fixtures + deliberately-invalid cases that the gate must reject |
| `store/example/` | A tracked seed run so the viewer works out of the box |
| `viewer/` | The Go TUI viewer (own module; single-binary build) |

## Develop

Two toolchains, two gates — both must be green:

```bash
npm test                                    # Node: schemas + fixtures + decision/render logic
cd viewer && go vet ./... && go test ./... && go build ./...   # Go: store parse, filter, model transitions
```

## Status & roadmap

> **Versioning:** semver stays pre-1.0 (`0.x`) until purchasing ships. The `v1` / `v2` milestones below are
> *feature* milestones, not release tags — `v0.2.0` is the current release.

- ✅ **v1 — research & recommend.** The full 8-step method, the Recommendation Object contract, independence
  clustering, the teardown decision engine, value/preference + gift switch, sourcing & rendering, and
  capability-gated orchestration. *No purchasing.*
- ✅ **v2 — durable store + Go TUI viewer + multi-angle harvest coverage.**
- 🔜 **Phase 2 — checkout-prep** and **Phase 3 — agentic purchase**, both consuming the same Recommendation Object.

## Contributing

Issues and PRs welcome. Two rules keep the two-toolchain seam honest:

1. **Both gates green before a PR** — `npm test` and `cd viewer && go vet ./... && go test ./... && go build ./...`.
2. **Branch as `feat/<desc>` or `fix/<desc>`**, and keep decision logic single-sourced in the Node core — the Go
   viewer only *displays*, it never re-derives a score or a disqualification.

Found a security issue? Please don't open a public issue — see [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE).
