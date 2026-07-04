// In-run candidate comparison model (Discern v2.1 — the ONLY place comparison logic lives).
// (design: prd/discern/specs/2026-07-03-tui-candidate-comparison-design.md §4/§6a/§7.)
//
// buildComparison(rec) is a PURE function: no I/O, no rendering. It joins candidates[] <-> shortlist[]
// by `product`, classifies each item's status from the RECORDED pick/runners_up (NOT by re-running the
// decision engine), computes the four derived quality axes, and derives counts + dealbreaker_rules +
// radar_default. The store writer persists the result as a sidecar (runs/<id>.compare.json) governed by
// schemas/store-compare.schema.json; the Go viewer only plots it (never recomputes a score or a cut).
//
// Disqualification is single-sourced via disqualify.mjs (shared with decision.mjs + render.mjs), so the
// engine, the prose grid, and this tableau can never disagree on what a dealbreaker removes.

import { isDisqualified, disqualifyReason } from "./disqualify.mjs";

/** A valid record element: a plain object, not null and not an array. Filters untrusted input. */
const isRecord = (o) => !!o && typeof o === "object" && !Array.isArray(o);

/**
 * Fail closed on non-unique product display names. The comparison join model keys on `product`
 * (a shortlist_item carries no maker to disambiguate), so a duplicate would silently mis-attribute
 * fundamentals/clean or emit two picks from one recorded pick. Refuse to build rather than launder
 * an ambiguous comparison — consistent with the store's "refuse a malformed object" posture.
 */
function assertUniqueProducts(items, label) {
  const seen = new Set();
  for (const it of items) {
    const p = typeof it.product === "string" ? it.product : "";
    if (seen.has(p)) {
      throw new Error(
        `compare: refusing to build — non-unique ${label} product ${JSON.stringify(p)} cannot be joined unambiguously`
      );
    }
    seen.add(p);
  }
}

/** The four fixed comparison axes (Phase 1 evidence-quality aggregates). Constant across every run. */
export const AXES = ["fundamentals", "consensus", "evidence", "clean"];

// Clean-axis penalty weights. The ORDERING is the contract (design §4): recall > defect === reliability
// > dissent > other; the magnitudes are tunable. `dealbreaker` never appears here — it disqualifies the
// item (§6a) instead of penalizing its Clean score.
export const CLEAN_PENALTY = { recall: 0.5, defect: 0.25, reliability: 0.25, dissent: 0.15, other: 0.1 };

