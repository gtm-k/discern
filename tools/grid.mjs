// Grid ranking for Discern (docs: SKILL.md steps 6-7).
//
// Ranking invariant R1: fundamentals OUTRANK raw frequency. A candidate with a higher fundamentals_score
// ranks above one with a lower score even when the latter has higher recurrence_over_clusters. Recurrence
// (independent consensus) is the trust signal and the tiebreaker — it never overrides substance.
//
// Implemented lexicographically (fundamentals first, recurrence as tiebreaker) so R1 is a hard guarantee,
// not a probabilistic outcome. Before Teardown runs (no fundamentals_score yet), candidates fall back to
// ranking by recurrence — exactly the Phase-2 grid behavior.

/** Returns a new array of candidates sorted best-first under invariant R1. */
export function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const fa = a.fundamentals_score ?? 0;
    const fb = b.fundamentals_score ?? 0;
    if (fb !== fa) return fb - fa;                       // fundamentals first (R1)
    const ra = a.recurrence_over_clusters ?? 0;
    const rb = b.recurrence_over_clusters ?? 0;
    return rb - ra;                                      // independent-consensus tiebreaker
  });
}

/** The top-ranked candidate, or undefined if none. */
export function gridWinner(candidates) {
  return rankCandidates(candidates)[0];
}
