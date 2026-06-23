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
import {
  DEFAULTS,
  emptyUniverse,
  detectTiers,
  createGovernor,
  validateSubagentResult,
  orchestrate,
} from "./orchestration.mjs";

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

// --- Phase 4 review hardening ROUND 2 (ensemble round 2: HIGH-3 sibling-array crash, HIGH-4 tie gap,
//     Codex MED unknown-tier, MED-1 raw price leak) -----------------------------------------------
{
  const base = load("evals/golden/electronics-headphones.json");

  // HIGH-3a: a malformed runners_up element must not crash the whole report (same class as the offers guard).
  const badRunner = structuredClone(base);
  badRunner.runners_up = [null, base.runners_up[0]];
  let t1 = false, r1 = "";
  try { r1 = renderReport(badRunner); } catch { t1 = true; }
  expect("render r2: malformed runner-up does not crash", !t1 && r1.length > 0, `renderReport threw on null runner-up`);
  expect("render r2: malformed runner-up surfaced", /malformed runner-up/i.test(r1), `missing malformed runner-up note`);

  // HIGH-3b: a non-array candidates must not crash the report.
  const badCands = structuredClone(base);
  badCands.candidates = "oops";
  let t2 = false, r2 = "";
  try { r2 = renderReport(badCands); } catch { t2 = true; }
  expect("render r2: non-array candidates does not crash", !t2 && r2.length > 0, `renderReport threw on non-array candidates`);

  // HIGH-4: a RECOMMEND-family TIE (pick=null) with no offers still surfaces the sourcing gap.
  const tie = structuredClone(base);
  tie.pick = null; delete tie.offers;
  expect("render r2: tie with no offers surfaces sourcing gap", /no offers sourced/i.test(renderReport(tie)),
    `missing sourcing-gap note for a tie`);

  // Codex MED: an unknown / missing provenance_tier is uncalibrated — unknown provenance cannot be trusted.
  expect("render r2: missing provenance_tier is a violation",
    offerConfidenceViolation({ merchant: "X", price: 10, currency: "USD", offer_confidence: 0.5, verify_at_checkout: true }) !== null,
    `missing provenance_tier accepted as calibrated`);
  const badTier = structuredClone(base);
  badTier.offers = [{ merchant: "MysteryShop", price: 50, currency: "USD", offer_confidence: 0.6, verify_at_checkout: true }];
  expect("render r2: unknown-tier offer renders uncalibrated", /uncalibrated/i.test(renderReport(badTier)),
    `unknown-tier offer not flagged uncalibrated`);

  // MED-1: a null / non-number price must not leak the raw "null"/"undefined" string to the user.
  const badPrice = structuredClone(base);
  badPrice.offers = [{ merchant: "NoPriceShop", price: null, currency: "USD", provenance_tier: "api",
    timestamp: "2026-06-22", offer_confidence: 0.9, verify_at_checkout: false }];
  const bpr = renderReport(badPrice);
  expect("render r2: null price does not leak raw null", !/NoPriceShop — null/.test(bpr),
    `raw null price leaked: ${bpr.split("\n").find((l) => l.includes("NoPriceShop"))}`);
  expect("render r2: null price shown as unavailable", /price unavailable/i.test(bpr), `missing price-unavailable note`);
}

