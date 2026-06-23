// Discern Phase 2 logic tests: independence clustering, R1 grid ranking, affiliate down-weighting.
// Runs via `npm test` (after schema validation). Exits non-zero on any failure.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clusterSources, distinctClusters, recurrenceByProduct, sourceWeight } from "./cluster.mjs";
import { gridWinner } from "./grid.mjs";
import {
  choosePick,
  decideOutcome,
  confidenceViolations,
  claimConfidenceViolation,
  runBeneficiaryDecision,
  shortlistJoinViolations,
} from "./decision.mjs";
import {
  renderReport,
  confidenceBand,
  offerConfidenceViolation,
  offerViolations,
} from "./render.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const failures = [];
let checks = 0;
const expect = (name, cond, detail) => { checks++; if (!cond) failures.push(`${name}: ${detail}`); };

// --- Independence clustering: syndicated listicles collapse to one signal ---------------------------
{
  const fx = load("evals/independence-cluster.json");
  const clustered = clusterSources(fx.sources);
  const clusters = distinctClusters(clustered);
  const rec = recurrenceByProduct(clustered);
  expect("independence-cluster: distinct_clusters", clusters === fx.expected.distinct_clusters,
    `expected ${fx.expected.distinct_clusters}, got ${clusters}`);
  expect("independence-cluster: recurrence_WidgetA", rec.WidgetA === fx.expected.recurrence_WidgetA,
    `expected ${fx.expected.recurrence_WidgetA}, got ${rec.WidgetA}`);
  // exactly one representative across the single cluster
  const reps = clustered.filter((s) => s.independence_flag).length;
  expect("independence-cluster: one representative", reps === clusters,
    `expected ${clusters} representative(s), got ${reps}`);
}

// --- R1 ranking: fundamentals outrank raw frequency ------------------------------------------------
{
  const fx = load("evals/ranking-invariant.json");
  const winner = gridWinner(fx.candidates);
  expect("ranking-invariant R1: winner", winner.product === fx.expected.winner,
    `expected ${fx.expected.winner}, got ${winner.product}`);
}

// --- Affiliate down-weighting (not zeroed) ---------------------------------------------------------
{
  const fx = load("evals/affiliate-downweight.json");
  const indep = fx.sources.find((s) => !s.affiliate_or_sponsored_flag);
  const aff = fx.sources.find((s) => s.affiliate_or_sponsored_flag);
  const wi = sourceWeight(indep), wa = sourceWeight(aff);
  expect("affiliate-downweight: independent > affiliate",
    (wi > wa) === fx.expected.independent_weight_gt_affiliate,
    `independent ${wi} vs affiliate ${wa}; expected independent_weight_gt_affiliate=${fx.expected.independent_weight_gt_affiliate}`);
  expect("affiliate-downweight: affiliate > 0",
    (wa > 0) === fx.expected.affiliate_weight_gt_zero,
    `affiliate weight ${wa}; expected affiliate_weight_gt_zero=${fx.expected.affiliate_weight_gt_zero}`);
}

// --- Phase 3: decision engine — R1 pick reproduces each golden's stated pick ------------------------
{
  const cases = [
    ["evals/golden/electronics-headphones.json", "Sony WH-1000XM5"],
    ["evals/golden/clothing-natural-materials.json", "Organic Cotton Oxford"],
    ["evals/golden/gift-recipient.json", "Handmade Ceramic Pour-over Set"],
  ];
  for (const [file, want] of cases) {
    const { pick } = choosePick(load(file));
    expect(`choosePick: ${file}`, pick && pick.product === want, `expected ${want}, got ${pick && pick.product}`);
  }
}

