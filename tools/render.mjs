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
import { isDisqualified } from "./disqualify.mjs";

const HIGH_BAND = 0.8; // docs/definitions.md §6: confidence >= 0.80 is the "high" band.
const KNOWN_TIERS = new Set(["search", "fetch", "browser", "api"]); // schema offer.provenance_tier enum.

/**
 * Map a 0..1 confidence to its named band (docs/definitions.md §6). A missing / non-numeric value is
 * "unknown" — never silently rendered as if it were high.
 */
export function confidenceBand(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return "unknown"; // NaN and ±Infinity are never a band.
  if (x >= HIGH_BAND) return "high";
  if (x >= 0.5) return "moderate";
  if (x >= 0.2) return "low";
  return "negligible";
}

/** Authoritative = a merchant/aggregator `api` tier. Every other tier is scraped / non-authoritative. */
export function isScrapedTier(tier) {
  return tier !== "api";
}

/** A valid record element: a plain object, not null and not an array. Used to filter untrusted input. */
const isRecord = (o) => !!o && typeof o === "object" && !Array.isArray(o);

/**
 * Coerce an interpolated leaf to a safe display string. Primitives render as text; anything else
 * (object/array/null/undefined) renders as the fallback — never a leaked "[object Object]"/"undefined".
 */
const safeStr = (v, fallback = "⚠ unavailable") => {
  const t = typeof v;
  if (t === "string") return v;
  if (t === "number" || t === "boolean") return String(v);
  return fallback;
};

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
const orNone = (arr) => (Array.isArray(arr) && arr.length ? arr.map((x) => safeStr(x)).join(", ") : "none");

/** The shortlist item matching a product — the pick joins to its fundamentals card by product name. */
function shortlistFor(rec, product) {
  return (Array.isArray(rec.shortlist) ? rec.shortlist : [])
    .filter(isRecord)
    .find((s) => s.product === product) ?? null;
}

/**
 * A compact "Best price" bit for the at-a-glance header: the lowest-priced offer, with the
 * verify-at-checkout caveat when the price is scraped. Empty for non-recommend outcomes or when
 * no offer carries a finite price (the Offers section still shows the full sourcing picture).
 */
function bestPriceBit(rec, recommendFamily) {
  if (!recommendFamily) return "";
  const priced = (Array.isArray(rec.offers) ? rec.offers : [])
    .filter((o) => isRecord(o) && Number.isFinite(o.price))
    .sort((a, b) => a.price - b.price);
  const o = priced[0];
  if (!o) return "";
  const cur = o.currency ? ` ${safeStr(o.currency, "")}` : "";
  const verify = o.verify_at_checkout === true || isScrapedTier(o.provenance_tier) ? " (verify at checkout)" : "";
  return `**Best price:** ${o.price}${cur}${verify}`;
}

function renderBudget(req) {
  const b = req?.budget;
  const bits = [];
  if (b) {
    const cur = b.currency ? ` ${safeStr(b.currency, "")}` : "";
    if (typeof b.max === "number") bits.push(`Budget: up to ${b.max}${cur}${typeof b.target === "number" ? ` (target ${b.target})` : ""}`);
    else if (typeof b.target === "number") bits.push(`Budget: target ${b.target}${cur}`);
  }
  if (req?.region) bits.push(`Region: ${safeStr(req.region)}`);
  return bits.join(" · ");
}

