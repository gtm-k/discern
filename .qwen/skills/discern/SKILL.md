---
name: discern
description: Use when the user wants to find the best product to buy among the options available — researching a considered purchase (electronics, appliances, gear, clothing, tools, furniture), comparing options, deciding what to buy, or choosing a gift for someone. Produces a structured, honest recommendation modeled on a disciplined human buying method, not on whatever ranks highest or pays the most commission.
---

# Discern (Qwen entry point)

The **canonical, runtime-neutral** buying method lives at `skills/discern/SKILL.md` in the repo root. This
mirror exists only so Qwen's native skill discovery lists Discern and auto-triggers it on buying intent — it
duplicates no logic.

To run:

1. Complete the **Setup gate** (profile bootstrap + version check) — see `AGENTS.md` › Setup. On a first run
   with no profile, walk the user through a short conversational setup; never fail or run profile-less.
2. Read and follow `skills/discern/SKILL.md` end-to-end, plus the files it references (`schemas/`, `docs/`,
   `agents/`, and the active `profiles/…`).

Scope (v1): research & recommend only — never purchase, enter payment details, or complete checkout.
