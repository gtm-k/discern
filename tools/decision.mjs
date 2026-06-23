// Discern Phase 3 decision engine (docs: skills/discern/SKILL.md steps 7-12; docs/definitions.md §3-§6).
//
// Bridges the two representations of a candidate's substance score:
//   - WORKING model — a flat `fundamentals_score` on the candidate (what grid.rankCandidates ranks over).
//   - OUTPUT model  — the Recommendation Object, where the score lives at
//                     shortlist[].fundamentals_card.fundamentals_score and recurrence lives on the candidate.
// The engine joins the two by `product`, then reuses grid.rankCandidates so invariant R1 (fundamentals
// outrank raw frequency) is a single source of truth, not re-implemented here.
//
// Scoring constants below encode the DIRECTION of the value framework / gift branches for the offline eval
// harness (definitions.md §4-§5); production rationale is the skill agent's judgment, but the harness must
// prove the rules move the pick the right way.

import { rankCandidates } from "./grid.mjs";

const HIGH_BAND = 0.8;       // docs/definitions.md §6: confidence >= 0.80 is the "high" band.
const RETURN_BONUS = 0.05;   // gift branch: returnability is weighted up (definitions.md §5.4).
const HANDMADE_BONUS = 0.1;  // value framework: handmade/local = value (definitions.md §4).
const MARKUP_PENALTY = 0.1;  // value framework: reject markup without substance (definitions.md §4).

// --- Per-claim confidence calibration (definitions.md §3 + §6) -------------------------------------

// The high band (>= 0.80) is reachable only with a genuine basis: multiple independent clusters, OR a
// first-party spec/teardown, OR api-authoritative data — and never for affiliate, non-independent, or
// unresolved-identity evidence. (definitions.md §6.)
function highBandAllowed(claim, { unresolved = false, recurrence = 0 } = {}) {
  if (unresolved) return false;                                   // §3: no high band without resolved identity.
  if (claim.affiliate_or_sponsored_flag === true) return false;   // §6: affiliate caps at moderate.
  if (claim.independence_flag === false) return false;            // §6: collapsed/non-independent caps at moderate.
  const sc = claim.provenance?.source_class;
  const tier = claim.provenance?.access_tier;
  if (sc === "spec_teardown_manufacturer" || tier === "api") return true; // first-party / authoritative.
  return (recurrence ?? 0) >= 2;                                  // multiple independent clusters agreeing.
}

/**
 * Returns a violation string when a single claim's confidence is missing or miscalibrated, else null.
 * @param {object} claim - an evidence item (claim_confidence, independence_flag, affiliate_or_sponsored_flag, provenance).
 * @param {{unresolved?: boolean, recurrence?: number}} ctx - owning-candidate context (unresolved identity, cluster count).
 */
export function claimConfidenceViolation(claim, ctx = {}) {
  const c = claim?.claim_confidence;
  if (typeof c !== "number" || Number.isNaN(c)) return "missing or non-numeric claim_confidence";
  if (c < 0 || c > 1) return `claim_confidence ${c} out of range [0,1]`;
  if (c >= HIGH_BAND && !highBandAllowed(claim, ctx)) {
    if (ctx.unresolved) return `unresolved-identity candidate cannot reach the high band, got ${c}`;
    if (claim.affiliate_or_sponsored_flag === true) return `affiliate/sponsored evidence capped at moderate, got ${c}`;
    if (claim.independence_flag === false) return `non-independent evidence cannot reach the high band, got ${c}`;
    return `high band requires >=2 independent clusters or a first-party/authoritative source, got ${c}`;
  }
  return null;
}

/** All per-claim calibration violations across a Recommendation Object (empty array = all calibrated). */
export function confidenceViolations(rec) {
  const out = [];
  for (const cand of rec.candidates ?? []) {
    const ctx = { unresolved: cand.durable_ids?.unresolved === true, recurrence: cand.recurrence_over_clusters ?? 0 };
    for (const ev of cand.evidence ?? []) {
      const v = claimConfidenceViolation(ev, ctx);
      if (v) out.push(`${cand.product}: ${v}`);
    }
  }
  return out;
}

// --- Grid / pick (invariant R1) -------------------------------------------------------------------

/**
 * Flatten a Recommendation Object into the working model R1 ranks over: each shortlist item joined with
 * its candidate (for recurrence + maker), carrying `recalled` (blocking counterevidence) and `joinMissing`
 * (no matching candidate) flags. Before Teardown produces a shortlist, falls back to ranking the raw
 * candidates (Phase-2 grid behavior).
 */
