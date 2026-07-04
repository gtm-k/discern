// Discern Phase 2 logic tests: independence clustering, R1 grid ranking, affiliate down-weighting.
// Runs via `npm test` (after schema validation). Exits non-zero on any failure.
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
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
import { categoryGateViolations, anchorResolves } from "./category-gate.mjs";
import { liveSmokeViolations } from "./live-smoke-check.mjs";
import { requirementTerms, minAnglesFor, coverageViolations } from "./coverage.mjs";

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

// --- Phase 3: dealbreaker render marker (structural exclusion surfaced in grid) ----------------------
{
  // Build a minimal rec with one dealbreakered shortlist item and verify the grid marks it.
  const dealbreakerRec = {
    beneficiary: { type: "self" },
    framed_requirements: { need: "shirt" },
    triage: { stakes: "low", depth: "standard", safety_relevant: false },
    candidates: [
      { product: "DisqualifiedItem", maker: "MakerD", durable_ids: { model_no: "DQ-01" },
        evidence: [ { claim: "Good but dealbreakered", source_cluster_id: "dq1",
          provenance: { url: "https://example.com/dq", owner: "ReviewDQ", access_tier: "fetch", source_class: "professional_review" },
          independence_flag: true, affiliate_or_sponsored_flag: false, claim_confidence: 0.78 } ],
        recurrence_over_clusters: 2 },
      { product: "CleanItem", maker: "MakerC2", durable_ids: { model_no: "CL-01" },
        evidence: [ { claim: "Clean, no issues", source_cluster_id: "cl1",
          provenance: { url: "https://example.com/cl", owner: "ReviewCL", access_tier: "fetch", source_class: "professional_review" },
          independence_flag: true, affiliate_or_sponsored_flag: false, claim_confidence: 0.75 } ],
        recurrence_over_clusters: 2 },
    ],
    shortlist: [
      { product: "DisqualifiedItem", fundamentals_card: { summary: "Top fundamentals but dealbreaker.", fundamentals_score: 0.90, fundamentals: [ { dimension: "build", finding: "Strong" } ] },
        counterevidence: [ { kind: "dealbreaker", detail: "Violates hard filter", source: "framed_requirements.dealbreakers" } ] },
      { product: "CleanItem", fundamentals_card: { summary: "Clean item, no counterevidence.", fundamentals_score: 0.70, fundamentals: [ { dimension: "build", finding: "Good" } ] }, counterevidence: [] },
    ],
    search_universe: { queries_run: ["shirt"], sources_hit: [], sources_failed_or_blocked: [], tiers_unavailable: [], budgets_hit: [], fetches_used: 1, angles_swept: ["roundup"] },
    outcome: "RECOMMEND", reason_code: "NONE", confidence_overall: 0.70,
    pick: { product: "CleanItem", maker: "MakerC2" }, rationale: "CleanItem wins.",
    value_assessment: { summary: "Good value." },
  };
  const dbReport = renderReport(dealbreakerRec);
  expect("render: dealbreaker grid marker present", dbReport.includes("DISQUALIFIED — dealbreaker"),
    `grid missing "DISQUALIFIED — dealbreaker" marker:\n${dbReport}`);

  // Scannable Pick (docs/render.md §3): fundamentals-card summary as a lead, "Why it wins" bullets from
  // fundamentals[], best price in the at-a-glance header, and the prose rationale demoted BELOW the bullets.
  const scanRec = {
    outcome: "RECOMMEND", reason_code: "NONE", confidence_overall: 0.8,
    framed_requirements: { need: "widget" },
    pick: { product: "PickW", maker: "M1" },
    candidates: [{ product: "PickW", maker: "M1", durable_ids: { model_no: "P1" },
      evidence: [{ claim: "c", source_cluster_id: "a", provenance: { url: "https://e/1", owner: "O", access_tier: "fetch", source_class: "professional_review" }, independence_flag: true, affiliate_or_sponsored_flag: false, claim_confidence: 0.8 }],
      recurrence_over_clusters: 2 }],
    shortlist: [{ product: "PickW", fundamentals_card: { summary: "A tidy one-line teardown summary.", fundamentals_score: 0.8,
      fundamentals: [{ dimension: "battery", finding: "60h class-leading" }, { dimension: "comfort", finding: "low clamp" }] }, counterevidence: [] }],
    rationale: "RATIONALE_PROSE_MARKER — the long paragraph that used to lead the section.",
    value_assessment: { summary: "good value", value_per_dollar: "high" },
    offers: [{ merchant: "Shop", price: 220, currency: "USD", provenance_tier: "fetch", timestamp: "2026-07-03", offer_confidence: 0.6, verify_at_checkout: true }],
    search_universe: { queries_run: ["q"], sources_hit: [], sources_failed_or_blocked: [], tiers_unavailable: [], budgets_hit: [], fetches_used: 1, angles_swept: ["roundup"] },
  };
  const scan = renderReport(scanRec);
  expect("render: pick shows fundamentals-card summary lead", scan.includes("A tidy one-line teardown summary."), `missing summary lead:\n${scan}`);
  expect("render: 'Why it wins' bullets from fundamentals[]",
    scan.includes("### Why it wins") && scan.includes("- **battery** — 60h class-leading") && scan.includes("- **comfort** — low clamp"),
    `missing why-it-wins bullets:\n${scan}`);
  expect("render: best price in the at-a-glance header", /\*\*Best price:\*\* 220 USD \(verify at checkout\)/.test(scan), `missing best price:\n${scan}`);
  expect("render: sub-sections are ### headings (block-level, not inline bold)",
    scan.includes("### Value") && scan.includes("### Full reasoning"), `sub-sections not headings:\n${scan}`);
  expect("render: prose rationale demoted below the bullets",
    scan.includes("### Full reasoning") && scan.indexOf("### Why it wins") < scan.indexOf("RATIONALE_PROSE_MARKER"),
    `rationale not demoted below the bullets:\n${scan}`);
  expect("render: dealbreakered item still appears in grid (visible)", dbReport.includes("DisqualifiedItem"),
    `dealbreakered item missing from grid entirely`);
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

// --- Phase 5 post-code review ROUND 1: ensemble REVISE-CODE (Codex + correctness + silent-failure) ---
{
  // C1 (Codex CRITICAL): a non-finite / negative budget must NOT fail OPEN (NaN >= x is always false,
  // which would silently remove the cap). The governor sanitizes to the default and records invalid_budget.
  const gNaN = createGovernor({ max_fetches: NaN, per_domain_fetches: Infinity, max_parallel_subagents: -3 });
  expect("C1: NaN max_fetches falls back to default (no fail-open)", gNaN.config.max_fetches === DEFAULTS.max_fetches,
    `config.max_fetches=${gNaN.config.max_fetches}`);
  expect("C1: Infinity per-domain falls back to default", gNaN.config.per_domain_fetches === DEFAULTS.per_domain_fetches,
    `config.per_domain_fetches=${gNaN.config.per_domain_fetches}`);
  expect("C1: negative parallel cap falls back to default", gNaN.config.max_parallel_subagents === DEFAULTS.max_parallel_subagents,
    `config.max_parallel_subagents=${gNaN.config.max_parallel_subagents}`);
  expect("C1: invalid budgets recorded observably", ["max_fetches", "per_domain_fetches", "max_parallel_subagents"]
    .every((k) => gNaN.universe.budgets_hit.includes(`invalid_budget:${k}`)),
    `budgets_hit=${JSON.stringify(gNaN.universe.budgets_hit)}`);
  // The cap actually bites at the default (Infinity did NOT disable it): the 6th fetch to one domain is denied.
  const gOpen = createGovernor({ per_domain_fetches: Infinity });
  let denied = false;
  for (let i = 0; i < DEFAULTS.per_domain_fetches + 1; i++) if (!gOpen.requestFetch("x.example").allowed) denied = true;
  expect("C1: Infinity per-domain budget still enforced at the default cap", denied, `cap was removed by Infinity`);

  // C2 (CRITICAL): a zero-evidence run blocked by TIER-UNAVAILABILITY (not budget) must return
  // INSUFFICIENT_ACCESS, never access:ok with a null outcome (the fabrication path).
  const apiOnly = orchestrate({ capabilities: { api: false }, plan: { work: [
    { type: "api", yields_evidence: true }, { type: "api", yields_evidence: true } ] } });
  expect("C2: api-only work with api off -> insufficient", apiOnly.access === "insufficient" &&
    apiOnly.reason_code === "INSUFFICIENT_ACCESS", `access=${apiOnly.access}, reason=${apiOnly.reason_code}`);
  expect("C2: api-tier-unavailable blockage is recorded", apiOnly.branches_stopped.some((b) => /api/.test(b)),
    `branches_stopped=${JSON.stringify(apiOnly.branches_stopped)}`);
  // C2b: fetch work must NOT proceed when no fetch-capable tier (baseline+browser both off) is available.
  const noFetchTier = orchestrate({ capabilities: { baseline: false, subagents: true }, plan: { work: [
    { type: "fetch", domain: "a.example", yields_evidence: true } ] } });
  expect("C2b: fetch with no fetch-capable tier gathers no evidence", noFetchTier.evidence_count === 0,
    `evidence_count=${noFetchTier.evidence_count}`);
  expect("C2b: fetch with no fetch-capable tier is recorded, not silently honored",
    noFetchTier.branches_stopped.some((b) => /fetch/.test(b)) || noFetchTier.search_universe.sources_failed_or_blocked.length > 0,
    `branches_stopped=${JSON.stringify(noFetchTier.branches_stopped)}`);
  // C2c: a legitimate run that SEARCHED fine but found no evidence (no failures/budgets) is NOT mislabeled
  // INSUFFICIENT_ACCESS — that is a downstream NO_CONSENSUS/THIN_EVIDENCE call, so access stays ok.
  const searchedEmpty = orchestrate({ plan: { work: [ { type: "fetch", domain: "ok.example", yields_evidence: false } ] } });
  expect("C2c: searched-but-empty (no failures) stays access ok", searchedEmpty.access === "ok",
    `access=${searchedEmpty.access}`);

  // H1 (HIGH): orchestrate must actually VALIDATE subagent returns and FOLD their deltas — the contract
  // boundary, not prose. An invalid return is discarded + recorded; a valid one's delta is merged.
  const goodCand = structuredClone(load("evals/golden/electronics-headphones.json").candidates[0]);
  const ingest = orchestrate({ capabilities: { subagents: true }, plan: {
    subagents: [
      { kind: "harvester", payload: { agent: "harvester", candidates: [goodCand],
        search_universe_delta: { queries_run: ["sub-query-xyz"], sources_hit: ["sub-source-abc"], fetches_used: 2 } } },
      { kind: "harvester", payload: { agent: "harvester" } }, // invalid: missing candidates
      { kind: "bogus", payload: { agent: "bogus" } },          // invalid: unknown kind (fail-closed)
    ],
  } });
  expect("H1: valid subagent contributes evidence", ingest.evidence_count > 0, `evidence_count=${ingest.evidence_count}`);
  expect("H1: valid subagent delta folded (query)", ingest.search_universe.queries_run.includes("sub-query-xyz"),
    `queries_run=${JSON.stringify(ingest.search_universe.queries_run)}`);
  expect("H1: valid subagent delta folded (source + fetches)",
    ingest.search_universe.sources_hit.includes("sub-source-abc") && ingest.search_universe.fetches_used >= 2,
    `sources_hit=${JSON.stringify(ingest.search_universe.sources_hit)}, fetches_used=${ingest.search_universe.fetches_used}`);
  expect("H1: invalid subagent returns discarded + recorded (not silent)",
    ingest.search_universe.sources_failed_or_blocked.filter((s) => /invalid output discarded/i.test(s)).length >= 2,
    `sources_failed_or_blocked=${JSON.stringify(ingest.search_universe.sources_failed_or_blocked)}`);
  expect("H1: discarded subagent output is never trusted (only the valid one counted)",
    ingest.evidence_count === 1, `evidence_count=${ingest.evidence_count}`);

  // M1 (MED): a wanted-but-impossible fan-out (subagents off, fanout > 0) records the magnitude lost,
  // not a silent no-op indistinguishable from "never wanted subagents".
  const droppedFan = orchestrate({ capabilities: { subagents: false }, plan: { subagent_fanout: 8,
    work: [ { type: "fetch", domain: "a.example", yields_evidence: true } ] } });
  expect("M1: dropped fan-out magnitude recorded", droppedFan.branches_stopped.some((b) => /subagents/.test(b) && /8/.test(b)),
    `branches_stopped=${JSON.stringify(droppedFan.branches_stopped)}`);

  // M2 (MED): a non-string domain must be a RECORDED failure, never a silent "unknown" success that
  // consumes/credits real budget.
  const badDomain = orchestrate({ plan: { work: [
    { type: "fetch", domain: 42, yields_evidence: true }, { type: "fetch", domain: "", yields_evidence: true } ] } });
  expect("M2: malformed domain gathers no evidence", badDomain.evidence_count === 0, `evidence_count=${badDomain.evidence_count}`);
  expect("M2: malformed domain consumes no fetch budget", badDomain.search_universe.fetches_used === 0,
    `fetches_used=${badDomain.search_universe.fetches_used}`);
  expect("M2: malformed domain recorded", badDomain.branches_stopped.some((b) => /malformed domain/i.test(b)),
    `branches_stopped=${JSON.stringify(badDomain.branches_stopped)}`);

  // H2 (HIGH): unknown / malformed work-item types are recorded, not silently dropped.
  const unknownType = orchestrate({ plan: { work: [ { type: "fetchh", domain: "x.example" }, { nope: 1 }, 7 ] } });
  expect("H2: unknown work type recorded", unknownType.branches_stopped.some((b) => /unknown work item/i.test(b)),
    `branches_stopped=${JSON.stringify(unknownType.branches_stopped)}`);
  expect("H2: non-object work item recorded", unknownType.branches_stopped.some((b) => /malformed work item/i.test(b)),
    `branches_stopped=${JSON.stringify(unknownType.branches_stopped)}`);
}

// --- Phase 5 post-code review ROUND 2: F8 (silent-failure HIGH) — work-level breadth losses must be
//     visible to the USER (rendered search_universe), not only to the orchestrator (branches_stopped). --
{
  const base = load("evals/golden/electronics-headphones.json");
  // A productive-but-narrowed run: it gathers evidence (so access stays "ok") yet drops a subagent
  // fan-out, hits a malformed domain, and an unknown work type. The user sees ONLY the rendered report,
  // so these losses MUST reach a rendered search_universe field, not just branches_stopped.
  const r = orchestrate({ capabilities: { subagents: false, browser: false, api: false }, plan: {
    subagent_fanout: 5,
    work: [
      { type: "fetch", domain: "good.example", yields_evidence: true },
      { type: "fetch", domain: 99 },                 // malformed domain
      { type: "frobnicate", domain: "x.example" },   // unknown work type
    ],
  } });
  expect("F8: narrowed run still completes access ok", r.access === "ok", `access=${r.access}`);
  for (const [label, re] of [["dropped fan-out", /subagents unavailable/], ["malformed domain", /malformed domain/],
    ["unknown work type", /unknown work item/]])
    expect(`F8: ${label} recorded in a rendered field`, r.search_universe.sources_failed_or_blocked.some((s) => re.test(s)),
      `sources_failed_or_blocked=${JSON.stringify(r.search_universe.sources_failed_or_blocked)}`);
  // Render-boundary: the user (who sees ONLY the report) actually sees the narrowing.
  const rec = structuredClone(base);
  rec.search_universe = r.search_universe;
  const report = renderReport(rec);
  expect("F8: narrowing is visible in the rendered report",
    /subagents unavailable/.test(report) && /malformed domain/.test(report) && /unknown work item/.test(report),
    `rendered report missing work-level stops:\n${report.split("\n").filter((l) => /failed\/blocked/i.test(l)).join("\n")}`);
  // Budget-exhaustion stops are NOT duplicated into failed/blocked (already rendered via budgets_hit).
  const b = orchestrate({ budgets: { per_domain_fetches: 1 }, plan: { work: [
    { type: "fetch", domain: "d.example", yields_evidence: true },
    { type: "fetch", domain: "d.example", yields_evidence: true } ] } });
  expect("F8: budget stop not double-reported in failed/blocked",
    !b.search_universe.sources_failed_or_blocked.some((s) => /per_domain_fetches/.test(s)),
    `budget stop leaked into failed/blocked: ${JSON.stringify(b.search_universe.sources_failed_or_blocked)}`);
  expect("F8: budget stop still recorded in budgets_hit",
    b.search_universe.budgets_hit.some((s) => /per_domain_fetches/.test(s)),
    `budgets_hit=${JSON.stringify(b.search_universe.budgets_hit)}`);
}

// --- Phase 5 post-code review ROUND 2 (Codex): two regressions introduced by the round-1 fixes --------
{
  const goldCand = structuredClone(load("evals/golden/electronics-headphones.json").candidates[0]);

  // New-A (Codex CRITICAL): an explicit plan.subagents entry missing its payload must FAIL CLOSED
  // (recorded + discarded), not silently inflate dispatched_subagents to a clean empty run.
  const malformedSubs = orchestrate({ capabilities: { subagents: true }, plan: {
    subagents: [ { kind: "harvester" }, { kind: "harvester" } ] } }); // objects, no payloads
  expect("New-A: payload-less subagent entries -> insufficient (not a clean empty run)",
    malformedSubs.access === "insufficient" && malformedSubs.reason_code === "INSUFFICIENT_ACCESS",
    `access=${malformedSubs.access}, reason=${malformedSubs.reason_code}`);
  expect("New-A: payload-less subagent entries are recorded (not silent)",
    malformedSubs.search_universe.sources_failed_or_blocked.some((s) => /invalid output discarded/.test(s)),
    `sources_failed_or_blocked=${JSON.stringify(malformedSubs.search_universe.sources_failed_or_blocked)}`);
  // A bare subagent_fanout count (no explicit returns modeled) is NOT a failure — it models dispatch slots.
  const bareFan = orchestrate({ capabilities: { subagents: true }, plan: { subagent_fanout: 3,
    work: [ { type: "fetch", domain: "a.example", yields_evidence: true } ] } });
  expect("New-A: bare fanout count is not a failure", bareFan.access === "ok" && bareFan.dispatched_subagents === 3,
    `access=${bareFan.access}, dispatched=${bareFan.dispatched_subagents}`);

  // New-B (Codex CRITICAL): a subagent cannot spoof the reserved `invalid_budget:` namespace to hide a real
  // exhaustion from the access gate. A delta using that reserved prefix is rejected at the boundary.
  const spoof = orchestrate({ capabilities: { subagents: true }, plan: {
    subagents: [ { kind: "harvester", payload: { agent: "harvester", candidates: [],
      search_universe_delta: { budgets_hit: ["invalid_budget:per_api_calls"] } } } ] } });
  expect("New-B: subagent using the reserved invalid_budget prefix is rejected + recorded",
    spoof.access === "insufficient" &&
    spoof.search_universe.sources_failed_or_blocked.some((s) => /invalid output discarded/.test(s)),
    `access=${spoof.access}, sfob=${JSON.stringify(spoof.search_universe.sources_failed_or_blocked)}`);
  expect("New-B: reserved prefix never lands in budgets_hit",
    !spoof.search_universe.budgets_hit.some((b) => b.startsWith("invalid_budget:")),
    `budgets_hit=${JSON.stringify(spoof.search_universe.budgets_hit)}`);
  // A legitimately-labeled subagent budget hit DOES fold and count as real exhaustion.
  const legitBudget = orchestrate({ capabilities: { subagents: true }, plan: {
    subagents: [ { kind: "harvester", payload: { agent: "harvester", candidates: [],
      search_universe_delta: { budgets_hit: ["per_api_calls"] } } } ] } });
  expect("New-B: legit subagent budget hit folds + counts as exhaustion",
    legitBudget.search_universe.budgets_hit.includes("per_api_calls") && legitBudget.access === "insufficient",
    `budgets_hit=${JSON.stringify(legitBudget.search_universe.budgets_hit)}, access=${legitBudget.access}`);
}

// --- Phase 6: integration — downstream contract (renderer consumes EVERY golden with zero drift) ----
// "A conflict-free merge is not a correct merge": the seam to verify here is Recommendation Object ->
// rendered report. Every golden path must render cleanly, surface its pick (RECOMMEND family) or its
// reason + no pick (INSUFFICIENT), and never hit the renderer's malformed-data backstop.
{
  const manifest = load("evals/expected/manifest.json");
  const names = readdirSync(join(root, "evals/golden")).filter((f) => f.endsWith(".json"));
  expect("integration: golden set present", names.length >= 4, `expected >=4 golden fixtures, got ${names.length}`);
  for (const name of names) {
    const rec = load(`evals/golden/${name}`);
    const report = renderReport(rec);
    const exp = manifest[name] ?? {};
    const recommendFamily = rec.outcome === "RECOMMEND" || rec.outcome === "RECOMMEND_WITH_CAVEATS";
    expect(`integration ${name}: renders a non-empty report`, typeof report === "string" && report.length > 50,
      `report length ${report?.length}`);
    expect(`integration ${name}: no malformed-data backstop on a golden fixture`, !report.includes("could not be rendered"),
      `renderer degraded on a schema-valid golden fixture`);
    expect(`integration ${name}: no [object Object] drift leak`, !report.includes("[object Object]"),
      `an object leaked into the rendered report`);
    expect(`integration ${name}: surfaces the search universe`, report.includes("## Search universe") && report.includes("Queries run:"),
      `search universe not surfaced`);
    // Field-level contract: schema-critical content must actually reach the report, not just "no crash".
    if (rec.framed_requirements?.budget?.max !== undefined)
      expect(`integration ${name}: surfaces the budget`, report.includes(String(rec.framed_requirements.budget.max)),
        `budget max ${rec.framed_requirements.budget.max} not rendered`);
    for (const s of rec.shortlist ?? [])
      expect(`integration ${name}: shortlist product "${s.product}" appears in the grid`, report.includes(s.product),
        `shortlist product "${s.product}" missing from the rendered grid`);
    if (recommendFamily) {
      if (exp.pick !== undefined)
        expect(`integration ${name}: presents the expected pick`, report.includes(`## Pick — ${exp.pick}`),
          `report does not present pick "${exp.pick}"`);
      else
        expect(`integration ${name}: RECOMMEND family has an expected pick in the manifest`, false,
          `manifest entry for '${name}' is missing or has no pick field`);
    } else {
      expect(`integration ${name}: insufficient outcome presents NO pick + shows the reason`,
        !report.includes("## Pick — ") && report.includes(exp.reason_code),
        `expected reason ${exp.reason_code} and no pick header`);
    }
  }
}

// --- Phase 6: category-widening gate BITES (PREMORTEM Story 3 / VISION §3.3) ------------------------
// Mirrors evals/invalid/ for the schema: each case proves a malformed category MUST raise >=1 violation,
// and a well-formed widening raises none. The synthetic anchor resolver honors per-case `present_tokens`.
{
  const cases = load("evals/category-gate-cases.json").cases;
  expect("category-gate: cases fixture is non-trivial", Array.isArray(cases) && cases.length >= 12,
    `expected >=12 gate cases, got ${cases?.length}`);
  for (const c of cases) {
    const present = new Set(c.input.present_tokens ?? []);
    const fileContains = (_file, token) => present.has(token);
    const v = categoryGateViolations({ ...c.input, fileContains }); // c.input may carry goldenRecs for exhibition
    if (c.expect_violation) {
      expect(`category-gate BITES: ${c.label}`, v.length >= 1,
        `expected >=1 violation, got none`);
      if (c.expect_match)
        expect(`category-gate match: ${c.label}`, v.join(" | ").includes(c.expect_match),
          `expected a violation containing "${c.expect_match}", got: ${v.join(" | ") || "(none)"}`);
    } else {
      expect(`category-gate PASSES: ${c.label}`, v.length === 0,
        `expected zero violations, got: ${v.join(" | ")}`);
    }
  }
}

// --- Phase 6: live-smoke checker turns an upstream live run into an observable PASS/FAIL --------------
// The live run hits real search+fetch (manual, at release — see docs/live-smoke.md). This checker enforces
// the PASS criteria on the produced Recommendation Object so a silently-empty run cannot pass quietly.
{
  const credibleEvidence = [{ independence_flag: true, affiliate_or_sponsored_flag: false, claim_confidence: 0.8 }];
  const ok = {
    candidates: [{ product: "P", evidence: credibleEvidence }],
    search_universe: { queries_run: ["q"], fetches_used: 3, sources_failed_or_blocked: [], budgets_hit: [], tiers_unavailable: ["browser", "api"] },
    outcome: "RECOMMEND", reason_code: "NONE",
  };
  expect("live-smoke PASS: credible evidence + queries + fetches", liveSmokeViolations(ok).length === 0,
    `expected pass, got: ${liveSmokeViolations(ok).join(" | ")}`);

  const okAccessGap = {
    candidates: [], outcome: "INSUFFICIENT_EVIDENCE", reason_code: "INSUFFICIENT_ACCESS",
    search_universe: { queries_run: ["q"], fetches_used: 2, sources_failed_or_blocked: ["retailer API (403)"], budgets_hit: [], tiers_unavailable: [] },
  };
  expect("live-smoke PASS: honest INSUFFICIENT_ACCESS with recorded block", liveSmokeViolations(okAccessGap).length === 0,
    `expected pass, got: ${liveSmokeViolations(okAccessGap).join(" | ")}`);

  const noQueries = { ...ok, search_universe: { ...ok.search_universe, queries_run: [] } };
  expect("live-smoke FAILS: queries_run is 0", liveSmokeViolations(noQueries).some((s) => /queries_run/.test(s)),
    `expected a queries_run violation, got: ${liveSmokeViolations(noQueries).join(" | ")}`);

  const noFetches = { ...ok, search_universe: { ...ok.search_universe, fetches_used: 0 } };
  expect("live-smoke FAILS: fetches_used is 0", liveSmokeViolations(noFetches).some((s) => /fetches_used/.test(s)),
    `expected a fetches_used violation, got: ${liveSmokeViolations(noFetches).join(" | ")}`);

  const silentEmpty = { candidates: [], outcome: "RECOMMEND", reason_code: "NONE",
    search_universe: { queries_run: ["q"], fetches_used: 3, sources_failed_or_blocked: [], budgets_hit: [], tiers_unavailable: [] } };
  expect("live-smoke FAILS: RECOMMEND with no credible evidence (silent empty)",
    liveSmokeViolations(silentEmpty).some((s) => /silent-empty/.test(s)),
    `expected a silent-empty violation, got: ${liveSmokeViolations(silentEmpty).join(" | ")}`);

  const unexplainedAccess = { candidates: [], outcome: "INSUFFICIENT_EVIDENCE", reason_code: "INSUFFICIENT_ACCESS",
    search_universe: { queries_run: ["q"], fetches_used: 2, sources_failed_or_blocked: [], budgets_hit: [], tiers_unavailable: ["api"] } };
  expect("live-smoke FAILS: INSUFFICIENT_ACCESS with nothing recorded (unexplained)",
    liveSmokeViolations(unexplainedAccess).some((s) => /unexplained access gap/.test(s)),
    `expected an unexplained-access violation, got: ${liveSmokeViolations(unexplainedAccess).join(" | ")}`);

  // queries_run of empty strings must NOT satisfy the "universe exercised" check (correctness review #3).
  const blankQueries = { ...ok, search_universe: { ...ok.search_universe, queries_run: ["", "   "] } };
  expect("live-smoke FAILS: queries_run of blank strings is not 'exercised'",
    liveSmokeViolations(blankQueries).some((s) => /queries_run/.test(s)),
    `expected a queries_run violation, got: ${liveSmokeViolations(blankQueries).join(" | ")}`);

  // A non-array candidates must fail cleanly (return a violation / no credible evidence), never throw (F4).
  const malformedCandidates = { candidates: "oops", outcome: "RECOMMEND", reason_code: "NONE",
    search_universe: { queries_run: ["q"], fetches_used: 3, sources_failed_or_blocked: [], budgets_hit: [] } };
  let threw = false, mv = [];
  try { mv = liveSmokeViolations(malformedCandidates); } catch { threw = true; }
  expect("live-smoke: non-array candidates does not throw", threw === false, `liveSmokeViolations threw on non-array candidates`);
  expect("live-smoke: non-array candidates FAILS as silent-empty", mv.some((s) => /silent-empty/.test(s)),
    `expected a silent-empty violation, got: ${mv.join(" | ")}`);
}

// --- Phase 6: structural anchor resolution (Codex HIGH-2 — anchors must not resolve off comments/prose) -
{
  const grid = readFileSync(join(root, "tools/grid.mjs"), "utf8");
  expect("anchor: a real declaration resolves", anchorResolves(grid, "rankCandidates", true) === true,
    `expected 'export function rankCandidates' to resolve`);
  expect("anchor: a comment-only mention does NOT resolve",
    anchorResolves("// rankCandidates is great\nconst x = 1;", "rankCandidates", true) === false,
    `a comment substring must not resolve a code anchor`);
  expect("anchor: a call-site mention does NOT resolve",
    anchorResolves("foo(rankCandidates);", "rankCandidates", true) === false,
    `a usage substring must not resolve a code anchor`);
  expect("anchor: a token inside a /* block comment */ does NOT resolve",
    anchorResolves("/*\nexport function rankCandidates() {}\n*/\nconst x = 1;", "rankCandidates", true) === false,
    `a declaration buried in a block comment must not resolve a code anchor`);
  const triage = readFileSync(join(root, "docs/triage.md"), "utf8");
  expect("anchor: a real markdown heading resolves", anchorResolves(triage, "Depth decision", false) === true,
    `expected the '## Depth decision' heading to resolve`);
  expect("anchor: doc prose (no heading) does NOT resolve",
    anchorResolves("the depth decision is computed elsewhere", "Depth decision", false) === false,
    `prose without a heading must not resolve a doc anchor`);
}

// --- Coverage requirement terms extraction ---------------------------------------------------------
{
  const t = requirementTerms({ must_haves: ["LDAC codec support","effective ANC","comfortable for long wear","waterproof"], dealbreakers: ["polyester"] });
  expect("coverage req: acronyms + single-word, NOT phrases, NOT dealbreakers",
    t.includes("ldac") && t.includes("anc") && t.includes("waterproof")
      && !t.includes("polyester")
      && !t.some(x => ["comfortable","wear","long"].includes(x)),
    `got ${JSON.stringify(t)}`);
  expect("coverage req: phrase-only must_have -> empty", requirementTerms({ must_haves:["natural / non-synthetic fabric"] }).length === 0, "phrase must not enforce a term");
  expect("coverage req: no must_haves -> empty", requirementTerms({ need:"x", dealbreakers:["x"] }).length === 0, "expected []");
}

// --- Coverage minAnglesFor -------------------------------------------------------------------------
{
  expect("coverage minAngles: depths", [["light",2],["standard",3],["deep",4],[undefined,3]].every(([d,n]) => minAnglesFor(d?{depth:d}:{}) === n), "depth->N mapping wrong");
}

// --- Coverage coverageViolations -------------------------------------------------------------------
{
  const su = (over) => ({ triage:{depth:"standard"}, framed_requirements:{must_haves:["LDAC codec support"]},
    search_universe:{ angles_swept:["roundup","requirement","community"], queries_run:["over-ear headphones with LDAC","best headphones 2026","reddit ldac picks"], budgets_hit:[] }, ...over });
  expect("coverage PASS: 3 angles + LDAC reflected", coverageViolations(su({})).length === 0, JSON.stringify(coverageViolations(su({}))));
  expect("coverage FAIL: requirement angle not declared, term missing",
    coverageViolations(su({ search_universe:{ angles_swept:["roundup","community","catalog"], queries_run:["best headphones 2026","top picks","reddit picks"], budgets_hit:[] }})).some(v=>/not reflected.*not declared/.test(v)),
    "expected requirement-not-declared");
  expect("coverage FAIL: declares requirement, no term (exactly check 3, not duplicated)",
    (()=>{ const vs=coverageViolations(su({ search_universe:{ angles_swept:["roundup","requirement","catalog"], queries_run:["best headphones 2026","catalog browse","top picks"], budgets_hit:[] }}));
      return vs.some(v=>/declaration not backed/.test(v)) && !vs.some(v=>/not declared/.test(v)); })(),
    "expected exactly declaration-not-backed, no duplicate");
  expect("coverage FAIL: under-swept, budget remaining",
    coverageViolations(su({ search_universe:{ angles_swept:["roundup"], queries_run:["over-ear headphones with LDAC"], budgets_hit:[] }})).some(v=>/swept 1 distinct/.test(v)),
    "expected under-swept");
  expect("coverage PASS: under-swept but budget exhausted exempts angle-count",
    coverageViolations(su({ search_universe:{ angles_swept:["roundup"], queries_run:["over-ear headphones with LDAC"], budgets_hit:["max_fetches"] }})).every(v=>!/swept 1 distinct/.test(v)),
    "honest exhaustion must exempt under-swept");
  expect("coverage FAIL: budget exhausted but requirement term still missing (NOT exempt)",
    coverageViolations(su({ search_universe:{ angles_swept:["roundup","community"], queries_run:["best headphones 2026","reddit picks"], budgets_hit:["max_fetches"] }})).some(v=>/not reflected.*not declared/.test(v)),
    "requirement-term check must not be budget-exempt");
}

// --- Task A4: schema field angles_swept present in search_universe ---------------------------------
{
  const s = load("schemas/recommendation-object.schema.json");
  expect("schema: angles_swept present", !!s.$defs?.search_universe?.properties?.angles_swept || !!s.properties?.search_universe?.properties?.angles_swept, "angles_swept not in schema");
}

// --- Task A4b: wire angles_swept end-to-end (orchestration seed/fold + universe_delta + render) ----
{
  const u = orchestrate({ capabilities:{}, plan:{ work:[] } }).search_universe;
  expect("orchestrate seeds angles_swept", Array.isArray(u.angles_swept), `angles_swept not seeded: ${JSON.stringify(u.angles_swept)}`);
  const folded = orchestrate({ capabilities:{ subagents:true }, plan:{ subagents:[ { kind:"harvester", payload:{ agent:"harvester", candidates:[],
    search_universe_delta:{ angles_swept:["requirement","community"] } } } ] } }).search_universe;
  expect("orchestrate folds angles_swept (union)", folded.angles_swept.includes("requirement") && folded.angles_swept.includes("community"), JSON.stringify(folded.angles_swept));
  const rep = renderReport({ outcome:"RECOMMEND", reason_code:"NONE", pick:{product:"X"}, search_universe:{ queries_run:["q"], sources_hit:[], sources_failed_or_blocked:[], tiers_unavailable:[], budgets_hit:[], fetches_used:1, angles_swept:["roundup","requirement"] } });
  expect("render surfaces angles_swept", rep.includes("Angles swept:") && /requirement/.test(rep), "angles_swept not rendered");
}

// --- Task A5: bite-case data + validate wiring + golden coverage -----------------------------------
{
  const cases = load("evals/coverage-cases.json").cases;
  expect("coverage cases: >=5", Array.isArray(cases) && cases.length >= 5, `got ${cases?.length}`);
  for (const c of cases) {
    const v = coverageViolations(c.input);
    if (c.expect_violation) expect(`coverage BITES: ${c.label}`, v.length>=1 && (!c.expect_match || v.join(" | ").includes(c.expect_match)), `got ${v.join(" | ")||"(none)"}`);
    else expect(`coverage PASSES: ${c.label}`, v.length===0, `got ${v.join(" | ")}`);
  }
  // real goldens must pass coverage
  for (const n of readdirSync(join(root,"evals/golden")).filter(f=>f.endsWith(".json")))
    expect(`coverage real golden ${n}`, coverageViolations(load(`evals/golden/${n}`)).length===0, `${n}: ${coverageViolations(load(`evals/golden/${n}`)).join(" | ")}`);
  // F3 (Codex): pin real-golden requirementTerms outputs — proves must_haves-only + phrase-exclusion
  expect("coverage F3: electronics terms = ['anc']", JSON.stringify(requirementTerms(load("evals/golden/electronics-headphones.json").framed_requirements)) === JSON.stringify(["anc"]), "electronics terms wrong");
  for (const n of ["clothing-natural-materials","gift-recipient","safety-supplement"])
    expect(`coverage F3: ${n} terms = []`, requirementTerms(load(`evals/golden/${n}.json`).framed_requirements).length===0, `${n} should yield no hard terms`);
  // F5: each golden's rendered report surfaces angles_swept (actor-observability)
  for (const n of readdirSync(join(root,"evals/golden")).filter(f=>f.endsWith(".json")))
    expect(`coverage F5 render ${n}`, renderReport(load(`evals/golden/${n}`)).includes("Angles swept:"), `${n}: angles_swept not in report`);
}

// --- Task B1: store-index schema (writer<->viewer contract) ------------------------------------------
expect("store-index schema loads + is array", (()=>{const s=load("schemas/store-index.schema.json");return s.type==="array"&&!!s.items?.properties?.id;})(), "schema missing/!array");

// --- Task B2: recordRun + id scheme (durable run store) -----------------------------------------------
{
  const { recordRun, rebuildIndex } = await import("./store.mjs");
  const dir = mkdtempSync(join(tmpdir(),"discern-store-"));
  const rec = load("evals/golden/electronics-headphones.json");
  const { id } = recordRun(rec, { storeDir: dir, now: "2026-06-23T10:00:00.000Z" });
  expect("store: writes json+md", existsSync(join(dir,"runs",id+".json")) && existsSync(join(dir,"runs",id+".md")), "artifacts missing");
  const idx = JSON.parse(readFileSync(join(dir,"index.json"),"utf8"));
  expect("store: index entry", idx.length===1 && idx[0].pick==="Sony WH-1000XM5" && idx[0].outcome==="RECOMMEND", JSON.stringify(idx));
  expect("store: id is timestamp+slug", /^20260623T100000Z-/.test(id), id);
  let threw=false; try { recordRun({outcome:"NONSENSE"}, {storeDir:dir, now:"2026-06-23T10:00:01.000Z"}); } catch { threw=true; }
  expect("store: rejects invalid rec", threw, "invalid object was stored");

  // --- Task B3: rebuildIndex ---
  rmSync(join(dir, "index.json"), { force: true });
  const rebuilt = rebuildIndex({ storeDir: dir });
  expect("store: rebuildIndex returns {count}", rebuilt.count === 1, `expected count=1, got ${rebuilt.count}`);
  const rebuiltIdx = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  expect("store: rebuilt index validates", Array.isArray(rebuiltIdx) && rebuiltIdx.length === 1, `index not valid array`);
  expect("store: rebuilt index entry preserved", rebuiltIdx[0].id === id && rebuiltIdx[0].pick === "Sony WH-1000XM5" && rebuiltIdx[0].outcome === "RECOMMEND",
    `entry missing/wrong: ${JSON.stringify(rebuiltIdx[0])}`);

  rmSync(dir,{recursive:true,force:true});

  // --- FIX 3: recordRun validates the assembled index BEFORE any filesystem write (no orphans) ---
  {
    const d2 = mkdtempSync(join(tmpdir(),"discern-store-orphan-"));
    // Pre-write a CORRUPT index so the assembled candidate index fails validation.
    mkdirSync(join(d2,"runs"),{recursive:true});
    writeFileSync(join(d2,"index.json"), JSON.stringify([{ bad: true }]));
    const before = readdirSync(join(d2,"runs"));
    let threw3 = false;
    try { recordRun(rec, { storeDir: d2, now: "2026-06-23T11:00:00.000Z" }); } catch { threw3 = true; }
    expect("store: recordRun throws when assembled index invalid", threw3, "expected throw on corrupt existing index");
    const after = readdirSync(join(d2,"runs"));
    expect("store: recordRun writes NO orphan run artifacts on index-validation failure",
      after.length === before.length, `orphan files created: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    rmSync(d2,{recursive:true,force:true});
  }

  // --- FIX 5: rebuildIndex validates every run and throws on a malformed one (naming the file) ---
  {
    const d3 = mkdtempSync(join(tmpdir(),"discern-store-rebuild-"));
    mkdirSync(join(d3,"runs"),{recursive:true});
    // One valid golden run, one malformed run missing required rec fields.
    writeFileSync(join(d3,"runs","20260623T120000Z-good.json"), JSON.stringify(rec,null,2));
    writeFileSync(join(d3,"runs","zzz.json"), JSON.stringify({ outcome: "RECOMMEND" }));
    let err5 = null;
    try { rebuildIndex({ storeDir: d3 }); } catch (e) { err5 = e; }
    expect("store: rebuildIndex throws on a malformed run", err5 !== null, "expected throw on malformed run json");
    expect("store: rebuildIndex error names the offending file", !!err5 && /zzz\.json/.test(err5.message),
      `error did not name bad file: ${err5 && err5.message}`);
    rmSync(d3,{recursive:true,force:true});
  }

  // --- Re-review FIX B: rebuildIndex names the file on a JSON *parse* error too ---
  // A syntactically broken run (truncated/corrupt) must throw an error that names
  // the offending file — not a bare "Unexpected token" with no context.
  {
    const d4 = mkdtempSync(join(tmpdir(),"discern-store-badjson-"));
    mkdirSync(join(d4,"runs"),{recursive:true});
    writeFileSync(join(d4,"runs","20260623T130000Z-good.json"), JSON.stringify(rec,null,2));
    writeFileSync(join(d4,"runs","bad.json"), "{ not json"); // syntactically invalid
    let errB = null;
    try { rebuildIndex({ storeDir: d4 }); } catch (e) { errB = e; }
    expect("store: rebuildIndex throws on a syntactically invalid run", errB !== null, "expected throw on invalid JSON");
    expect("store: rebuildIndex JSON-parse error names the offending file", !!errB && /bad\.json/.test(errB.message),
      `error did not name bad file: ${errB && errB.message}`);
    rmSync(d4,{recursive:true,force:true});
  }
}

// --- Task B4: tracked example store ---------------------------------------------------------------
{
  const { default: Ajv2020b4 } = await import("ajv/dist/2020.js");
  const { default: addFormatsB4 } = await import("ajv-formats");
  const ajvB4 = new Ajv2020b4({ allErrors: true, strict: false }); addFormatsB4(ajvB4);
  const validateRecB4 = ajvB4.compile(JSON.parse(readFileSync(join(root,"schemas/recommendation-object.schema.json"),"utf8")));
  const validateCompareB4 = ajvB4.compile(JSON.parse(readFileSync(join(root,"schemas/store-compare.schema.json"),"utf8")));
  const exIdx = (() => { try { return JSON.parse(readFileSync(join(root,"store/example/index.json"),"utf8")); } catch { return null; } })();
  expect("example store: index.json exists and is array with >=1 entry", Array.isArray(exIdx) && exIdx.length >= 1, "no example store (run tools/seed-example.mjs first)");
  if (Array.isArray(exIdx)) {
    for (const entry of exIdx) {
      const runPath = join(root, "store/example", entry.json);
      expect(`example store: run file exists (${entry.id})`, existsSync(runPath), `run file missing: ${runPath}`);
      if (existsSync(runPath)) {
        const rec = JSON.parse(readFileSync(runPath,"utf8"));
        expect(`example store: run schema-validates (${entry.id})`, validateRecB4(rec), `schema violations: ${(validateRecB4.errors||[]).map(e=>e.instancePath+" "+e.message).join("; ")}`);
      }
      // The tracked example must carry a comparison sidecar (the seam fixture the Go reader parses).
      expect(`example store: index entry has compare path (${entry.id})`, entry.compare === `runs/${entry.id}.compare.json`,
        `entry.compare=${entry.compare}`);
      const cmpPath = join(root, "store/example", `runs/${entry.id}.compare.json`);
      expect(`example store: comparison sidecar exists (${entry.id})`, existsSync(cmpPath), `sidecar missing: ${cmpPath}`);
      if (existsSync(cmpPath)) {
        const cmp = JSON.parse(readFileSync(cmpPath,"utf8"));
        expect(`example store: sidecar schema-validates (${entry.id})`, validateCompareB4(cmp),
          `schema violations: ${(validateCompareB4.errors||[]).map(e=>e.instancePath+" "+e.message).join("; ")}`);
        expect(`example store: sidecar id = run id (${entry.id})`, cmp.id === entry.id, `id=${cmp.id}`);
      }
    }
  }
}

// --- Phase 1 (v2.1): store writes + validates the comparison sidecar (design 2026-07-03 §6b/§8) ----
{
  const { recordRun, rebuildIndex } = await import("./store.mjs");
  const { default: Ajv2020cs } = await import("ajv/dist/2020.js");
  const { default: addFormatsCs } = await import("ajv-formats");
  const ajvCs = new Ajv2020cs({ allErrors: true, strict: false }); addFormatsCs(ajvCs);
  const validateCompareCs = ajvCs.compile(JSON.parse(readFileSync(join(root,"schemas/store-compare.schema.json"),"utf8")));
  // The clothing golden carries a dealbreaker -> a richer sidecar (a removed item) than the happy path.
  const rec = load("evals/golden/clothing-natural-materials.json");

  // recordRun writes a schema-valid sidecar AND the index entry gains its "compare" path.
  {
    const dir = mkdtempSync(join(tmpdir(),"discern-compare-"));
    const { id } = recordRun(rec, { storeDir: dir, now: "2026-07-03T10:00:00.000Z" });
    const sidecarPath = join(dir,"runs",id+".compare.json");
    expect("store/compare: recordRun writes the sidecar", existsSync(sidecarPath), `missing ${sidecarPath}`);
    const sidecar = JSON.parse(readFileSync(sidecarPath,"utf8"));
    expect("store/compare: written sidecar schema-validates", validateCompareCs(sidecar),
      `violations: ${(validateCompareCs.errors||[]).map(e=>e.instancePath+" "+e.message).join("; ")}`);
    expect("store/compare: sidecar id stamped with the run id", sidecar.id === id, `id=${sidecar.id} want ${id}`);
    const idx = JSON.parse(readFileSync(join(dir,"index.json"),"utf8"));
    expect("store/compare: index entry gains the compare path", idx[0].compare === `runs/${id}.compare.json`,
      `compare=${idx[0].compare}`);
    rmSync(dir,{recursive:true,force:true});
  }

  // rebuildIndex back-fills a sidecar for an existing run that has none (the reindex path §8).
  {
    const d2 = mkdtempSync(join(tmpdir(),"discern-compare-reindex-"));
    mkdirSync(join(d2,"runs"),{recursive:true});
    const rid = "20260703T110000Z-good";
    writeFileSync(join(d2,"runs",rid+".json"), JSON.stringify(rec,null,2)+"\n");
    const rb = rebuildIndex({ storeDir: d2 });
    expect("store/compare: rebuildIndex counts the run", rb.count === 1, `count=${rb.count}`);
    const backfilled = join(d2,"runs",rid+".compare.json");
    expect("store/compare: rebuildIndex back-fills the sidecar", existsSync(backfilled), `missing ${backfilled}`);
    const bf = JSON.parse(readFileSync(backfilled,"utf8"));
    expect("store/compare: back-filled sidecar schema-validates", validateCompareCs(bf), `invalid back-filled sidecar`);
    expect("store/compare: back-filled sidecar id = run id", bf.id === rid, `id=${bf.id}`);
    const d2idx = JSON.parse(readFileSync(join(d2,"index.json"),"utf8"));
    expect("store/compare: reindex index entry has the compare path", d2idx[0].compare === `runs/${rid}.compare.json`,
      `compare=${d2idx[0].compare}`);
    // reindex also (re)renders the .md from source, so a render.mjs change propagates on reindex.
    const d2md = join(d2,"runs",rid+".md");
    expect("store: rebuildIndex (re)renders the .md report", existsSync(d2md), `missing ${d2md}`);
    expect("store: reindexed .md matches renderReport(rec)", readFileSync(d2md,"utf8") === renderReport(rec)+"\n", `reindexed .md drifted from renderReport`);
    rmSync(d2,{recursive:true,force:true});
  }

  // Fail-closed: a malformed comparison is REFUSED and leaves NO artifacts (like the rec/index guards).
  {
    const d3 = mkdtempSync(join(tmpdir(),"discern-compare-failclosed-"));
    let threwRec = false;
    try { recordRun(rec, { storeDir: d3, now: "2026-07-03T12:00:00.000Z", makeComparison: () => ({ bogus: true }) }); }
    catch { threwRec = true; }
    expect("store/compare: recordRun refuses an invalid comparison", threwRec, "expected throw on invalid comparison");
    const leaked = existsSync(join(d3,"runs")) ? readdirSync(join(d3,"runs")) : [];
    expect("store/compare: recordRun writes NO artifacts on an invalid comparison",
      leaked.length === 0 && !existsSync(join(d3,"index.json")), `artifacts leaked: ${JSON.stringify(leaked)}`);

    // rebuildIndex is equally fail-closed on an invalid comparison.
    mkdirSync(join(d3,"runs"),{recursive:true});
    writeFileSync(join(d3,"runs","20260703T130000Z-x.json"), JSON.stringify(rec,null,2)+"\n");
    let threwReidx = false;
    try { rebuildIndex({ storeDir: d3, makeComparison: () => ({ bogus: true }) }); } catch { threwReidx = true; }
    expect("store/compare: rebuildIndex refuses an invalid comparison", threwReidx, "expected throw on invalid comparison");
    expect("store/compare: rebuildIndex writes no index/sidecar on an invalid comparison",
      !existsSync(join(d3,"index.json")) && !existsSync(join(d3,"runs","20260703T130000Z-x.compare.json")),
      "artifacts leaked on a failed reindex");
    rmSync(d3,{recursive:true,force:true});
  }

  // Back-compat: an old index WITHOUT a "compare" field still validates against the index schema.
  {
    const legacyIdx = [{ id:"20260101T000000Z-x", timestamp:"2026-01-01T00:00:00.000Z", need:"n",
      beneficiary_type:"self", outcome:"RECOMMEND", json:"runs/20260101T000000Z-x.json", md:"runs/20260101T000000Z-x.md" }];
    expect("store/compare: legacy index without compare still validates", validateCompareCs !== null && (()=>{
      const vi = ajvCs.compile(JSON.parse(readFileSync(join(root,"schemas/store-index.schema.json"),"utf8")));
      return vi(legacyIdx);
    })(), "legacy index rejected — compare must be OPTIONAL");
  }
}

// --- Phase 1 (v2.1): in-run candidate comparison model (design 2026-07-03 §4/§7) ------------------
{
  const { buildComparison, cleanScore } = await import("./compare.mjs");
  const { default: Ajv2020c } = await import("ajv/dist/2020.js");
  const { default: addFormatsC } = await import("ajv-formats");
  const ajvC = new Ajv2020c({ allErrors: true, strict: false }); addFormatsC(ajvC);
  const validateCompare = ajvC.compile(JSON.parse(readFileSync(join(root, "schemas/store-compare.schema.json"), "utf8")));

  const clothing = load("evals/golden/clothing-natural-materials.json");
  const cmp = buildComparison(clothing);
  const byProduct = Object.fromEntries(cmp.items.map((it) => [it.product, it]));

  // Status classification: pick / runner-up / disqualified all derived from the recorded recommendation.
  expect("compare: pick classified", byProduct["Organic Cotton Oxford"]?.status === "pick",
    `got ${byProduct["Organic Cotton Oxford"]?.status}`);
  expect("compare: runner-up classified", byProduct["Linen Camp Shirt"]?.status === "runner_up",
    `got ${byProduct["Linen Camp Shirt"]?.status}`);
  expect("compare: dealbreaker -> disqualified", byProduct["Poly-Blend Oxford"]?.status === "disqualified",
    `got ${byProduct["Poly-Blend Oxford"]?.status}`);

  // Disqualified item: reason = its CE detail, a non-null rule, excluded from radar, null norm + clean.
  const poly = byProduct["Poly-Blend Oxford"];
  const polyCeDetail = clothing.shortlist.find((s) => s.product === "Poly-Blend Oxford").counterevidence[0].detail;
  expect("compare: disqualified reason is the CE detail", poly?.disqualified_reason === polyCeDetail,
    `reason=${poly?.disqualified_reason}`);
  expect("compare: dealbreaker_rule non-null for disqualified", typeof poly?.dealbreaker_rule === "string" && poly.dealbreaker_rule.length > 0,
    `rule=${poly?.dealbreaker_rule}`);
  expect("compare: disqualified excluded from radar_default.series", !cmp.radar_default.series.includes("Poly-Blend Oxford"),
    `series=${JSON.stringify(cmp.radar_default.series)}`);
  expect("compare: disqualified consensus_norm null", poly?.scores.consensus_norm === null, `got ${poly?.scores.consensus_norm}`);
  expect("compare: disqualified clean null", poly?.scores.clean === null, `got ${poly?.scores.clean}`);
  // Eligible items never carry a reason/rule.
  expect("compare: eligible has null reason + rule",
    byProduct["Organic Cotton Oxford"]?.disqualified_reason === null && byProduct["Organic Cotton Oxford"]?.dealbreaker_rule === null,
    `reason=${byProduct["Organic Cotton Oxford"]?.disqualified_reason}, rule=${byProduct["Organic Cotton Oxford"]?.dealbreaker_rule}`);

  // Fundamentals honesty: a shortlisted item shows its raw score.
  expect("compare: shortlisted fundamentals is the raw score", byProduct["Organic Cotton Oxford"]?.scores.fundamentals === 0.78,
    `got ${byProduct["Organic Cotton Oxford"]?.scores.fundamentals}`);
  // durable_ids.unresolved surfaces.
  expect("compare: durable_unresolved surfaced", byProduct["Linen Camp Shirt"]?.durable_unresolved === true,
    `got ${byProduct["Linen Camp Shirt"]?.durable_unresolved}`);

  // Evidence = mean claim_confidence (single-evidence pick here -> 0.75).
  expect("compare: evidence is mean claim_confidence", byProduct["Organic Cotton Oxford"]?.scores.evidence === 0.75,
    `got ${byProduct["Organic Cotton Oxford"]?.scores.evidence}`);

  // Consensus: raw preserved; norm over the ELIGIBLE set (eligible raws 2 cotton / 1 linen; poly disq excluded).
  expect("compare: consensus_raw preserved", byProduct["Organic Cotton Oxford"]?.scores.consensus_raw === 2,
    `got ${byProduct["Organic Cotton Oxford"]?.scores.consensus_raw}`);
  expect("compare: consensus_norm pick = 1.0 (eligible max)", byProduct["Organic Cotton Oxford"]?.scores.consensus_norm === 1,
    `got ${byProduct["Organic Cotton Oxford"]?.scores.consensus_norm}`);
  expect("compare: consensus_norm runner = 0.5 (eligible max)", byProduct["Linen Camp Shirt"]?.scores.consensus_norm === 0.5,
    `got ${byProduct["Linen Camp Shirt"]?.scores.consensus_norm}`);

  // Counts arithmetic.
  expect("compare: counts.considered == #candidates", cmp.counts.considered === clothing.candidates.length,
    `got ${cmp.counts.considered}`);
  expect("compare: counts.removed == #dealbreaker", cmp.counts.removed === 1, `got ${cmp.counts.removed}`);
  expect("compare: counts.eligible == considered - removed", cmp.counts.eligible === cmp.counts.considered - cmp.counts.removed,
    `got ${cmp.counts.eligible}`);

  // axes constant + dealbreaker_rules copied verbatim for the legend.
  expect("compare: axes are the four fixed axes",
    JSON.stringify(cmp.axes) === JSON.stringify(["fundamentals", "consensus", "evidence", "clean"]),
    `got ${JSON.stringify(cmp.axes)}`);
  expect("compare: dealbreaker_rules copied verbatim",
    JSON.stringify(cmp.dealbreaker_rules) === JSON.stringify(clothing.framed_requirements.dealbreakers),
    `got ${JSON.stringify(cmp.dealbreaker_rules)}`);

  // radar_default: <=2 series, pick first, rival = highest-fundamentals eligible non-pick.
  expect("compare: radar series length <= 2", cmp.radar_default.series.length <= 2, `len=${cmp.radar_default.series.length}`);
  expect("compare: radar series[0] is the pick", cmp.radar_default.series[0] === "Organic Cotton Oxford",
    `series=${JSON.stringify(cmp.radar_default.series)}`);
  expect("compare: radar series[1] is the highest-fundamentals eligible rival", cmp.radar_default.series[1] === "Linen Camp Shirt",
    `series=${JSON.stringify(cmp.radar_default.series)}`);

  // Canonical item order: pick first, removed last.
  expect("compare: items ordered pick-first", cmp.items[0]?.status === "pick", `first=${cmp.items[0]?.status}`);
  expect("compare: items ordered removed-last", cmp.items[cmp.items.length - 1]?.status === "disqualified",
    `last=${cmp.items[cmp.items.length - 1]?.status}`);

  // Clean-axis penalty ORDERING is the contract: recall > defect === reliability > dissent > other.
  const pen = (kind) => 1 - cleanScore([{ kind, detail: "x" }]);
  expect("compare: clean penalty recall > defect", pen("recall") > pen("defect"), `recall=${pen("recall")} defect=${pen("defect")}`);
  expect("compare: clean penalty defect === reliability", pen("defect") === pen("reliability"),
    `defect=${pen("defect")} reliability=${pen("reliability")}`);
  expect("compare: clean penalty defect > dissent", pen("defect") > pen("dissent"), `defect=${pen("defect")} dissent=${pen("dissent")}`);
  expect("compare: clean penalty dissent > other", pen("dissent") > pen("other"), `dissent=${pen("dissent")} other=${pen("other")}`);
  expect("compare: dealbreaker contributes no clean penalty", cleanScore([{ kind: "dealbreaker", detail: "x" }]) === 1,
    `got ${cleanScore([{ kind: "dealbreaker", detail: "x" }])}`);
  expect("compare: empty counterevidence -> clean 1.0", cleanScore([]) === 1, `got ${cleanScore([])}`);

  // Electronics: a shortlisted item's clean reflects its counterevidence; a clean item is 1.0.
  const electronics = load("evals/golden/electronics-headphones.json");
  const ecmp = buildComparison(electronics);
  const eBy = Object.fromEntries(ecmp.items.map((it) => [it.product, it]));
  expect("compare: pick clean reflects defect penalty (0.75)", eBy["Sony WH-1000XM5"]?.scores.clean === 0.75,
    `got ${eBy["Sony WH-1000XM5"]?.scores.clean}`);
  expect("compare: no-counterevidence item clean 1.0", eBy["Bose QuietComfort Ultra"]?.scores.clean === 1,
    `got ${eBy["Bose QuietComfort Ultra"]?.scores.clean}`);
  expect("compare: evidence = mean of two claim_confidences",
    Math.abs((eBy["Sony WH-1000XM5"]?.scores.evidence ?? 0) - (0.85 + 0.70) / 2) < 1e-9,
    `got ${eBy["Sony WH-1000XM5"]?.scores.evidence}`);

  // Crafted: a not-shortlisted candidate -> fundamentals null + status not_shortlisted; and a disqualified
  // item with the HIGHEST recurrence must be excluded from the normalization max (eligible-only scope).
  const crafted = {
    beneficiary: { type: "self" },
    framed_requirements: { need: "widget", dealbreakers: ["banned material"] },
    triage: { stakes: "low", reversibility: "easy", commoditization: "mixed", depth: "standard", safety_relevant: false },
    candidates: [
      { product: "PickW", maker: "M1", durable_ids: { model_no: "P1" },
        evidence: [{ claim: "good", source_cluster_id: "a", provenance: { url: "https://e/1", owner: "O1", access_tier: "fetch", source_class: "professional_review" }, independence_flag: true, affiliate_or_sponsored_flag: false, claim_confidence: 0.8 }],
        recurrence_over_clusters: 2 },
      { product: "BannedW", maker: "M2", durable_ids: { model_no: "P2" },
        evidence: [{ claim: "banned", source_cluster_id: "b", provenance: { url: "https://e/2", owner: "O2", access_tier: "fetch", source_class: "professional_review" }, independence_flag: true, affiliate_or_sponsored_flag: false, claim_confidence: 0.6 }],
        recurrence_over_clusters: 9 },
      { product: "UnlistedW", maker: "M3", durable_ids: { model_no: "P3" },
        evidence: [{ claim: "unlisted", source_cluster_id: "c", provenance: { url: "https://e/3", owner: "O3", access_tier: "fetch", source_class: "professional_review" }, independence_flag: true, affiliate_or_sponsored_flag: false, claim_confidence: 0.5 }],
        recurrence_over_clusters: 1 },
    ],
    shortlist: [
      { product: "PickW", fundamentals_card: { summary: "s", fundamentals_score: 0.7, fundamentals: [{ dimension: "d", finding: "f" }] }, counterevidence: [] },
      { product: "BannedW", fundamentals_card: { summary: "s", fundamentals_score: 0.9, fundamentals: [{ dimension: "d", finding: "f" }] },
        counterevidence: [{ kind: "dealbreaker", detail: "Contains banned material", source: "framed_requirements.dealbreakers" }] },
    ],
    pick: { product: "PickW", maker: "M1" }, runners_up: [],
    search_universe: { queries_run: ["widget"], sources_hit: [], sources_failed_or_blocked: [], tiers_unavailable: [], budgets_hit: [], fetches_used: 1, angles_swept: ["roundup"] },
    outcome: "RECOMMEND", reason_code: "NONE", confidence_overall: 0.7, rationale: "PickW.", value_assessment: { summary: "ok" },
  };
  const cc = buildComparison(crafted);
  const ccBy = Object.fromEntries(cc.items.map((it) => [it.product, it]));
  expect("compare: not-shortlisted -> status not_shortlisted", ccBy["UnlistedW"]?.status === "not_shortlisted",
    `got ${ccBy["UnlistedW"]?.status}`);
  expect("compare: not-shortlisted -> fundamentals null (never 0)", ccBy["UnlistedW"]?.scores.fundamentals === null,
    `got ${ccBy["UnlistedW"]?.scores.fundamentals}`);
  expect("compare: not-shortlisted -> clean null (no counterevidence data)", ccBy["UnlistedW"]?.scores.clean === null,
    `got ${ccBy["UnlistedW"]?.scores.clean}`);
  // Eligible-only max = max(PickW 2, UnlistedW 1) = 2 (BannedW disq raw 9 excluded).
  expect("compare: normalization excludes disqualified from max (pick norm 1.0)", ccBy["PickW"]?.scores.consensus_norm === 1,
    `got ${ccBy["PickW"]?.scores.consensus_norm}`);
  expect("compare: eligible max is 2 not 9 (unlisted norm 0.5)", ccBy["UnlistedW"]?.scores.consensus_norm === 0.5,
    `got ${ccBy["UnlistedW"]?.scores.consensus_norm}`);
  // A not-shortlisted item can still be a radar rival only if it has a fundamentals score — here it does not.
  expect("compare: not-shortlisted item not chosen as radar rival", !cc.radar_default.series.includes("UnlistedW"),
    `series=${JSON.stringify(cc.radar_default.series)}`);

  // Shared-predicate parity (design §13): the products the prose grid marks "DISQUALIFIED — dealbreaker"
  // are exactly the compare items with status "disqualified" — grid, engine, and tableau in lockstep.
  const gridReport = renderReport(clothing);
  const gridLines = gridReport.split("\n");
  const cmpDisq = cmp.items.filter((it) => it.status === "disqualified").map((it) => it.product);
  const gridDisqProducts = clothing.candidates.map((c) => c.product)
    .filter((p) => gridLines.some((l) => l.includes(p) && l.includes("DISQUALIFIED — dealbreaker")));
  expect("compare/grid parity: identical disqualified set",
    JSON.stringify([...cmpDisq].sort()) === JSON.stringify([...gridDisqProducts].sort()),
    `compare=${JSON.stringify(cmpDisq)} grid=${JSON.stringify(gridDisqProducts)}`);

  // Degenerate INSUFFICIENT_EVIDENCE (no shortlist / no pick): builds, lists every candidate, radar off,
  // and fabricates no pick status.
  const supp = load("evals/golden/safety-supplement.json");
  let sThrew = false, scmp = null;
  try { scmp = buildComparison(supp); } catch { sThrew = true; }
  expect("compare: degenerate does not throw", !sThrew && !!scmp, `buildComparison threw on safety-supplement`);
  expect("compare: degenerate lists every candidate", !!scmp && scmp.items.length === supp.candidates.length,
    `items=${scmp?.items.length}`);
  expect("compare: degenerate radar disabled (<2 series)", !!scmp && scmp.radar_default.series.length < 2,
    `series=${JSON.stringify(scmp?.radar_default.series)}`);
  expect("compare: degenerate fabricates no pick", !!scmp && !scmp.items.some((it) => it.status === "pick"),
    `a pick status was fabricated`);

  // Fail-closed on non-unique product display names (Codex review, high): the join keys on `product`
  // and a shortlist item has no maker to disambiguate, so a duplicate would mis-attribute scores or
  // emit two picks. buildComparison must REFUSE rather than launder an ambiguous comparison.
  const dupCandidate = {
    ...crafted,
    candidates: [crafted.candidates[0], { ...crafted.candidates[2], product: "PickW" }], // two "PickW" candidates
    shortlist: [crafted.shortlist[0]],
    runners_up: [],
  };
  let dupCandThrew = false;
  try { buildComparison(dupCandidate); } catch { dupCandThrew = true; }
  expect("compare: fail-closed on duplicate candidate product", dupCandThrew,
    "buildComparison did not throw on two candidates sharing a product name");

  const dupShortlist = { ...crafted, shortlist: [crafted.shortlist[0], { ...crafted.shortlist[0] }] };
  let dupShortThrew = false;
  try { buildComparison(dupShortlist); } catch { dupShortThrew = true; }
  expect("compare: fail-closed on duplicate shortlist product", dupShortThrew,
    "buildComparison did not throw on two shortlist items sharing a product name");

  // Fail-closed on dangling cross-references (Codex review, high): a shortlist/pick/runner-up
  // product that does not resolve to a candidate would drop the recorded pick or mislabel rows.
  const danglingPick = { ...crafted, pick: { product: "GhostW", maker: "M9" } };
  let dpThrew = false;
  try { buildComparison(danglingPick); } catch { dpThrew = true; }
  expect("compare: fail-closed on dangling pick", dpThrew,
    "buildComparison did not throw on a pick not among the candidates");

  const danglingRunner = { ...crafted, runners_up: [{ product: "GhostR", maker: "M8" }] };
  let drThrew = false;
  try { buildComparison(danglingRunner); } catch { drThrew = true; }
  expect("compare: fail-closed on dangling runner-up", drThrew,
    "buildComparison did not throw on a runner-up not among the candidates");

  const danglingShortlist = {
    ...crafted,
    shortlist: [...crafted.shortlist,
      { product: "GhostS", fundamentals_card: { summary: "s", fundamentals_score: 0.5, fundamentals: [{ dimension: "d", finding: "f" }] }, counterevidence: [] }],
  };
  let dslThrew = false;
  try { buildComparison(danglingShortlist); } catch { dslThrew = true; }
  expect("compare: fail-closed on dangling shortlist product", dslThrew,
    "buildComparison did not throw on a shortlist product not among the candidates");

  // Numeric bounds (Codex review): normalized axes must be 0..1 and consensus_raw >= 0 — the
  // schema must reject impossible values a hand-edited sidecar could carry.
  const outHi = JSON.parse(JSON.stringify(cmp)); outHi.items[0].scores.fundamentals = 2;
  expect("compare: schema rejects fundamentals > 1", !validateCompare(outHi), "schema accepted fundamentals=2");
  const outNeg = JSON.parse(JSON.stringify(cmp)); outNeg.items[0].scores.consensus_raw = -3;
  expect("compare: schema rejects negative consensus_raw", !validateCompare(outNeg), "schema accepted consensus_raw=-3");

  // Sidecar schema-validity: buildComparison output validates against store-compare.schema.json for every golden.
  for (const name of ["electronics-headphones", "clothing-natural-materials", "gift-recipient", "safety-supplement"]) {
    const out = buildComparison(load(`evals/golden/${name}.json`));
    out.id = `test-${name}`; // the writer stamps a real id; supply one so the required field is present
    expect(`compare: sidecar validates against schema (${name})`, validateCompare(out),
      `schema violations: ${(validateCompare.errors || []).map((e) => e.instancePath + " " + e.message).join("; ")}`);
  }
}

// --- Report ----------------------------------------------------------------------------------------
if (failures.length) {
  console.error(`\nLOGIC FAIL — ${failures.length} problem(s) across ${checks} checks:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`OK — ${checks} logic checks passed (clustering + R1 ranking + affiliate weighting + decision engine + confidence calibration + gift switch + offer calibration + rendering + capability orchestration + fail-closed governance + subagent-output validation + category-widening gate + live-smoke checker + multi-angle coverage + store-index schema + example store + candidate-comparison model).`);
