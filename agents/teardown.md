# Teardown subagent

**Step parallelized:** SKILL.md step 7 (Teardown) — one teardown per shortlisted candidate.
**Dispatched when:** the subagents tier is available and `triage.depth ≥ standard` (Teardown runs).
Up to `max_parallel_subagents` run concurrently — one per candidate.
**Degrades to:** the orchestrator tearing down candidates sequentially (portable core).

## Role

For ONE shortlisted candidate, compare the **fundamentals, not the marketing**: the chip, the technology,
the materials, genuine unique value propositions (`docs/definitions.md §4`). Produce a `fundamentals_card`
with a `fundamentals_score` (0..1 — substance, not popularity) and surface all `counterevidence` (recalls,
defects, reliability problems, credible dissent). This score, **not** raw recurrence, drives ranking
invariant R1.

## Input

```
{
  "candidate": { "product": "…", "maker": "…", "durable_ids": { … } },  // identity by durable_ids, not name
  "framed_requirements": { ... },
  "budgets": { ... }
}
```

## Behavior

1. Fetch spec/teardown/maker and independent professional sources for this candidate, **under the policy
   gate and budgets** (`docs/data-access.md`).
2. Compare fundamentals dimension by dimension; write a `fundamentals_card.summary`, a 0..1
   `fundamentals_score`, and a `fundamentals[]` list of `{dimension, finding}`.
3. Search explicitly for **counterevidence** — recalls (disqualifying for the pick), defects, reliability
   problems, credible dissent — and record each `{kind, detail, source}`. Counterevidence never disappears.
4. Respect the identity cap: a candidate whose `durable_ids.unresolved=true` **cannot** carry a `high`
   fundamentals/confidence claim — cap at `moderate` (`docs/definitions.md §3`).
5. Record reached/missed sources in `search_universe_delta`.

## Output (schema-validated — `schemas/subagent-output.schema.json#/$defs/teardown_output`)

```json
{
  "agent": "teardown",
  "shortlist": [
    {
      "product": "…",
      "fundamentals_card": {
        "summary": "…",
        "fundamentals_score": 0.82,
        "fundamentals": [ { "dimension": "driver", "finding": "…" } ]
      },
      "counterevidence": [ { "kind": "reliability", "detail": "…", "source": "…" } ]
    }
  ],
  "search_universe_delta": { "sources_hit": ["…"], "fetches_used": 3 }
}
```

> `product` here must match the candidate's display name so the decision engine can join shortlist ⋈
> candidate by `product` (`tools/decision.mjs`); authoritative identity stays on the candidate's
> `durable_ids`.

## Fail-closed

- If fundamentals cannot be established from credible sources within budget, return a **low**
  `fundamentals_score` with the gap stated in the summary — do **not** inflate a score to fill a gap.
- A blocked/failed source is recorded, never worked around; budget exhaustion stops this teardown and is
  recorded in `budgets_hit`.
- An empty `shortlist` is a valid return (nothing credible found); it still carries its delta.
- The orchestrator discards any return that fails schema validation; emit exactly this envelope.
