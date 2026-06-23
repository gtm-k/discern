# Discern subagents — capability-gated enhancement tier

These are **optional** subagents the skill orchestrator may fan out to *when the runtime supports
subagents* (capability detection in `docs/data-access.md`). They exist to **widen breadth and add
parallelism**, never to become load-bearing: the full buying method completes with subagents, browser,
AND API tiers all disabled — the **portable-core guarantee** (`SKILL.md` steps 3–12 run sequentially).

| Subagent | Replaces / parallelizes | Returns (envelope) |
|----------|-------------------------|--------------------|
| [`harvester.md`](harvester.md) | step 3 Harvest + step 4 clustering inputs | `harvester_output` — `candidates[]` |
| [`teardown.md`](teardown.md) | step 7 Teardown | `teardown_output` — `shortlist[]` |
| [`sourcing.md`](sourcing.md) | step 11 Sourcing | `sourcing_output` — `offers[]` |

## How the orchestrator uses them (the contract)

1. **Capability detect.** `detectTiers(capabilities)` (`tools/orchestration.mjs`) reports which tiers are
   usable. Subagents/browser/API are OFF unless explicitly available (fail-closed). Every unavailable tier
   is recorded in `search_universe.tiers_unavailable` — absence narrows breadth observably, never silently.
2. **Fan out under a budget.** When the subagents tier is available, dispatch up to
   `max_parallel_subagents` (default **6**) concurrently. The cap bounds one wave; **excess is not
   widened** — it is denied and recorded in `search_universe.budgets_hit` (governor in
   `tools/orchestration.mjs`). When subagents are unavailable, the orchestrator runs the same steps
   **sequentially** (degraded core) — the run still completes.
3. **Validate every return at the boundary.** Subagent output is untrusted (LLM-produced). The orchestrator
   runs `validateSubagentResult(kind, payload)` against
   `schemas/subagent-output.schema.json` (which `$ref`s the recommendation-object `$defs`, so the subagent
   contract and the final-object contract are one source of truth). **Invalid output is discarded and
   recorded — never trusted, never fabricated around.**
4. **Fold deltas honestly.** Each subagent returns a `search_universe_delta` (queries it ran, sources it
   hit, sources it failed/was blocked on, fetches it used, budgets it hit). The orchestrator merges these
   into the run's `search_universe` so the counters stay truthful end-to-end.
5. **Fail closed on access.** If no tier is usable, or budgets are exhausted before any credible evidence,
   the run returns `outcome=INSUFFICIENT_EVIDENCE` with `reason_code=INSUFFICIENT_ACCESS` — never a
   fabricated pick.

## Rules every subagent inherits (non-negotiable)

- **Policy gate (`docs/data-access.md`).** Respect `robots.txt`; never bypass bot defenses, CAPTCHAs, or
  login/paywalls; identify honestly; a blocked source is *recorded*, never worked around.
- **Budgets (`docs/data-access.md`).** Obey the core fetch budgets (per-run `max_fetches`, per-domain,
  timeout, retries) and the enhancement-tier budgets (`max_parallel_subagents`, per-API). Budget
  exhaustion **stops that branch and records it** — never widen fanout or retry unbounded.
- **Schema-valid output only.** Return exactly the envelope in your spec. Anything else is discarded by the
  orchestrator (fail-closed).
- **Never fabricate.** Thin or unreachable evidence is reported as such (empty result + recorded
  failure/blocked/budget), not filled with a guess. The decision engine, not a subagent, decides the
  outcome.
- **Stay in your lane.** A subagent does one step; it does not re-rank, re-decide, or render. Identity is
  carried on `durable_ids` (never identity-by-name).