export function rankingModel(rec) {
  const candByProduct = new Map((rec.candidates ?? []).map((c) => [c.product, c]));
  if ((rec.shortlist ?? []).length) {
    return rec.shortlist.map((s) => {
      const cand = candByProduct.get(s.product);
      return {
        product: s.product,
        maker: cand?.maker,
        fundamentals_score: s.fundamentals_card?.fundamentals_score ?? 0,
        recurrence_over_clusters: cand?.recurrence_over_clusters ?? 0,
        recalled: (s.counterevidence ?? []).some((c) => c.kind === "recall"),
        joinMissing: !cand,
      };
    });
  }
  return (rec.candidates ?? []).map((c) => ({
    product: c.product,
    maker: c.maker,
    fundamentals_score: c.fundamentals_score ?? 0,
    recurrence_over_clusters: c.recurrence_over_clusters ?? 0,
    recalled: false,
    joinMissing: false,
  }));
}

/**
 * Shortlist items that cannot be tied to a candidate, or whose display name is ambiguous across
 * candidates. A join error is a real data-integrity fault (identity lives on `durable_ids`, not the
 * display name), surfaced rather than silently demoted to a 0-score / undefined-maker candidate.
 */
export function shortlistJoinViolations(rec) {
  const names = (rec.candidates ?? []).map((c) => c.product);
  const dupes = new Set(names.filter((n, i) => names.indexOf(n) !== i));
  const out = [];
  for (const s of rec.shortlist ?? []) {
    if (!names.includes(s.product)) out.push(`${s.product}: no matching candidate`);
    else if (dupes.has(s.product)) out.push(`${s.product}: ambiguous (duplicate candidate display names)`);
  }
  return out;
}

/**
 * Choose the front-runner under invariant R1, after removing candidates blocked by a recall or by a
 * failed join. A genuine tie (top two equal on BOTH fundamentals and recurrence) yields NO sole pick —
 * `pick` is null and the tied finalists are returned in `tiedPicks` so the caller must present the
 * judgment call honestly (SKILL.md step 9), never inherit an arbitrary array-order winner.
 */
export function choosePick(rec) {
  const eligible = rankingModel(rec).filter((m) => !m.recalled && !m.joinMissing);
  const ranked = rankCandidates(eligible);
  const [top, second] = ranked;
  const tie = !!(top && second &&
    top.fundamentals_score === second.fundamentals_score &&
    top.recurrence_over_clusters === second.recurrence_over_clusters);
  const tiedPicks = tie
    ? ranked
        .filter((m) => m.fundamentals_score === top.fundamentals_score &&
                       m.recurrence_over_clusters === top.recurrence_over_clusters)
        .map((m) => ({ product: m.product, maker: m.maker }))
    : [];
  const pick = top && !tie ? { product: top.product, maker: top.maker } : null;
  return { pick, tiedPicks, ranked, tie };
}

// --- Outcome engine (definitions.md §1, §5; SKILL.md step 12) --------------------------------------

// Substantive independent source-classes that satisfy the safety "fundamentals" bar. Editorial roundups
// and retailer user-reviews are deliberately excluded — too gameable to clear a safety category alone.
const SAFETY_FUNDAMENTALS_CLASSES = new Set(["professional_review", "spec_teardown_manufacturer", "video_review"]);

const independentEvidence = (cand) =>
  (cand?.evidence ?? []).some((e) => e.independence_flag === true && e.affiliate_or_sponsored_flag !== true);

const independentFundamentals = (cand) =>
  (cand?.evidence ?? []).some((e) =>
    e.independence_flag === true &&
    e.affiliate_or_sponsored_flag !== true &&
    SAFETY_FUNDAMENTALS_CLASSES.has(e.provenance?.source_class));

/**
 * Derive the outcome FAMILY and reason_code from a Recommendation Object's evidence state. The engine
 * owns the safety-critical boundary (RECOMMEND-family vs INSUFFICIENT_EVIDENCE) deterministically; the
 * RECOMMEND vs RECOMMEND_WITH_CAVEATS nuance stays a skill/human judgment on caveat materiality.
 * @returns {{family: "RECOMMEND"|"INSUFFICIENT_EVIDENCE", reason_code: string, tie: boolean}}
 */
