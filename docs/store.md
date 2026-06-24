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

The `.md` file is produced by `tools/render.mjs` at write time. The Go viewer reads and displays it as-is;
there is no rendering in Go. `tools/render.mjs` is the single renderer.

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
writing; it refuses invalid input. Both commands validate the resulting index against
`schemas/store-index.schema.json` before writing.

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

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate the run list |
| `Enter` | Open the selected run (view report) |
| `Esc` | Back to the list |
| `/` | Filter runs |
| `q` | Quit |