/** Ranked grid rows joined back to their candidate (evidence) and shortlist item (counterevidence). */
function renderGrid(rec, lines) {
  // Filter to well-formed records so a malformed (non-array, or null/array element) candidates/shortlist
  // degrades to an empty/partial grid instead of throwing and blanking the whole report. Any dropped
  // element is surfaced (observable), never silently swallowed.
  const candRaw = Array.isArray(rec.candidates) ? rec.candidates : [];
  const shortRaw = Array.isArray(rec.shortlist) ? rec.shortlist : [];
  const candidates = candRaw.filter(isRecord);
  // Also sanitize each shortlist item's nested counterevidence to a record array, so rankingModel's
  // recall scan (decision.mjs) can't choke on a null/non-array element deep in the structure.
  const shortlist = shortRaw.filter(isRecord).map((s) => ({
    ...s,
    counterevidence: (Array.isArray(s.counterevidence) ? s.counterevidence : []).filter(isRecord),
  }));
  const dropped = (candRaw.length - candidates.length) + (shortRaw.length - shortlist.length);
  const ranked = rankCandidates(rankingModel({ ...rec, candidates, shortlist }));
  if (!ranked.length && !dropped) return;
  const candByProduct = new Map(candidates.map((c) => [c.product, c]));
  const shortByProduct = new Map(shortlist.map((s) => [s.product, s]));
  lines.push("## The grid (ranked by fundamentals, then independent recurrence)");
  ranked.forEach((row, i) => {
    const flags = [];
    if (row.recalled) flags.push("RECALLED — disqualified");
    // Derive the disqualified marker from the SHARED predicate on this item's counterevidence — the
    // same "renderer recomputes the check itself" discipline renderOffers uses for
    // offerConfidenceViolation — so the prose grid, the decision engine, and the comparison tableau
    // stay in lockstep on what "disqualified" means (disqualify.mjs; design §6a/§13).
    if (isDisqualified(shortByProduct.get(row.product)?.counterevidence)) flags.push("DISQUALIFIED — dealbreaker");
    if (row.joinMissing) flags.push("identity join failed");
    lines.push(
      `${i + 1}. ${safeStr(row.product, "<unknown>")}${row.maker ? ` by ${safeStr(row.maker)}` : ""} — fundamentals ${safeStr(row.fundamentals_score)} · ` +
      `independent clusters ${safeStr(row.recurrence_over_clusters)}${flags.length ? ` · ${flags.join(" · ")}` : ""}`,
    );
    for (const ev of candByProduct.get(row.product)?.evidence ?? []) {
      if (!isRecord(ev)) { lines.push(`   - ⚠ malformed evidence omitted`); continue; }
      lines.push(`   - "${safeStr(ev.claim, "<no claim>")}" — ${conf(ev.claim_confidence)}`);
    }
    for (const ce of shortByProduct.get(row.product)?.counterevidence ?? []) {
      if (!isRecord(ce)) { lines.push(`   - ⚠ malformed counterevidence omitted`); continue; }
      lines.push(`   - counterevidence (${safeStr(ce.kind, "unspecified")}): ${safeStr(ce.detail, "unspecified")}${ce.source ? ` [${safeStr(ce.source)}]` : ""}`);
    }
  });
  if (dropped) lines.push(`⚠ ${dropped} malformed candidate record(s) omitted`);
  lines.push("");
}

