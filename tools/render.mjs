// Discern Phase 4 — offer calibration + human-readable rendering.
// (docs: skills/discern/SKILL.md "Sourcing"; docs/render.md; docs/definitions.md §6-§7.)
//
// Two responsibilities, both at the LOGIC layer (mirroring Phase 3's claim-confidence calibration in
// decision.mjs rather than tightening the GO'd schema):
//   1. offerConfidenceViolation / offerViolations — the OFFER analog of decision.mjs::claimConfidence*,
//      enforcing that every offer carries a calibrated confidence, that a scraped (non-authoritative)
//      price is always marked verify_at_checkout, and that a scraped price never claims the high band.
//   2. renderReport — turn a Recommendation Object into the report a human reads: the grid, the pick +
//      rationale, runners-up, offers with provenance + per-offer confidence band + verify-at-checkout,
//      per-claim confidence, caveats, the outcome, and the real search_universe.
//
// Actor-observability (the user sees ONLY the rendered report): renderReport derives the
// verify-at-checkout warning from the provenance tier itself, not solely from the data flag, so a
// mis-flagged scraped price can never reach the user without the caveat. The calibration check is what
// catches the underlying data fault at test time.

import { rankCandidates } from "./grid.mjs";
import { rankingModel } from "./decision.mjs";

const HIGH_BAND = 0.8; // docs/definitions.md §6: confidence >= 0.80 is the "high" band.

/**
 * Map a 0..1 confidence to its named band (docs/definitions.md §6). A missing / non-numeric value is
 * "unknown" — never silently rendered as if it were high.
 */
export function confidenceBand(x) {
  if (typeof x !== "number" || Number.isNaN(x)) return "unknown";
  if (x >= HIGH_BAND) return "high";
  if (x >= 0.5) return "moderate";
  if (x >= 0.2) return "low";
  return "negligible";
}

/** Authoritative = a merchant/aggregator `api` tier. Every other tier is scraped / non-authoritative. */
export function isScrapedTier(tier) {
  return tier !== "api";
}

/**
 * Returns a violation string when a single offer's confidence/provenance is miscalibrated, else null
 * (docs/definitions.md §7). The OFFER analog of decision.mjs::claimConfidenceViolation:
 *   - offer_confidence missing / non-numeric / out of [0,1];
 *   - a scraped (non-api) price not marked verify_at_checkout;
 *   - a scraped price claiming the high (>=0.80) band — a scraped point-in-time price can't be near-certain.
 * Authoritative (api) offers may omit verify_at_checkout and may sit in the high band.
 */
export function offerConfidenceViolation(offer) {
  const c = offer?.offer_confidence;
  if (typeof c !== "number" || Number.isNaN(c)) return "missing or non-numeric offer_confidence";
  if (c < 0 || c > 1) return `offer_confidence ${c} out of range [0,1]`;
  const scraped = isScrapedTier(offer.provenance_tier); // undefined tier -> treated as scraped (fail-closed).
  if (scraped && offer.verify_at_checkout !== true)
    return `scraped (${offer.provenance_tier ?? "unknown"}) price must be marked verify_at_checkout`;
  if (scraped && c >= HIGH_BAND)
    return `scraped (${offer.provenance_tier ?? "unknown"}) price cannot reach the high confidence band, got ${c}`;
  return null;
}

/** All per-offer calibration violations across a Recommendation Object (empty array = all calibrated). */
export function offerViolations(rec) {
  const out = [];
  for (const o of rec.offers ?? []) {
    const v = offerConfidenceViolation(o);
    if (v) out.push(`${o.merchant ?? "<offer>"}: ${v}`);
  }
  return out;
}

// --- Rendering -------------------------------------------------------------------------------------

const conf = (x) => `${confidenceBand(x)} (${typeof x === "number" ? x.toFixed(2) : "n/a"})`;
const orNone = (arr) => (arr && arr.length ? arr.join(", ") : "none");

function renderBudget(req) {
  const b = req?.budget;
  const bits = [];
  if (b) {
    const cur = b.currency ? ` ${b.currency}` : "";
    if (typeof b.max === "number") bits.push(`Budget: up to ${b.max}${cur}${typeof b.target === "number" ? ` (target ${b.target})` : ""}`);
    else if (typeof b.target === "number") bits.push(`Budget: target ${b.target}${cur}`);
  }
  if (req?.region) bits.push(`Region: ${req.region}`);
  return bits.join(" · ");
}

