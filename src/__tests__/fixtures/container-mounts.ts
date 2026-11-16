/**
 * The agent service's mounts as the container smoke test passes them to
 * `docker run`. container-layout.test.ts checks them against
 * deploy/docker-compose.yml, so the smoke test cannot drift from the
 * documented layout while Docker is unavailable.
 */

export const AGENT_STATE = "/home/automaton/.automaton";

/** data/config files bound read-only over the state folder. */
export const SMOKE_OWNER_FILES = [
  "automaton.json",
  "wallet.json",
  "config.json",
  "heartbeat.yml",
  "constitution.md",
  "inference-providers.json",
  "mcp-servers.json",
];

/** data/config folders bound read-only over the state folder. */
export const SMOKE_OWNER_CONFIG_DIRS = ["public-access"];

/** `host:container[:ro]` for every volume of the agent service, with data/ at `dir`. */
export function agentVolumes(dir: string, state = "state"): string[] {
  return [
    `${dir}/${state}:${AGENT_STATE}`,
    ...SMOKE_OWNER_FILES.map((f) => `${dir}/config/${f}:${AGENT_STATE}/${f}:ro`),
    `${dir}/owner:${AGENT_STATE}/owner:ro`,
    ...SMOKE_OWNER_CONFIG_DIRS.map((d) => `${dir}/config/${d}:${AGENT_STATE}/${d}:ro`),
  ];
}

/** The same as `docker run` arguments. */
export function agentMounts(dir: string, state = "state"): string[] {
  return agentVolumes(dir, state).flatMap((v) => ["-v", v]);
}

/** The mounts without every volume whose text contains `needle` (the `-v` goes with its volume). */
export function agentMountsWithout(dir: string, needle: string, state = "state"): string[] {
  return agentVolumes(dir, state)
    .filter((v) => !v.includes(needle))
    .flatMap((v) => ["-v", v]);
}