export function decideOutcome(rec) {
  const candidates = rec.candidates ?? [];
  const safety = rec.triage?.safety_relevant === true;
  const { ranked, tie, pick, tiedPicks } = choosePick(rec);
  const candByProduct = new Map(candidates.map((c) => [c.product, c]));

  // Safety: the RECOMMENDED candidate(s) — not some other, non-picked candidate — must rest on
  // independent fundamentals. Scoped to the eligible finalist set (post-recall, post-join).
  if (safety) {
    const finalists = tiedPicks.length ? tiedPicks : pick ? [pick] : ranked[0] ? [ranked[0]] : [];
    const backed = finalists.length > 0 && finalists.every((f) => independentFundamentals(candByProduct.get(f.product)));
    if (!backed) return { family: "INSUFFICIENT_EVIDENCE", reason_code: "UNSAFE_BRAND_PROXY", tie };
  }
  // No independent endorsement anywhere -> no consensus to stand on.
  if (!candidates.some(independentEvidence))
    return { family: "INSUFFICIENT_EVIDENCE", reason_code: "NO_CONSENSUS", tie };
  // Nothing recurs across a distinct cluster, or Teardown never produced a shortlist to compare.
  const anyRecurrence = candidates.some((c) => (c.recurrence_over_clusters ?? 0) >= 1);
  if (!anyRecurrence || (rec.shortlist ?? []).length === 0)
    return { family: "INSUFFICIENT_EVIDENCE", reason_code: "THIN_EVIDENCE", tie };
  // No eligible (non-recalled, joined) candidate remains to recommend — never emit RECOMMEND with no pick.
  if (ranked.length === 0)
    return { family: "INSUFFICIENT_EVIDENCE", reason_code: "THIN_EVIDENCE", tie };

  return { family: "RECOMMEND", reason_code: "NONE", tie };
}

// --- Value & preference filter + beneficiary switch (definitions.md §4, §5) ------------------------

/**
 * The hard filters that apply for a beneficiary (definitions.md §5.1):
 *   - self      -> the self profile's filters.
 *   - recipient -> the recipient profile's OWN filters, plus any self-profile filter explicitly marked
 *                  applies_to_gifts=true. Self-only filters (applies_to_gifts falsy) do NOT transfer.
 */
export function applicableHardFilters(selfProfile, recipientProfile, beneficiaryType) {
  if (beneficiaryType === "recipient") {
    const own = recipientProfile?.hard_filters ?? [];
    const transferred = (selfProfile?.hard_filters ?? []).filter((f) => f.applies_to_gifts === true);
    return [...own, ...transferred];
  }
  return selfProfile?.hard_filters ?? [];
}

/** Structured hard-filter match against a candidate's attributes (a disallow-list or an equals test). */
function disqualifies(candidate, filter) {
  const m = filter?.match;
  if (!m) return false;
  const value = candidate[m.attribute];
  if (Array.isArray(m.disallow)) return m.disallow.includes(value);
  if (Object.prototype.hasOwnProperty.call(m, "equals")) return value === m.equals;
  return false;
}

/**
 * Run the value/preference filter + R1 ranking for one beneficiary over a flat candidate set. Applies, in
 * order: the active beneficiary's hard filters (disqualifying), then the active profile's VALUE FRAMEWORK
 * (handmade/local up, unjustified markup down — definitions.md §4) and, in the gift branch, returnability
 * (definitions.md §5.4). The active profile is the recipient's for gifts, the self's otherwise — so the
 * recipient's taste, not the buyer's, shapes a gift.
 */
export function runBeneficiaryDecision(candidates, { selfProfile, recipientProfile }, beneficiaryType) {
  const filters = applicableHardFilters(selfProfile, recipientProfile, beneficiaryType);
  const isGift = beneficiaryType === "recipient";
  const active = isGift ? recipientProfile : selfProfile;
  const vf = active?.value_framework ?? {};

  const disqualified = [];
  const survivors = [];
  for (const c of candidates) {
    if (filters.some((f) => disqualifies(c, f))) disqualified.push(c.product);
    else survivors.push(c);
  }

  const scored = survivors
    .map((c) => {
      let score = c.fundamentals_score ?? 0;
      if (vf.prefers_handmade_local && c.handmade_local) score += HANDMADE_BONUS; // §4 handmade/local = value
      if (vf.markup_tolerance === "low" && c.high_markup) score -= MARKUP_PENALTY; // §4 reject markup w/o substance
      if (isGift && c.returnable) score += RETURN_BONUS;                           // §5.4 returnability weighted
      return { product: c.product, score };
    })
    .sort((a, b) => b.score - a.score);

  return {
    winner: scored[0]?.product ?? null,
    disqualified,
    returnabilityApplied: isGift && survivors.some((c) => c.returnable),
    valueFrameworkApplied: !!(vf.prefers_handmade_local || vf.markup_tolerance),
  };
}