function renderOffers(rec, lines, recommendFamily) {
  const offers = Array.isArray(rec.offers) ? rec.offers : [];
  // Never surface a "where to buy" buy signal under a non-recommend outcome. If offers were nonetheless
  // present on such an object, say so (observable) rather than directing a purchase.
  if (!recommendFamily) {
    if (offers.length)
      lines.push("## Offers", `${offers.length} offer(s) seen during search withheld — outcome is ${rec.outcome ?? "unknown"}, no recommendation made.`, "");
    return;
  }
  if (!offers.length) {
    // A recommend-family outcome with no sourced offers is a visible gap, not a silent omission —
    // including a tie (no single pick), where the absence of sourcing is itself load-bearing.
    lines.push("## Offers (where to buy)", "No offers sourced — see Search universe below.", "");
    return;
  }
  lines.push("## Offers (where to buy)");
  for (const o of offers) {
    if (!isRecord(o)) { lines.push("- ⚠ malformed offer omitted"); continue; } // never deref a bad element
    const violation = offerConfidenceViolation(o); // renderer runs the SAME check the gate uses.
    const priceStr = Number.isFinite(o.price) ? `${o.price}${o.currency ? ` ${safeStr(o.currency, "")}` : ""}` : "price unavailable";
    const parts = [
      `${safeStr(o.merchant, "<unknown merchant>")} — ${priceStr}`,
      `provenance: ${safeStr(o.provenance_tier, "unknown")}`,
      // An uncalibrated offer never shows a trusted band — it shows WHY it can't be trusted.
      violation ? `⚠ uncalibrated (${violation})` : `confidence: ${conf(o.offer_confidence)}`,
    ];
    if (o.timestamp) parts.push(`as of ${safeStr(o.timestamp)}`);
    if (o.region) parts.push(`region: ${safeStr(o.region)}`);
    if (o.returns) parts.push(`returns: ${safeStr(o.returns)}`);
    if (o.warranty) parts.push(`warranty: ${safeStr(o.warranty)}`);
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
  const lines = ["# Discern recommendation", ""];

  // Backstop: the targeted guards below handle every known malformed shape gracefully, but the renderer's
  // contract is to NEVER throw to the (user-facing) caller. The whole body — header through the final
  // join — is wrapped, so any residual throw degrades to the partial report built so far plus a note.
  try {
  const recommendFamily = rec.outcome === "RECOMMEND" || rec.outcome === "RECOMMEND_WITH_CAVEATS";
  const head = [`**Outcome:** ${safeStr(rec.outcome, "(missing outcome)")}`];
  if (rec.reason_code && rec.reason_code !== "NONE") head.push(`**Reason:** ${safeStr(rec.reason_code)}`);
  head.push(`**Overall confidence:** ${conf(rec.confidence_overall)}`);
  const price = bestPriceBit(rec, recommendFamily); // at-a-glance: the answer + its price in one line
  if (price) head.push(price);
  lines.push(head.join("  ·  "), "");

  if (rec.framed_requirements?.need) {
    lines.push("## Need", safeStr(rec.framed_requirements.need));
    const b = renderBudget(rec.framed_requirements);
    if (b) lines.push(b);
    lines.push("");
  }

  // A pick is presented ONLY for a RECOMMEND-family outcome with a well-formed pick (a real product) —
  // never under INSUFFICIENT_EVIDENCE, and never a stray/garbled pick rendered as "## Pick — undefined".
  if (recommendFamily && isRecord(rec.pick) && rec.pick.product) {
    lines.push(`## Pick — ${safeStr(rec.pick.product)}${rec.pick.maker ? ` by ${safeStr(rec.pick.maker)}` : ""}`);
    // Scannable-first (docs/render.md §3): lead with the pick's fundamentals-card summary, then the
    // structured teardown as "Why it wins" bullets (dimension → finding — the data the method already
    // produced but the report used to discard), then value, and ONLY then the full prose rationale,
    // demoted under "Full reasoning" so the reader grasps the bullets before the paragraph.
    const card = isRecord(shortlistFor(rec, rec.pick.product)?.fundamentals_card)
      ? shortlistFor(rec, rec.pick.product).fundamentals_card : null;
    if (card?.summary) lines.push(safeStr(card.summary), "");
    const fundamentals = (Array.isArray(card?.fundamentals) ? card.fundamentals : []).filter(isRecord);
    if (fundamentals.length) {
      // `###` sub-headings (block-level) rather than `**bold**` (inline): they read as distinct
      // sections AND don't merge into the following paragraph the way inline bold does.
      lines.push("### Why it wins", "");
      for (const f of fundamentals) lines.push(`- **${safeStr(f.dimension, "—")}** — ${safeStr(f.finding, "")}`);
      lines.push("");
    }
    if (rec.value_assessment?.summary)
      lines.push("### Value",
        `${safeStr(rec.value_assessment.summary)}${rec.value_assessment.value_per_dollar ? ` (value-per-dollar: ${safeStr(rec.value_assessment.value_per_dollar)})` : ""}`, "");
    if (rec.rationale) lines.push("### Full reasoning", "", safeStr(rec.rationale), "");
  } else {
    lines.push("## No single pick");
    if (recommendFamily) {
      lines.push("No single pick is presented — the top candidates are tied or none could be resolved; see the grid.");
    } else {
      const reason = rec.reason_code && rec.reason_code !== "NONE" ? safeStr(rec.reason_code) : "unspecified (reason_code missing)";
      lines.push(`Outcome is ${safeStr(rec.outcome, "unknown")} — ${reason}. No pick is presented.`);
    }
    lines.push("");
  }

  renderGrid(rec, lines);

  // Runners-up are recommendations too — only surface them when the outcome actually recommends.
  if (recommendFamily && Array.isArray(rec.runners_up) && rec.runners_up.length) {
    lines.push("## Runners-up");
    for (const r of rec.runners_up) {
      if (!isRecord(r)) { lines.push("- ⚠ malformed runner-up omitted"); continue; }
      lines.push(`- ${safeStr(r.product, "<unknown>")}${r.maker ? ` by ${safeStr(r.maker)}` : ""}`);
    }
    lines.push("");
  }

  renderOffers(rec, lines, recommendFamily);

  if (Array.isArray(rec.caveats) && rec.caveats.length) {
    lines.push("## Caveats");
    for (const c of rec.caveats) lines.push(`- ${safeStr(c)}`);
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
  lines.push(`Angles swept: ${orNone(su.angles_swept)}`);
  return lines.join("\n");
  } catch {
    return lines.join("\n") + "\n\n⚠ Part of this report could not be rendered (malformed data).";
  }
}
