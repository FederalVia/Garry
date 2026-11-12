/**
 * Spawn
 *
 * Spawn child automatons in new Conway sandboxes.
 * Uses the lifecycle state machine for tracked transitions.
 * Cleans up sandbox on ANY failure after creation.
 */

import type {
  ConwayClient,
  AutomatonIdentity,
  AutomatonDatabase,
  GenesisConfig,
  ChildAutomaton,
  ExecResult,
} from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";
import type { ChildLifecycle } from "./lifecycle.js";
import {
  SPAWNING,
  countSlotHoldingChildren,
  holdsSlot,
  latestLifecycleEventMs,
} from "./child-status.js";
import { ulid } from "ulid";
import { propagateConstitution } from "./constitution.js";
import { INSTALL_AND_BUILD } from "../self-mod/install.js";
import { createConfig } from "../config.js";

/** Valid Conway sandbox pricing tiers. */
const SANDBOX_TIERS = [
  { memoryMb: 512,  vcpu: 1, diskGb: 5 },
  { memoryMb: 1024, vcpu: 1, diskGb: 10 },
  { memoryMb: 2048, vcpu: 2, diskGb: 20 },
  { memoryMb: 4096, vcpu: 2, diskGb: 40 },
  { memoryMb: 8192, vcpu: 4, diskGb: 80 },
];

/** Find the smallest valid tier that has at least the requested memory. */
function selectSandboxTier(requestedMemoryMb: number) {
  return SANDBOX_TIERS.find((t) => t.memoryMb >= requestedMemoryMb) ?? SANDBOX_TIERS[SANDBOX_TIERS.length - 1];
}

import { isValidAddress } from "../identity/chain.js";
import type { ChainType } from "../identity/chain.js";

/**
 * Validate that an address is a well-formed, non-zero wallet address.
 * Supports both EVM (0x...) and Solana (base58) addresses.
 */
export function isValidWalletAddress(address: string, chainType?: ChainType): boolean {
  if (chainType === "solana") {
    return isValidAddress(address, "solana");
  }
  // Default EVM validation (with non-zero check)
  return (
    /^0x[a-fA-F0-9]{40}$/.test(address) && address !== "0x" + "0".repeat(40)
  );
}

/** Operator limits for spawning, from AutomatonConfig. */
export interface SpawnLimits {
  maxChildren: number;
  childSandboxMemoryMb?: number;
  /** Git repository the child runtime is cloned from (https). */
  childRuntimeRepo?: string;
  /** Branch or tag of childRuntimeRepo; the default branch when absent. */
  childRuntimeRef?: string;
}

/** Where a child's runtime comes from unless the operator configures one. */
export const DEFAULT_CHILD_RUNTIME_REPO = "https://github.com/Conway-Research/automaton.git";

/** Present in a child checkout that builds automaton.json from genesis.json itself. */
export const CHILD_GENESIS_BOOTSTRAP = "/root/automaton/dist/setup/genesis-bootstrap.js";
export const CHILD_CONFIG_PATH = "/root/.automaton/automaton.json";

/** A spawn that has made no lifecycle progress for this long was abandoned. */
export const SPAWN_ABANDONED_MS = 30 * 60 * 1000;

/** Matches the child's agent loop and never the shell that runs the check. */
export const CHILD_PROCESS_PATTERN = "[i]ndex.js --run";

interface ResolvedLimits {
  maxChildren: number;
  memoryMb: number;
  cloneCommand: string;
}

function resolveLimits(limits?: SpawnLimits): ResolvedLimits {
  const maxChildren = limits?.maxChildren ?? DEFAULT_CONFIG.maxChildren ?? 3;
  const memoryMb = limits?.childSandboxMemoryMb ?? DEFAULT_CONFIG.childSandboxMemoryMb ?? 1024;
  return {
    maxChildren: Number.isFinite(maxChildren) ? Math.floor(maxChildren) : 0,
    memoryMb,
    cloneCommand: childCloneCommand(limits?.childRuntimeRepo, limits?.childRuntimeRef),
  };
}

/**
 * The clone-and-build command for the child runtime. Repo and ref go into a
 * shell command, so only plain https URLs and ref names are accepted.
 */
