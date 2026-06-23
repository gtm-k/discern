# Definitions (normative)

Short, binding definitions for primitives that later phases depend on. If a phase's behavior contradicts
this file, this file wins (or the change is made here first).

## 1. Source-classes (Harvest channels)

Harvest deliberately spreads across distinct *classes* so one gamed channel can't dominate. The v1 classes
(the `provenance.source_class` enum keys, which the schema **requires** on every evidence item):

1. **Professional reviews** (`professional_review`) — dedicated review outlets/publications.
2. **Editorial "best of" roundups** (`editorial_roundup`) — listicles/buyer's guides (treated with suspicion; see independence).
3. **Video reviews** (`video_review`) — YouTube and similar (hands-on, teardown-style preferred).
4. **Community/forums** (`community_forum`) — Reddit, specialist forums, Q&A.
5. **Retailer user-reviews** (`retailer_user_review`) — ratings/reviews on storefronts (volume + recency + dissent).
6. **Spec / teardown / manufacturer** (`spec_teardown_manufacturer`) — datasheets, iFixit-style teardowns, maker docs.

Each harvested item records which class it came from via `provenance.source_class`.

## 2. Independence detection → clustering

Two sources are **non-independent** (share one `source_cluster_id`, count once in
`recurrence_over_clusters`) if ANY of:

- **Same owner** — same publisher / parent company / author network (`provenance.owner`).
- **Same affiliate network** — endorsements monetized through the same affiliate program/aggregator.
- **Shared upstream citation** — both derive their ranking from the same upstream source (re-syndication,
  "according to <X>" copying).

`independence_flag = false` marks an item that collapsed into an existing cluster. `affiliate_or_sponsored_flag`
marks monetized/sponsored content; such items are **down-weighted, not excluded**, and disclosed.

> Rationale: naive recurrence across "best of" content amplifies affiliate/SEO bias. Counting clusters,
> not pages, is what turns repetition back into a trust signal.

## 3. Durable product IDs

A candidate is identified durably (so it survives renames and matches across merchants) by, in order of
preference: `gtin` / `upc` / `ean` (global trade item numbers), else `model_no`, plus a `variant`
(color/size/configuration) when relevant. Free-text product names are display-only, never identity.

The schema **requires** `durable_ids` on every candidate. When no real ID can be found, set
`durable_ids.unresolved = true` with an `unresolved_reason` — this is an explicit, visible gap. An
unresolved identity **prevents that candidate from reaching the `high` confidence band** (any band up to
`moderate` is permitted; the `high` band is not — there is no floor), enforced from Phase 3 by the
confidence-calibration check (§6). Identity is never silently faked from a product name.

> **Why cap at `moderate`, not `low` (Phase 3 refinement, supersedes the original "cap at low").**
> Identity-resolution and evidence-strength are orthogonal axes. Handmade / local / boutique items — the
> category the value framework deliberately elevates (§4) — *structurally* lack GTINs, so capping every
> unresolved candidate at `low` would systematically suppress exactly what Discern exists to surface (a
> rule fighting another rule). A missing durable ID is a **cross-merchant matching / sourcing** caveat
> (you can't guarantee you're pricing the same SKU), not weak evidence: it blocks near-certainty (the
> `high` band) but solid independent endorsement can still legitimately earn `moderate`.

## 4. Value framework semantics

Encoded per profile (`value_framework`), applied at the Value & preference filter step:

- **value ≠ price** — a higher price is not evidence of more value.
- **value ≠ markup** — large margin with no underlying substance is rejected (`markup_tolerance`).
- **handmade / locally-made = value** — human-made / local-enterprise items carry value beyond their
  spec sheet (`prefers_handmade_local`).
- **hard_filters** are disqualifying; **preferences** are weighted. A `hard_filter` with
  `applies_to_gifts=false` does NOT transfer when the beneficiary is a recipient.

## 5. Gift-specific method branches (beneficiary ≠ self)

When `beneficiary.type = recipient`, these branches change relative to a self purchase:

1. **Profile source** — load the recipient profile; the self profile's `hard_filters` apply only if
   `applies_to_gifts=true`. The recipient's own hard_filters apply.
2. **Requirements inference** — the recipient usually can't be asked; infer from relationship/occasion and
   `occasion_history` (avoid repeat gifts).
