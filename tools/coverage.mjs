// Multi-angle harvest coverage (Discern v2 — spec: prd/discern/specs/2026-06-23-multi-angle-harvest-coverage-design.md).
export const ANGLES = ["roundup","requirement","community","catalog"];

// Atomic requirement tokens from must_haves ONLY (positive requirements you search FOR). Dealbreakers are
// enforced by HARD_FILTER at decision time, not harvest coverage. A must-have contributes only if atomic:
// an all-caps acronym, OR a single word >=4 chars. Multi-word phrases contribute nothing (non-enforced).
export function requirementTerms(framed) {
  const out = new Set();
  const add = (s) => {
    if (typeof s !== "string") return;
    const acro = s.match(/\b[A-Z]{2,}\b/g);
    if (acro) { for (const a of acro) out.add(a.toLowerCase()); return; } // acronym present: the phrase is enforced via the acronym token — no need to also add the full phrase
    const trimmed = s.trim();
    if (/^[A-Za-z0-9-]{4,}$/.test(trimmed)) out.add(trimmed.toLowerCase()); // single atomic word only
  };
  for (const m of framed?.must_haves ?? []) add(m);          // must_haves only
  return [...out];
}

export function minAnglesFor(triage) {
  const d = triage?.depth;
  return d === "light" ? 2 : d === "deep" ? 4 : 3; // standard / unknown -> 3
}

const wholeWord = (q, term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(q);

export function coverageViolations(rec) {
  const v = [];
  const su = rec?.search_universe ?? {};
  const swept = Array.isArray(su.angles_swept) ? [...new Set(su.angles_swept.filter((a) => ANGLES.includes(a)))] : [];
  const queries = Array.isArray(su.queries_run) ? su.queries_run.filter((q) => typeof q === "string") : [];
  const budgetHit = Array.isArray(su.budgets_hit) && su.budgets_hit.length > 0;
  const need = minAnglesFor(rec?.triage);
  const terms = requirementTerms(rec?.framed_requirements);

  if (swept.length < need && !budgetHit)
    v.push(`coverage: swept ${swept.length} distinct angle(s), need >= ${need} (depth ${rec?.triage?.depth ?? "unknown"}) and budget was not exhausted`);

  // checks 2 & 3 are MUTUALLY EXCLUSIVE — gate check 2 on the requirement angle NOT being declared
  if (!swept.includes("requirement"))
    for (const t of terms)
      if (!queries.some((q) => wholeWord(q, t)))
        v.push(`coverage: hard requirement '${t}' not reflected in queries_run and the requirement angle was not declared`);

  if (swept.includes("requirement") && terms.length > 0 && !terms.some((t) => queries.some((q) => wholeWord(q, t))))
    v.push(`coverage: angles_swept declares 'requirement' but no requirement term appears in queries_run (declaration not backed by reality)`);

  return v;
}
