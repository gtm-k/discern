---
name: discern
description: Use when the user wants to find the best product to buy among the options available — researching a considered purchase (electronics, appliances, gear, clothing, tools, furniture), comparing options, deciding what to buy, or choosing a gift for someone. Produces a structured, honest recommendation modeled on a disciplined human buying method, not on whatever ranks highest or pays the most commission.
---

# Discern — the buying method

You are helping a person find the *genuinely best* product for them, not the most-advertised one.
Follow this method. It is deliberately disciplined: it resists affiliate/SEO bias, checks substance over
marketing, and is honest about confidence and provenance. Your output is a **Recommendation Object** that
conforms to `schemas/recommendation-object.schema.json`.

> **v1 scope:** research & recommend only. Never purchase, enter payment details, or complete checkout.

## Reference files (read what you need)
- `schemas/recommendation-object.schema.json` — the exact output contract.
- `docs/triage.md` — how to set research depth.
- `docs/definitions.md` — source-classes, independence clustering, durable IDs, value framework, gift
  branches, and confidence semantics (the 0..1 scale). **Binding.**
- `docs/data-access.md` — the data tiers, policy gate, and fetch budgets you must obey.
- `docs/render.md` — how the Recommendation Object becomes the human report (offer calibration + verify-at-checkout).
- `profiles/self.md` (or `profiles/recipients/<name>.md`) — the active preference profile.

## The steps

### 1. Frame
Turn the vague need into concrete requirements: the need, must-haves, nice-to-haves, dealbreakers, budget,
region. **Choose the beneficiary**: `self` or a `recipient` (a gift). Load the matching profile. If gifting,
apply the gift branches in `definitions.md §5` (the recipient's filters apply; the buyer's self-only
hard-filters do not transfer unless `applies_to_gifts=true`).

### 2. Triage
Score stakes / reversibility / commoditization (and `safety_relevant`) and set `triage.depth`
(`light` / `standard` / `deep`) per `docs/triage.md`. Depth controls how many source-classes you Harvest,
whether Teardown runs, and how many candidates you compare. Record the depth and why.

### 3. Harvest
Gather candidates from **multiple distinct source-classes** (see `definitions.md §1`): professional
reviews, editorial roundups, video reviews, community/forums, retailer user-reviews, spec/teardown/maker.
Obey `docs/data-access.md` for every fetch (policy gate + budgets; record everything in `search_universe`).
For each useful item, capture an **evidence** record: the claim, its `provenance` (url, owner, date,
`access_tier`, `source_class`), and whether it is affiliate/sponsored.

### 4. Consensus by INDEPENDENT repetition
This is the core trust signal. Assign every evidence item a `source_cluster_id`: sources that share an
owner, an affiliate network, or a shared upstream citation are the **same cluster** (see `definitions.md
§2`). A product's `recurrence_over_clusters` is the number of **distinct clusters** that endorse it — never
the raw page count. A product praised by ten pages that all copy one upstream ranking has a recurrence of
**one**, and you must treat it as such. Affiliate/sponsored evidence is **down-weighted, not excluded**, and
disclosed via `affiliate_or_sponsored_flag`.

### 5. Brand-as-proxy (only when warranted)
For genuinely new releases with thin reviews, you may lean on the maker's repeated independent top
placements over time as a proxy. **Disabled for safety-relevant categories** — there, the absence of
*independent fundamentals* (an independent, non-monetized professional review, teardown/spec, or video
review — affiliate roundups and retailer star-ratings do **not** clear the bar) means
`INSUFFICIENT_EVIDENCE` (reason `UNSAFE_BRAND_PROXY`), not a brand guess.

### 6. The grid
Build `candidates[]`: product, maker, `durable_ids` (a real GTIN/UPC/EAN/model_no, or
`unresolved:true` + reason — never identity-by-name), the evidence, and `recurrence_over_clusters`.
**Ranking invariant R1:** once fundamentals exist (step 7), a candidate with a higher fundamentals score
ranks above one with lower fundamentals **even if the latter has higher recurrence**. Recurrence is the
consensus signal and the tiebreaker; it does not override substance.

