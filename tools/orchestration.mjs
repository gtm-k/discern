// Discern Phase 5 — capability-gated orchestration: capability detection, fail-closed resource
// governance, and subagent-output validation. (docs: skills/discern/SKILL.md "Orchestration"; agents/*.md;
// docs/data-access.md "Enhancement tiers".)
//
// Design (systems-thinking leverage point): every tier — baseline, subagents, browser, API — routes
// through ONE governor + ONE capability detector, so three guarantees fall out of the structure rather
// than being re-implemented per tier:
//   1. fail-closed budgets — a hit budget STOPS that branch and is RECORDED (search_universe.budgets_hit),
//      never silently widening fanout or retrying unbounded;
//   2. honest breadth — a disabled/absent tier is RECORDED (tiers_unavailable), never treated as present;
//   3. portable-core guarantee — with subagents/browser/API all off, the run still completes on baseline.
//
// Contract boundary (the repeating bug-cluster lesson): subagent output is untrusted (LLM-produced), so
// validateSubagentResult schema-validates every return against schemas/subagent-output.schema.json — which
// $refs the recommendation-object $defs, so subagent and final contracts are one source of truth. Invalid
// output is REJECTED; the orchestrator discards + records it (never fabricates around a gap). When no tier
// is usable, or budgets are exhausted before any credible evidence, the honest terminal is
// INSUFFICIENT_EVIDENCE / reason_code INSUFFICIENT_ACCESS — never a fabricated pick.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Budget defaults. The core fetch budgets are the Phase 1 data-access.md values; the enhancement-tier
 * budgets (max_parallel_subagents, per_api_calls) are additive Phase 5 governance. All are tunable, but
 * the STRUCTURE (every request through the governor, fail-closed) is fixed.
 */
export const DEFAULTS = {
  max_fetches: 40,          // per-run total fetch cap (core, Phase 1)
  per_domain_fetches: 5,    // per-domain fetch cap (core, Phase 1)
  per_fetch_timeout_s: 15,  // per-fetch timeout (core, Phase 1; informational here)
  max_retries: 2,           // per-fetch retries (core, Phase 1; informational here)
  max_parallel_subagents: 6, // enhancement-tier concurrency cap (Phase 5)
  per_api_calls: 20,         // enhancement-tier per-run API call budget (Phase 5)
};

/** A fresh search_universe with all six counters present, so they are populated on EVERY run. */
export function emptyUniverse() {
  return {
    queries_run: [],
    sources_hit: [],
    sources_failed_or_blocked: [],
    tiers_unavailable: [],
    budgets_hit: [],
    fetches_used: 0,
  };
}

const TIER_ORDER = ["baseline", "subagents", "browser", "api"];

/**
 * Detect which data tiers are usable. Baseline (web search + fetch) is ON unless explicitly disabled —
 * it is the portability guarantee. Enhancement tiers (subagents, browser, api) are OFF unless explicitly
 * enabled (fail-closed: an undetectable tier is treated as absent, never assumed present). Every tier that
 * is not available is recorded so breadth narrowing is observable, never silent.
 */
export function detectTiers(capabilities = {}) {
  const cap = capabilities && typeof capabilities === "object" ? capabilities : {};
  const enabled = {
    baseline: cap.baseline !== false, // default ON
    subagents: cap.subagents === true,
    browser: cap.browser === true,
    api: cap.api === true,
  };
  return {
    available: TIER_ORDER.filter((t) => enabled[t]),
    tiers_unavailable: TIER_ORDER.filter((t) => !enabled[t]),
  };
}

/**
 * Build the effective budget config, fail-closed. A non-finite or negative override (NaN, Infinity, -1)
 * would silently DISABLE a cap — `NaN >= x` is always false, so the `>=` checks below would never fire and
 * the governor would fail OPEN. Such a value is rejected: it falls back to the default and is recorded as
 * `invalid_budget:<key>` so the bad config is observable. Unknown keys are ignored (forward-compatible).
 */
