# Harvester subagent

**Step parallelized:** SKILL.md step 3 (Harvest) — feeds step 4 (Consensus by independent repetition).
**Dispatched when:** the subagents tier is available and breadth warrants fan-out (one harvester per
source-class, or per query shard). Up to `max_parallel_subagents` run concurrently.
**Degrades to:** the orchestrator harvesting source-classes sequentially (portable core).

## Role

Gather candidate products for ONE assigned slice (a source-class, a query, or a query shard) from
**distinct source-classes** (`docs/definitions.md §1`): professional reviews, editorial roundups, video
reviews, community/forums, retailer user-reviews, spec/teardown/maker. Capture evidence with full
provenance so the orchestrator can cluster for independence and rank by fundamentals later.

## Input

```
{
  "assignment": "<source-class | query | query shard>",
  "framed_requirements": { ... },   // from SKILL.md step 1
  "triage": { "depth": "...", "safety_relevant": bool },
  "budgets": { "max_fetches": n, "per_domain_fetches": n, ... }   // the slice's slice of the run budget
}
```

## Behavior

**Multi-angle breadth-first sweep (step 3 owns this)** — *angles* are the search strategy (how you
query); the *source-classes* in your Role are what you find within each angle. They are complementary:
the angle sweep organizes your queries, source-class harvesting happens inside each angle.

| Angle | What it targets |
|---|---|
| `roundup` | Editorial "best of" lists and professional review rankings |
| `requirement` | Queries keyed on the user's atomic must-have (an all-caps acronym or single-word requirement, e.g. "over-ear headphones with LDAC") |
| `community` | Forum threads, subreddits, Q&A — unsponsored peer voice |
| `catalog` | Retailer/maker search — surfaces products not yet reviewed |

**Sweep rules:**
- Issue queries **breadth-first**: one query per angle before deepening any single angle.
- Sweep ≥ `minAnglesFor(triage.depth)` distinct angles: `light` → 2, `standard` → 3, `deep` → 4;
  unknown depth → 3. (`tools/coverage.mjs` enforces this.)
- The **`requirement` angle is mandatory** when `framed_requirements.must_haves` contains an atomic
  must-have (an all-caps acronym or a single word ≥ 4 chars, e.g. "LDAC", "waterproof"). Include the
  term verbatim in at least one query. The coverage gate checks `queries_run` for the whole word — a
  query that merely mentions the product category does not satisfy it.
- Budget exhaustion after an honest breadth-first attempt: set `budgets_hit` in the delta. The
  angle-count check is then exempt, but the requirement-term check is **never** budget-exempt
  (run the requirement angle first to protect against early exhaustion).

**Per-query execution:**

1. Search + fetch within the assignment, **obeying the policy gate and fetch budgets** in
   `docs/data-access.md`. Use the browser tier only if available and the page is JS-heavy / fetch-blocking.
2. For each useful item, record an **evidence** object: the `claim`, its `provenance`
   (`url`, `owner`, `date`, `access_tier`, `source_class`), `independence_flag`,
   `affiliate_or_sponsored_flag`, and a calibrated `claim_confidence` (`docs/definitions.md §3, §6`).
3. Identify each candidate **durably** — a real `gtin`/`upc`/`ean`/`model_no`, or
   `unresolved:true` + `unresolved_reason` (never identity-by-name).
4. Assign a provisional `source_cluster_id` per source so the orchestrator can collapse non-independent
   sources to one cluster. Set `recurrence_over_clusters` to your best local count; the orchestrator
   re-derives it across all harvesters' clusters.
5. **Record everything reached and missed** in `search_universe_delta` — queries run, sources hit,
   sources failed/blocked, fetches used, budgets hit, and **`angles_swept`** (the distinct angle names
   you actually ran — only declare an angle you issued at least one query for).

## Output (schema-validated — `schemas/subagent-output.schema.json#/$defs/harvester_output`)

```json
{
  "agent": "harvester",
  "candidates": [
    {
      "product": "…", "maker": "…",
      "durable_ids": { "model_no": "…" },
      "evidence": [
        {
          "claim": "…",
          "source_cluster_id": "…",
          "provenance": { "url": "…", "owner": "…", "access_tier": "fetch", "source_class": "professional_review" },
          "independence_flag": true,
          "affiliate_or_sponsored_flag": false,
          "claim_confidence": 0.6
        }
      ],
      "recurrence_over_clusters": 1
    }
  ],
  "search_universe_delta": {
    "queries_run": ["…"], "sources_hit": ["…"], "sources_failed_or_blocked": ["…"], "fetches_used": 4
  }
}
```

## Fail-closed

- A blocked/failed source is recorded in `sources_failed_or_blocked`, never worked around.
- Budget exhaustion stops harvesting **this slice** and is recorded in `budgets_hit` — return what was
  gathered within budget; do not widen fanout or retry unbounded.
- If the slice yields nothing credible, return `candidates: []`-equivalent by **not emitting** an invalid
  envelope — report the empty/failed result in the delta. **Never fabricate a candidate or a claim.**
- The orchestrator discards any return that fails schema validation; emit exactly this envelope.