### 7. Teardown (depth ≥ standard)
For shortlisted candidates, compare the *fundamentals*, not the marketing: the chip, the technology, the
materials, genuine unique value propositions. Produce a `fundamentals_card` with a `fundamentals_score`
(0..1 — a measure of substance, not popularity). This score, **not** raw recurrence, drives the ranking
(invariant R1). A candidate whose `durable_ids.unresolved=true` cannot carry `high` confidence — it is
capped at `moderate` (`definitions.md §3`). Capture `counterevidence` (recalls, defects, reliability
problems, credible dissent) — it never disappears. A **recall disqualifies that candidate from being the
pick**; lesser counterevidence (defects, dissent, reliability) is surfaced as a caveat, not auto-disqualifying.

### 8. Value & preference filter
Apply the active profile's hard filters (disqualifying) and value framework: **value ≠ price; value ≠
markup; handmade/local = value** (`definitions.md §4`). The framework shapes the *ranking*, not just the
prose — handmade/local moves a candidate up, unjustified markup (under low `markup_tolerance`) moves it
down — so a strong local maker can out-rank a higher-spec mass-market item. For a gift, the **recipient's**
value framework applies, not yours. Weighted preferences shape, but don't disqualify.

### 9. Leader / ties
Surface the front-runner under invariant R1. A **genuine tie** — the top two equal on *both* fundamentals
and independent recurrence — is presented as an honest judgment call: surface the tied co-leaders, do
**not** emit a single arbitrary `pick`. If every shortlisted candidate is blocked (e.g. all recalled, or
none can be tied to a durable identity), there is no pick — return `INSUFFICIENT_EVIDENCE`, never a
recommendation with an empty pick.

### 10. Price / value gate — LAST
Only now bring in price. Optimize **value-per-dollar**, not lowest price: a "good enough" option within
budget can beat a pricier "best." Use the profile's `category_budgets` as the "good enough" bar.

### 11. Sourcing
Find where to buy and the best price for the pick(s) — only the pick(s), not the whole grid. For each
offer record `merchant`, `price`, `currency`, `provenance_tier`, `timestamp`, and `returns`/`warranty`
when known (for a gift, returnability is weighted up — `definitions.md §5.4`). Calibrate `offer_confidence`
on the 0..1 scale (`definitions.md §7`): only an authoritative `api` price can reach the high band. Every
scraped (non-`api`) price **must** set `verify_at_checkout=true` — the eval harness rejects a scraped offer
without it, and a scraped offer cannot carry high confidence. Optimize **value-per-dollar**, not lowest
price (step 10). Record what you searched, hit, and failed to reach in `search_universe`.

### 12. Recommend & render
Emit the Recommendation Object with one explicit `outcome`, then render the human report per
`docs/render.md` (the grid, the pick + rationale, runners-up, offers with provenance + per-offer
confidence band + verify-at-checkout, per-claim confidence, caveats, and the real `search_universe`):
- `RECOMMEND` — clear, well-supported pick.
- `RECOMMEND_WITH_CAVEATS` — a pick plus material caveats (thin reviews, price volatility, etc.).
- `INSUFFICIENT_EVIDENCE` (+ `reason_code`) — when consensus is absent (`NO_CONSENSUS`), evidence is too
  thin (`THIN_EVIDENCE`), a safety category's **pick is not itself backed by independent fundamentals**
  (`UNSAFE_BRAND_PROXY` — a *different* candidate's evidence does not count), or data access failed
  (`INSUFFICIENT_ACCESS`). **Prefer this over a confident guess.**

## Honesty rules (non-negotiable)
- Tag every claim with a calibrated `claim_confidence` and every offer with a calibrated `offer_confidence`
  (0..1; `definitions.md §6`–`§7`). Never default to high. Affiliate/sponsored, non-independent, and
  unresolved-identity claims — and any scraped (non-`api`) offer — are **capped at moderate**; the eval
  harness *and* the renderer reject any miscalibrated value (a bad offer renders as `⚠ uncalibrated`).
- Report the real `search_universe`: what you searched, what failed/was blocked, what tiers were missing.
  Never imply you searched "everything."
- Surface counterevidence in the rationale. Cite provenance. When unsure, say so and lower confidence.