export function childCloneCommand(repo?: string, ref?: string): string {
  const source = repo?.trim() || DEFAULT_CHILD_RUNTIME_REPO;
  if (!/^https:\/\/[A-Za-z0-9._~:/@%+-]+$/.test(source)) {
    throw new Error(`Cannot spawn: childRuntimeRepo must be a plain https git URL (got ${JSON.stringify(source)}).`);
  }
  const branch = ref?.trim();
  if (branch !== undefined && branch !== "" && !/^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,199}$/.test(branch)) {
    throw new Error(`Cannot spawn: childRuntimeRef is not a valid branch or tag name (got ${JSON.stringify(branch)}).`);
  }
  const branchArg = branch ? `--branch ${branch} ` : "";
  return `git clone ${branchArg}${source} /root/automaton && cd /root/automaton && ${INSTALL_AND_BUILD}`;
}

function assertSpawnAllowed(maxChildren: number): void {
  if (maxChildren <= 0) {
    throw new Error("Cannot spawn: replication disabled (maxChildren is 0).");
  }
}

function assertSlotAvailable(db: AutomatonDatabase, maxChildren: number): void {
  const active = countSlotHoldingChildren(db.raw);
  if (active >= maxChildren) {
    throw new Error(
      `Cannot spawn: already at max children (${active}/${maxChildren}). Stop a child (stop_child) or wait for one to end.`,
    );
  }
}

/**
 * Fail lifecycle rows stuck in a spawning state. spawnChild runs in this
 * process, so a row that made no progress for SPAWN_ABANDONED_MS belongs to
 * a spawn that crashed or was interrupted; it would otherwise hold a slot
 * forever.
 */
function failAbandonedSpawns(db: AutomatonDatabase, lifecycle: ChildLifecycle, nowMs: number): void {
  const rows = db.raw
    .prepare(`SELECT id, status FROM children WHERE status IN (${[...SPAWNING].map(() => "?").join(",")})`)
    .all(...SPAWNING) as Array<{ id: string; status: string }>;
  for (const row of rows) {
    const lastMs = latestLifecycleEventMs(db.raw, row.id);
    if (Number.isNaN(lastMs) || nowMs - lastMs < SPAWN_ABANDONED_MS) continue;
    try {
      lifecycle.transition(row.id, "failed", `spawn abandoned: no progress since ${new Date(lastMs).toISOString()}`);
    } catch {
      // State changed under us; the slot count below sees the new state.
    }
  }
}