// --- Phase 4 review hardening ROUND 3 (ensemble round 3: element-level crash, NaN/stray leaks, buy
//     section under INSUFFICIENT, array-element bypass) --------------------------------------------
{
  const base = load("evals/golden/electronics-headphones.json");

  // NEW-1: a malformed ELEMENT inside candidates[]/shortlist[] must not crash the report.
  const gridMutations = [
    (r) => { r.candidates = [null]; delete r.shortlist; },
    (r) => { r.candidates = [structuredClone(base.candidates[0]), null]; },
    (r) => { r.shortlist = [null, structuredClone(base.shortlist[0])]; },
  ];
  for (let i = 0; i < gridMutations.length; i++) {
    const r = structuredClone(base); gridMutations[i](r);
    let threw = false, out = "";
    try { out = renderReport(r); } catch { threw = true; }
    expect(`render r3: malformed grid element #${i} does not crash`, !threw && out.length > 0,
      `renderReport threw on malformed candidate/shortlist element`);
  }

  // NEW-2: a NaN price must not leak the literal "NaN" to the user. (Merchant name avoids "NaN" itself.)
  const nanPrice = structuredClone(base);
  nanPrice.offers = [{ merchant: "GlitchShop", price: NaN, currency: "USD", provenance_tier: "api",
    timestamp: "2026-06-22", offer_confidence: 0.9, verify_at_checkout: false }];
  const nanLine = renderReport(nanPrice).split("\n").find((l) => l.includes("GlitchShop")) ?? "";
  expect("render r3: NaN price does not leak", !/NaN/.test(nanLine) && /price unavailable/.test(nanLine),
    `NaN price leaked: ${nanLine}`);

  // NEW-3: a stray non-object pick must NOT render "## Pick — undefined".
  for (const p of ["Sony", {}, 42]) {
    const r = structuredClone(base); r.pick = p;
    expect(`render r3: stray pick (${JSON.stringify(p)}) not shown as pick`, !renderReport(r).includes("## Pick — undefined"),
      `rendered "## Pick — undefined" for ${JSON.stringify(p)}`);
  }

  // NEW-4: an INSUFFICIENT_EVIDENCE outcome must NOT render a "where to buy" buy section.
  const insufOffers = structuredClone(base);
  insufOffers.outcome = "INSUFFICIENT_EVIDENCE"; insufOffers.reason_code = "THIN_EVIDENCE";
  expect("render r3: no buy section under INSUFFICIENT_EVIDENCE", !/where to buy/i.test(renderReport(insufOffers)),
    `buy section rendered under INSUFFICIENT_EVIDENCE`);

  // NEW-5: an array element in offers must not leak as a record — it is flagged malformed.
  const arrEl = structuredClone(base);
  arrEl.offers = [[], structuredClone(base.offers[0])];
  expect("render r3: array offer element flagged malformed", /malformed offer/i.test(renderReport(arrEl)),
    `array offer element not flagged malformed`);
}

// --- Phase 4 review hardening ROUND 4 (nested malformed elements + non-finite confidence + backstop) -
{
  const base = load("evals/golden/electronics-headphones.json");

  // R4-4: confidenceBand must treat non-finite as "unknown", never "high".
  expect("render r4: confidenceBand(Infinity) is unknown", confidenceBand(Infinity) === "unknown",
    `got ${confidenceBand(Infinity)}`);
  const infConf = structuredClone(base); infConf.confidence_overall = Infinity;
  expect("render r4: Infinity overall confidence not shown as high", !/high \(Infinity\)/.test(renderReport(infConf)),
    `Infinity confidence shown as high`);

  // R4-1/R4-3: a null element inside a candidate's evidence[] must not crash; the gap is surfaced.
  const badEv = structuredClone(base);
  badEv.candidates[0].evidence = [null, structuredClone(base.candidates[0].evidence[0])];
  let te = false, er = "";
  try { er = renderReport(badEv); } catch { te = true; }
  expect("render r4: malformed evidence does not crash", !te && er.length > 0, `renderReport threw on malformed evidence`);
  expect("render r4: malformed evidence surfaced", /malformed evidence/i.test(er), `missing malformed-evidence note`);

  // R4-2: a null element / non-array in a shortlist item's counterevidence[] must not crash.
  for (const ce of [[null], "oops", 42]) {
    const r = structuredClone(base); r.shortlist[0].counterevidence = ce;
    let t = false, o = "";
    try { o = renderReport(r); } catch { t = true; }
    expect(`render r4: malformed counterevidence (${JSON.stringify(ce)}) does not crash`, !t && o.length > 0,
      `renderReport threw on counterevidence ${JSON.stringify(ce)}`);
  }

  // A non-array search_universe field must not crash the report (orNone guard).
  const badSU = structuredClone(base); badSU.search_universe.queries_run = "oops";
  let ts = false, sr = "";
  try { sr = renderReport(badSU); } catch { ts = true; }
  expect("render r4: non-array search_universe field does not crash", !ts && sr.length > 0,
    `renderReport threw on non-array search_universe field`);
}

