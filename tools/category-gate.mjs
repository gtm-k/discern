// Category-widening gate (Discern Phase 6 — PREMORTEM Story 3, VISION §3.3/§3.5/§6).
//
// The "universal engine" claim is kept HONEST by structure, not by assertion: a new category may only be
// accepted if (a) it cites EXISTING category-neutral rules (never a bespoke per-category patch), (b) its
// fixture actually EXHIBITS each rule it claims (claims are checked against the recommendation, not just
// prose), and (c) no already-passing seed category regresses. This module is the guard; it must BITE.
//
// SCOPE (made observable, per docs/category-widening.md): the gate validates the registry's declarations,
// that each cited rule's catalog anchor resolves to a real declaration in engine code / a real docs heading,
// and that the fixture exhibits the cited rules. It does NOT parse tools/ source for category-specific
// control flow — the anti-bespoke guarantee is enforced indirectly (cite-a-seed-rule + exhibition) and by
// the review checklist, not by static analysis. Execution-trace enforcement is a Phase-2 item.
//
// Pure: callers supply the data + an anchor resolver, so the same logic runs against synthetic bite cases
// (test-logic.mjs) and the real registry/catalog/baseline (validate.mjs). Non-empty return = gate fails.

const MIN_NOTE_LEN = 24;
const isMeta = (k) => typeof k === "string" && k.startsWith("_");
const realEntries = (obj) => Object.entries(obj ?? {}).filter(([k]) => !isMeta(k));
const realKeys = (obj) => Object.keys(obj ?? {}).filter((k) => !isMeta(k));
const refsOf = (e) => (Array.isArray(e?.rule_refs) ? e.rule_refs : []);

const countCredible = (rec) =>
  (Array.isArray(rec?.candidates) ? rec.candidates : []).reduce(
    (n, c) => n + (Array.isArray(c?.evidence) ? c.evidence : []).filter(
      (e) => e?.independence_flag === true && e?.affiliate_or_sponsored_flag !== true).length, 0);

const confidenceBandOf = (x) =>
  typeof x !== "number" || Number.isNaN(x) ? "unknown" : x >= 0.8 ? "high" : x >= 0.5 ? "moderate" : "low";

// Each catalog rule, when CLAIMED by a category, must be EXHIBITED in that category's fixture. This ties
// the registry's declaration to observable reality: a category cannot claim it rides a generalized rule it
// does not actually use. Rules with no meaningful structural signature (OUTCOME_FAMILY — every rec has an
// outcome) are intentionally omitted; only claimed rules WITH a predicate are checked.
const EXHIBITS = {
  TRIAGE: (r) => !!(r?.triage && (r.triage.depth || r.triage.stakes)),
  SAFETY_OVERRIDE: (r) => r?.triage?.safety_relevant === true,
  // R1 is a COMPARISON invariant (fundamentals outrank frequency); exhibiting it needs >=2 ranked entries,
  // not a lone scored item. (The fundamentals-beats-frequency case itself is unit-tested by ranking-invariant.json.)
  R1: (r) => {
    const sl = (Array.isArray(r?.shortlist) ? r.shortlist : []).filter((s) => typeof s?.fundamentals_card?.fundamentals_score === "number");
    if (sl.length >= 2) return true;
    const cands = (Array.isArray(r?.candidates) ? r.candidates : []).filter((c) => typeof c?.fundamentals_score === "number");
    return cands.length >= 2;
  },
  INDEPENDENCE: (r) =>
    Array.isArray(r?.candidates) &&
    r.candidates.some((c) => (Array.isArray(c?.evidence) ? c.evidence : []).some((e) => e && "independence_flag" in e)),
  PROVENANCE_CONFIDENCE: (r) =>
    Array.isArray(r?.candidates) &&
    r.candidates.some((c) => (Array.isArray(c?.evidence) ? c.evidence : []).some((e) => e?.provenance && typeof e?.claim_confidence === "number")),
  VALUE_FRAMEWORK: (r) => !!r?.value_assessment,
  // HARD_FILTER must be APPLIED, not merely declared (Codex): a declared dealbreaker with a pick that
  // violates it must NOT pass. Require a structural applied-signal — counterevidence tying a candidate to
  // the filter (the same shape the gift seed uses for the wool exclusion). Bare "filter" dropped to avoid
  // matching coincidental prose (correctness review).
  HARD_FILTER: (r) =>
    Array.isArray(r?.shortlist) && r.shortlist.some((s) =>
      (Array.isArray(s?.counterevidence) ? s.counterevidence : []).some((c) =>
        /dealbreaker|hard ?filter|applies_to_gifts|sensitiv|disqualif|excluded/i.test(c?.detail ?? ""))),
  BENEFICIARY_SWITCH: (r) => r?.beneficiary?.type === "recipient",
};