/** Run a setup command in the child sandbox and fail on a non-zero exit. */
async function runStep(client: ConwayClient, step: string, command: string, timeoutMs: number): Promise<ExecResult> {
  const result = await client.exec(command, timeoutMs);
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(-300);
    throw new Error(`${step} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

/**
 * Make sure the child can start without a terminal. A checkout with the
 * genesis bootstrap builds automaton.json from genesis.json on its first
 * --run. An older checkout (upstream) would block in the setup wizard, so the
 * child provisions its own API key (it stays in the child's config.json,
 * which loadConfig falls back to) and the parent writes automaton.json.
 */
async function ensureChildConfig(
  client: ConwayClient,
  params: {
    genesis: GenesisConfig;
    identity: AutomatonIdentity;
    sandboxId: string;
    walletAddress: string;
    chainType: string;
  },
): Promise<"genesis-bootstrap" | "parent-written"> {
  const probe = await client.exec(
    `test -f ${CHILD_GENESIS_BOOTSTRAP} && echo genesis-bootstrap || echo no-bootstrap`,
    10_000,
  );
  if ((probe.stdout || "").trim().split("\n").pop()?.trim() === "genesis-bootstrap") {
    return "genesis-bootstrap";
  }

  // Output is discarded: it carries the child's API key.
  await runStep(
    client,
    "child API key provisioning",
    "node /root/automaton/dist/index.js --provision >/dev/null 2>&1 && test -s /root/.automaton/config.json",
    60_000,
  );
  const config: Record<string, unknown> = {
    ...createConfig({
      name: params.genesis.name,
      genesisPrompt: params.genesis.genesisPrompt,
      creatorMessage: params.genesis.creatorMessage,
      creatorAddress: params.identity.address,
      registeredWithConway: true,
      sandboxId: params.sandboxId,
      walletAddress: params.walletAddress,
      apiKey: "",
      parentAddress: params.identity.address,
      chainType: params.chainType as any,
    }),
  };
  delete config.conwayApiKey;
  await client.writeFile(CHILD_CONFIG_PATH, JSON.stringify(config, null, 2));
  await runStep(client, "child config check", `test -s ${CHILD_CONFIG_PATH}`, 10_000);
  return "parent-written";
}

/**
 * Spawn a child automaton in a new Conway sandbox using lifecycle state machine.
 *
 * `limits` comes from the operator's AutomatonConfig. The slot count and the
 * row insert happen in one transaction, so concurrent spawns cannot both take
 * the last slot.
 */
export async function spawnChild(
  conway: ConwayClient,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  genesis: GenesisConfig,
  lifecycle?: ChildLifecycle,
  limits?: SpawnLimits,
): Promise<ChildAutomaton> {
  const { maxChildren, memoryMb: childMemoryMb, cloneCommand } = resolveLimits(limits);
  assertSpawnAllowed(maxChildren);

  const childId = ulid();
  let sandboxId: string | undefined;
  let reusedSandbox: { id: string } | null = null;

  // If no lifecycle provided, use legacy path
  if (!lifecycle) {
    return spawnChildLegacy(conway, identity, db, genesis, childId, maxChildren, childMemoryMb, cloneCommand);
  }

  const childChainType = genesis.chainType || (identity as any).chainType || "evm";
  // State: requested (the slot is taken here)
  db.raw.transaction(() => {
    failAbandonedSpawns(db, lifecycle, Date.now());
    assertSlotAvailable(db, maxChildren);
    lifecycle.initChild(childId, genesis.name, "", genesis.genesisPrompt, childChainType);
  }).immediate();

  try {
    // Try to reuse an existing sandbox whose DB record is 'failed' but
    // is still running remotely, before creating a new one.
    reusedSandbox = await findReusableSandbox(conway, db);

    const tier = selectSandboxTier(childMemoryMb);

    let sandbox: { id: string };
    if (reusedSandbox) {
      sandbox = reusedSandbox;
    } else {
      sandbox = await conway.createSandbox({
        name: `automaton-child-${genesis.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
        vcpu: tier.vcpu,
        memoryMb: tier.memoryMb,
        diskGb: tier.diskGb,
      });
    }
    sandboxId = sandbox.id;

    // Create a scoped client so all exec/writeFile calls target the CHILD sandbox
    const childConway = conway.createScopedClient(sandbox.id);

    // Update sandbox ID in children table
    db.raw
      .prepare("UPDATE children SET sandbox_id = ? WHERE id = ?")
      .run(sandbox.id, childId);

    // State: sandbox_created
    lifecycle.transition(
      childId,
      "sandbox_created",
      `sandbox ${sandbox.id} created`,
    );

    // A reused sandbox still holds the previous child's wallet, state and
    // checkout. Move the state aside and remove the checkout so the clone
    // works and --init creates a fresh wallet.
    if (reusedSandbox) {
      const stamp = Date.now();
      await runStep(
        childConway,
        "previous child state rotation",
        `if [ -e /root/.automaton ]; then mv /root/.automaton /root/.automaton.prev-${stamp}; fi && rm -rf /root/automaton`,
        30_000,
      );
    }

    // Install runtime (on the CHILD sandbox)
    await runStep(childConway, "runtime install", "apt-get update -qq && apt-get install -y -qq nodejs npm git curl", 120_000);
    await runStep(childConway, "clone and build", cloneCommand, 180_000);

    // Write genesis configuration (on the CHILD sandbox)
    await runStep(childConway, "state directory setup", "mkdir -p /root/.automaton", 10_000);
    const genesisJson = JSON.stringify(
      {
        name: genesis.name,
        genesisPrompt: genesis.genesisPrompt,
        creatorMessage: genesis.creatorMessage,
        creatorAddress: identity.address,
        parentAddress: identity.address,
        chainType: genesis.chainType || (identity as any).chainType || "evm",
      },
      null,
      2,
    );
    await childConway.writeFile("/root/.automaton/genesis.json", genesisJson);

    // Propagate constitution with hash verification
    try {
      await propagateConstitution(childConway, sandbox.id, db.raw);
    } catch {
      // Constitution file not found locally
    }

    // State: runtime_ready
    lifecycle.transition(childId, "runtime_ready", "runtime installed");

    // Initialize child wallet (on the CHILD sandbox)
    const initResult = await childConway.exec("node /root/automaton/dist/index.js --init 2>&1", 60_000);
    // Extract child wallet address - support both EVM (0x...) and Solana (base58)
    const stdout = initResult.stdout || "";
    const evmMatch = stdout.match(/0x[a-fA-F0-9]{40}/);
    const solanaMatch = stdout.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    const parentChainType = (identity as any).chainType || "evm";
    const childWallet = parentChainType === "solana"
      ? (solanaMatch ? solanaMatch[0] : "")
      : (evmMatch ? evmMatch[0] : "");

    if (!isValidWalletAddress(childWallet, parentChainType)) {
      throw new Error(`Child wallet address invalid: ${childWallet}`);
    }

    // Before funding is possible: a child that cannot configure itself never starts.
    await ensureChildConfig(childConway, {
      genesis,
      identity,
      sandboxId: sandbox.id,
      walletAddress: childWallet,
      chainType: childChainType,
    });

    // Update address in children table. The unique address index makes an
    // inherited wallet (one another row already has) fail here, loudly.
    db.raw
      .prepare("UPDATE children SET address = ? WHERE id = ?")
      .run(childWallet, childId);

    // State: wallet_verified
    lifecycle.transition(
      childId,
      "wallet_verified",
      `wallet ${childWallet} verified`,
    );

    // Record spawn modification
    db.insertModification({
      id: ulid(),
      timestamp: new Date().toISOString(),
      type: "child_spawn",
      description: `Spawned child: ${genesis.name} in sandbox ${sandbox.id}${reusedSandbox ? " (reused)" : ""}`,
      reversible: false,
    });

    // If we reused a sandbox, update the old children record to 'cleaned_up'
    // so it doesn't get reused again.
    if (reusedSandbox) {
      retireReusedSandboxRows(db, lifecycle, sandbox.id, childId);
    }

    const child: ChildAutomaton = {
      id: childId,
      name: genesis.name,
      address: childWallet as any,
      sandboxId: sandbox.id,
      genesisPrompt: genesis.genesisPrompt,
      creatorMessage: genesis.creatorMessage,
      fundedAmountCents: 0,
      status: "wallet_verified" as any,
      createdAt: new Date().toISOString(),
    };

    return child;
  } catch (error) {
    // Note: sandbox deletion is disabled by the Conway API (prepaid, non-refundable).
    // Failed sandboxes are left running and may be reused by findReusableSandbox().

    // Transition to failed if lifecycle has been initialized
    try {
      lifecycle.transition(
        childId,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    } catch {
      // May fail if child doesn't exist yet
    }

    throw error;
  }
}

