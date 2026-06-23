# Rendering (the human report)

How a **Recommendation Object** (`schemas/recommendation-object.schema.json`) becomes the report a person
reads. The renderer is `tools/render.mjs::renderReport(rec)` → a deterministic markdown string. The user
sees **only** this report, so anything load-bearing for a buying decision must appear here — a fact that is
computed but never rendered is, for the user, a silent failure.

## Sections (in order)

1. **Header** — `outcome`; `reason_code` when it is not `NONE`; `confidence_overall` as a band + value.
2. **Need** — `framed_requirements.need`, plus budget and region when present.
3. **Pick** — `pick.product` by `maker`, the `rationale`, and the `value_assessment` (value-per-dollar).
   When there is no pick (a genuine tie, or `INSUFFICIENT_EVIDENCE`), this becomes a **"No single pick"**
   note — the renderer never fabricates a pick the object does not contain.
4. **The grid** — candidates ranked by **fundamentals, then independent recurrence** (invariant R1, via
   `decision.mjs::rankingModel` + `grid.mjs::rankCandidates` — one source of truth, not re-implemented).
   Each row shows `fundamentals_score`, `recurrence_over_clusters`, a `RECALLED` flag where it applies,
   each evidence **claim with its per-claim confidence band**, and any counterevidence.
5. **Runners-up** — from `runners_up`.
6. **Offers** — one line per offer: merchant, price + currency, `provenance_tier`, **per-offer confidence
   band**, `timestamp`, region/returns/warranty when present, and the **⚠ verify at checkout** marker
   (see below).
7. **Caveats** — `caveats[]` verbatim.
8. **Search universe** — `search_universe`: queries run, sources hit, **failed/blocked sources**,
   **unavailable tiers**, budgets hit, fetches used. Always rendered, even when the run was thin — never
   imply "everything" was searched.

## Offer calibration (enforced at test time AND at render time)

`render.mjs::offerConfidenceViolation(offer)` is the offer analog of the Phase-3 claim-confidence check
(`decision.mjs::claimConfidenceViolation`). It runs in **two** places so the test gate and the user see the
same signal: over every golden fixture in `npm test` (all must be clean) and over
`evals/offer-confidence.json` (which asserts each rule actually bites), **and** inside `renderReport` for
every offer — a failing offer is rendered as `⚠ uncalibrated (<reason>)`, never as a trusted
`confidence: <band>` cell. It **rejects** an offer whose `offer_confidence` is:

- **missing / non-numeric**, or outside `[0, 1]`;
- present on an offer whose **`provenance_tier` is unknown or missing** (fail-closed);
- present on a **scraped (non-`api`) price not marked `verify_at_checkout`** — see the rule below;
- **≥ 0.80 (high band) on a scraped (non-`api`) price** — a scraped point-in-time price cannot be
  near-certain. Authoritative (`api`) offers may sit in the high band and may omit `verify_at_checkout`.

A null / non-numeric `price` renders as `price unavailable` (never the raw `null`/`undefined`).

These are *caps*, not auto-grades (definitions.md §7): clearing a cap removes a ceiling, it does not raise
confidence.

## Verify-at-checkout (the scraped-price guarantee)

`provenance_tier = api` is the only **authoritative** tier (a merchant/aggregator API returning a
structured price). Every other tier (`search`, `fetch`, `browser`) is **scraped / non-authoritative**: the
price is a point-in-time observation that may be stale or wrong, so the offer **must** set
`verify_at_checkout = true` and the report **must** show the ⚠ verify-at-checkout caveat.

Defense in depth (actor-observability): `renderReport` shows the caveat when
`verify_at_checkout === true` **OR** the tier is scraped — so a mis-flagged scraped price still reaches the
user with the warning, while `offerConfidenceViolation` catches the underlying data fault at test time.

## Confidence bands

`render.mjs::confidenceBand(x)` maps a 0..1 value to its band (definitions.md §6): `>= 0.80` high,
`0.50–0.79` moderate, `0.20–0.49` low, `< 0.20` negligible; a missing/non-numeric value renders as
`unknown` — never silently shown as high.
