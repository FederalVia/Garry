#!/usr/bin/env node
/**
 * Conway Automaton Runtime
 *
 * The entry point for the sovereign AI agent.
 * Handles CLI args, bootstrapping, and orchestrating
 * the heartbeat daemon + agent loop.
 */

import fs from "fs";
import path from "path";
import { getWallet, getAutomatonDir } from "./identity/wallet.js";
import { provision, loadApiKeyFromConfig } from "./identity/provision.js";
import { loadConfig, resolvePath, getConfigPath, ConfigError } from "./config.js";
import { RESTART_REQUIRED_KEY, getRestartRequired } from "./self-mod/restart-notice.js";
import { createDatabase, recoverStrandedInboxClaims } from "./state/database.js";
import { createConwayClient, createCreditBalanceReader } from "./conway/client.js";
import { createInferenceClient } from "./conway/inference.js";
import { createHeartbeatDaemon } from "./heartbeat/daemon.js";
import type { HeartbeatDaemon } from "./heartbeat/daemon.js";
import {
  loadHeartbeatConfig,
  syncHeartbeatToDb,
} from "./heartbeat/config.js";
import { consumeNextWakeEvent } from "./state/database.js";
import { runAgentLoop, shutdownWorkerPools } from "./agent/loop.js";
import { ModelRegistry } from "./inference/registry.js";
import { loadSkills } from "./skills/loader.js";
import { initStateRepo } from "./git/state-versioning.js";
import { createSocialClient } from "./social/client.js";
import { PolicyEngine } from "./agent/policy-engine.js";
import { SpendTracker } from "./agent/spend-tracker.js";
import { createDefaultRules } from "./agent/policy-rules/index.js";
import type {
  AutomatonConfig,
  AutomatonIdentity,
  AgentState,
  Skill,
  SocialClientInterface,
  WakeEventRow,
} from "./types.js";
import { acquireInstanceLock, InstanceLockedError } from "./state/instance-lock.js";
import type { InstanceLock } from "./state/instance-lock.js";
import {
  createShutdownController,
  installShutdownSignals,
  resolveShutdownGraceMs,
  finishShutdown,
} from "./runtime/shutdown.js";
import { preloadLazyModules } from "./runtime/preload.js";
import { bootstrapConfigFromGenesis, genesisPath } from "./setup/genesis-bootstrap.js";
import { createLogger, setGlobalLogLevel, parseLogLevel, StructuredLogger } from "./observability/logger.js";
import { prettySink } from "./observability/pretty-sink.js";
import { startupBootstrapTopup } from "./conway/topup.js";
import { readUsdcAuthorizationState } from "./conway/x402.js";
import { Treasury, installTreasury, normalizeTreasuryPolicy } from "./treasury/index.js";
import { InferenceGate, installInferenceGate } from "./inference/gate.js";
import { getSurvivalTier } from "./conway/credits.js";
import { resolveInferencePolicy, registryPrice, checkPolicySanity } from "./inference/policy.js";
import { DEFAULT_ROUTING_MATRIX } from "./inference/types.js";
import { protectRuntimeFile } from "./security/protected-paths.js";
import { holdsSlot } from "./replication/child-status.js";
import { randomUUID } from "crypto";
import { keccak256, toHex } from "viem";

