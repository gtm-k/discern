# Category-widening gate

Discern claims to be a **universal** buying engine: one category-neutral method (triage → harvest →
independence clustering → teardown → value/preference filter → decision → sourcing), validated on a few
**seed** categories. The risk that claim creates is **per-category drift** — over time, contributors paper
over a hard case with a bespoke "if category == X" patch, the engine quietly stops being universal, and the
seed cases start to rot. (This is PREMORTEM Story 3; the falsifiable commitment is VISION §3.3.)

This gate makes "universal" **structurally constrained, not merely asserted**. It is wired into `npm test`
(`tools/validate.mjs`), so a category cannot be widened in a way that breaks the checks below without turning
the suite red.

### What the gate does and does NOT enforce (read this before trusting it)

The gate validates three things: (a) the registry's **declarations** (every category cites catalog rules,
not a bespoke ID); (b) each cited rule's catalog **anchor resolves** to a real declared identifier in engine
code or a real markdown heading (so a rule can't be a bare string); and (c) each cited rule is **exhibited**
in that category's fixture — the recommendation must actually show the rule at work, so a category can't
claim to ride a generalized rule it doesn't use.

It does **not** parse `tools/` source for a category-specific `if (category === …)` branch. The
"no bespoke patch" guarantee is therefore enforced *indirectly* — by (b)+(c) above, by the
**cite-a-seed-rule** clause, and by the review **checklist** below — **not** by static code analysis. A
determined contributor could still add category-specific code that produces a fixture which happens to
exhibit the cited rules; that residual gap is closed by code review, and by a Phase-2 plan to enforce
rules-fired from an actual end-to-end engine run (execution-trace enforcement) once such a runner exists.
This boundary is stated so a maintainer does not over-trust the gate beyond its real scope.

## The rule

To accept a **new category**, a contributor MUST:

1. **Add a golden fixture** — `evals/golden/<category>.json`, a schema-valid Recommendation Object, plus
   its expected-outcome entry in `evals/expected/manifest.json` (the existing schema check).
2. **Register a generalized-rule note** — an entry in `evals/category-registry.json` whose
   `generalized_rule` prose explains how the behavior falls out of **existing category-neutral rules**, and
   whose `rule_refs` cite those rules by ID from `evals/rule-catalog.json`. The fixture must actually
   **exhibit** each cited rule. **Not a bespoke per-category patch.**
3. **Keep the seed-regression suite green** — every seed's recorded `outcome`/`pick` **and quality
   fingerprint** (credible-evidence presence, confidence band) in `evals/baseline-picks.json` must still
   hold. Widening must not move a seed answer or quietly degrade its evidence quality.

If any of these is missing or violated, `npm test` fails.

## The three data files

| File | Holds | Gate checks |
|------|-------|-------------|
| `evals/rule-catalog.json` | The canonical **category-neutral** rule IDs (`R1`, `INDEPENDENCE`, `HARD_FILTER`, `BENEFICIARY_SWITCH`, `SAFETY_OVERRIDE`, …). Each has an `anchor: {file, token}` pointing at the real engine code/doc that implements it. | Every anchor must resolve **structurally** — a `.mjs` token must be a declared identifier (export/function/const/let/class), a `.md` token a heading. A comment or prose mention does NOT resolve, so a rule cannot exist as a bare string. |
| `evals/category-registry.json` | One entry per golden fixture: `{ seed, generalized_rule, rule_refs }`. | Every golden fixture has an entry; the note is substantive; every `rule_ref` is a real catalog rule; **a non-seed category may only cite rules a seed already uses**; **each cited rule is exhibited by the fixture**. |
| `evals/baseline-picks.json` | Per seed: recorded `outcome`/`reason_code`/`pick` + quality fingerprint (`credible_evidence`, `confidence_band`) — the regression anchor — plus the "if we did nothing" contrast. | No seed drifts from its baseline (outcome, pick, evidence-quality, or confidence band); no orphan/mislabeled baseline entry. |

The logic lives in `tools/category-gate.mjs` (`categoryGateViolations`, pure). Its **bite** — that a malformed
category actually fails the suite — is proven on synthetic scenarios in `evals/category-gate-cases.json`
(exercised by `tools/test-logic.mjs`), the widening gate's analogue of `evals/invalid/` for the schema.

## Why "cite a rule a seed already uses"?

This is the load-bearing clause. A genuinely **general** rule will already be earning its keep in at least
one seed category. So a new category that only cites such rules is, by construction, riding the shared
engine — not a special case. A new category that needs a rule no seed exercises is the warning sign the gate
is built to catch: either the rule isn't really general yet, or it's a bespoke patch wearing a catalog ID.

### Escape hatch — introducing a genuinely new general rule

Sometimes a new category legitimately needs a new *general* mechanism. The honest path (which the gate
enforces):

1. Implement it as a category-neutral rule in the engine.
2. Add it to `evals/rule-catalog.json` with an `anchor` that resolves to the real implementation.
3. **Retrofit at least one seed** to cite it (proving it generalizes, not that it was bolted on for the new
   category) — *and confirm the seed-regression suite stays green*.
4. Only then cite it from the new category.

If you cannot retrofit a seed, the rule is not general — that is the signal to redesign, not to widen.

## Contributor checklist

- [ ] `evals/golden/<category>.json` added and schema-valid; `evals/expected/manifest.json` updated.
- [ ] `evals/category-registry.json` entry added: `seed: false`, a substantive `generalized_rule` note,
      `rule_refs` drawn from the catalog and **all already used by a seed** (or escape-hatch followed), and
      **each cited rule actually exhibited by the fixture**.
- [ ] No new `if (category === …)` branch in `tools/` — behavior comes from the generalized rules. (This
      one is enforced by review, not by the gate — see the scope note above.)
- [ ] `npm test` green (schema + logic + this gate + seed regression).

## Observable failure signals (per VISION §3.3)

The gate is the *detector*; the failure signals it surfaces (each turns `npm test` red) are: the
seed-regression suite shrinking; a seed drifting in outcome, pick, evidence quality, or confidence band; a
category needing a rule no seed uses; a category claiming a rule its fixture does not exhibit; a dangling
catalog anchor; or a fixture with no generalized-rule note. The one invariant the gate canNOT see — a
category-specific code branch that still exhibits the cited rules — is covered by code review and the
Phase-2 execution-trace plan, and is called out in the scope note above rather than left implicit.
