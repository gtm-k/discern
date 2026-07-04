# Durable run store

Every completed Discern run can be persisted to `store/` — a flat JSON store plus pre-rendered Markdown
reports. `tools/store.mjs` is the only write path. The Go viewer (`viewer/`) reads and displays runs
interactively.

## Store layout

```
store/
  runs/
    <id>.json   ← Recommendation Object (full structured data)
    <id>.md     ← pre-rendered Markdown report (produced by tools/render.mjs)
  index.json    ← flat array of index entries; one per run (see contract below)
  example/      ← tracked seed run; safe to commit
    runs/...
    index.json
```

- `store/runs/` — private, gitignored. Each run has two files: the raw Recommendation Object and the
  pre-rendered report.
- `store/index.json` — private, gitignored. Navigation index; rebuilt from runs on demand.
- `store/example/` — tracked. Ships with the repo as a seed so the viewer can be exercised without a
  live run.

## The `id` scheme

Run IDs have the form `<YYYYMMDDTHHMMSSZ>-<slug>`:

- **Timestamp** — the current UTC time at record time, with separators stripped:
  `20260623T143000Z`.
- **Slug** — derived from `framed_requirements.need`; falls back to `candidates[0].category_taxonomy`,
  then `"run"`. The slug is lowercased, non-alphanumeric runs replaced by `-`, leading/trailing dashes
  stripped, and truncated to 40 characters.
- **Collision suffix** — if `<id>.json` already exists, the id becomes `<base>-2`, `<base>-3`, etc.

Example: `20260623T100000Z-over-ear-noise-cancelling-headphones-for`

IDs are deterministic given the same input and timestamp, and sort chronologically as plain strings.

## Index-entry contract

The index is a JSON array conforming to [`schemas/store-index.schema.json`](../schemas/store-index.schema.json).
Each entry has the following fields:

| Field | Required | Description |
|---|---|---|
| `id` | yes | Run ID (the `<ts>-<slug>` string) |
| `timestamp` | yes | ISO 8601 UTC timestamp of the run |
| `need` | yes | The framed need string |
| `category_taxonomy` | no | Leaf category from the first candidate |
| `beneficiary_type` | yes | `"self"` or `"recipient"` |
| `outcome` | yes | `RECOMMEND`, `RECOMMEND_WITH_CAVEATS`, or `INSUFFICIENT_EVIDENCE` |
| `reason_code` | no | Populated when `outcome` is not `RECOMMEND` |
| `pick` | no | The picked product name, or `null` |
| `confidence_overall` | no | Overall confidence score (0..1), or `null` |
| `json` | yes | Relative path to the run JSON (`runs/<id>.json`) |
| `md` | yes | Relative path to the pre-rendered report (`runs/<id>.md`) |
| `compare` | no | Relative path to the comparison sidecar (`runs/<id>.compare.json`); absent on stores written before the sidecar existed |

The `.md` file is produced by `tools/render.mjs` at write time. The Go viewer reads and displays it as-is;
there is no rendering in Go. `tools/render.mjs` is the single renderer.

