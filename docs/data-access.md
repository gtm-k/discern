# Data access — baseline protocol (portable core)

This file defines the **portable-core** data tier and the policy + budget rules that ALL fetching obeys,
from Phase 2 onward. Phase 5 extends this same protocol to the enhancement tiers (subagents, browser,
APIs); it does not replace it. Establishing the rules here — before any fetch path exists — is deliberate:
the core must never run ahead of its own containment.

## Tiers (capability-detected, graceful degradation)

| Tier | Mechanism | Availability | Use |
|------|-----------|--------------|-----|
| **Baseline** (this doc) | web **search** + page **fetch** | every runtime | always on; the portability guarantee |
| Booster (Phase 5) | browser automation | some runtimes | JS-heavy / fetch-blocking pages, fresher prices |
| Premium (Phase 5) | retailer / price APIs | if configured | authoritative live pricing |

The agent uses the best available tier per task and records which tier produced each datum
(`provenance.access_tier`, `offer.provenance_tier`). Absence of a higher tier never breaks a run; it only
narrows breadth, which is recorded in `search_universe.tiers_unavailable`.

## Policy gate (applies to every tier)

- **Respect `robots.txt`** and crawl directives.
- **Never bypass bot defenses, CAPTCHAs, or login/paywalls.** No credential stuffing, no session hijacking.
- **Identify honestly**; do not spoof to evade blocks.
- A blocked source is *recorded* (`search_universe.sources_failed_or_blocked`), never worked around.

## Core fetch governance (fail-closed)

Defaults (tunable); when any budget is exhausted the run **stops that branch and records it** — it never
silently widens fanout or retries unbounded:

| Budget | Default | Behavior on exhaustion |
|--------|---------|------------------------|
| `max_fetches` (per run) | 40 | stop harvesting; proceed with what's gathered; log `budgets_hit` |
| per-domain fetch budget | 5 | stop fetching that domain; log |
| per-fetch `timeout` | 15 s | abandon that fetch; record as failed |
| `max_retries` | 2 (exp. backoff) | give up the fetch; record as failed |

`search_universe` counters (`queries_run`, `fetches_used`, `sources_hit`, `sources_failed_or_blocked`,
`tiers_unavailable`, `budgets_hit`) are populated every run and surfaced in the report.

## Insufficient access

If no usable tier is available, or budgets are exhausted before any credible evidence is gathered, the run
returns `outcome = INSUFFICIENT_EVIDENCE` with `reason_code = INSUFFICIENT_ACCESS`. Discern never fabricates
a recommendation to fill a data gap.

## "All available" — honesty

Discern never claims to have searched everything. The honest scope is "everything reachable via the
available tiers within budget," and that scope is exactly what `search_universe` reports.