/** Ranked grid rows joined back to their candidate (evidence) and shortlist item (counterevidence). */
function renderGrid(rec, lines) {
  const ranked = rankCandidates(rankingModel(rec));
  if (!ranked.length) return;
  const candByProduct = new Map((rec.candidates ?? []).map((c) => [c.product, c]));
  const shortByProduct = new Map((rec.shortlist ?? []).map((s) => [s.product, s]));
  lines.push("## The grid (ranked by fundamentals, then independent recurrence)");
  ranked.forEach((row, i) => {
    const flags = [];
    if (row.recalled) flags.push("RECALLED — disqualified");
    if (row.joinMissing) flags.push("identity join failed");
    lines.push(
      `${i + 1}. ${row.product}${row.maker ? ` by ${row.maker}` : ""} — fundamentals ${row.fundamentals_score} · ` +
      `independent clusters ${row.recurrence_over_clusters}${flags.length ? ` · ${flags.join(" · ")}` : ""}`,
    );
    for (const ev of candByProduct.get(row.product)?.evidence ?? [])
      lines.push(`   - "${ev.claim}" — ${conf(ev.claim_confidence)}`);
    for (const ce of shortByProduct.get(row.product)?.counterevidence ?? [])
      lines.push(`   - counterevidence (${ce.kind}): ${ce.detail}${ce.source ? ` [${ce.source}]` : ""}`);
  });
  lines.push("");
}

function renderOffers(rec, lines) {
  const offers = rec.offers ?? [];
  if (!offers.length) return;
  lines.push("## Offers (where to buy)");
  for (const o of offers) {
    const parts = [
      `${o.merchant} — ${o.price}${o.currency ? ` ${o.currency}` : ""}`,
      `provenance: ${o.provenance_tier}`,
      `confidence: ${conf(o.offer_confidence)}`,
    ];
    if (o.timestamp) parts.push(`as of ${o.timestamp}`);
    if (o.region) parts.push(`region: ${o.region}`);
    if (o.returns) parts.push(`returns: ${o.returns}`);
    if (o.warranty) parts.push(`warranty: ${o.warranty}`);
    // User-observability defense: warn on any scraped tier even if the data flag is (wrongly) unset.
    if (o.verify_at_checkout === true || isScrapedTier(o.provenance_tier)) parts.push("⚠ verify at checkout");
    lines.push(`- ${parts.join(" · ")}`);
  }
  lines.push("");
}

/**
 * Render a Recommendation Object into a human report. Honest by construction: an INSUFFICIENT_EVIDENCE
 * object prints its reason_code and the grid of what was considered but NO fabricated pick; the real
 * search_universe (including failed/blocked sources and unavailable tiers) is always surfaced.
 */
export function renderReport(rec) {
  const lines = [];
  lines.push("# Discern recommendation", "");
  const head = [`**Outcome:** ${rec.outcome}`];
  if (rec.reason_code && rec.reason_code !== "NONE") head.push(`**Reason:** ${rec.reason_code}`);
  head.push(`**Overall confidence:** ${conf(rec.confidence_overall)}`);
  lines.push(head.join("  ·  "), "");

  if (rec.framed_requirements?.need) {
    lines.push("## Need", rec.framed_requirements.need);
    const b = renderBudget(rec.framed_requirements);
    if (b) lines.push(b);
    lines.push("");
  }

  if (rec.pick) {
    lines.push(`## Pick — ${rec.pick.product}${rec.pick.maker ? ` by ${rec.pick.maker}` : ""}`);
    if (rec.rationale) lines.push(rec.rationale);
    if (rec.value_assessment?.summary)
      lines.push(`**Value:** ${rec.value_assessment.summary}${rec.value_assessment.value_per_dollar ? ` (value-per-dollar: ${rec.value_assessment.value_per_dollar})` : ""}`);
    lines.push("");
  } else {
    lines.push("## No single pick", "No candidate cleared the bar — see the reason above and the grid below.", "");
  }

  renderGrid(rec, lines);

  if (rec.runners_up?.length) {
    lines.push("## Runners-up");
    for (const r of rec.runners_up) lines.push(`- ${r.product}${r.maker ? ` by ${r.maker}` : ""}`);
    lines.push("");
  }

  renderOffers(rec, lines);

  if (rec.caveats?.length) {
    lines.push("## Caveats");
    for (const c of rec.caveats) lines.push(`- ${c}`);
    lines.push("");
  }

  const su = rec.search_universe ?? {};
  lines.push("## Search universe");
  lines.push(`Queries run: ${orNone(su.queries_run)}`);
  lines.push(`Sources hit: ${orNone(su.sources_hit)}`);
  lines.push(`Failed/blocked: ${orNone(su.sources_failed_or_blocked)}`);
  lines.push(`Tiers unavailable: ${orNone(su.tiers_unavailable)}`);
  lines.push(`Budgets hit: ${orNone(su.budgets_hit)}`);
  lines.push(`Fetches used: ${typeof su.fetches_used === "number" ? su.fetches_used : "n/a"}`);

  return lines.join("\n");
}
