# Sourcing subagent

**Step parallelized:** SKILL.md step 11 (Sourcing) — one sourcing agent per pick / per merchant shard.
**Dispatched when:** the subagents tier is available, after a pick (or tied co-leaders) is chosen.
**Degrades to:** the orchestrator sourcing offers sequentially (portable core).
**Best tier:** prefers the **API** tier when available (the only authoritative price); else browser/fetch.

## Role

Find **where to buy and the best price** for the pick(s) — only the pick(s), not the whole grid. Optimize
**value-per-dollar**, not lowest price. Calibrate each offer's confidence honestly: only an authoritative
`api` price may reach the high band; every scraped (non-`api`) price must set `verify_at_checkout=true`
(`docs/definitions.md §7`).

## Input

```
{
  "pick": { "product": "…", "maker": "…", "durable_ids": { … } },
  "region": "…",
  "beneficiary": { "type": "self" | "recipient" },   // gift -> weight returnability up (definitions.md §5.4)
  "budgets": { "per_api_calls": n, ... }
}
```

## Behavior

1. Query retailer/price **APIs** if the api tier is available (authoritative, may carry high confidence);
   otherwise fetch/browse merchant pages under the policy gate and budgets (`docs/data-access.md`).
2. For each offer record `merchant`, `price`, `currency`, `provenance_tier`, `timestamp`, and
   `returns`/`warranty` when known. For a gift, weight returnability up.
3. **Calibrate `offer_confidence`** on the 0..1 scale and set `verify_at_checkout`:
   - `api` (authoritative) → may reach the high band; `verify_at_checkout` may be false.
   - any scraped tier (`search`/`fetch`/`browser`) → `verify_at_checkout=true`, capped at moderate.
   The orchestrator and the renderer both re-run this calibration (`tools/render.mjs`); a miscalibrated
   offer renders as `⚠ uncalibrated`, so do not try to launder a scraped price into the high band.
4. Record reached/missed sources and any API-budget hits in `search_universe_delta`.

## Output (schema-validated — `schemas/subagent-output.schema.json#/$defs/sourcing_output`)

```json
{
  "agent": "sourcing",
  "offers": [
    {
      "merchant": "…", "price": 279.0, "currency": "USD",
      "provenance_tier": "api", "timestamp": "2026-06-23",
      "returns": "30-day", "warranty": "2-year",
      "offer_confidence": 0.9, "verify_at_checkout": false
    }
  ],
  "search_universe_delta": { "sources_hit": ["…"], "budgets_hit": ["per_api_calls"] }
}
```

## Fail-closed

- **Never fabricate a price.** If no credible offer is reachable within budget, return an empty `offers`
  array and record the gap (`sources_failed_or_blocked` / `budgets_hit`) — the renderer surfaces "No offers
  sourced", which is honest, not a guessed price.
- A scraped price is never presented as authoritative; the high band is reserved for `api`.
- Per-API budget exhaustion stops sourcing and is recorded; never widen calls or retry unbounded.
- The orchestrator discards any return that fails schema validation; emit exactly this envelope.