const logger = createLogger("main");
const VERSION = "0.2.1";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ─── CLI Commands ────────────────────────────────────────────

  if (args.includes("--version") || args.includes("-v")) {
    logger.info(`Conway Automaton v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    logger.info(`
Conway Automaton v${VERSION}
Sovereign AI Agent Runtime

Usage:
  automaton --run          Start the automaton (first run: setup wizard in a terminal,
                           or built from ~/.automaton/genesis.json)
  automaton --setup        Re-run the interactive setup wizard
  automaton --configure    Edit configuration (providers, model, treasury, general)
  automaton --pick-model   Interactively pick the active inference model
  automaton --init         Initialize wallet and config directory
  automaton --provision    Provision Conway API key via SIWE
  automaton --status       Show current automaton status
  automaton --version      Show version
  automaton --help         Show this help

Environment:
  CONWAY_API_URL           Conway API URL (default: https://api.conway.tech)
  CONWAY_API_KEY           Conway API key (overrides config)
  OLLAMA_BASE_URL          Ollama base URL (overrides config, e.g. http://localhost:11434)
  AUTOMATON_SHUTDOWN_GRACE_MS  Time a stop may take before exit is forced (default 30000)
`);
    process.exit(0);
  }

  if (args.includes("--init")) {
    // Read chain type from genesis.json if written by parent during spawn
    let initChainType: import("./identity/chain.js").ChainType | undefined;
    try {
      const genesisPath = path.join(getAutomatonDir(), "genesis.json");
      if (fs.existsSync(genesisPath)) {
        const genesis = JSON.parse(fs.readFileSync(genesisPath, "utf-8"));
        initChainType = genesis.chainType;
      }
    } catch {}
    const { chainIdentity, isNew } = await getWallet(initChainType);
    logger.info(
      JSON.stringify({
        address: chainIdentity.address,
        isNew,
        configDir: getAutomatonDir(),
      }),
    );
    process.exit(0);
  }

  if (args.includes("--provision")) {
    try {
      const result = await provision();
      logger.info(JSON.stringify(result));
    } catch (err: any) {
      logger.error(`Provision failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--status")) {
    await showStatus();
    process.exit(0);
  }

  if (args.includes("--setup")) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (args.includes("--pick-model")) {
    const { runModelPicker } = await import("./setup/model-picker.js");
    await runModelPicker();
    process.exit(0);
  }

  if (args.includes("--configure")) {
    const { runConfigure } = await import("./setup/configure.js");
    await runConfigure();
    process.exit(0);
  }

  if (args.includes("--run")) {
    StructuredLogger.setSink(prettySink);
    await run();
    return;
  }

  // Default: show help
  logger.info('Run "automaton --help" for usage information.');
  logger.info('Run "automaton --run" to start the automaton.');
}

// ─── Status Command ────────────────────────────────────────────

async function showStatus(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    logger.error(`automaton.json cannot be read: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (!config) {
    logger.info("Automaton is not configured. Run the setup script first.");
    return;
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  const state = db.getAgentState();
  const turnCount = db.getTurnCount();
  const tools = db.getInstalledTools();
  const heartbeats = db.getHeartbeatEntries();
  const skills = db.getSkills(true);
  const children = db.getChildren();
  const registry = db.getRegistryEntry();

  logger.info(`
=== AUTOMATON STATUS ===
Name:       ${config.name}
Address:    ${config.walletAddress}
Creator:    ${config.creatorAddress}
Sandbox:    ${config.sandboxId}
State:      ${state}
Turns:      ${turnCount}
Tools:      ${tools.length} installed
Skills:     ${skills.length} active
Heartbeats: ${heartbeats.filter((h) => h.enabled).length} active
Children:   ${children.filter((c) => holdsSlot(c.status)).length} holding a slot / ${children.length} total
Agent ID:   ${registry?.agentId || "not registered"}
Model:      ${config.inferenceModel}
Version:    ${config.version}
========================
`);

  db.close();
}

// ─── Main Run ──────────────────────────────────────────────────

function fail(message: string): never {
  logger.error(message);
  process.exit(1);
}

function pathExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The config for --run. A missing file is built from genesis.json (a spawned
 * child) or by the wizard (a terminal only); anything else exits 1 so
 * supervisors and parents see the failure.
 */
async function loadRunConfig(): Promise<AutomatonConfig> {
  const configPath = getConfigPath();
  let config: AutomatonConfig | null;
  try {
    config = loadConfig();
  } catch (err: any) {
    fail(`automaton.json cannot be read: ${err?.message || String(err)}. Fix or remove ${configPath}.`);
  }
  if (config) return config;
  // loadConfig reports a dangling symlink as missing; it is not a first run.
  if (pathExists(configPath)) {
    fail(`automaton.json cannot be read: ${configPath} is not valid JSON. Fix or remove it.`);
  }

  const genesisFile = genesisPath();
  if (pathExists(genesisFile)) {
    logger.info(`[${new Date().toISOString()}] No automaton.json; building it from genesis.json.`);
    try {
      return await bootstrapConfigFromGenesis();
    } catch (err: any) {
      fail(`Could not build automaton.json from ${genesisFile}: ${err?.message || String(err)}`);
    }
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    return await runSetupWizard();
  }
  fail(
    "No automaton.json and no terminal for the setup wizard. " +
      "Run `automaton --setup` in a terminal, or provide genesis.json.",
  );
}

async function run(): Promise<void> {
  logger.info(`[${new Date().toISOString()}] Conway Automaton v${VERSION} starting...`);

  const config = await loadRunConfig();
  setGlobalLogLevel(parseLogLevel(config.logLevel) ?? "info");

  // Load wallet (chain-aware)
  const { account, chainIdentity, chainType: walletChainType } = await getWallet();
  const resolvedChainType = config.chainType || walletChainType || "evm";
  const apiKey = config.conwayApiKey || loadApiKeyFromConfig();
  if (!apiKey) {
    logger.error("No API key found. Run: automaton --provision");
    process.exit(1);
  }

  // One running agent per state database: two would double spend and steal
  // each other's wake events and inbox claims.
  const dbPath = resolvePath(config.dbPath);
  let instanceLock: InstanceLock;
  try {
    instanceLock = acquireInstanceLock(`${dbPath}.lock`);
  } catch (err) {
    if (err instanceof InstanceLockedError) {
      fail(
        `Another automaton${err.pid ? ` (pid ${err.pid})` : ""} is already running on ${dbPath} ` +
          `(lock: ${err.lockPath}). Stop it first.`,
      );
    }
    throw err;
  }

  // Initialize database
  const db = createDatabase(dbPath);
  // SQLite's own locks on these files are POSIX locks too; the agent's file
  // tools must not open them in this process whatever dbPath is.
  for (const suffix of ["", "-wal", "-shm", "-journal"]) protectRuntimeFile(`${dbPath}${suffix}`);

  // Shutdown is wired before the rest of startup, so a signal during startup
  // is handled too. The first signal stops the loop at its next tool
  // boundary; a second one, or the grace deadline, forces exit 1.
  const ctl = createShutdownController();
  const graceMs = resolveShutdownGraceMs();
  let heartbeat: HeartbeatDaemon | undefined;
  const leaveState = (): void => {
    try {
      // 'dead' survives a restart; anything else is asleep while stopped.
      if (db.getAgentState() !== "dead") db.setAgentState("sleeping");
    } catch {
      // The database may already be closed.
    }
  };
  const forceExit = (why: string): void => {
    logger.error(`[${new Date().toISOString()}] Forced exit (${why}).`);
    try {
      heartbeat?.stop();
    } catch {
      // Exiting anyway.
    }
    leaveState();
    try {
      instanceLock.release();
    } catch {
      // The OS drops the lock on exit.
    }
    try {
      db.close();
    } catch {
      // Exiting anyway.
    }
    process.exit(1);
  };
  const signals = installShutdownSignals({
    controller: ctl,
    graceMs,
    forceExit,
    log: (message) => logger.warn(`[${new Date().toISOString()}] ${message}`),
  });

  // Claims a crash or forced exit left in_progress. Safe here only because
  // the lock guarantees no other process holds live claims.
  try {
    const recovered = recoverStrandedInboxClaims(db.raw);
    if (recovered.requeued + recovered.failed + recovered.processed > 0) {
      logger.info(
        `[${new Date().toISOString()}] Recovered stranded inbox claims: ${recovered.requeued} re-queued, ` +
          `${recovered.failed} failed (retries used up), ${recovered.processed} already answered.`,
      );
    }
  } catch (err: any) {
    logger.warn(`Inbox claim recovery failed: ${err?.message || String(err)}`);
  }

  // This process runs whatever was built before it started.
  if (db.getKV(RESTART_REQUIRED_KEY)) {
    db.deleteKV(RESTART_REQUIRED_KEY);
    logger.info(`[${new Date().toISOString()}] Restarted after a rebuild; the rebuilt code is now running.`);
  }

  // Persist createdAt: only set if not already stored (never overwrite)
  const existingCreatedAt = db.getIdentity("createdAt");
  const createdAt = existingCreatedAt || new Date().toISOString();
  if (!existingCreatedAt) {
    db.setIdentity("createdAt", createdAt);
  }

  // Build identity (chain-aware)
  const identity: AutomatonIdentity = {
    name: config.name,
    address: chainIdentity.address,
    account,
    creatorAddress: config.creatorAddress,
    sandboxId: config.sandboxId,
    apiKey,
    createdAt,
    chainType: resolvedChainType,
    chainIdentity,
  };

  // Store identity in DB
  db.setIdentity("name", config.name);
  db.setIdentity("address", chainIdentity.address);
  db.setIdentity("creator", config.creatorAddress);
  db.setIdentity("chainType", resolvedChainType);
  db.setIdentity("sandbox", config.sandboxId);
  const storedAutomatonId = db.getIdentity("automatonId");
  const automatonId = storedAutomatonId || config.sandboxId || randomUUID();
  if (!storedAutomatonId) {
    db.setIdentity("automatonId", automatonId);
  }

  // Create Conway client. Its value-moving calls resolve the installed
  // Treasury at call time, so the Treasury is installed right below, before
  // anything can spend.
  const conway = createConwayClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    sandboxId: config.sandboxId,
  });

  // Treasury: the one spending gate. The normalized policy is shared by the
  // policy rules and the gate, so both enforce the same numbers.
  const treasuryPolicy = normalizeTreasuryPolicy(config.treasuryPolicy);
  const spendTracker = new SpendTracker(db.raw);
  // The gate's balance reads use their own client, so a circuit breaker
  // opened by unrelated failures (sandbox exec) does not refuse every outflow.
  // It also throws on a missing balance instead of reading it as zero.
  const readCreditBalance = createCreditBalanceReader({ apiUrl: config.conwayApiUrl, apiKey });
  const treasury = new Treasury({
    db: db.raw,
    policy: treasuryPolicy,
    selfAddress: chainIdentity.address,
    readCreditBalance,
    readAuthorizationState: readUsdcAuthorizationState,
    spendTracker,
    conwayApiUrl: config.conwayApiUrl,
    // acquireInstanceLock above: no other boot is alive on this database.
    holdsInstanceLock: true,
  });
  installTreasury(treasury);

  // Inference spend gate: every inference attempt (main loop, orchestrator,
  // workers) reserves against the same caps, including the daily cap from
  // treasuryPolicy.maxInferenceDailyCents.
  const inferencePolicy = resolveInferencePolicy(config, treasuryPolicy);
  const inferenceGate = new InferenceGate({ db: db.raw, policy: inferencePolicy });
  installInferenceGate(inferenceGate);
  // Resolve payments a previous run left without an answer.
  void treasury
    .reconcileX402({ limit: 20 })
    .then((n) => {
      if (n > 0) logger.info(`[${new Date().toISOString()}] Reconciled ${n} pending x402 payment(s).`);
    })
    .catch((err: any) => logger.warn(`x402 reconcile at startup failed: ${err?.message || String(err)}`));

  // Register automaton identity (one-time, immutable)
  const registrationState = db.getIdentity("conwayRegistrationStatus");
  if (registrationState !== "registered") {
    try {
      const genesisPromptHash = config.genesisPrompt
        ? keccak256(toHex(config.genesisPrompt))
        : undefined;
      await conway.registerAutomaton({
        automatonId,
        automatonAddress: chainIdentity.address,
        creatorAddress: config.creatorAddress,
        name: config.name,
        bio: config.creatorMessage || "",
        genesisPromptHash,
        account,
        chainType: resolvedChainType,
        chainIdentity,
      });
      db.setIdentity("conwayRegistrationStatus", "registered");
      logger.info(`[${new Date().toISOString()}] Automaton identity registered.`);
    } catch (err: any) {
      const status = err?.status;
      if (status === 409) {
        db.setIdentity("conwayRegistrationStatus", "conflict");
        logger.warn(`[${new Date().toISOString()}] Automaton identity conflict: ${err.message}`);
      } else {
        db.setIdentity("conwayRegistrationStatus", "failed");
        logger.warn(`[${new Date().toISOString()}] Automaton identity registration failed: ${err.message}`);
      }
    }
  }

  // Resolve Ollama base URL: env var takes precedence over config
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl;

  // Create inference client — pass a live registry lookup so model names like
  // "gpt-oss:120b" route to Ollama based on their registered provider, not heuristics.
  const modelRegistry = new ModelRegistry(db.raw);
  modelRegistry.initialize();
  {
    const criticalId = config.modelStrategy?.criticalModel || "gpt-5-mini";
    const critical = modelRegistry.get(criticalId);
    checkPolicySanity(
      inferencePolicy,
      critical
        ? {
            model: critical.modelId,
            price: registryPrice(critical),
            matrixCeilings: {
              critical: DEFAULT_ROUTING_MATRIX.critical.agent_turn.ceilingCents,
              low_compute: DEFAULT_ROUTING_MATRIX.low_compute.agent_turn.ceilingCents,
            },
          }
        : null,
    );
  }
  const inference = createInferenceClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    defaultModel: config.inferenceModel,
    maxTokens: config.maxTokensPerTurn,
    lowComputeModel: config.modelStrategy?.lowComputeModel || "gpt-5-mini",
    openaiApiKey: config.openaiApiKey,
    anthropicApiKey: config.anthropicApiKey,
    ollamaBaseUrl,
    getModelProvider: (modelId) => modelRegistry.get(modelId)?.provider,
  });

  if (ollamaBaseUrl) {
    logger.info(`[${new Date().toISOString()}] Ollama backend: ${ollamaBaseUrl}`);
  }

  // Create social client (chain-aware: pass ChainIdentity for Solana signing)
  let social: SocialClientInterface | undefined;
  if (config.socialRelayUrl) {
    social = createSocialClient(config.socialRelayUrl, resolvedChainType === "solana" ? chainIdentity : account);
    logger.info(`[${new Date().toISOString()}] Social relay: ${config.socialRelayUrl}`);
  }

  // Initialize PolicyEngine (Phase 1.4) with the same normalized policy.
  const rules = createDefaultRules(treasuryPolicy);
  const policyEngine = new PolicyEngine(db.raw, rules);

  // Load and sync heartbeat config
  const heartbeatConfigPath = resolvePath(config.heartbeatConfigPath);
  const heartbeatConfig = loadHeartbeatConfig(heartbeatConfigPath);
  syncHeartbeatToDb(heartbeatConfig, db);

  // Load skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  let skills: Skill[] = [];
  try {
    skills = loadSkills(skillsDir, db);
    logger.info(`[${new Date().toISOString()}] Loaded ${skills.length} skills.`);
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] Skills loading failed: ${err.message}`);
  }

  // Initialize state repo (git)
  try {
    await initStateRepo(conway);
    logger.info(`[${new Date().toISOString()}] State repo initialized.`);
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] State repo init failed: ${err.message}`);
  }

  // Bootstrap topup: buy minimum credits ($5) from USDC so the agent can start.
  // The agent decides larger topups itself via the topup_credits tool.
  // A failed balance read skips the buy; it is not a zero balance.
  try {
    const outcome = await startupBootstrapTopup({
      apiUrl: config.conwayApiUrl,
      account,
      readCreditBalance: () => conway.getCreditsBalance(),
      chainType: resolvedChainType,
      timeoutMs: 15_000,
    });
    if (outcome.status === "done" && outcome.result?.success) {
      logger.info(
        `[${new Date().toISOString()}] Bootstrap topup: +$${outcome.result.amountUsd} credits from USDC`,
      );
    } else if (outcome.status === "skipped") {
      logger.warn(`[${new Date().toISOString()}] Bootstrap topup skipped: ${outcome.reason}`);
    } else if (outcome.status === "timed_out") {
      logger.warn(
        `[${new Date().toISOString()}] Bootstrap topup still pending after 15s; continuing (the payment stays in the ledger).`,
      );
    } else if (outcome.result && !outcome.result.success) {
      logger.warn(`[${new Date().toISOString()}] Bootstrap topup not made: ${outcome.result.error}`);
    }
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] Bootstrap topup skipped: ${err.message}`);
  }

  // Load every lazily imported module now, so a later rebuild cannot mix
  // new modules into this process; rebuilt code runs after a restart.
  const preload = await preloadLazyModules((specifier, err) => {
    logger.warn(`Preload of ${specifier} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  logger.info(`[${new Date().toISOString()}] Preloaded ${preload.loaded} lazy module(s).`);

  // Start heartbeat daemon (Phase 1.1: DurableScheduler)
  heartbeat = createHeartbeatDaemon({
    identity,
    config,
    heartbeatConfig,
    db,
    rawDb: db.raw,
    conway,
    social,
    // The scheduler writes the wake event itself; this only logs.
    onWakeRequest: (reason) => {
      logger.info(`[HEARTBEAT] Wake request: ${reason}`);
    },
  });

  if (!ctl.stopping) {
    heartbeat.start();
    logger.info(`[${new Date().toISOString()}] Heartbeat daemon started.`);
  }

  /**
   * Sleep up to totalMs in short steps, keeping the gate's survival tier
   * current. Returns the wake event that cut it short, if any.
   */
  const waitForWake = async (totalMs: number): Promise<WakeEventRow | undefined> => {
    const checkInterval = Math.min(totalMs, 30_000);
    let slept = 0;
    let sinceSurvivalRefresh = 0;
    while (slept < totalMs) {
      if (!(await ctl.sleep(checkInterval))) return undefined;
      slept += checkInterval;
      sinceSurvivalRefresh += checkInterval;

      // Workers from earlier cycles keep running while the loop sleeps,
      // so keep the gate's survival tier current. A failed read keeps the
      // last tier rather than reading as zero.
      if (sinceSurvivalRefresh >= SURVIVAL_REFRESH_MS) {
        sinceSurvivalRefresh = 0;
        try {
          const creditsCents = await conway.getCreditsBalance();
          inferenceGate.setSurvival({ tier: getSurvivalTier(creditsCents), creditsCents });
        } catch (err: any) {
          logger.warn(`Survival tier refresh failed: ${err?.message || String(err)}`);
        }
      }

      // Phase 1.1: Check for wake events from wake_events table (atomic consume)
      const wakeEvent = consumeNextWakeEvent(db.raw);
      if (wakeEvent) {
        logger.info(
          `[${new Date().toISOString()}] Woken by ${wakeEvent.source}: ${wakeEvent.reason}`,
        );
        return wakeEvent;
      }
    }
    return undefined;
  };

  // ─── Main Run Loop ──────────────────────────────────────────
  // The automaton alternates between running and sleeping.
  // The heartbeat can wake it up.

  // The wake event that ended the last sleep, shown to the next cycle.
  let pendingWakeEvents: WakeEventRow[] = [];

  while (!ctl.stopping) {
    try {
      // Reload skills (may have changed since last loop)
      try {
        skills = loadSkills(skillsDir, db);
      } catch (error) {
        logger.error("Skills reload failed", error instanceof Error ? error : undefined);
      }

      const wakeEvents = pendingWakeEvents;
      pendingWakeEvents = [];

      // Run the agent loop
      await runAgentLoop({
        identity,
        config,
        db,
        conway,
        inference,
        social,
        skills,
        policyEngine,
        spendTracker,
        ollamaBaseUrl,
        shouldStop: () => ctl.stopping,
        wakeEvents,
        onStateChange: (state: AgentState) => {
          logger.info(`[${new Date().toISOString()}] State: ${state}`);
        },
        onTurnComplete: (turn) => {
          logger.info(
            `[${new Date().toISOString()}] Turn ${turn.id}: ${turn.toolCalls.length} tools, ${turn.tokenUsage.totalTokens} tokens`,
          );
        },
      });

      if (db.getKV(RESTART_REQUIRED_KEY)) {
        const pending = getRestartRequired(db);
        logger.warn(
          `[${new Date().toISOString()}] A rebuild finished${pending ? ` at ${pending.at} (${pending.reason})` : ""}; ` +
            "restart the automaton to run the new code.",
        );
      }
      if (ctl.stopping) break;

      // Agent loop exited (sleeping or dead)
      const state = db.getAgentState();

      if (state === "dead") {
        logger.info(`[${new Date().toISOString()}] Automaton is dead. Heartbeat will continue.`);
        // Wait for funding; the heartbeat keeps checking and broadcasting
        // distress, and a wake event (for example a topup) ends the wait.
        const wakeEvent = await waitForWake(300_000);
        if (wakeEvent) pendingWakeEvents.push(wakeEvent);
        continue;
      }

      if (state === "sleeping") {
        const sleepUntilStr = db.getKV("sleep_until");
        const sleepUntil = sleepUntilStr
          ? new Date(sleepUntilStr).getTime()
          : Date.now() + 60_000;
        const sleepMs = Math.max(sleepUntil - Date.now(), 10_000);
        logger.info(
          `[${new Date().toISOString()}] Sleeping for ${Math.round(sleepMs / 1000)}s`,
        );

        // Sleep, but check for wake requests periodically
        const wakeEvent = await waitForWake(sleepMs);
        if (wakeEvent) pendingWakeEvents.push(wakeEvent);

        // Clear sleep state
        db.deleteKV("sleep_until");
        continue;
      }
    } catch (err: any) {
      logger.error(
        `[${new Date().toISOString()}] Fatal error in run loop: ${err.message}`,
      );
      // Wait before retrying
      await ctl.sleep(30_000);
    }
  }

  // ─── Graceful shutdown ──────────────────────────────────────
  // The loop has saved its turn. Drain the heartbeat and the workers within
  // what is left of the grace period, then exit 0.
  logger.info(`[${new Date().toISOString()}] Shutting down...`);
  const hb = heartbeat;
  await finishShutdown({
    remainingMs: () => signals.remainingMs(),
    stopHeartbeat: () => hb.stop(),
    drainHeartbeat: (ms) => hb.drain(ms),
    drainWorkers: (ms) => shutdownWorkerPools(ms),
    leaveState,
    releaseLock: () => instanceLock.release(),
    closeDb: () => db.close(),
    log: (message) => logger.warn(message),
  });
  logger.info(`[${new Date().toISOString()}] Shutdown complete.`);
  process.exit(0);
}

/** How often the sleeping runtime refreshes the gate's survival tier. */
const SURVIVAL_REFRESH_MS = 5 * 60_000;

// ─── Entry Point ───────────────────────────────────────────────

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