`json`, `md`, and `compare` are always `runs/<id>.{json,md,compare.json}` relative paths (enforced by the
schema's `pattern`). The viewer treats these as untrusted on a shared or hand-edited store: it rejects any
path that is absolute or escapes the store directory, so a tampered index cannot make the viewer read files
outside `store/`. `compare` is optional for back-compat — an old store without it still validates, and the
viewer shows "no comparison — run `reindex` to generate" for that run.

## Comparison sidecar — `runs/<id>.compare.json`

Alongside each run the writer persists a **comparison sidecar**, a derived view artifact governed by
[`schemas/store-compare.schema.json`](../schemas/store-compare.schema.json). It is computed by
`tools/compare.mjs` (`buildComparison(rec)`, a pure function) and validated fail-closed before it is
written — exactly like the Recommendation Object and the index. It is **not** a change to the recommendation
contract (`schemas/recommendation-object.schema.json` is untouched); it is a scannable projection of data
already in the run.

The sidecar drives the viewer's **comparison view** — a dense heatmap tableau (plus an optional radar) over
the full considered set. Its shape:

```json
{
  "id": "<run id>",
  "need": "…",
  "axes": ["fundamentals", "consensus", "evidence", "clean"],
  "dealbreaker_rules": ["… the run's hard-filter rules …"],
  "counts": { "considered": 4, "eligible": 3, "removed": 1 },
  "radar_default": { "series": ["<pick>", "<top rival>"] },
  "items": [ { "product": "…", "maker": "…", "status": "pick",
              "disqualified_reason": null, "dealbreaker_rule": null,
              "durable_unresolved": false,
              "scores": { "fundamentals": 0.82, "consensus_raw": 3,
                          "consensus_norm": 1.0, "evidence": 0.71, "clean": 0.9 } } ]
}
```

**The four axes** (all derived from today's data; no per-feature scores yet):

| Axis | Source | Honesty rule |
|---|---|---|
| **Fundamentals** | `shortlist[].fundamentals_card.fundamentals_score` | `null` (shown `—`) when not shortlisted — never `0` |
| **Consensus** | `candidates[].recurrence_over_clusters` (raw count) | `consensus_norm` = raw ÷ max over the **eligible** set; `null` for removed items |
| **Evidence** | mean of `candidates[].evidence[].claim_confidence` | always present (schema requires ≥1 evidence) |
| **Clean** | `1 − Σ penalty(counterevidence)` clamped 0..1 | penalty ordering `recall > defect ≈ reliability > dissent > other`; a `dealbreaker` does **not** penalize — it disqualifies; `null` when removed or not shortlisted |

**Observability (normative):** every `candidates[]` entry is listed — eligible *and* removed. A removed
item stays visible (struck-through, **scores intact**), tagged with the specific `dealbreaker_rule` and the
reason `detail`, so a hard filter reads as "removed by rule, regardless of merit." The `dealbreaker_rules`
legend and an `N considered · M eligible · K removed` completeness line are always shown. `status` is one of
`pick | runner_up | eligible | not_shortlisted | disqualified`.

`reindex` recomputes **all derived artifacts from the source `.json`** — the `.md` report, the
`.compare.json` sidecar, and `index.json` — so a `render.mjs` or `compare.mjs` change propagates to existing
runs (and pre-sidecar runs gain a comparison) with no agent re-run.

## Privacy / gitignore

```
store/runs/        ← gitignored (private runs)
store/index.json   ← gitignored (private index)
store/example/     ← tracked (seed, safe to commit)
viewer/discern-view         ← gitignored (built binary, Unix)
viewer/discern-view.exe     ← gitignored (built binary, Windows)
```

Live runs are private by default. Only `store/example/` ships with the repo.

## Write pipeline

### Automatic (after a Discern run)

Step 13 of the skill (`skills/discern/SKILL.md`) calls `recordRun(rec)` after producing the
Recommendation Object. This step is **capability-gated**: it only runs if Node.js and `tools/store.mjs`
are available. It is also **fail-soft**: if the write fails, the recommendation is still delivered; the
failure is noted in the run summary rather than blocking the result. The skill never silently skips
archiving without saying so.

### Manual

```bash
# Record a single run from a Recommendation Object JSON file:
node tools/store.mjs record <rec.json>

# Rebuild index.json from all .json files in store/runs/ (e.g. after manual edits):
node tools/store.mjs reindex
```

`record` validates the Recommendation Object against `schemas/recommendation-object.schema.json` before
writing; it refuses invalid input. `record` also validates the assembled index **before** any file is
written, so a validation failure never leaves orphaned run artifacts behind. `reindex` validates every
`runs/*.json` against the rec schema and fails (naming the offending file) rather than indexing a malformed
run. Both commands validate the resulting index against `schemas/store-index.schema.json` before writing.
The `node tools/store.mjs` CLI always operates on the repo-root `store/`, regardless of the current
working directory.

## Running the viewer

```bash
cd viewer
go build -o discern-view .
./discern-view --store ../store/example   # seed data
./discern-view --store ../store           # live store
```

The viewer is a single Go binary built from `viewer/`. The `--store` flag points at the store directory
(default: `./store`). If the store is empty, it prints a hint and exits cleanly instead of launching the
UI.

### Keys

| State | Key | Action |
|---|---|---|
| List | `↑` / `↓` | Navigate runs |
| List | `Enter` | Open selected run (view report) |
| List | `c` | Open the comparison view for the selected run |
| List | `/` | Enter filter |
| List | `q` or `Ctrl+C` | Quit |
| Detail | `↑` / `↓` | Scroll report |
| Detail | `c` | Open the comparison view for this run |
| Detail | `Esc` or `q` | Back to list |
| Detail | `Ctrl+C` | Quit |
| Compare | `1`–`4` | Sort by axis (Fundamentals / Consensus / Evidence / Clean); removed rows always sink to the bottom |
| Compare | `r` | Toggle the radar (pick vs. top rival); disabled when fewer than 2 eligible series |
| Compare | `tab` | Cycle the radar's rival series |
| Compare | `Enter` | Open the full prose report for this run |
| Compare | `Esc` or `q` | Back to list |
| Compare | `Ctrl+C` | Quit |
| Filter | `type` | Edit filter query |
| Filter | `Enter` or `Esc` | Apply filter and return to list |
| Filter | `Ctrl+C` | Quit |
