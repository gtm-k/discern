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
    if (acro) { for (const a of acro) out.add(a.toLowerCase()); return; }
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

// placeholder — full implementation added in A3
export function coverageViolations(_rec) { return []; }