// --- Phase 4 review hardening ROUND 5 (wrong-typed leaf leaks + complete backstop) ------------------
{
  const base = load("evals/golden/electronics-headphones.json");

  // Wrong-typed leaf fields (reachable via JSON: object where a string is expected) must not leak
  // "[object Object]"/"undefined" as if real data — they render as a visible gap instead.
  const objNeed = structuredClone(base); objNeed.framed_requirements.need = { en: "x" };
  expect("render r5: object need not leaked", !/\[object Object\]/.test(renderReport(objNeed)), `[object Object] leaked for need`);

  const objRationale = structuredClone(base); objRationale.rationale = { t: "x" };
  expect("render r5: object rationale not leaked", !/\[object Object\]/.test(renderReport(objRationale)), `leaked rationale`);

  const objCaveat = structuredClone(base); objCaveat.caveats = [{}, "a real caveat"];
  expect("render r5: object caveat not leaked", !/\[object Object\]/.test(renderReport(objCaveat)), `leaked caveat`);

  const badCe = structuredClone(base); badCe.shortlist[0].counterevidence = [{}]; // record missing kind/detail
  expect("render r5: counterevidence missing fields not raw-undefined",
    !/counterevidence \(undefined\): undefined/.test(renderReport(badCe)), `raw undefined counterevidence`);

  const objSummary = structuredClone(base); objSummary.value_assessment.summary = {};
  expect("render r5: object value summary not leaked", !/\*\*Value:\*\* \[object Object\]/.test(renderReport(objSummary)), `leaked summary`);

  // Backstop completeness: a throwing accessor ANYWHERE (incl. the header) must not propagate —
  // renderReport always returns a string (the partial report + a visible note), never throws.
  const evil = structuredClone(base);
  Object.defineProperty(evil, "outcome", { get() { throw new Error("boom"); }, enumerable: true });
  let threw = false, out = "";
  try { out = renderReport(evil); } catch { threw = true; }
  expect("render r5: throwing accessor does not propagate", !threw && out.length > 0, `renderReport threw on hostile getter`);
}

// --- Phase 4 review hardening ROUND 6 (currency/region leaf leaks missed by the round-5 sweep) -------
{
  const base = load("evals/golden/electronics-headphones.json");

  const objBudCur = structuredClone(base); objBudCur.framed_requirements.budget.currency = {};
  expect("render r6: object budget.currency not leaked", !/\[object Object\]/.test(renderReport(objBudCur)), `leaked budget.currency`);

  const objRegion = structuredClone(base); objRegion.framed_requirements.region = {};
  expect("render r6: object region not leaked", !/\[object Object\]/.test(renderReport(objRegion)), `leaked region`);

  const objOfferCur = structuredClone(base); objOfferCur.offers[0].currency = {};
  expect("render r6: object offer.currency not leaked", !/\[object Object\]/.test(renderReport(objOfferCur)), `leaked offer.currency`);

  // R7: wrong-typed ELEMENTS inside a search_universe list must not leak via the orNone join.
  const objSU = structuredClone(base); objSU.search_universe.queries_run = [{}, "ok", null];
  expect("render r7: search_universe array elements not leaked", !/\[object Object\]/.test(renderReport(objSU)),
    `leaked search_universe element`);
}