/**
 * Resolve a catalog anchor STRUCTURALLY (not a bare substring — Codex HIGH-2). Code anchors must match a
 * declared identifier (export/function/const/let/class NAME); doc anchors must match a markdown heading
 * containing the token. So a token appearing only in a comment or prose does NOT resolve.
 */
export function anchorResolves(text, token, isCode) {
  if (typeof text !== "string" || typeof token !== "string" || !token) return false;
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (isCode) {
    // Strip comments first so a token inside a /* block */ or // line comment can't masquerade as a
    // declaration (Codex HIGH — block-comment bodies otherwise reopened the substring-anchor hole).
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    return new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|const|let|class)\\s+${esc}\\b`).test(code);
  }
  return new RegExp(`(?:^|\\n)#{1,6}[^\\n]*${esc}`).test(text); // markdown heading containing the token
}

/**
 * @param {object} args
 * @param {string[]} args.goldenNames    golden fixture basenames on disk (the categories)
 * @param {object}   args.registry       fixtureName -> { seed, generalized_rule, rule_refs }
 * @param {object}   args.catalog        ruleId -> { desc, anchor: { file, token } }
 * @param {object}   args.baseline       fixtureName -> { outcome, reason_code?, pick?, credible_evidence?, confidence_band? }
 * @param {object}   args.goldenOutcomes fixtureName -> observed { outcome, reason_code?, pick? }
 * @param {object}   args.goldenRecs     fixtureName -> full Recommendation Object (for exhibition + fingerprint); optional
 * @param {(file:string, token:string)=>boolean} args.fileContains  anchor resolver
 * @returns {string[]} violation strings (empty = gate passes)
 */
