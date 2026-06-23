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

---

# Enhancement tiers (Phase 5) — capability-gated, additive to the baseline

The baseline above is the portable core. The enhancement tiers below **widen breadth and add
parallelism** but are never load-bearing: the full method completes with all of them disabled (the
**portable-core guarantee**). They obey the **same policy gate** and extend (do not replace) the same
fail-closed budget model. The reference implementation of this section's rules is
`tools/orchestration.mjs`; the subagents are specified in `agents/`.

## Capability detection (fail-closed)

`detectTiers(capabilities)` reports which tiers are usable for a run:

| Tier | Mechanism | Default | Detected by |
|------|-----------|---------|-------------|
| **baseline** | web search + page fetch | ON (portability guarantee) | always, unless explicitly absent |
| **subagents** | parallel sub-agent fan-out | OFF unless available | runtime exposes a subagent/Task capability |
| **browser** | browser automation | OFF unless available | runtime exposes a browser tool |
| **api** | retailer / price APIs | OFF unless configured | API credentials/endpoint present |

A tier is treated as **available only when positively detected** — an undetectable or uncertain tier is
treated as absent (fail-closed), never assumed present. **Every unavailable tier is recorded in
`search_universe.tiers_unavailable`**, so a narrowed run is observable, never a silent gap. If *no* tier is
usable, the run returns `INSUFFICIENT_EVIDENCE` / `reason_code=INSUFFICIENT_ACCESS` (below).

## The browser tier

Use browser automation only for **JS-heavy or fetch-blocking pages** where the baseline fetch cannot read
the content, or to read a fresher price. It is **bound by the same policy gate** — robots.txt, no
bot-defense/CAPTCHA/login-wall bypass, honest identification — and the same per-domain / per-run fetch
budgets. A browser-sourced datum is tagged `access_tier: "browser"` and, for an offer, is a **scraped**
price (`verify_at_checkout=true`, capped at moderate confidence — `docs/definitions.md §7`).

## The API tier

Retailer / price APIs are the **only authoritative pricing tier** (`provenance_tier: "api"` — the only tier
that may reach the high offer-confidence band). Available only when configured. Bound by the **per-API call
budget** (below) and the same honesty rules — an API outage degrades to browser/fetch, recorded in
`tiers_unavailable`, never faked.

## Enhancement-tier resource governance (fail-closed) — additive to the core budgets

| Budget | Default | Behavior on exhaustion |
|--------|---------|------------------------|
| `max_parallel_subagents` | 6 | cap the concurrent wave; **excess is not dispatched** (never widen fanout); log `budgets_hit` |
| `per_api_calls` (per run) | 20 | stop calling the API tier; proceed with what's gathered; log `budgets_hit` |

These compose with the Phase 1 core budgets (`max_fetches`, per-domain, timeout, retries). The rule is
uniform across all budgets: **exhaustion stops that branch and records it — Discern never widens fanout or
retries unbounded to get around a budget.** A stopped branch is *not* the same as insufficient access: the
run still completes with whatever was gathered within budget, unless *no* credible evidence was reached.

## Subagent output validation (the contract boundary)

Subagent output is **untrusted** (LLM-produced). The orchestrator validates every return against
`schemas/subagent-output.schema.json` (which `$ref`s the recommendation-object `$defs`, so the subagent
contract and the final-object contract are **one source of truth**, no drift). **A return that fails
validation is discarded and recorded — never trusted, never fabricated around.** Each subagent also returns
a `search_universe_delta` that the orchestrator folds into the run's counters, so breadth and failures stay
honest end-to-end. An *empty* return (e.g. a harvester that found nothing) is valid and still carries its
delta — so the orchestrator sees *why* breadth narrowed.

## Orchestration & degradation

- **When subagents are available:** fan out (harvester per source-class, teardown per candidate, sourcing
  per pick/merchant) up to `max_parallel_subagents`; validate and fold each return.
- **When subagents are unavailable:** run the same steps **sequentially** — the Phase 1–4 portable core.
  The run completes either way; the only difference is breadth/latency, recorded in `tiers_unavailable`.

## Insufficient access (enhancement-tier extension)

The Phase 1 rule stands and is extended: the run returns `outcome=INSUFFICIENT_EVIDENCE` with
`reason_code=INSUFFICIENT_ACCESS` when **no tier is usable**, OR when **budgets are exhausted before any
credible evidence** is gathered. A budget hit *with* evidence gathered elsewhere is a stopped branch, not
insufficient access. Discern never fabricates a pick to fill a data gap.