// --- Phase 5: capability detection + graceful degradation (docs/data-access.md) ---------------------
{
  // Baseline is always available; enhancement tiers are gated by capability flags. A disabled/absent
  // enhancement tier is RECORDED in tiers_unavailable, never silently treated as present.
  const all = detectTiers({ subagents: true, browser: true, api: true });
  expect("detectTiers: all enhancement tiers available", all.available.includes("baseline") &&
    all.available.includes("subagents") && all.available.includes("browser") && all.available.includes("api"),
    `available=${JSON.stringify(all.available)}`);
  expect("detectTiers: nothing unavailable when all enabled", all.tiers_unavailable.length === 0,
    `tiers_unavailable=${JSON.stringify(all.tiers_unavailable)}`);

  const none = detectTiers({});
  expect("detectTiers: baseline still available with no enhancements", none.available.includes("baseline"),
    `available=${JSON.stringify(none.available)}`);
  expect("detectTiers: disabled enhancements recorded unavailable",
    ["subagents", "browser", "api"].every((t) => none.tiers_unavailable.includes(t)),
    `tiers_unavailable=${JSON.stringify(none.tiers_unavailable)}`);

  const dark = detectTiers({ baseline: false });
  expect("detectTiers: no usable tier when even baseline is off", dark.available.length === 0,
    `available=${JSON.stringify(dark.available)}`);
}

// --- Phase 5: emptyUniverse seeds all six counters (so they are populated every run) ----------------
{
  const u = emptyUniverse();
  for (const k of ["queries_run", "sources_hit", "sources_failed_or_blocked", "tiers_unavailable", "budgets_hit"]) {
    expect(`emptyUniverse: ${k} is an array`, Array.isArray(u[k]) && u[k].length === 0, `u.${k}=${JSON.stringify(u[k])}`);
  }
  expect("emptyUniverse: fetches_used is 0", u.fetches_used === 0, `u.fetches_used=${u.fetches_used}`);
  // Sane defaults (core budgets from Phase 1 + enhancement budgets added here).
  expect("DEFAULTS: max_parallel_subagents default 6", DEFAULTS.max_parallel_subagents === 6,
    `got ${DEFAULTS.max_parallel_subagents}`);
  expect("DEFAULTS: per-API call budget present", typeof DEFAULTS.per_api_calls === "number" && DEFAULTS.per_api_calls > 0,
    `got ${DEFAULTS.per_api_calls}`);
}

// --- Phase 5: ResourceGovernor concurrency cap (max_parallel_subagents, fail-closed) ----------------
{
  const g = createGovernor({ max_parallel_subagents: 2 });
  expect("governor: 1st subagent acquired", g.acquireSubagent().allowed === true, `1st denied`);
  expect("governor: 2nd subagent acquired", g.acquireSubagent().allowed === true, `2nd denied`);
  const third = g.acquireSubagent();
  expect("governor: 3rd subagent denied at cap", third.allowed === false, `3rd allowed past cap`);
  expect("governor: cap exhaustion recorded in budgets_hit",
    g.universe.budgets_hit.some((b) => b.includes("max_parallel_subagents")), `budgets_hit=${JSON.stringify(g.universe.budgets_hit)}`);
  g.releaseSubagent();
  expect("governor: slot frees after release", g.acquireSubagent().allowed === true, `denied after release`);
}

// --- Phase 5: enhancement-tier resource governance is fail-closed (evals/budget-failclose.json) -----
{
  const fx = load("evals/budget-failclose.json");
  for (const c of fx.cases) {
    const r = orchestrate({ capabilities: c.capabilities, budgets: c.budgets, plan: c.plan });
    const e = c.expect;
    if (e.fetches_used !== undefined)
      expect(`budget-failclose ${c.name}: fetches_used`, r.search_universe.fetches_used === e.fetches_used,
        `expected ${e.fetches_used}, got ${r.search_universe.fetches_used}`);
    if (e.api_calls !== undefined)
      expect(`budget-failclose ${c.name}: api_calls`, r.api_calls === e.api_calls,
        `expected ${e.api_calls}, got ${r.api_calls}`);
    if (e.dispatched_subagents !== undefined)
      expect(`budget-failclose ${c.name}: dispatched_subagents capped`, r.dispatched_subagents === e.dispatched_subagents,
        `expected ${e.dispatched_subagents}, got ${r.dispatched_subagents}`);
    if (e.budgets_hit_includes !== undefined)
      expect(`budget-failclose ${c.name}: budget recorded`,
        r.search_universe.budgets_hit.some((b) => b.includes(e.budgets_hit_includes)),
        `budgets_hit=${JSON.stringify(r.search_universe.budgets_hit)}`);
    if (e.branches_stopped_includes !== undefined)
      expect(`budget-failclose ${c.name}: branch stopped recorded`,
        r.branches_stopped.some((b) => b.includes(e.branches_stopped_includes)),
        `branches_stopped=${JSON.stringify(r.branches_stopped)}`);
    if (e.access !== undefined)
      expect(`budget-failclose ${c.name}: access`, r.access === e.access, `expected ${e.access}, got ${r.access}`);
  }
}

