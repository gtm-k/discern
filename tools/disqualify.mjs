// Single source of the dealbreaker / disqualification predicate + reason extraction.
// (design: prd/discern/specs/2026-07-03-tui-candidate-comparison-design.md §6a, §13.)
//
// Imported by decision.mjs (rankingModel -> choosePick + grid.disqualified), render.mjs (the prose
// grid's "DISQUALIFIED — dealbreaker" marker), and compare.mjs (the comparison tableau's status), so
// the decision engine, the prose grid, and the comparison tableau can NEVER disagree on what "removed
// by a dealbreaker" means.
//
// A `dealbreaker` counterevidence is a STRUCTURAL exclusion — it disqualifies the item from the
// eligible set and the pick regardless of merit (unlike `recall`, which is a Clean-axis penalty).

/** A valid record element: a plain object, not null and not an array. Filters untrusted input. */
const isRecord = (o) => !!o && typeof o === "object" && !Array.isArray(o);

/**
 * The disqualifying (`kind==="dealbreaker"`) counterevidence object, or null when none is present.
 * A non-array / malformed input degrades to [] so callers never throw on untrusted data.
 * @param {unknown} counterevidence - a shortlist item's counterevidence[] (or anything).
 */
export function disqualifyingCounter(counterevidence) {
  return (Array.isArray(counterevidence) ? counterevidence : [])
    .find((c) => isRecord(c) && c.kind === "dealbreaker") ?? null;
}

/** True iff a `dealbreaker` counterevidence is present (the structural-exclusion predicate). */
export function isDisqualified(counterevidence) {
  return disqualifyingCounter(counterevidence) !== null;
}

/** The dealbreaker's reason `detail` string, or null when not disqualified / no string detail. */
export function disqualifyReason(counterevidence) {
  const c = disqualifyingCounter(counterevidence);
  return c && typeof c.detail === "string" ? c.detail : null;
}
