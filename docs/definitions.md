# Definitions (normative)

Short, binding definitions for primitives that later phases depend on. If a phase's behavior contradicts
this file, this file wins (or the change is made here first).

## 1. Source-classes (Harvest channels)

Harvest deliberately spreads across distinct *classes* so one gamed channel can't dominate. The v1 classes:

1. **Professional reviews** — dedicated review outlets/publications.
2. **Editorial "best of" roundups** — listicles/buyer's guides (treated with suspicion; see independence).
3. **Video reviews** — YouTube and similar (hands-on, teardown-style preferred).
4. **Community/forums** — Reddit, specialist forums, Q&A.
5. **Retailer user-reviews** — ratings/reviews on storefronts (volume + recency + dissent).
6. **Spec / teardown / manufacturer** — datasheets, iFixit-style teardowns, maker documentation.

Each harvested item records which class it came from via its `provenance`.

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

Confidence is **never silently defaulted to high**. Unknown provenance → low. Phases 3 and 4 reject any
claim or offer emitted without a calibrated confidence value.