// --- Phase 5: portable-core guarantee — completes with all enhancement tiers disabled ---------------
{
  const fx = load("evals/portable-core.json");
  let threw = false, r;
  try { r = orchestrate({ capabilities: fx.capabilities, budgets: fx.budgets, plan: fx.plan }); } catch { threw = true; }
  expect("portable-core: orchestrate does not throw with enhancements off", !threw && !!r, `orchestrate threw`);
  const e = fx.expect;
  expect("portable-core: access ok (run completes)", r.access === e.access, `expected ${e.access}, got ${r.access}`);
  expect("portable-core: marked degraded", r.degraded === e.degraded, `expected ${e.degraded}, got ${r.degraded}`);
  expect("portable-core: no subagents dispatched", r.dispatched_subagents === e.dispatched_subagents,
    `expected ${e.dispatched_subagents}, got ${r.dispatched_subagents}`);
  expect("portable-core: evidence still gathered via baseline", (r.evidence_count > 0) === e.evidence_gathered,
    `evidence_count=${r.evidence_count}`);
  expect("portable-core: disabled tiers recorded unavailable",
    e.tiers_unavailable.every((t) => r.search_universe.tiers_unavailable.includes(t)),
    `tiers_unavailable=${JSON.stringify(r.search_universe.tiers_unavailable)}`);
  expect("portable-core: baseline reported available", r.tiers_available.includes(e.tiers_available_includes),
    `tiers_available=${JSON.stringify(r.tiers_available)}`);
}

// --- Phase 5: INSUFFICIENT_ACCESS path — no fabricated pick on a data gap (evals/insufficient-access) -
{
  const fx = load("evals/insufficient-access.json");
  for (const c of fx.cases) {
    const r = orchestrate({ capabilities: c.capabilities, budgets: c.budgets, plan: c.plan });
    const e = c.expect;
    expect(`insufficient-access ${c.name}: access`, r.access === e.access, `expected ${e.access}, got ${r.access}`);
    expect(`insufficient-access ${c.name}: outcome`, r.outcome === e.outcome, `expected ${e.outcome}, got ${r.outcome}`);
    expect(`insufficient-access ${c.name}: reason_code`, r.reason_code === e.reason_code,
      `expected ${e.reason_code}, got ${r.reason_code}`);
    if (e.evidence_gathered !== undefined)
      expect(`insufficient-access ${c.name}: no evidence`, (r.evidence_count > 0) === e.evidence_gathered,
        `evidence_count=${r.evidence_count}`);
    if (e.budgets_hit_includes !== undefined)
      expect(`insufficient-access ${c.name}: budget recorded`,
        r.search_universe.budgets_hit.some((b) => b.includes(e.budgets_hit_includes)),
        `budgets_hit=${JSON.stringify(r.search_universe.budgets_hit)}`);
  }
}

// --- Phase 5: every orchestrate run populates all six search_universe counters ----------------------
{
  for (const file of ["evals/portable-core.json", "evals/budget-failclose.json", "evals/insufficient-access.json"]) {
    const fx = load(file);
    const cases = fx.cases ?? [fx];
    for (const c of cases) {
      const r = orchestrate({ capabilities: c.capabilities, budgets: c.budgets, plan: c.plan });
      const su = r.search_universe;
      for (const k of ["queries_run", "sources_hit", "sources_failed_or_blocked", "tiers_unavailable", "budgets_hit"])
        expect(`counters populated: ${file} [${c.name ?? "single"}] ${k}`, Array.isArray(su[k]),
          `${k} not an array: ${JSON.stringify(su[k])}`);
      expect(`counters populated: ${file} [${c.name ?? "single"}] fetches_used`, typeof su.fetches_used === "number",
        `fetches_used=${su.fetches_used}`);
    }
  }
}

