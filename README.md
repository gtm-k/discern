# Discern

A cross-platform, **agentic-commerce** skill + research-subagent fleet that finds the genuinely-best
product for a *specific person* — modeled on a disciplined human buying method, not on whatever ranks
highest or pays the most commission.

> **v1 scope:** research & recommend only (no purchasing). It produces a structured **Recommendation
> Object**; later phases consume that same object to prep checkout (Phase 2) and, eventually, to buy via
> agentic-commerce rails (Phase 3).

## Why it's different

Most shopping tools rank by price or star rating and have no taste. Discern encodes a real method:

1. **Frame** the need; pick the **beneficiary** (yourself vs. a gift recipient).
2. **Triage** how much research the purchase actually warrants.
3. **Harvest** many independent sources.
4. **Consensus by *independent* repetition** — syndicated/affiliate listicles that copy each other count as
   **one** signal, not many, so visibility can't masquerade as quality.
5. **Teardown** the fundamentals (chips, materials, real value propositions) — substance over marketing.
6. **Value & preference filter** — value ≠ price, value ≠ markup; handmade/local is value.
7. **Price/value gate, applied last** — "good enough" can beat "best."
8. **Source** the best place to buy, with honest provenance on every price.

Every recommendation carries **provenance, confidence, counterevidence, and an explicit outcome**
(`RECOMMEND` / `RECOMMEND_WITH_CAVEATS` / `INSUFFICIENT_EVIDENCE`). It would rather say "not enough
evidence" than launder a guess.

## Design philosophy

**Portable core + capability-gated enhancements.** The method, schemas, and a sequential web-search/fetch
path are the portable core that runs in any AI runtime. Parallel subagents, browser automation, and
retailer APIs are *optional boosters* that improve breadth/speed where available — never hard dependencies.

## Repository layout

| Path | What |
|------|------|
| `schemas/` | The Recommendation Object + Preference Profile JSON Schemas (the contracts) |
| `profiles/` | `*.example.md` reference profiles; real profiles are git-ignored |
| `docs/` | `triage.md`, `definitions.md`, `data-access.md` — the normative specs |
| `tools/` | `validate.mjs` — schema + fixture validator (`npm test`) |
| `evals/` | Offline golden fixtures (no live fetch) + deliberately-invalid cases |
| `skills/discern/` | The skill itself (added in Phase 2) |
| `agents/` | Research subagent definitions (added in Phase 5) |

Planning docs (vision, plan, pre-mortem, review audit trail) live privately in `gtm-k/prd/discern/`.

## Develop

```bash
npm install
npm test    # validates all schemas + fixtures; non-zero exit on any violation
```

## Status

Phase 1 (Foundations) — in progress. See `gtm-k/prd/discern/PLAN.md` for the phase ledger.
