# Security Policy

## Supported versions

Discern is pre-1.0 and ships from `master`. Security fixes land on `master` and in
the next tagged release. Only the latest release is supported.

| Version | Supported |
|---------|-----------|
| `0.2.x` (latest) | ✅ |
| `< 0.2` | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting: go to the repository's **Security** tab →
**Report a vulnerability**. That opens a private advisory visible only to the maintainers.

Please include:

- affected component (Node core, the durable store, or the Go viewer) and version/commit,
- a minimal reproduction (an input Recommendation Object, a store layout, or a run of commands),
- the impact you observed, and
- any suggested remediation.

You can expect an initial acknowledgement within a few days. Once a fix is available we'll
coordinate a disclosure timeline with you and credit you in the release notes unless you'd
rather remain anonymous.

## Scope and threat model

Discern's security posture assumes **untrusted input at two boundaries**, and the code is
built to fail closed at both:

- **Untrusted analysis data reaching the renderer.** A Recommendation Object may be produced
  by an LLM and is treated as untrusted. The renderer validates against
  `schemas/recommendation-object.schema.json`, never renders a scraped/uncalibrated price as
  trusted (it is flagged *verify-at-checkout*), and never emits raw objects, `undefined`, or
  `NaN` into the report.
- **An untrusted, shared, or hand-edited store reaching the Go viewer.** The viewer treats the
  store as untrusted: report paths taken from `index.json` are constrained to
  `runs/<name>.{json,md}` and re-checked after symlink resolution, so a malicious or corrupted
  index cannot make the viewer read a file outside the store. The Node writer validates every
  object *before* writing and fails closed (no orphaned artifacts, bad files named) when the
  index cannot be rebuilt.

Capability tiers (subagents / browser / retailer API) are **fail-closed**: any tier that cannot
be positively confirmed is treated as absent, subagent output is schema-validated before use,
and resource budgets stop a branch rather than retrying unbounded.

### Out of scope

- **Payments / checkout.** The current release does **research and recommendation only** — it
  never enters payment details or completes a purchase, so there is no payment or credential
  surface to attack. (Phases 2–3 will add checkout-prep and purchasing; this policy will be
  revised when they land.)
- **Third-party content.** Discern reports on products and prices gathered from external sources;
  the *accuracy* of that third-party content is a data-quality concern, not a security
  vulnerability. Prices are explicitly flagged for verification at checkout.
- **Findings that require an already-compromised local machine** (e.g. an attacker who can already
  write arbitrary files to your home directory).

## Dependencies

Dependency updates (e.g. Dependabot security bumps) are treated as security fixes and merged
promptly. Both toolchain gates — `npm test` and `go vet ./... && go test ./... && go build ./...`
— must pass before a security fix is released.
