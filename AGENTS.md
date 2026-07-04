# Discern — agent instructions (canonical · all runtimes)

This file is the **runtime-neutral** entry point for Discern. Every AI coding agent that opens this repo —
Claude Code, Cursor, Codex, Gemini CLI, OpenCode, Aider, Zed, and others — reads it automatically. The
CLI-specific files (`CLAUDE.md`, `CODEX.md`, `GEMINI.md`, `OPENCODE.md`) are thin wrappers that import this
one. **No runtime is privileged — Claude is just one of them.**

## What this repo is

Discern runs a disciplined human **buying method**: it finds the *genuinely best* product for a specific
person — not whatever ranks highest or pays the most commission. The method is `skills/discern/SKILL.md`.

## When to act (trigger)

When the user expresses **buying intent** — for example *"find the best `<thing>`"*, *"what `<X>` should I
buy"*, *"compare `<A>` vs `<B>`"*, *"help me pick a gift for `<person>`"* — run Discern. **Plain language is
enough; the user does not need to name the skill file or paste a long prompt.**

1. **Setup gate — do this first, every run.** Ensure the active profile exists and is current before
   recommending (see [Setup](#setup) below). Never fail or silently run profile-less.
2. **Follow the method.** Read and execute `skills/discern/SKILL.md` end-to-end, plus the files it
   references (`schemas/`, `docs/`, `agents/`, and the active `profiles/…`). Produce the Recommendation
   Object and render the human report.

## Setup

Run this **before** the method, on every run:

1. **Profile bootstrap.** The active profile is `profiles/self.md` (buying for yourself) or
   `profiles/recipients/<name>.md` (a gift). If the needed profile is **missing** — e.g. a fresh install:
   - Offer a **short conversational setup**: ask what *value* means to them (their value framework), rough
     budgets for the categories they care about, any hard filters (materials / origin / repairability), and
     any gift defaults. Write the answers to `profiles/self.md` using `profiles/self.example.md` as the
     shape (Discern reads the fenced `json` block). Show the result and confirm before continuing.
   - If they'd rather skip the interview, copy `profiles/self.example.md` → `profiles/self.md` and tell them
     it's a generic starting point to edit later. Proceed with it.
   - `profiles/self.md` and real recipient profiles are **git-ignored** (private); only `*.example.md` ship.
2. **Version check.** Read the profile's `schema_version` and compare it to the current version in
   `profiles/MIGRATIONS.md`. If the profile is **behind**, summarize what changed (from that file) and offer
   to migrate it in place before running. Never silently run a stale profile.

Only once Setup completes, proceed to the method.

## Scope (v1)

Research & recommend **only**. Never purchase, enter payment details, or complete checkout.

## Updating

This repo's version is in `VERSION`. Profile-schema changes are logged in `profiles/MIGRATIONS.md`. After
pulling a new version, the Setup version check tells the user whether their profile needs migrating.
