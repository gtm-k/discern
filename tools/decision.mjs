// Discern Phase 3 decision engine (docs: skills/discern/SKILL.md steps 7-11; docs/definitions.md §3-§6).
//
// Bridges the two representations of a candidate's substance score:
//   - WORKING model — a flat `fundamentals_score` on the candidate (what grid.rankCandidates ranks over).
//   - OUTPUT model  — the Recommendation Object, where the score lives at
//                     shortlist[].fundamentals_card.fundamentals_score and recurrence lives on the candidate.
// The engine joins the two by `product`, then reuses grid.rankCandidates so invariant R1 (fundamentals
// outrank raw frequency) is a single source of truth, not re-implemented here.

import { rankCandidates } from "./grid.mjs";

const HIGH_BAND = 0.8;     // docs/definitions.md §6: confidence >= 0.80 is the "high" band.
const RETURN_BONUS = 0.05; // gift branch: returnability is weighted up (definitions.md §5.4).

// --- Per-claim confidence calibration (definitions.md §3 + §6) -------------------------------------

/**
 * Returns a violation string when a single claim's confidence is missing or miscalibrated, else null.
 * "Calibrated" means present & numeric in [0,1] AND respecting the provenance caps:
 *   - affiliate/sponsored evidence cannot reach the high band (§6: capped at moderate),
 *   - non-independent evidence (collapsed into a cluster) cannot reach the high band (§6),
 *   - a candidate with unresolved durable_ids cannot reach the high band (§3).
 * @param {object} claim - an evidence item (claim_confidence, independence_flag, affiliate_or_sponsored_flag).
 * @param {{unresolved?: boolean}} ctx - whether the owning candidate has unresolved durable_ids.
 */
export function claimConfidenceViolation(claim, { unresolved = false } = {}) {
  const c = claim?.claim_confidence;
  if (typeof c !== "number" || Number.isNaN(c)) return "missing or non-numeric claim_confidence";
  if (c < 0 || c > 1) return `claim_confidence ${c} out of range [0,1]`;
  if (claim.affiliate_or_sponsored_flag === true && c >= HIGH_BAND)
    return `affiliate/sponsored evidence capped at moderate, got ${c}`;
  if (claim.independence_flag === false && c >= HIGH_BAND)
    return `non-independent evidence cannot reach the high band, got ${c}`;
  if (unresolved && c >= HIGH_BAND)
    return `unresolved-identity candidate cannot reach the high band, got ${c}`;
  return null;
}

/** All per-claim calibration violations across a Recommendation Object (empty array = all calibrated). */
export function confidenceViolations(rec) {
  const out = [];
  for (const cand of rec.candidates ?? []) {
    const unresolved = cand.durable_ids?.unresolved === true;
    for (const ev of cand.evidence ?? []) {
      const v = claimConfidenceViolation(ev, { unresolved });
      if (v) out.push(`${cand.product}: ${v}`);
    }
  }
  return out;
}

// --- Grid / pick (invariant R1) -------------------------------------------------------------------

/**
 * Flatten a Recommendation Object into the working model R1 ranks over: each shortlist item joined with
 * its candidate (for recurrence + maker), carrying a `recalled` flag from blocking counterevidence.
 * Before Teardown produces a shortlist, falls back to ranking the raw candidates (Phase-2 grid behavior).
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
      };
    });
  }
  return (rec.candidates ?? []).map((c) => ({
    product: c.product,
    maker: c.maker,
    fundamentals_score: c.fundamentals_score ?? 0,
    recurrence_over_clusters: c.recurrence_over_clusters ?? 0,
    recalled: false,
  }));
}

/**
 * Choose the front-runner under invariant R1, after removing candidates blocked by a recall. A genuine
 * tie (top two equal on BOTH fundamentals and recurrence) is surfaced, never resolved by fabrication —
 * the caller must present the judgment call honestly (SKILL.md step 9).
 */
export function choosePick(rec) {
  const eligible = rankingModel(rec).filter((m) => !m.recalled);
  const ranked = rankCandidates(eligible);
  const [top, second] = ranked;
  const tie = !!(top && second &&
    top.fundamentals_score === second.fundamentals_score &&
    top.recurrence_over_clusters === second.recurrence_over_clusters);
  return { pick: top ? { product: top.product, maker: top.maker } : null, ranked, tie };
}

// --- Outcome engine (definitions.md §1, §5; SKILL.md step 11) --------------------------------------

// Substantive independent source-classes that satisfy the safety "fundamentals" bar. Editorial roundups
// and retailer user-reviews are deliberately excluded — too gameable to clear a safety category alone.
const SAFETY_FUNDAMENTALS_CLASSES = new Set(["professional_review", "spec_teardown_manufacturer", "video_review"]);

const independentEvidence = (cand) =>
  (cand.evidence ?? []).some((e) => e.independence_flag === true && e.affiliate_or_sponsored_flag !== true);

const independentFundamentals = (cand) =>
  (cand.evidence ?? []).some((e) =>
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
  const { tie } = choosePick(rec);

  // Safety categories may not rest on brand-proxy / affiliate content alone (SKILL.md step 5).
  if (safety && !candidates.some(independentFundamentals))
    return { family: "INSUFFICIENT_EVIDENCE", reason_code: "UNSAFE_BRAND_PROXY", tie };
  // No independent endorsement anywhere -> no consensus to stand on.
  if (!candidates.some(independentEvidence))
    return { family: "INSUFFICIENT_EVIDENCE", reason_code: "NO_CONSENSUS", tie };
  // Nothing recurs across a distinct cluster, or Teardown never produced a shortlist to compare.
  const anyRecurrence = candidates.some((c) => (c.recurrence_over_clusters ?? 0) >= 1);
  if (!anyRecurrence || (rec.shortlist ?? []).length === 0)
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
 * Run the value/preference filter + R1 ranking for one beneficiary over a flat candidate set. In the
 * gift branch, returnability is weighted up (definitions.md §5.4) and can be the decisive tiebreaker
 * between otherwise-close options. Returns the winner, the disqualified products, and whether the
 * returnability weighting was in force.
 */
export function runBeneficiaryDecision(candidates, { selfProfile, recipientProfile }, beneficiaryType) {
  const filters = applicableHardFilters(selfProfile, recipientProfile, beneficiaryType);
  const isGift = beneficiaryType === "recipient";

  const disqualified = [];
  const survivors = [];
  for (const c of candidates) {
    if (filters.some((f) => disqualifies(c, f))) disqualified.push(c.product);
    else survivors.push(c);
  }

  const scored = survivors
    .map((c) => ({ product: c.product, score: (c.fundamentals_score ?? 0) + (isGift && c.returnable ? RETURN_BONUS : 0) }))
    .sort((a, b) => b.score - a.score);

  return { winner: scored[0]?.product ?? null, disqualified, returnabilityApplied: isGift };
}