/**
 * Legacy spawn path for backward compatibility when no lifecycle is provided.
 */
async function spawnChildLegacy(
  conway: ConwayClient,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  genesis: GenesisConfig,
  childId: string,
  maxChildren: number,
  childMemoryMb: number,
  cloneCommand: string,
): Promise<ChildAutomaton> {
  let sandboxId: string | undefined;
  const legacyTier = selectSandboxTier(childMemoryMb);
  const legacyParentChainType = genesis.chainType || (identity as any).chainType || "evm";
  const createdAt = new Date().toISOString();

  // Take the slot with a placeholder row, in the same transaction as the count.
  db.raw.transaction(() => {
    assertSlotAvailable(db, maxChildren);
    db.insertChild({
      id: childId,
      name: genesis.name,
      address: "" as any,
      sandboxId: "",
      genesisPrompt: genesis.genesisPrompt,
      creatorMessage: genesis.creatorMessage,
      fundedAmountCents: 0,
      status: "spawning",
      createdAt,
      chainType: legacyParentChainType as any,
    });
  }).immediate();

  try {
    const sandbox = await conway.createSandbox({
      name: `automaton-child-${genesis.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
      vcpu: legacyTier.vcpu,
      memoryMb: legacyTier.memoryMb,
      diskGb: legacyTier.diskGb,
    });
    sandboxId = sandbox.id;

    // Create a scoped client so all exec/writeFile calls target the CHILD sandbox
    const childConway = conway.createScopedClient(sandbox.id);

    db.raw.prepare("UPDATE children SET sandbox_id = ? WHERE id = ?").run(sandbox.id, childId);

    await runStep(childConway, "runtime install", "apt-get update -qq && apt-get install -y -qq nodejs npm git curl", 120_000);
    await runStep(childConway, "clone and build", cloneCommand, 180_000);
    await runStep(childConway, "state directory setup", "mkdir -p /root/.automaton", 10_000);

    const legacyGenesisJson = JSON.stringify(
      {
        name: genesis.name,
        genesisPrompt: genesis.genesisPrompt,
        creatorMessage: genesis.creatorMessage,
        creatorAddress: identity.address,
        parentAddress: identity.address,
        chainType: genesis.chainType || (identity as any).chainType || "evm",
      },
      null,
      2,
    );
    await childConway.writeFile("/root/.automaton/genesis.json", legacyGenesisJson);

    try {
      await propagateConstitution(childConway, sandbox.id, db.raw);
    } catch {
      // Constitution file not found
    }

    const initResult = await childConway.exec("node /root/automaton/dist/index.js --init 2>&1", 60_000);
    const legacyEvmMatch = (initResult.stdout || "").match(/0x[a-fA-F0-9]{40}/);
    const legacySolMatch = (initResult.stdout || "").match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    const childWallet = legacyParentChainType === "solana"
      ? (legacySolMatch ? legacySolMatch[0] : "")
      : (legacyEvmMatch ? legacyEvmMatch[0] : "");

    if (!isValidWalletAddress(childWallet, legacyParentChainType)) {
      throw new Error(`Child wallet address invalid: ${childWallet}`);
    }

    await ensureChildConfig(childConway, {
      genesis,
      identity,
      sandboxId: sandbox.id,
      walletAddress: childWallet,
      chainType: legacyParentChainType,
    });

    const child: ChildAutomaton = {
      id: childId,
      name: genesis.name,
      address: childWallet as any,
      sandboxId: sandbox.id,
      genesisPrompt: genesis.genesisPrompt,
      creatorMessage: genesis.creatorMessage,
      fundedAmountCents: 0,
      status: "spawning",
      createdAt,
      chainType: legacyParentChainType as any,
    };

    db.raw.prepare("UPDATE children SET address = ?, sandbox_id = ? WHERE id = ?").run(childWallet, sandbox.id, childId);

    db.insertModification({
      id: ulid(),
      timestamp: new Date().toISOString(),
      type: "child_spawn",
      description: `Spawned child: ${genesis.name} in sandbox ${sandbox.id}`,
      reversible: false,
    });

    return child;
  } catch (error) {
    // Sandbox deletion disabled — failed sandboxes left for potential reuse.
    // The placeholder row ends here and frees its slot.
    try {
      db.raw.prepare("UPDATE children SET status = 'failed', last_checked = datetime('now') WHERE id = ?").run(childId);
    } catch {
      // The original error matters more.
    }
    throw error;
  }
}

/**
 * Find a reusable sandbox: one whose DB child is 'failed', that is still
 * running remotely, that no slot-holding child uses, and in which no agent
 * process runs (start_child can mark a child failed while its process is
 * alive). Returns the first match or null.
 */
async function findReusableSandbox(
  conway: ConwayClient,
  db: AutomatonDatabase,
): Promise<{ id: string } | null> {
  try {
    const children = db.getChildren();
    const inUse = new Set(children.filter((c) => holdsSlot(c.status) && c.sandboxId).map((c) => c.sandboxId));
    const failedChildren = children.filter((c) => c.status === "failed" && c.sandboxId && !inUse.has(c.sandboxId));
    if (failedChildren.length === 0) return null;

    const remoteSandboxes = await conway.listSandboxes();
    const runningIds = new Set(
      remoteSandboxes
        .filter((s) => s.status === "running")
        .map((s) => s.id),
    );

    const checked = new Set<string>();
    for (const child of failedChildren) {
      if (!runningIds.has(child.sandboxId) || checked.has(child.sandboxId)) continue;
      checked.add(child.sandboxId);
      if (await isSandboxIdle(conway, child.sandboxId)) {
        return { id: child.sandboxId };
      }
    }
  } catch {
    // If listing fails, just create a new sandbox
  }
  return null;
}

/** Move the failed rows that held a reused sandbox to cleaned_up. */
function retireReusedSandboxRows(
  db: AutomatonDatabase,
  lifecycle: ChildLifecycle,
  sandboxId: string,
  newChildId: string,
): void {
  const rows = db.raw
    .prepare("SELECT id FROM children WHERE sandbox_id = ? AND status = 'failed' AND id <> ?")
    .all(sandboxId, newChildId) as Array<{ id: string }>;
  for (const row of rows) {
    try {
      if (lifecycle.getStateOrNull(row.id)) {
        lifecycle.transition(row.id, "cleaned_up", `sandbox ${sandboxId} reused by child ${newChildId}`);
      } else {
        db.raw.prepare("UPDATE children SET status = 'cleaned_up' WHERE id = ?").run(row.id);
      }
    } catch {
      // Best effort: the row is ended either way.
    }
  }
}

/** True only when the check ran and found no agent process. */
async function isSandboxIdle(conway: ConwayClient, sandboxId: string): Promise<boolean> {
  try {
    const result = await conway
      .createScopedClient(sandboxId)
      .exec(`pgrep -f '${CHILD_PROCESS_PATTERN}' >/dev/null && echo busy || echo idle`, 15_000);
    if (typeof result.exitCode === "number" && result.exitCode !== 0) return false;
    return (result.stdout || "").trim().split("\n").pop()?.trim() === "idle";
  } catch {
    return false;
  }
}