export function categoryGateViolations({
  goldenNames = [],
  registry = {},
  catalog = {},
  baseline = {},
  goldenOutcomes = {},
  goldenRecs = {},
  fileContains = () => false,
} = {}) {
  const v = [];

  // (1) Catalog integrity — a rule cannot be a bare string; its anchor must resolve to real code/docs.
  for (const [id, def] of realEntries(catalog)) {
    const a = def?.anchor;
    if (!a?.file || !a?.token) { v.push(`rule-catalog: '${id}' has no anchor {file, token}`); continue; }
    if (!fileContains(a.file, a.token))
      v.push(`rule-catalog: '${id}' anchor unresolved — '${a.file}' has no declared '${a.token}'; a rule must point at real engine code/docs`);
  }

  // Rules SEED categories already rely on = the proven-general engine surface.
  const seedRules = new Set();
  for (const [, e] of realEntries(registry)) if (e?.seed) for (const r of refsOf(e)) seedRules.add(r);

  // (1b) A fixture basename starting with `_` would be stripped by the metadata filter and silently escape
  // the seed-regression / orphan checks — reject it so the gate has no blind spot. (silent-failure F3)
  for (const name of goldenNames)
    if (isMeta(name)) v.push(`category-gate: golden fixture '${name}' basename cannot start with '_' (would evade the gate's metadata filter)`);

  // (2) Every golden fixture (category) must have a registry entry with a substantive, generalized note.
  for (const name of goldenNames) {
    if (isMeta(name)) continue; // already flagged in (1b)
    const e = registry[name];
    if (!e) { v.push(`category-gate: '${name}' has no entry in category-registry.json (no generalized-rule note)`); continue; }

    const note = typeof e.generalized_rule === "string" ? e.generalized_rule.trim() : "";
    if (note.length < MIN_NOTE_LEN)
      v.push(`category-gate: '${name}' generalized_rule note is missing or too thin (>=${MIN_NOTE_LEN} chars required)`);

    if (e.rule_refs !== undefined && !Array.isArray(e.rule_refs))
      v.push(`category-gate: '${name}' rule_refs is not an array`);
    const refs = refsOf(e);
    if (Array.isArray(e.rule_refs) ? refs.length === 0 : e.rule_refs === undefined)
      v.push(`category-gate: '${name}' cites no rule_refs — a category must ride generalized engine rules`);

    for (const r of refs) {
      if (isMeta(r))
        v.push(`category-gate: '${name}' cites '${r}', a metadata key, not a rule`);
      else if (!(r in catalog))
        v.push(`category-gate: '${name}' cites unknown rule '${r}' (absent from rule-catalog.json) — looks like a bespoke per-category patch`);
      else if (!e.seed && !seedRules.has(r))
        v.push(`category-gate: non-seed '${name}' cites '${r}' which no seed category uses — promote it to a generalized rule (retrofit a seed) before widening`);
    }
  }

  // (2b) Exhibition — each claimed rule must be visible in the fixture (claims vs reality, HIGH-1/HIGH-3).
  for (const [name, e] of realEntries(registry)) {
    const rec = goldenRecs[name];
    if (!rec) continue; // synthetic declaration-only cases have no rec; real data always provides one.
    for (const r of refsOf(e)) {
      const pred = EXHIBITS[r];
      if (pred && !pred(rec))
        v.push(`category-gate: '${name}' claims rule '${r}' but its fixture does not exhibit it (claim not backed by the recommendation)`);
    }
  }

  // (3) No orphan registry entry (a note pointing at a fixture that does not exist on disk).
  for (const name of realKeys(registry))
    if (!goldenNames.includes(name))
      v.push(`category-registry: entry '${name}' has no matching golden fixture`);

  // (4) Seed regression — observed outcome/reason_code/pick (and, when recorded, evidence quality &
  //     confidence band) must match the baseline. (MED-4: shallow regression catches more than the pick.)
  for (const [name, e] of realEntries(registry)) {
    if (!e?.seed) continue;
    const b = baseline[name];
    if (!b) { v.push(`baseline-picks: seed '${name}' has no baseline entry — regression would be undetectable`); continue; }
    const o = goldenOutcomes[name];
    if (!o) { v.push(`baseline-picks: seed '${name}' has no observed outcome to compare`); continue; }
    if (o.outcome !== b.outcome) v.push(`seed regression: '${name}' outcome ${o.outcome} != baseline ${b.outcome}`);
    if (b.reason_code !== undefined && o.reason_code !== b.reason_code)
      v.push(`seed regression: '${name}' reason_code ${o.reason_code} != baseline ${b.reason_code}`);
    if (b.pick !== undefined && o.pick !== b.pick)
      v.push(`seed regression: '${name}' pick ${o.pick} != baseline ${b.pick}`);
    const rec = goldenRecs[name];
    if (rec && b.credible_evidence !== undefined) {
      const has = countCredible(rec) > 0;
      if (has !== b.credible_evidence)
        v.push(`seed regression: '${name}' credible_evidence ${has} != baseline ${b.credible_evidence}`);
    }
    if (rec && b.confidence_band !== undefined) {
      const band = confidenceBandOf(rec.confidence_overall);
      if (band !== b.confidence_band)
        v.push(`seed regression: '${name}' confidence_band ${band} != baseline ${b.confidence_band}`);
    }
  }

  // (5) No orphan / mislabeled baseline entry (keeps the baseline file honest).
  for (const name of realKeys(baseline)) {
    const e = registry[name];
    if (!e) v.push(`baseline-picks: entry '${name}' has no registry entry / golden fixture`);
    else if (!e.seed) v.push(`baseline-picks: '${name}' is recorded as a baseline but is not marked seed`);
  }

  return v;
}