function sanitizeBudgets(budgets, universe) {
  const cfg = { ...DEFAULTS };
  if (budgets && typeof budgets === "object" && !Array.isArray(budgets)) {
    for (const key of Object.keys(DEFAULTS)) {
      if (!(key in budgets)) continue;
      const v = budgets[key];
      if (Number.isFinite(v) && v >= 0) { cfg[key] = Math.floor(v); continue; }
      cfg[key] = DEFAULTS[key]; // fail closed to the default cap, never to "no cap"
      const tag = `invalid_budget:${key}`;
      if (!universe.budgets_hit.includes(tag)) universe.budgets_hit.push(tag);
    }
  }
  return cfg;
}

/**
 * Create a fail-closed resource governor over a search_universe. Each request returns {allowed, reason};
 * when a budget is exhausted the request is denied and the budget is recorded ONCE in universe.budgets_hit
 * (deduped). The governor never widens a budget or retries unbounded — exhaustion stops that branch.
 */
export function createGovernor(budgets = {}, universe = emptyUniverse()) {
  const cfg = sanitizeBudgets(budgets, universe);
  const perDomain = new Map();
  let activeSubagents = 0;
  let apiCalls = 0;

  const record = (tag) => { if (!universe.budgets_hit.includes(tag)) universe.budgets_hit.push(tag); };

  return {
    universe,
    config: cfg,
    /** Request one fetch against a domain. Checks the global cap first, then the per-domain cap. */
    requestFetch(domain = "unknown") {
      const d = typeof domain === "string" && domain ? domain : "unknown";
      if (universe.fetches_used >= cfg.max_fetches) { record("max_fetches"); return { allowed: false, reason: "max_fetches" }; }
      const used = perDomain.get(d) ?? 0;
      if (used >= cfg.per_domain_fetches) { record(`per_domain_fetches:${d}`); return { allowed: false, reason: "per_domain_fetches" }; }
      perDomain.set(d, used + 1);
      universe.fetches_used += 1;
      return { allowed: true };
    },
    /** Request one enhancement-tier API call against the per-run API budget. */
    requestApiCall() {
      if (apiCalls >= cfg.per_api_calls) { record("per_api_calls"); return { allowed: false, reason: "per_api_calls" }; }
      apiCalls += 1;
      return { allowed: true };
    },
    /** Acquire one concurrent subagent slot (fail-closed at the max_parallel_subagents cap). */
    acquireSubagent() {
      if (activeSubagents >= cfg.max_parallel_subagents) { record("max_parallel_subagents"); return { allowed: false, reason: "max_parallel_subagents" }; }
      activeSubagents += 1;
      return { allowed: true };
    },
    /** Release a concurrent subagent slot. */
    releaseSubagent() { if (activeSubagents > 0) activeSubagents -= 1; },
  };
}

// --- Subagent output validation (the contract boundary) --------------------------------------------

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const recSchema = JSON.parse(readFileSync(join(root, "schemas/recommendation-object.schema.json"), "utf8"));
const subSchema = JSON.parse(readFileSync(join(root, "schemas/subagent-output.schema.json"), "utf8"));
ajv.addSchema(recSchema); // registered under its $id so subSchema's cross-file $refs resolve.
ajv.addSchema(subSchema);
const SUB_ID = subSchema.$id;
const subValidators = {
  harvester: ajv.compile({ $ref: `${SUB_ID}#/$defs/harvester_output` }),
  teardown: ajv.compile({ $ref: `${SUB_ID}#/$defs/teardown_output` }),
  sourcing: ajv.compile({ $ref: `${SUB_ID}#/$defs/sourcing_output` }),
};

/**
 * Validate one subagent return against its envelope schema. Returns [] when valid, else a list of
 * violation strings. Fail-closed: an unknown subagent kind or a non-object payload is rejected before any
 * deref, so a misrouted or garbled return can never be silently accepted.
 * @param {"harvester"|"teardown"|"sourcing"} kind
 * @param {object} payload
 */
