# Triage — the research depth-dial

A universal agent must not apply one fixed routine: a $12 cable and an $1,800 laptop deserve very
different effort. Triage runs right after **Frame** and sets `triage.depth`, which controls how many
source-classes Harvest covers, whether Teardown runs, and how many candidates reach the shortlist.

## Inputs (scored at Frame time)

| Signal | Values | Meaning |
|--------|--------|---------|
| `stakes` | low / medium / high | Price relative to the user's category budget + how much it matters to them |
| `reversibility` | easy / moderate / hard | Return policy, resale value, switching cost |
| `commoditization` | commodity / mixed / differentiated | Do products meaningfully differ, or are they interchangeable? |
| `safety_relevant` | boolean | Ingestible, protective, electrical, child-related (see definitions.md) |

## Depth decision

Compute a depth from the signals (deterministic, then allow one-step manual override):

- **deep** — `stakes=high` OR `reversibility=hard`, AND `commoditization` ≠ commodity.
  Full Harvest (all source-classes), Teardown on the full shortlist, ≥3 candidates compared, sourcing
  across multiple merchants.
- **standard** — `stakes=medium`, or high-stakes but commodity. Core source-classes, Teardown on the top
  2–3, light sourcing.
- **light** — `stakes=low` AND `commoditization=commodity` AND `reversibility=easy`. One or two
  source-classes, skip Teardown (note that it was skipped), single best-value pick.

**Safety override:** if `safety_relevant=true`, depth is at least **standard** and the brand-as-proxy
shortcut is disabled regardless of the above (see definitions.md → brand-as-proxy and Decision outcomes).

## Worked examples

- *USB-C cable, $12, returnable, commodity* → light. Pick the best-value reputable option; don't write an essay.
- *Over-ear headphones, $250, returnable, differentiated* → standard/deep. Harvest widely, teardown the
  top picks (chip, ANC, comfort, materials), then price.
- *Car seat, $200* → `safety_relevant=true` → at least standard, brand-proxy disabled; if fundamentals
  can't be established, return `INSUFFICIENT_EVIDENCE` (reason `UNSAFE_BRAND_PROXY`).
- *Espresso machine, $1,500, hard to resell* → deep.

## Honesty rule

The chosen depth and *why* (the signal values) are recorded in `triage` on the Recommendation Object, so
the user can see how hard Discern worked and contest it.
