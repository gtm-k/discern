# Upstream live-smoke protocol

The offline suite (`npm test`) proves the engine's **logic** against fixtures. It cannot prove the **upstream
contract**: the open web is the unstable input (VISION §3.4 — page structure and listicle content are "it
usually works," not versioned). Fixtures are a mock, and **mock ≠ real**. This protocol is the periodic check
that Discern still works against live search + fetch.

It is **not** part of `npm test` — CI has no network and live results are non-deterministic. It is an
operator procedure, run before a release or whenever upstream sources change, and again at G4 (UAT).

## What to run

1. Pick the named category. **Default: "over-ear headphones under $300", region US.** (Change it by editing
   the line above in a PR so the choice is reviewable; record the category used in the run log.)
2. Execute the full Discern method (`skills/discern/SKILL.md`) against that category using **real** tools —
   web search for harvest, real fetch for teardown/sourcing. Portable core is sufficient (no browser/API
   required); enhancements may be on if available.
3. Save the produced Recommendation Object to a JSON file.
4. Check it: `node tools/live-smoke-check.mjs <path-to-rec.json>` (see "Checker" below). It must also pass
   the schema: the object is a normal Recommendation Object, so `npm test`'s schema validator applies.

## PASS / FAIL criteria

A run **PASSES** iff all hold:

- `search_universe.queries_run > 0` — the search universe was actually exercised.
- `search_universe.fetches_used > 0` — at least one page was actually fetched.
- **Either** ≥ 1 **credible** evidence item (independent, non-affiliate) was produced, **or** the outcome is
  a correct `INSUFFICIENT_EVIDENCE` (with `reason_code=INSUFFICIENT_ACCESS` when the cause is blocked
  access).
- All failed/blocked sources are recorded in `search_universe` (`sources_failed_or_blocked` / `budgets_hit`
  / `tiers_unavailable`). An `INSUFFICIENT_ACCESS` outcome that records **no** blocked source or budget hit
  is an unexplained empty and **FAILS**.

A run that **silently returns empty** — no credible evidence and no `INSUFFICIENT_EVIDENCE` declaration —
**FAILS**. (Actor-observability: an empty answer the user can't distinguish from "nothing matched" is a
silent failure.)

## Checker

`tools/live-smoke-check.mjs` exports `liveSmokeViolations(rec)` returning a list of violation strings (empty
= PASS); its bite is covered by `tools/test-logic.mjs`. The criteria above are enforced there, so the live
PASS/FAIL is an observable signal, not an eyeball judgment. Run it on the saved object; a non-empty result
is a FAIL with the reasons printed.

> Note: the *judgment* of whether the live pick is actually good stays human (G4). The checker only enforces
> that the run was honest and non-empty — it does not certify the pick is correct.

## Run log

Record each live-smoke run (date, category, outcome, `queries_run`/`fetches_used` counts, any
failed/blocked sources, and PASS/FAIL) wherever release notes live — internally for Discern, in
`gtm-k/prd/discern/`, **not** in this OSS repo, since it includes operational specifics rather than
user-facing docs.