export function validateSubagentResult(kind, payload) {
  const v = subValidators[kind];
  if (!v) return [`unknown subagent kind "${kind}" (fail-closed)`];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return [`subagent "${kind}" returned a non-object payload (fail-closed)`];
  if (v(payload)) return [];
  return (v.errors || []).map((e) => `${e.instancePath || "/"} ${e.message}`);
}

// --- Orchestration (deterministic simulation the evals drive) --------------------------------------

/** Merge a subagent's honest search_universe_delta into the run universe (dedup arrays; sum fetches). */
function foldDelta(universe, delta) {
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) return;
  for (const k of ["queries_run", "sources_hit", "sources_failed_or_blocked", "budgets_hit"]) {
    if (!Array.isArray(delta[k])) continue;
    for (const x of delta[k]) if (typeof x === "string" && !universe[k].includes(x)) universe[k].push(x);
  }
  if (Number.isFinite(delta.fetches_used) && delta.fetches_used > 0) universe.fetches_used += Math.floor(delta.fetches_used);
}

/**
 * Ingest one subagent return at the contract boundary. Untrusted (LLM-produced) output is schema-validated;
 * an invalid return is DISCARDED and recorded in sources_failed_or_blocked (never trusted, never fabricated
 * around). A valid return's delta is folded; the count of credible items it contributed is returned (so the
 * access gate can tell a productive run from an empty one). An empty-but-valid return contributes 0 but its
 * delta still records WHY it was empty.
 * @returns {number} credible items contributed (0 if discarded or empty)
 */
function ingestSubagentResult(kind, payload, universe, idx) {
  const violations = validateSubagentResult(kind, payload);
  if (violations.length) {
    universe.sources_failed_or_blocked.push(
      `subagent ${typeof kind === "string" ? kind : "unknown"} #${idx}: invalid output discarded (${violations.length} violation(s))`);
    return 0;
  }
  foldDelta(universe, payload.search_universe_delta);
  if (kind === "harvester") return (payload.candidates ?? []).length;
  if (kind === "teardown") return (payload.shortlist ?? []).length;
  if (kind === "sourcing") return (payload.offers ?? []).length;
  return 0;
}

/** The honest terminal when access is insufficient — never a fabricated pick. */
function terminalInsufficient(universe, branches_stopped, extra) {
  return {
    search_universe: universe, branches_stopped,
    access: "insufficient", outcome: "INSUFFICIENT_EVIDENCE", reason_code: "INSUFFICIENT_ACCESS",
    ...extra,
  };
}

/**
 * Run the capability-gated orchestration over a plan and report what was reachable within budget. This is
 * the offline-eval model of the live skill's orchestration step: it does not fetch, it decides what WOULD
 * be allowed and records the honest search_universe. The skill agent performs the real fetches under the
 * same rules.
 *
 * @param {{capabilities?: object, budgets?: object, plan?: object}} args
 *   plan.queries: string[]            -> recorded in search_universe.queries_run
 *   plan.subagent_fanout: number      -> desired parallel subagents (capped at max_parallel_subagents)
 *   plan.work: Array<{type:"fetch"|"api", domain?:string, yields_evidence?:boolean}>
 * @returns {{search_universe, evidence_count, api_calls, dispatched_subagents, branches_stopped,
 *            tiers_available, access:"ok"|"insufficient", outcome, reason_code, degraded}}
 */
