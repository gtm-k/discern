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
// Actor-observability (the user sees ONLY the rendered report): renderReport runs
// offerConfidenceViolation on every offer at render time, so the user and the test gate get the SAME
// signal — a miscalibrated or scraped-high-band offer reaches the user only as "⚠ uncalibrated", never
// as a trusted confidence band. The verify-at-checkout warning is additionally derived from the
// provenance tier itself (not just the data flag), so a mis-flagged scraped price still carries the
// caveat. A malformed/absent offer is surfaced as a visible gap, never silently dropped or crashed on.

import { rankCandidates } from "./grid.mjs";
import { rankingModel } from "./decision.mjs";

const HIGH_BAND = 0.8; // docs/definitions.md §6: confidence >= 0.80 is the "high" band.
const KNOWN_TIERS = new Set(["search", "fetch", "browser", "api"]); // schema offer.provenance_tier enum.

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
  if (!KNOWN_TIERS.has(offer.provenance_tier)) // unknown provenance can't be trusted (fail-closed).
    return `unknown or missing provenance_tier "${offer.provenance_tier}"`;
  const scraped = isScrapedTier(offer.provenance_tier); // any non-api tier is scraped.
  if (scraped && offer.verify_at_checkout !== true)
    return `scraped (${offer.provenance_tier ?? "unknown"}) price must be marked verify_at_checkout`;
  if (scraped && c >= HIGH_BAND)
    return `scraped (${offer.provenance_tier ?? "unknown"}) price cannot reach the high confidence band, got ${c}`;
  return null;
}

/** All per-offer calibration violations across a Recommendation Object (empty array = all calibrated). */
export function offerViolations(rec) {
  const out = [];
  for (const o of rec?.offers ?? []) {
    if (!o || typeof o !== "object") { out.push("<offer>: not an object"); continue; } // guard before any deref
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
  // Coerce sibling arrays so a malformed (non-array) candidates/shortlist degrades to an empty grid
  // instead of throwing and blanking the whole report.
  const candidates = Array.isArray(rec.candidates) ? rec.candidates : [];
  const shortlist = Array.isArray(rec.shortlist) ? rec.shortlist : [];
  const ranked = rankCandidates(rankingModel({ ...rec, candidates, shortlist }));
  if (!ranked.length) return;
  const candByProduct = new Map(candidates.map((c) => [c.product, c]));
  const shortByProduct = new Map(shortlist.map((s) => [s.product, s]));
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

function renderOffers(rec, lines, recommendFamily) {
  const offers = Array.isArray(rec.offers) ? rec.offers : [];
  if (!offers.length) {
    // A recommend-family outcome with no sourced offers is a visible gap, not a silent omission —
    // including a tie (no single pick), where the absence of sourcing is itself load-bearing.
    if (recommendFamily)
      lines.push("## Offers (where to buy)", "No offers sourced — see Search universe below.", "");
    return;
  }
  lines.push("## Offers (where to buy)");
  for (const o of offers) {
    if (!o || typeof o !== "object") { lines.push("- ⚠ malformed offer omitted"); continue; } // never deref a bad element
    const violation = offerConfidenceViolation(o); // renderer runs the SAME check the gate uses.
    const priceStr = typeof o.price === "number" ? `${o.price}${o.currency ? ` ${o.currency}` : ""}` : "price unavailable";
    const parts = [
      `${o.merchant} — ${priceStr}`,
      `provenance: ${o.provenance_tier ?? "unknown"}`,
      // An uncalibrated offer never shows a trusted band — it shows WHY it can't be trusted.
      violation ? `⚠ uncalibrated (${violation})` : `confidence: ${conf(o.offer_confidence)}`,
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
  if (!rec || typeof rec !== "object")
    return "# Discern recommendation\n\n⚠ No recommendation object to render.";
  const recommendFamily = rec.outcome === "RECOMMEND" || rec.outcome === "RECOMMEND_WITH_CAVEATS";
  const lines = [];
  lines.push("# Discern recommendation", "");
  const head = [`**Outcome:** ${rec.outcome ?? "(missing outcome)"}`];
  if (rec.reason_code && rec.reason_code !== "NONE") head.push(`**Reason:** ${rec.reason_code}`);
  head.push(`**Overall confidence:** ${conf(rec.confidence_overall)}`);
  lines.push(head.join("  ·  "), "");

  if (rec.framed_requirements?.need) {
    lines.push("## Need", rec.framed_requirements.need);
    const b = renderBudget(rec.framed_requirements);
    if (b) lines.push(b);
    lines.push("");
  }

  // A pick is presented ONLY for a RECOMMEND-family outcome with an actual pick — never under
  // INSUFFICIENT_EVIDENCE (a stray pick on such an object must not be shown as the recommendation).
  if (recommendFamily && rec.pick) {
    lines.push(`## Pick — ${rec.pick.product}${rec.pick.maker ? ` by ${rec.pick.maker}` : ""}`);
    if (rec.rationale) lines.push(rec.rationale);
    if (rec.value_assessment?.summary)
      lines.push(`**Value:** ${rec.value_assessment.summary}${rec.value_assessment.value_per_dollar ? ` (value-per-dollar: ${rec.value_assessment.value_per_dollar})` : ""}`);
    lines.push("");
  } else {
    lines.push("## No single pick");
    if (recommendFamily) {
      lines.push("Top candidates are tied — presented as a judgment call (see the grid), not a single pick.");
    } else {
      const reason = rec.reason_code && rec.reason_code !== "NONE" ? rec.reason_code : "unspecified (reason_code missing)";
      lines.push(`Outcome is ${rec.outcome ?? "unknown"} — ${reason}. No pick is presented.`);
    }
    lines.push("");
  }

  renderGrid(rec, lines);

  // Runners-up are recommendations too — only surface them when the outcome actually recommends.
  if (recommendFamily && Array.isArray(rec.runners_up) && rec.runners_up.length) {
    lines.push("## Runners-up");
    for (const r of rec.runners_up) {
      if (!r || typeof r !== "object") { lines.push("- ⚠ malformed runner-up omitted"); continue; }
      lines.push(`- ${r.product}${r.maker ? ` by ${r.maker}` : ""}`);
    }
    lines.push("");
  }

  renderOffers(rec, lines, recommendFamily);

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
