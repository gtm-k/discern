// Independence clustering for Discern's Consensus step (docs/definitions.md §2).
//
// Two sources are NON-independent (belong to the same cluster) if they share an owner, an affiliate
// network, or an upstream citation. A product's recurrence is counted over DISTINCT clusters, never raw
// pages — this is what stops syndicated/affiliate listicles from masquerading as independent agreement.
//
// Implemented as union-find (connected components): each shared signal is an edge.

/**
 * Assign a stable `source_cluster_id` to each source and an `independence_flag`
 * (true for the representative of each cluster, false for collapsed duplicates).
 * @param {Array<{id?:string, owner?:string, affiliate_network?:string, upstream_citation?:string}>} sources
 */
export function clusterSources(sources) {
  const parent = sources.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };

  const seen = new Map(); // signal-key -> first index that had it
  const link = (i, key) => {
    if (key === undefined || key === null || key === "") return;
    if (seen.has(key)) union(i, seen.get(key));
    else seen.set(key, i);
  };
  // Canonicalize signals so case/whitespace variants of the same owner/network/citation still collapse.
  // A value that is empty AFTER normalization (e.g. whitespace-only) is not a real signal and must NOT
  // link sources — otherwise blank owners would all merge into one bogus cluster.
  const norm = (v) => String(v).trim().toLowerCase();
  sources.forEach((s, i) => {
    const owner = norm(s.owner ?? "");
    const aff = norm(s.affiliate_network ?? "");
    const up = norm(s.upstream_citation ?? "");
    if (owner) link(i, "owner:" + owner);
    if (aff) link(i, "aff:" + aff);
    if (up) link(i, "up:" + up);
  });

  const rootToId = new Map();
  const rootSeen = new Set();
  let n = 0;
  return sources.map((s, i) => {
    const r = find(i);
    if (!rootToId.has(r)) rootToId.set(r, "cluster-" + ++n);
    const isRepresentative = !rootSeen.has(r);
    rootSeen.add(r);
    return { ...s, source_cluster_id: rootToId.get(r), independence_flag: isRepresentative };
  });
}

/** Number of distinct clusters among a set of (already clustered) sources. */
export function distinctClusters(clustered) {
  return new Set(clustered.map((s) => s.source_cluster_id)).size;
}

/** Map of product -> recurrence_over_clusters (distinct clusters endorsing that product). */
export function recurrenceByProduct(clustered) {
  const m = new Map();
  for (const s of clustered) {
    if (!m.has(s.product)) m.set(s.product, new Set());
    m.get(s.product).add(s.source_cluster_id);
  }
  return Object.fromEntries([...m].map(([p, set]) => [p, set.size]));
}

/**
 * Evidence weight. Affiliate/sponsored content is DOWN-WEIGHTED, not excluded (and never zero),
 * so it still counts but cannot dominate independent evidence.
 */
export function sourceWeight(source) {
  // Uses the Recommendation Object contract field (schema: evidence.affiliate_or_sponsored_flag).
  return source.affiliate_or_sponsored_flag ? 0.5 : 1.0;
}