// --- Phase 3: outcome family is consistent with each golden's stated outcome ------------------------
{
  const familyOf = (o) => (o === "INSUFFICIENT_EVIDENCE" ? "INSUFFICIENT_EVIDENCE" : "RECOMMEND");
  for (const name of ["electronics-headphones", "clothing-natural-materials", "gift-recipient", "safety-supplement"]) {
    const rec = load(`evals/golden/${name}.json`);
    const d = decideOutcome(rec);
    expect(`decideOutcome family: ${name}`, d.family === familyOf(rec.outcome),
      `engine ${d.family} vs stated ${rec.outcome}`);
  }
  // Safety-relevant brand-proxy-only support must derive UNSAFE_BRAND_PROXY, never a guess.
  const safety = decideOutcome(load("evals/golden/safety-supplement.json"));
  expect("decideOutcome: safety -> UNSAFE_BRAND_PROXY", safety.reason_code === "UNSAFE_BRAND_PROXY",
    `got reason_code ${safety.reason_code}`);
}

// --- Phase 3: per-claim confidence calibration -----------------------------------------------------
{
  // Real golden fixtures must carry calibrated confidence on every claim (no violations).
  for (const name of ["electronics-headphones", "clothing-natural-materials", "gift-recipient", "safety-supplement"]) {
    const v = confidenceViolations(load(`evals/golden/${name}.json`));
    expect(`confidence calibrated: ${name}`, v.length === 0, `violations: ${v.join("; ")}`);
  }
  // The calibration check REJECTS miscalibrated / missing-value claims and ACCEPTS calibrated ones.
  const fx = load("evals/confidence-calibration.json");
  for (const c of fx.cases) {
    const v = claimConfidenceViolation(c.claim, { unresolved: c.unresolved, recurrence: c.recurrence });
    expect(`calibration: ${c.name}`, (v !== null) === c.expect_violation,
      `expected violation=${c.expect_violation}, got ${v === null ? "none" : v}`);
  }
}

// --- Phase 3: value framework shapes the pick (not just hard filters + fundamentals) ----------------
{
  const fx = load("evals/value-framework.json");
  const withFramework = runBeneficiaryDecision(fx.candidates, { selfProfile: fx.self_profile }, "self");
  const fundamentalsOnly = runBeneficiaryDecision(fx.candidates, { selfProfile: fx.neutral_profile }, "self");
  expect("value-framework: framework winner", withFramework.winner === fx.expected.winner_with_framework,
    `expected ${fx.expected.winner_with_framework}, got ${withFramework.winner}`);
  expect("value-framework: fundamentals-only winner", fundamentalsOnly.winner === fx.expected.winner_fundamentals_only,
    `expected ${fx.expected.winner_fundamentals_only}, got ${fundamentalsOnly.winner}`);
  // The two must DIFFER, else the framework changed nothing (a vacuous pass).
  expect("value-framework: framework actually flips the winner",
    withFramework.winner !== fundamentalsOnly.winner,
    `framework winner ${withFramework.winner} == fundamentals-only winner ${fundamentalsOnly.winner}`);
}

// --- Phase 3: self-vs-gift switch (observable differences per definitions.md §5) --------------------
{
  const fx = load("evals/gift-vs-self.json");
  const profiles = { selfProfile: fx.self_profile, recipientProfile: fx.recipient_profile };
  const self = runBeneficiaryDecision(fx.candidates, profiles, "self");
  const recip = runBeneficiaryDecision(fx.candidates, profiles, "recipient");

  expect("gift-vs-self: self winner", self.winner === fx.expected.self.winner,
    `expected ${fx.expected.self.winner}, got ${self.winner}`);
  expect("gift-vs-self: recipient winner", recip.winner === fx.expected.recipient.winner,
    `expected ${fx.expected.recipient.winner}, got ${recip.winner}`);
  expect("gift-vs-self: self applies its own hard filter",
    self.disqualified.includes(fx.expected.self.disqualified[0]),
    `self disqualified=${JSON.stringify(self.disqualified)}`);
  expect("gift-vs-self: recipient applies its own hard filter",
    recip.disqualified.includes(fx.expected.recipient.disqualified[0]),
    `recipient disqualified=${JSON.stringify(recip.disqualified)}`);
  // The self-only hard filter (applies_to_gifts=false) must NOT transfer to the gift branch.
  expect("gift-vs-self: self-only filter does not transfer",
    !recip.disqualified.includes(fx.expected.self_only_filter_not_transferred),
    `recipient wrongly disqualified ${fx.expected.self_only_filter_not_transferred}`);
  // Returnability is weighted UP only in the gift branch (and here it flips the winner).
  expect("gift-vs-self: returnability weighted for recipient", recip.returnabilityApplied === true,
    `recipient returnabilityApplied=${recip.returnabilityApplied}`);
  expect("gift-vs-self: returnability NOT weighted for self", self.returnabilityApplied === false,
    `self returnabilityApplied=${self.returnabilityApplied}`);
}