/** Mean of a candidate's numeric evidence[].claim_confidence (schema guarantees >=1). 0 if none numeric. */
function meanConfidence(candidate) {
  const vals = (Array.isArray(candidate?.evidence) ? candidate.evidence : [])
    .map((e) => (isRecord(e) ? e.claim_confidence : undefined))
    .filter((c) => typeof c === "number" && Number.isFinite(c));
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Clean score = clamp(1 - Σ penalty(kind), 0, 1) over a shortlist item's counterevidence[].
 * `dealbreaker` contributes 0 (it disqualifies). An unknown/malformed kind falls to the smallest
 * (`other`) penalty. Empty counterevidence -> 1.0. Exported for the penalty-ordering unit test.
 */
export function cleanScore(counterevidence) {
  const ces = (Array.isArray(counterevidence) ? counterevidence : []).filter(isRecord);
  let penalty = 0;
  for (const ce of ces) {
    if (ce.kind === "dealbreaker") continue; // structural exclusion, not a Clean penalty
    penalty += CLEAN_PENALTY[ce.kind] ?? CLEAN_PENALTY.other;
  }
  return Math.max(0, Math.min(1, 1 - penalty));
}

/**
 * Map a disqualified item's reason to the specific dealbreaker RULE it violated (design D3). The data
 * carries no structured link, so compute it honestly and NEVER fabricate:
 *   - exactly one rule -> that rule;
 *   - otherwise the rule whose lowercased tokens best overlap the reason detail;
 *   - no rules, or no overlap when ambiguous -> null.
 */
function matchDealbreakerRule(reason, rules) {
  const list = (Array.isArray(rules) ? rules : []).filter((r) => typeof r === "string" && r.length);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  if (typeof reason !== "string" || !reason.length) return null;
  const tokens = (s) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const reasonTokens = tokens(reason);
  let best = null;
  let bestScore = 0;
  for (const rule of list) {
    let overlap = 0;
    for (const t of tokens(rule)) if (reasonTokens.has(t)) overlap++;
    if (overlap > bestScore) { bestScore = overlap; best = rule; }
  }
  return bestScore > 0 ? best : null; // ambiguous with no token overlap -> null, never a guess.
}

/**
 * Classify one item's status from the RECORDED recommendation (design D1/§7). Disqualified is checked
 * FIRST so a structurally-excluded item never masquerades as pick/eligible.
 *   disqualified > pick > runner_up > eligible (shortlisted) > not_shortlisted.
 */
function classify(product, shortlistItem, rec) {
  if (isDisqualified(shortlistItem?.counterevidence)) return "disqualified";
  if (isRecord(rec.pick) && rec.pick.product === product) return "pick";
  const runners = Array.isArray(rec.runners_up) ? rec.runners_up : [];
  if (runners.some((r) => isRecord(r) && r.product === product)) return "runner_up";
  if (shortlistItem) return "eligible"; // shortlisted (has a fundamentals card) but not the pick/runner-up
  return "not_shortlisted";
}

// Canonical emit order: pick -> runner_up -> eligible -> not_shortlisted -> disqualified (removed last).
const STATUS_ORDER = { pick: 0, runner_up: 1, eligible: 2, not_shortlisted: 3, disqualified: 4 };

/**
 * Build the comparison sidecar model from a Recommendation Object. Pure; never throws on a schema-valid
 * object and degrades gracefully (skips malformed elements) on a malformed one. The `id` field is left
 * empty for the store writer to stamp.
 * @param {object} rec - a Recommendation Object.
 */
export function buildComparison(rec) {
  const r = isRecord(rec) ? rec : {};
  const candidates = (Array.isArray(r.candidates) ? r.candidates : []).filter(isRecord);
  const shortlist = (Array.isArray(r.shortlist) ? r.shortlist : []).filter(isRecord);
  // Fail closed BEFORE any joining if product display names collide (Codex review, high) — the
  // join keys on `product` and, with no maker on a shortlist item, cannot disambiguate duplicates.
  assertUniqueProducts(candidates, "candidate");
  assertUniqueProducts(shortlist, "shortlist");

  // Fail closed on dangling cross-references (Codex review, high): the rec schema does not
  // enforce that shortlist / pick / runners_up products resolve to a candidate, but the
  // comparison is built by iterating candidates — a dangling reference would silently drop the
  // recorded pick or mislabel rows. Refuse rather than ship a panel that contradicts the record.
  const candidateProducts = new Set(candidates.map((c) => (typeof c.product === "string" ? c.product : "")));
  const requireCandidate = (product, label) => {
    if (!candidateProducts.has(product)) {
      throw new Error(`compare: refusing to build — ${label} product ${JSON.stringify(product)} is not among the candidates`);
    }
  };
  for (const s of shortlist) requireCandidate(typeof s.product === "string" ? s.product : "", "shortlist");
  if (isRecord(r.pick)) requireCandidate(typeof r.pick.product === "string" ? r.pick.product : "", "pick");
  for (const ru of Array.isArray(r.runners_up) ? r.runners_up : []) {
    if (isRecord(ru)) requireCandidate(typeof ru.product === "string" ? ru.product : "", "runner-up");
  }

  const shortByProduct = new Map(shortlist.map((s) => [s.product, s]));

  const need = typeof r.framed_requirements?.need === "string" ? r.framed_requirements.need : "";
  const dealbreaker_rules = (Array.isArray(r.framed_requirements?.dealbreakers)
    ? r.framed_requirements.dealbreakers : []).filter((d) => typeof d === "string");

  // First pass: classify + gather raw axis inputs, joining candidate <-> shortlist by product.
  const prelim = candidates.map((c) => {
    const product = typeof c.product === "string" ? c.product : "";
    const sItem = shortByProduct.get(product);
    const status = classify(product, sItem, r);
    const disq = status === "disqualified";
    const raw = c.recurrence_over_clusters;
    return {
      product,
      maker: typeof c.maker === "string" ? c.maker : "",
      status,
      disq,
      reason: disq ? disqualifyReason(sItem?.counterevidence) : null,
      durable_unresolved: c.durable_ids?.unresolved === true,
      fundamentals: typeof sItem?.fundamentals_card?.fundamentals_score === "number"
        ? sItem.fundamentals_card.fundamentals_score : null,
      consensus_raw: typeof raw === "number" && Number.isFinite(raw) ? raw : 0,
      evidence: meanConfidence(c),
      clean: disq ? null : (sItem ? cleanScore(sItem.counterevidence) : null),
    };
  });

  // Normalization scope (design §4): the max is taken over the ELIGIBLE (non-disqualified) set only, so a
  // removed item — even one with the highest recurrence — can never distort the radar's consensus scale.
  const eligibleRaw = prelim.filter((p) => !p.disq).map((p) => p.consensus_raw);
  const maxRecurrence = eligibleRaw.length ? Math.max(...eligibleRaw) : 0;

  const items = prelim.map((p) => ({
    product: p.product,
    maker: p.maker,
    status: p.status,
    disqualified_reason: p.disq ? p.reason : null,
    dealbreaker_rule: p.disq ? matchDealbreakerRule(p.reason, dealbreaker_rules) : null,
    durable_unresolved: p.durable_unresolved,
    scores: {
      fundamentals: p.fundamentals, // null when not shortlisted (honesty rule §4) — never 0
      consensus_raw: p.consensus_raw, // always present; the tableau shows the raw count
      consensus_norm: p.disq ? null : (maxRecurrence > 0 ? p.consensus_raw / maxRecurrence : 0),
      evidence: p.evidence,
      clean: p.clean, // null when disqualified OR not shortlisted (no counterevidence data)
    },
  }));

  // Canonical order (design §5.1): pick -> runner_up -> eligible -> not_shortlisted -> removed(last).
  items.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

  const considered = prelim.length;
  const removed = prelim.filter((p) => p.disq).length;
  const eligible = considered - removed;

  // radar_default (design §5.6): [pick, rival], rival = highest-fundamentals eligible, non-pick,
  // non-disqualified item (null fundamentals sort last / excluded). No pick or <2 such items -> <2
  // series and the Go viewer disables the radar. Disqualified items are NEVER in a series.
  const series = [];
  const pickItem = items.find((it) => it.status === "pick");
  if (pickItem) {
    series.push(pickItem.product);
    const rival = items
      .filter((it) => it.status !== "pick" && it.status !== "disqualified" && it.scores.fundamentals !== null)
      .sort((a, b) => b.scores.fundamentals - a.scores.fundamentals)[0];
    if (rival) series.push(rival.product);
  }

  return {
    id: "", // stamped by the store writer (recordRun / rebuildIndex)
    need,
    axes: [...AXES],
    dealbreaker_rules,
    counts: { considered, eligible, removed },
    radar_default: { series },
    items,
  };
}