// --- Phase 5: subagent output is schema-validated at the boundary (fail-closed) ---------------------
{
  // Valid payloads are built from a REAL golden fixture so they cannot drift from the live contract.
  const g = load("evals/golden/electronics-headphones.json");
  const validHarvester = { agent: "harvester", candidates: [structuredClone(g.candidates[0])] };
  const validTeardown = { agent: "teardown", shortlist: [structuredClone(g.shortlist[0])] };
  const validSourcing = { agent: "sourcing", offers: [structuredClone(g.offers[0])] };
  expect("subagent-output: valid harvester accepted", validateSubagentResult("harvester", validHarvester).length === 0,
    `violations: ${validateSubagentResult("harvester", validHarvester).join("; ")}`);
  expect("subagent-output: valid teardown accepted", validateSubagentResult("teardown", validTeardown).length === 0,
    `violations: ${validateSubagentResult("teardown", validTeardown).join("; ")}`);
  expect("subagent-output: valid sourcing accepted", validateSubagentResult("sourcing", validSourcing).length === 0,
    `violations: ${validateSubagentResult("sourcing", validSourcing).join("; ")}`);

  // An honest EMPTY harvest is a valid return — it still carries its search_universe_delta so the
  // orchestrator sees WHY breadth narrowed. (An invalid-and-discarded envelope would lose that signal.)
  const emptyHarvest = { agent: "harvester", candidates: [],
    search_universe_delta: { sources_failed_or_blocked: ["forum.example (robots.txt)"] } };
  expect("subagent-output: empty-but-honest harvest accepted",
    validateSubagentResult("harvester", emptyHarvest).length === 0,
    `violations: ${validateSubagentResult("harvester", emptyHarvest).join("; ")}`);

  // Every rejection case must produce at least one violation (the gate bites).
  const fx = load("evals/subagent-output.json");
  for (const c of fx.invalid) {
    const v = validateSubagentResult(c.kind, c.payload);
    expect(`subagent-output: rejects "${c.name}"`, v.length > 0, `expected violation, got none`);
  }
}

// --- Phase 5: renderer surfaces the orchestrated universe (budgets_hit + tiers_unavailable) ---------
{
  const base = load("evals/golden/electronics-headphones.json");
  const r = orchestrate({
    capabilities: { subagents: false, browser: false, api: false },
    budgets: { per_domain_fetches: 1 },
    plan: { queries: ["x"], work: [
      { type: "fetch", domain: "d.example", yields_evidence: true },
      { type: "fetch", domain: "d.example", yields_evidence: true },
    ] },
  });
  const rec = structuredClone(base);
  rec.search_universe = r.search_universe;
  const report = renderReport(rec);
  expect("render p5: budgets_hit surfaced in report",
    r.search_universe.budgets_hit.every((b) => report.includes(b)) && /Budgets hit:/.test(report),
    `report budgets line missing some of ${JSON.stringify(r.search_universe.budgets_hit)}`);
  expect("render p5: unavailable tiers surfaced in report",
    r.search_universe.tiers_unavailable.every((t) => report.includes(t)),
    `report missing some of ${JSON.stringify(r.search_universe.tiers_unavailable)}`);
}

// --- Report ----------------------------------------------------------------------------------------
if (failures.length) {
  console.error(`\nLOGIC FAIL — ${failures.length} problem(s) across ${checks} checks:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`OK — ${checks} logic checks passed (clustering + R1 ranking + affiliate weighting + decision engine + confidence calibration + gift switch + offer calibration + rendering + capability orchestration + fail-closed governance + subagent-output validation).`);