// --- Phase 3: ties surface a judgment call; recalls demote; all-recalled & safety-bypass are caught -
{
  const fx = load("evals/decision-outcomes.json");
  for (const c of fx.cases) {
    const d = decideOutcome(c.rec);
    const p = choosePick(c.rec);
    if (c.expect.family !== undefined)
      expect(`decision ${c.name}: family`, d.family === c.expect.family, `expected ${c.expect.family}, got ${d.family}`);
    if (c.expect.reason_code !== undefined)
      expect(`decision ${c.name}: reason_code`, d.reason_code === c.expect.reason_code,
        `expected ${c.expect.reason_code}, got ${d.reason_code}`);
    if (c.expect.tie !== undefined)
      expect(`decision ${c.name}: tie surfaced`, p.tie === c.expect.tie && d.tie === c.expect.tie,
        `expected tie=${c.expect.tie}, got pick.tie=${p.tie}, outcome.tie=${d.tie}`);
    if (c.expect.pickNull === true)
      expect(`decision ${c.name}: no sole pick fabricated`, p.pick === null,
        `expected pick=null, got ${p.pick && p.pick.product}`);
    if (c.expect.tiedProducts !== undefined) {
      const got = p.tiedPicks.map((t) => t.product).sort();
      const want = [...c.expect.tiedProducts].sort();
      expect(`decision ${c.name}: tied finalists surfaced`, JSON.stringify(got) === JSON.stringify(want),
        `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
    if (c.expect.pick !== undefined)
      expect(`decision ${c.name}: pick`, p.pick && p.pick.product === c.expect.pick,
        `expected ${c.expect.pick}, got ${p.pick && p.pick.product}`);
    if (c.expect.pick_not !== undefined)
      expect(`decision ${c.name}: recall demotes pick`, !p.pick || p.pick.product !== c.expect.pick_not,
        `pick must not be ${c.expect.pick_not}, got ${p.pick && p.pick.product}`);
    if (c.expect.joinViolations !== undefined) {
      const v = shortlistJoinViolations(c.rec);
      for (const prod of c.expect.joinViolations)
        expect(`decision ${c.name}: join violation surfaced (${prod})`, v.some((s) => s.startsWith(prod)),
          `expected a join violation for ${prod}, got ${JSON.stringify(v)}`);
    }
  }
  // Healthy golden fixtures must have ZERO shortlist-join violations (referential integrity holds).
  for (const name of ["electronics-headphones", "clothing-natural-materials", "gift-recipient"]) {
    const v = shortlistJoinViolations(load(`evals/golden/${name}.json`));
    expect(`join integrity: ${name}`, v.length === 0, `violations: ${v.join("; ")}`);
  }
}

// --- Phase 4: offer calibration + verify-at-checkout + rendering (definitions.md §7; docs/render.md) -
{
  // Real golden offers must all be calibrated: confidence present + in range, scraped -> verify_at_checkout,
  // no scraped price riding the high band. (Acceptance: REJECT any offer lacking a calibrated confidence.)
  for (const name of ["electronics-headphones", "clothing-natural-materials", "gift-recipient"]) {
    const v = offerViolations(load(`evals/golden/${name}.json`));
    expect(`offer calibrated: ${name}`, v.length === 0, `violations: ${v.join("; ")}`);
  }
  // The offer-calibration check REJECTS miscalibrated offers and ACCEPTS calibrated ones (each rule bites).
  const fx = load("evals/offer-confidence.json");
  for (const c of fx.cases) {
    const v = offerConfidenceViolation(c.offer);
    expect(`offer-calibration: ${c.name}`, (v !== null) === c.expect_violation,
      `expected violation=${c.expect_violation}, got ${v === null ? "none" : v}`);
  }

  // Renderer surfaces the human report: outcome, pick, rationale, runners-up, each offer's confidence BAND,
  // the verify-at-checkout marker, per-claim confidence, caveats, and the real search_universe.
  const rec = load("evals/golden/electronics-headphones.json");
  const report = renderReport(rec);
  expect("render: shows outcome", report.includes("RECOMMEND"), `report missing outcome:\n${report}`);
  expect("render: shows pick", report.includes(rec.pick.product), `report missing pick ${rec.pick.product}`);
  expect("render: shows rationale", report.includes(rec.rationale.slice(0, 24)), `report missing rationale`);
  expect("render: shows runner-up", report.includes(rec.runners_up[0].product), `report missing runner-up`);
  // Assert on the offer's OWN line (not the whole report) so the band/verify checks cannot pass vacuously
  // from grid or overall-confidence text that happens to share the band word.
  const reportLines = report.split("\n");
  for (const o of rec.offers) {
    const cell = `confidence: ${confidenceBand(o.offer_confidence)} (${o.offer_confidence.toFixed(2)})`;
    const line = reportLines.find((l) => l.includes(o.merchant) && l.includes(String(o.price)));
    expect(`render: offer ${o.merchant} has its own line`, !!line, `no offer line for ${o.merchant}`);
    expect(`render: offer ${o.merchant} shows calibrated confidence on its line`, !!line && line.includes(cell),
      `offer line missing "${cell}": ${line}`);
    // A scraped (non-api) offer must NEVER be presented without the verify-at-checkout warning, on its own line.
    expect(`render: offer ${o.merchant} shows verify-at-checkout on its line`, !!line && /verify at checkout/i.test(line),
      `offer line missing verify marker: ${line}`);
  }
  // Per-claim confidence is displayed (claim text + band).
  const ev0 = rec.candidates[0].evidence[0];
  expect("render: shows a per-claim line", report.includes(ev0.claim.slice(0, 20)), `report missing per-claim line`);
  // search_universe transparency: queries run + unavailable tiers appear in the report.
  for (const q of rec.search_universe.queries_run)
    expect(`render: shows query "${q}"`, report.includes(q), `report missing query ${q}`);
  for (const t of rec.search_universe.tiers_unavailable)
    expect(`render: shows unavailable tier "${t}"`, report.includes(t), `report missing tier ${t}`);
  // Caveats are surfaced verbatim.
  expect("render: shows caveat", report.includes(rec.caveats[0]), `report missing caveat`);

  // INSUFFICIENT_EVIDENCE renders honestly: reason_code shown, NO fabricated pick, universe still surfaced.
  const insuf = load("evals/golden/safety-supplement.json");
  const ir = renderReport(insuf);
  expect("render: insufficient shows outcome", ir.includes("INSUFFICIENT_EVIDENCE"), `missing outcome`);
  expect("render: insufficient shows reason_code", ir.includes(insuf.reason_code), `missing reason_code ${insuf.reason_code}`);
  expect("render: insufficient surfaces search_universe", /search universe/i.test(ir), `missing universe section`);
}

// --- Phase 4 review hardening: the RENDERER enforces calibration + degrades observably (ensemble) ----
{
  const base = load("evals/golden/electronics-headphones.json");

  // HIGH-1: the renderer must run the calibration check itself — a scraped, high-band price is NEVER
  // shown to the user as trusted "high" confidence (the dishonesty §7 exists to prevent).
  const scrapedHigh = structuredClone(base);
  scrapedHigh.offers = [{ merchant: "ShadyShop", price: 99, currency: "USD", provenance_tier: "browser",
    timestamp: "2026-06-22", offer_confidence: 0.95, verify_at_checkout: true }];
  const shReport = renderReport(scrapedHigh);
  expect("render hardening: scraped high-band NOT shown as high", !shReport.includes("high (0.95)"),
    `scraped price shown as high:\n${shReport}`);
  expect("render hardening: scraped high-band flagged uncalibrated", /uncalibrated/i.test(shReport),
    `missing uncalibrated marker:\n${shReport}`);
  expect("render hardening: scraped offer still warns verify-at-checkout", /verify at checkout/i.test(shReport),
    `missing verify marker`);

  // HIGH-1b: a missing offer_confidence renders an uncalibrated marker, never a trusted band.
  const noConf = structuredClone(base);
  noConf.offers = [{ merchant: "NoConfShop", price: 100, currency: "USD", provenance_tier: "fetch",
    timestamp: "2026-06-22", verify_at_checkout: true }];
  expect("render hardening: missing offer confidence flagged uncalibrated", /uncalibrated/i.test(renderReport(noConf)),
    `missing uncalibrated marker for no-confidence offer`);

  // HIGH-2: a null offer element must not crash the whole report (renderReport + offerViolations both guard).
  const nullOffer = structuredClone(base);
  nullOffer.offers = [null, base.offers[0]];
  let threw = false, nr = "";
  try { nr = renderReport(nullOffer); } catch { threw = true; }
  expect("render hardening: null offer element does not crash render", !threw && nr.length > 0, `renderReport threw on null offer`);
  expect("render hardening: malformed offer surfaced", /malformed offer/i.test(nr), `missing malformed-offer note`);
  let threw2 = false;
  try { offerViolations(nullOffer); } catch { threw2 = true; }
  expect("render hardening: offerViolations does not crash on null offer", !threw2, `offerViolations threw on null offer`);

  // Codex HIGH: an INSUFFICIENT_EVIDENCE object carrying a stray pick must NOT render it as the recommendation.
  const insufWithPick = structuredClone(base);
  insufWithPick.outcome = "INSUFFICIENT_EVIDENCE";
  insufWithPick.reason_code = "THIN_EVIDENCE";
  const iwp = renderReport(insufWithPick);
  expect("render hardening: no Pick section for INSUFFICIENT_EVIDENCE", !iwp.includes("## Pick"),
    `Pick section rendered for INSUFFICIENT_EVIDENCE:\n${iwp}`);
  expect("render hardening: INSUFFICIENT shows reason", iwp.includes("THIN_EVIDENCE"), `missing reason`);

  // MED-1: a RECOMMEND with a pick but no offers must surface the sourcing gap, not silently omit it.
  const noOffers = structuredClone(base);
  delete noOffers.offers;
  expect("render hardening: empty offers surfaces sourcing gap", /no offers sourced/i.test(renderReport(noOffers)),
    `missing sourcing-gap note`);

  // LOW-1: rendering a null / non-object recommendation must not throw.
  let threw3 = false, nullRec = "";
  try { nullRec = renderReport(null); } catch { threw3 = true; }
  expect("render hardening: renderReport(null) does not throw", !threw3 && nullRec.length > 0, `renderReport(null) threw`);
}

// --- Report ----------------------------------------------------------------------------------------
if (failures.length) {
  console.error(`\nLOGIC FAIL — ${failures.length} problem(s) across ${checks} checks:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`OK — ${checks} logic checks passed (clustering + R1 ranking + affiliate weighting + decision engine + confidence calibration + gift switch + offer calibration + rendering).`);