export function orchestrate({ capabilities = {}, budgets = {}, plan = {} } = {}) {
  const p = plan && typeof plan === "object" ? plan : {};
  const universe = emptyUniverse();
  const { available, tiers_unavailable } = detectTiers(capabilities);
  universe.tiers_unavailable = tiers_unavailable;
  if (Array.isArray(p.queries)) universe.queries_run = p.queries.filter((q) => typeof q === "string");

  const degraded = tiers_unavailable.length > 0;
  const branches_stopped = [];
  const stopped = new Set(); // dedupe branch-stop records
  const stop = (key) => { if (!stopped.has(key)) { stopped.add(key); branches_stopped.push(key); } };

  // No usable tier at all -> honest INSUFFICIENT_ACCESS, never a fabricated pick.
  if (available.length === 0)
    return terminalInsufficient(universe, branches_stopped,
      { evidence_count: 0, api_calls: 0, dispatched_subagents: 0, tiers_available: available, degraded });

  const gov = createGovernor(budgets, universe); // sanitizes budgets (records invalid_budget)
  let evidence_count = 0;
  let api_calls = 0;
  let dispatched_subagents = 0;
  const canFetch = available.includes("baseline") || available.includes("browser");

  // Subagent fan-out (only when the subagents tier is available). `plan.subagents` carries explicit returns
  // that are validated + folded at the boundary; a bare `subagent_fanout` count models dispatch slots with
  // no modeled returns. The cap bounds ONE concurrent wave — excess is denied + recorded, never widened.
  let subagentPlan = [];
  if (Array.isArray(p.subagents)) subagentPlan = p.subagents;
  else if (Number.isInteger(p.subagent_fanout) && p.subagent_fanout > 0)
    subagentPlan = Array.from({ length: p.subagent_fanout }, () => null);
  if (subagentPlan.length > 0) {
    if (available.includes("subagents")) {
      let idx = 0;
      for (const sub of subagentPlan) {
        if (!gov.acquireSubagent().allowed) continue; // cap reached -> governor recorded budgets_hit
        dispatched_subagents += 1;
        if (sub && typeof sub === "object" && sub.payload !== undefined)
          evidence_count += ingestSubagentResult(sub.kind, sub.payload, universe, idx);
        idx += 1;
      }
    } else {
      // Wanted parallel breadth but the tier is absent: record the MAGNITUDE lost (not a silent no-op
      // indistinguishable from "never wanted subagents").
      stop(`subagents unavailable: ${subagentPlan.length} planned, 0 dispatched`);
    }
  }

  // Walk the work plan through the governor. Fetches need a fetch-capable tier (baseline or browser); api
  // items need the api tier. Every unreachable / malformed item is RECORDED (never a silent skip).
  for (const item of Array.isArray(p.work) ? p.work : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) { stop("malformed work item (non-object)"); continue; }
    if (item.type === "fetch") {
      if (typeof item.domain !== "string" || !item.domain) { stop("fetch: malformed domain"); continue; }
      if (!canFetch) { stop(`fetch:${item.domain} (no fetch-capable tier)`); continue; }
      const res = gov.requestFetch(item.domain);
      if (res.allowed) {
        if (!universe.sources_hit.includes(item.domain)) universe.sources_hit.push(item.domain);
        if (item.yields_evidence) evidence_count += 1;
      } else {
        stop(`fetch:${item.domain} (${res.reason})`);
      }
    } else if (item.type === "api") {
      if (!available.includes("api")) { stop("api (tier unavailable)"); continue; }
      const res = gov.requestApiCall();
      if (res.allowed) {
        api_calls += 1;
        if (item.yields_evidence) evidence_count += 1;
      } else {
        stop(`api (${res.reason})`);
      }
    } else {
      stop(`unknown work item type "${typeof item.type === "string" ? item.type : String(item.type)}"`);
    }
  }

  // Insufficient access: ZERO credible evidence AND access was actually impeded — a real budget exhaustion
  // (not an invalid_budget config marker), a stopped branch, or a recorded source failure. A run that
  // searched fine but found nothing (no failures) is NOT insufficient access: that is a downstream
  // NO_CONSENSUS / THIN_EVIDENCE call, so access stays "ok" and the decision engine decides.
  const realBudgetExhausted = universe.budgets_hit.some((b) => !b.startsWith("invalid_budget:"));
  const accessImpeded = realBudgetExhausted || branches_stopped.length > 0 || universe.sources_failed_or_blocked.length > 0;
  if (evidence_count === 0 && accessImpeded)
    return terminalInsufficient(universe, branches_stopped,
      { evidence_count, api_calls, dispatched_subagents, tiers_available: available, degraded });

  return {
    search_universe: universe, evidence_count, api_calls, dispatched_subagents, branches_stopped,
    tiers_available: available, access: "ok", outcome: null, reason_code: "NONE", degraded,
  };
}