3. **Budget** — use the recipient `category_budgets` (social-norm budget), not the buyer's value-per-dollar.
4. **Returnability weighting** — returns/exchange policy is weighted UP (the buyer can't confirm fit/taste).
5. **Presentation** — note giftability (packaging/presentation) where relevant.

These five toggles are the observable differences asserted by `evals/gift-vs-self.json` (Phase 3).

## 6. Confidence semantics

All `*_confidence` fields are numbers on **0..1**, with bands:

| Band | Range | Meaning |
|------|-------|---------|
| high | ≥ 0.80 | Multiple independent clusters and/or first-party fundamentals agree |
| moderate | 0.50–0.79 | Some independent support; minor gaps |
| low | 0.20–0.49 | Sparse, single-cluster, or aging evidence |
| negligible | < 0.20 | Anecdotal/unverifiable |

Provenance→confidence mapping (starting points, then adjusted):
- `api` authoritative data → high; first-party spec/teardown → high.
- multiple independent clusters agreeing → high; single independent cluster → moderate.
- `affiliate_or_sponsored_flag=true` → cap at moderate.
- stale (old `provenance.date`), scraped-without-verification, or `independence_flag=false` → reduce one band.
- blocked/failed source that would have mattered → it cannot raise confidence; record in `search_universe`.

Confidence is **never silently defaulted to high**. Unknown provenance → low (this is the rule for a
*claim*'s source; for an *offer*, an unknown/missing `provenance_tier` is rejected as uncalibrated — §7).
Phases 3 and 4 reject any claim or offer emitted without a calibrated confidence value.

### Machine-enforced calibration (Phase 3 — `tools/decision.mjs`)

The confidence-calibration check (`claimConfidenceViolation`) **rejects** any claim whose `claim_confidence`
is:

- **missing / non-numeric**, or outside `[0, 1]`;
- **≥ 0.80 while `affiliate_or_sponsored_flag = true`** — affiliate/sponsored evidence caps at `moderate`;
- **≥ 0.80 while `independence_flag = false`** — non-independent (cluster-collapsed) evidence cannot be high-band;
- **≥ 0.80 while the owning candidate's `durable_ids.unresolved = true`** — unresolved identity caps at `moderate` (§3);
- **≥ 0.80 without a high-band basis** — the `high` band requires multiple independent clusters
  (`recurrence_over_clusters ≥ 2`) OR a first-party `spec_teardown_manufacturer` source OR
  `access_tier = api`. A lone single-cluster professional/editorial/forum claim caps at `moderate`, so a
  heavily-marketed mass-market item cannot ride at high confidence on one source.

`npm test` runs this over every golden fixture (all must pass) and over `evals/confidence-calibration.json`
(which asserts each rejection actually bites). These are *caps*, not auto-grades: clearing a cap does not
raise confidence; it only removes a ceiling.

## 7. Offer provenance & confidence (sourcing)

Every offer in `offers[]` carries `merchant`, `price`, `currency`, `provenance_tier`, `timestamp`,
`offer_confidence` (the same 0..1 scale and bands as §6), and `verify_at_checkout`. `returns` and
`warranty` are recorded when known (and weighted up for gifts — §5.4).

**Authoritative vs scraped.** `provenance_tier = api` (a merchant/aggregator API returning a structured
price) is the only **authoritative** tier. `search`, `fetch`, and `browser` are **scraped /
non-authoritative**: the price is a point-in-time observation that may be stale or wrong.

**Verify-at-checkout rule.** Any scraped (non-`api`) price **must** set `verify_at_checkout = true`, and
the rendered report **must** show a "verify at checkout" caveat for it (`docs/render.md`). An authoritative
`api` price may omit it.

### Machine-enforced offer calibration (Phase 4 — `tools/render.mjs`)

The offer-calibration check (`offerConfidenceViolation`) — the offer analog of §6's
`claimConfidenceViolation` — **rejects** any offer whose `offer_confidence` is:

- **missing / non-numeric**, or outside `[0, 1]`;
- present on an offer whose **`provenance_tier` is unknown or missing** (not one of `search`/`fetch`/`browser`/`api`) — unknown provenance can't be trusted (fail-closed);
- present on a **scraped (non-`api`) price not marked `verify_at_checkout`**;
- **≥ 0.80 (high band) on a scraped (non-`api`) price** — a scraped point-in-time price cannot be
  near-certain; only an authoritative `api` price can reach the high band.

`npm test` runs this over every golden fixture (all must pass) and over `evals/offer-confidence.json`
(which asserts each rejection bites). As in §6 these are *caps*, not auto-grades. Offer confidence is
**never silently defaulted to high**. The check runs in two places so both actors get the same signal:
the test harness rejects miscalibrated offers in fixtures, and `tools/render.mjs::renderReport` runs it at
render time — a miscalibrated or scraped-high-band offer reaches the user only as `⚠ uncalibrated`
(stating why), never as a trusted confidence band.
