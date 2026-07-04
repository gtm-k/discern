# Profile schema — versions & migrations

Your profile carries a `schema_version`. On every run, Discern's **Setup** gate (see `AGENTS.md` and
`skills/discern/SKILL.md`) compares it to the **current** version below and tells you if your profile needs
migrating — so pulling a new version never silently breaks or ignores your preferences.

**Current profile schema version: `0.1.0`**

## How migration works

If your `profiles/self.md` (or a recipient profile) shows an older `schema_version` than the current one,
Discern summarizes the relevant changes below and offers to update the file **in place**, preserving your
values. It never rewrites a profile without showing you the diff first.

## Changelog

### 0.1.0 — baseline
Initial profile schema (`schemas/profile.schema.json`): `value_framework` (principles,
`prefers_handmade_local`, `markup_tolerance`), `hard_filters`, `preferences`, `category_budgets`,
`brand_trust`, and — for `kind: recipient` — `name`, `occasion_history`, and `sizes`. No migrations needed.
