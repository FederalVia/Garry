/**
 * Eager loading of modules the runtime otherwise imports lazily.
 *
 * Node caches ES modules for the life of the process. A module first
 * imported after a rebuild would come from the new dist and be linked
 * against the old cached modules, which can fail on every call until a
 * restart. Loading them all at startup keeps one code version per process:
 * a rebuild takes effect at the next restart, as the tools tell the agent.
 *
 * Every `await import()` target in agent/tools.ts, agent/loop.ts,
 * heartbeat/*.ts and self-mod/*.ts must be listed here (preload.test.ts
 * checks). Each entry is a literal import so bundlers and tsc see it.
 */

const LOADERS: Record<string, () => Promise<unknown>> = {
  "../config.js": () => import("../config.js"),
  "../conway/topup.js": () => import("../conway/topup.js"),
  "../conway/x402.js": () => import("../conway/x402.js"),
  "../git/tools.js": () => import("../git/tools.js"),
  "../heartbeat/tick-context.js": () => import("../heartbeat/tick-context.js"),
  "../inference/gate.js": () => import("../inference/gate.js"),
  "../inference/registry.js": () => import("../inference/registry.js"),
  "../memory/knowledge-store.js": () => import("../memory/knowledge-store.js"),
  "../memory/tools.js": () => import("../memory/tools.js"),
  "../ollama/discover.js": () => import("../ollama/discover.js"),
  "../orchestration/health-monitor.js": () => import("../orchestration/health-monitor.js"),
  "../orchestration/messaging.js": () => import("../orchestration/messaging.js"),
  "../orchestration/simple-tracker.js": () => import("../orchestration/simple-tracker.js"),
  "../orchestration/task-graph.js": () => import("../orchestration/task-graph.js"),
  "../registry/agent-card.js": () => import("../registry/agent-card.js"),
  "../registry/discovery.js": () => import("../registry/discovery.js"),
  "../registry/erc8004.js": () => import("../registry/erc8004.js"),
  "../replication/cleanup.js": () => import("../replication/cleanup.js"),
  "../replication/constitution.js": () => import("../replication/constitution.js"),
  "../replication/genesis.js": () => import("../replication/genesis.js"),
  "../replication/health.js": () => import("../replication/health.js"),
  "../replication/lifecycle.js": () => import("../replication/lifecycle.js"),
  "../replication/lineage.js": () => import("../replication/lineage.js"),
  "../replication/messaging.js": () => import("../replication/messaging.js"),
  "../replication/spawn.js": () => import("../replication/spawn.js"),
  "../self-mod/audit-log.js": () => import("../self-mod/audit-log.js"),
  "../self-mod/code.js": () => import("../self-mod/code.js"),
  "../self-mod/upstream.js": () => import("../self-mod/upstream.js"),
  "../skills/registry.js": () => import("../skills/registry.js"),
  "../soul/reflection.js": () => import("../soul/reflection.js"),
  "../soul/tools.js": () => import("../soul/tools.js"),
  "../state/database.js": () => import("../state/database.js"),
  "../types.js": () => import("../types.js"),
  "ulid": () => import("ulid"),
};

/** Import specifiers, relative to this file (or bare package names). */
export const LAZY_MODULES: readonly string[] = Object.freeze(Object.keys(LOADERS));

/**
 * Import every lazy module. A module that fails to load is reported, not
 * thrown: the tool that needs it fails later with the same error, as before.
 */
export async function preloadLazyModules(
  onError?: (specifier: string, err: unknown) => void,
): Promise<{ loaded: number; failed: string[] }> {
  const failed: string[] = [];
  await Promise.all(
    Object.entries(LOADERS).map(async ([specifier, load]) => {
      try {
        await load();
      } catch (err) {
        failed.push(specifier);
        onError?.(specifier, err);
      }
    }),
  );
  return { loaded: LAZY_MODULES.length - failed.length, failed };
}
