/**
 * Genealogy store.
 *
 * Tracks how a champion genome came to exist: for every agent we keep a compact
 * node (id, generation, species, parents, origin, lineage). No market data, no
 * genomes, no snapshots are duplicated here — a champion can be traced back
 * through parents without storing redundant copies of anything.
 *
 * The store is bounded: long replay runs would otherwise grow without limit, so
 * the oldest non-ancestral nodes are pruned once the cap is reached.
 */

export const ORIGIN = Object.freeze({
  FOUNDER: "founder",
  ELITE: "elite",
  // Carried forward unculled (evidence-checked survivor tier) but not one of
  // the top elites. See DEFAULT_EVOLUTION.survivorFraction in simulation.mjs.
  SURVIVOR: "survivor",
  CROSSOVER: "crossover",
  MUTATION: "mutation",
  IMMIGRANT: "immigrant",
  FROZEN: "frozen-candidate",
  // Phase 5A: compiled from a validated research proposal (see
  // scripts/research/). Still an ordinary genome from the moment it is born —
  // no special privilege, subject to the exact same fitness/selection/death
  // rules as any other agent.
  RESEARCH: "research",
});

export function createGenealogy({ maxNodes = 20_000 } = {}) {
  /** @type {Map<string, object>} */
  const nodes = new Map();
  const lineageNames = new Set();
  let lineageCounter = 0;
  let pruned = 0;

  function nextLineageId() {
    lineageCounter += 1;
    const id = `L${String(lineageCounter).padStart(5, "0")}`;
    lineageNames.add(id);
    return id;
  }

  /** Register an agent node. Returns its lineage id. */
  function record({ id, generation, species, parents = [], origin = ORIGIN.FOUNDER, lineageId = null }) {
    const inherited = lineageId ?? (parents.length > 0 ? nodes.get(parents[0])?.lineageId ?? null : null);
    const lineage = inherited ?? nextLineageId();

    nodes.set(id, {
      id,
      generation,
      species,
      parents: [...parents],
      origin,
      lineageId: lineage,
      at: null,
    });

    if (nodes.size > maxNodes) prune();
    return lineage;
  }

  /** Drop the oldest nodes that are not referenced as a parent. */
  function prune() {
    const referenced = new Set();
    for (const node of nodes.values()) {
      for (const parent of node.parents) referenced.add(parent);
    }

    for (const id of nodes.keys()) {
      if (nodes.size <= maxNodes * 0.75) break;
      if (referenced.has(id)) continue;
      nodes.delete(id);
      pruned += 1;
    }
  }

  /**
   * Trace an agent back to its founders.
   * Returns newest-first steps, bounded by `maxDepth`.
   */
  function chain(agentId, { maxDepth = 16 } = {}) {
    const steps = [];
    const seen = new Set();
    let cursor = agentId;

    while (cursor && steps.length < maxDepth && !seen.has(cursor)) {
      const node = nodes.get(cursor);
      if (!node) break;
      seen.add(cursor);
      steps.push({
        agentId: node.id,
        generation: node.generation,
        species: node.species,
        origin: node.origin,
        lineageId: node.lineageId,
        parents: node.parents,
      });
      cursor = node.parents[0] ?? null;
    }

    return steps;
  }

  function ancestryDepth(agentId, { maxDepth = 64 } = {}) {
    return chain(agentId, { maxDepth }).length - 1;
  }

  /** Lineage summary: how many lineages exist, which died out, deepest chain. */
  function stats({ alive = [] } = {}) {
    const aliveLineages = new Set();
    for (const node of nodes.values()) {
      if (alive.length > 0 && !alive.includes(node.id)) continue;
      aliveLineages.add(node.lineageId);
    }

    const all = [...lineageNames];
    return {
      nodes: nodes.size,
      lineages: all.length,
      prunedNodes: pruned,
      activeLineages: aliveLineages.size,
      extinctLineages: Math.max(0, all.length - aliveLineages.size),
      maxGeneration: [...nodes.values()].reduce(
        (max, node) => Math.max(max, Number.isFinite(node.generation) ? node.generation : 0),
        0,
      ),
    };
  }

  return {
    record,
    chain,
    ancestryDepth,
    stats,
    get size() {
      return nodes.size;
    },
    get(id) {
      return nodes.get(id) ?? null;
    },
  };
}
