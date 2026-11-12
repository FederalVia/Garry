/**
 * Conway API Client
 *
 * Communicates with Conway's control plane for sandbox management,
 * credits, and infrastructure operations.
 * Adapted from @aiws/sdk patterns.
 */

import { spawn } from "child_process";
import fs from "fs";
import nodePath from "path";
import type {
  ConwayClient,
  ExecResult,
  PortInfo,
  CreateSandboxOptions,
  SandboxInfo,
  PricingTier,
  CreditTransferResult,
  DomainSearchResult,
  DomainRegistration,
  DnsRecord,
  ModelInfo,
  OutflowRequestOptions,
} from "../types.js";
import { ResilientHttpClient } from "./http-client.js";
import { BalanceUnavailableError } from "./balance.js";
import { guardConwayClient, type TreasuryResolver } from "../treasury/guarded-conway.js";
import { ulid } from "ulid";
import { keccak256, toHex } from "viem";
import type { Address, PrivateKeyAccount } from "viem";
import { randomUUID } from "crypto";
import type { ChainType, ChainIdentity } from "../identity/chain.js";
import { childProcessEnv } from "../security/child-env.js";

/** Default command timeout when the caller gives none. */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
/** Remote exec: the HTTP call may outlive the command by this much (queueing, upload of output). */
export const REMOTE_EXEC_HTTP_MARGIN_MS = 15_000;
const MAX_EXEC_OUTPUT_BYTES = 10 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
/** After the shell exits, how long to wait for its pipes to close before detaching them. */
const PIPE_CLOSE_GRACE_MS = 200;

// Process groups of commands still running in the foreground. A runtime
// that exits mid-command must not leave them behind.
const activeExecGroups = new Set<number>();
let execExitHookInstalled = false;

function installExecExitHook(): void {
  if (execExitHookInstalled) return;
  execExitHookInstalled = true;
  process.on("exit", () => {
    for (const pid of activeExecGroups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

/**
 * Run a shell command on this machine without blocking the event loop. The
 * command gets its own process group, the scrubbed child environment and
 * HOME as cwd. On timeout the whole group is killed (SIGTERM, then SIGKILL
 * after 2 s) and the result has exit code 124. Background jobs (`cmd &`)
 * keep running after the shell exits; their output is discarded.
 */
export function execLocalCommand(
  command: string,
  timeoutMs?: number,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  const timeout = timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_EXEC_TIMEOUT_MS;
  installExecExitHook();

  return new Promise<ExecResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd: opts.cwd ?? (process.env.HOME || "/root"),
        env: opts.env ?? childProcessEnv(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      resolve({ stdout: "", stderr: err?.message || String(err), exitCode: 1 });
      return;
    }

    const pid = child.pid;
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let collecting = true;
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let shellExited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;

    if (pid !== undefined) activeExecGroups.add(pid);

    const detachPipes = () => {
      collecting = false;
      // Keep draining so a background job never dies of SIGPIPE, but never
      // let its pipes keep this process alive.
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        stream.removeAllListeners("data");
        stream.on("data", () => {});
        stream.on("error", () => {});
        stream.resume();
        (stream as unknown as { unref?: () => void }).unref?.();
      }
      child.unref();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (closeTimer) clearTimeout(closeTimer);
      if (pid !== undefined) activeExecGroups.delete(pid);
      detachPipes();
      const stdout = Buffer.concat(out).toString("utf8");
      let stderr = Buffer.concat(errOut).toString("utf8");
      if (overflow) {
        resolve({
          stdout,
          stderr: `${stderr}${stderr ? "\n" : ""}Command output exceeded 10 MB; its process group was killed.`,
          exitCode: 1,
        });
        return;
      }
      if (timedOut) {
        resolve({
          stdout,
          stderr: `${stderr}${stderr ? "\n" : ""}Command timed out after ${timeout} ms; its process group was killed.`,
          exitCode: 124,
        });
        return;
      }
      if (exitCode === null && exitSignal) {
        stderr = `${stderr}${stderr ? "\n" : ""}Command terminated by ${exitSignal}`;
      }
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    };

    const stopGroup = (reason: "timeout" | "overflow") => {
      if (settled) return;
      if (reason === "timeout") timedOut = true;
      else overflow = true;
      collecting = false;
      if (pid === undefined) {
        finish();
        return;
      }
      killGroup(pid, reason === "overflow" ? "SIGKILL" : "SIGTERM");
      if (killTimer) return;
      killTimer = setTimeout(() => {
        if (groupAlive(pid)) killGroup(pid, "SIGKILL");
        finish();
      }, reason === "overflow" ? 0 : KILL_GRACE_MS);
    };

    const collect = (chunks: Buffer[], which: "out" | "err") => (chunk: Buffer) => {
      if (!collecting) return;
      if (which === "out") outBytes += chunk.length;
      else errBytes += chunk.length;
      if (outBytes > MAX_EXEC_OUTPUT_BYTES || errBytes > MAX_EXEC_OUTPUT_BYTES) {
        stopGroup("overflow");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout?.on("data", collect(out, "out"));
    child.stderr?.on("data", collect(errOut, "err"));

    const timer = setTimeout(() => stopGroup("timeout"), timeout);

    child.on("error", (err) => {
      if (settled) return;
      errOut.push(Buffer.from(err.message));
      exitCode = 1;
      finish();
    });

    child.on("exit", (code, signal) => {
      shellExited = true;
      exitCode = code;
      exitSignal = signal;
      if (timedOut || overflow) {
        // Finish as soon as the whole group is gone; else the kill timer does.
        if (pid === undefined || !groupAlive(pid)) finish();
        return;
      }
      if (pid !== undefined) activeExecGroups.delete(pid);
      closeTimer = setTimeout(finish, PIPE_CLOSE_GRACE_MS);
    });

    child.on("close", () => {
      if (shellExited && !timedOut && !overflow) finish();
    });
  });
}

export interface ConwayClientOptions {
  apiUrl: string;
  apiKey: string;
  sandboxId: string;
}

/**
 * The Conway client the rest of the agent uses. Its value-moving calls
 * (transferCredits, createSandbox, registerDomain) go through the Treasury,
 * resolved at call time: the explicit resolver, else the installed one, else
 * the call is refused and nothing is sent. Scoped clients are guarded too.
 */
export function createConwayClient(
  options: ConwayClientOptions & { treasury?: TreasuryResolver },
): ConwayClient {
  const { treasury, ...rawOptions } = options;
  return guardConwayClient(createRawConwayClient(rawOptions), treasury);
}

/**
 * A balance reader for the Treasury with its own HTTP client, so failures of
 * other Conway calls (which can open the shared circuit breaker) never make
 * the gate's balance reads fail. Throws when the balance is missing.
 */
export function createCreditBalanceReader(options: {
  apiUrl: string;
  apiKey: string;
  /** Base delay between 404 retries (attempt n waits n times this). Default 1000ms. */
  notFoundRetryDelayMs?: number;
}): () => Promise<number> {
  const httpClient = new ResilientHttpClient();
  const delayMs = options.notFoundRetryDelayMs ?? 1000;
  return async () => {
    // Conway's load balancer intermittently answers 404 for valid endpoints;
    // retry those like the main client does, outside the circuit breaker.
    const max404Retries = 3;
    let resp: Response;
    for (let attempt = 0; ; attempt++) {
      resp = await httpClient.request(`${options.apiUrl}/v1/credits/balance`, {
        method: "GET",
        headers: { Authorization: options.apiKey },
        retries: 1,
      });
      if (resp.status !== 404 || attempt >= max404Retries) break;
      await resp.body?.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw httpError("GET", "/v1/credits/balance", resp.status, text);
    }
    const text = await resp.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new BalanceUnavailableError("malformed_response", "credit balance response is not JSON");
    }
    return parseCreditBalanceBody(data);
  };
}

/**
 * The credit balance in cents from a /v1/credits/balance body. Anything
 * other than a finite number in balance_cents (else credits_cents) throws:
 * a proxy error page or a renamed field is not a zero balance. A negative
 * number is a real answer (debt).
 */
export function parseCreditBalanceBody(data: unknown): number {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new BalanceUnavailableError("malformed_response", "credit balance response is not a JSON object");
  }
  const body = data as Record<string, unknown>;
  const value = body.balance_cents ?? body.credits_cents;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BalanceUnavailableError(
      "malformed_response",
      `credit balance response has no numeric balance_cents or credits_cents (got ${JSON.stringify(value) ?? "undefined"})`,
    );
  }
  return value;
}

/**
 * The unguarded client. Module-private: only createConwayClient (which wraps
 * it) and its own scoped clients use it, so no caller can move value without
 * a treasury ledger row.
 */
function createRawConwayClient(options: ConwayClientOptions): ConwayClient {
  const { apiUrl, apiKey } = options;
  // Normalize sandbox ID defensively so values like whitespace/"undefined"/"null"
  // never produce malformed API paths such as /v1/sandboxes//exec.
  const sandboxId = normalizeSandboxId(options.sandboxId);
  const httpClient = new ResilientHttpClient();

  async function request(
    method: string,
    path: string,
    body?: unknown,
    requestOptions?: {
      idempotencyKey?: string;
      retries404?: number;
      /** Passed to the HTTP client; 0 for value-moving calls. */
      retries?: number;
      /** Runs once, before the first attempt; 404 re-sends do not call it again. */
      onSend?: () => void;
      /** "manual" for value-moving calls: a redirect is an answer, never followed. */
      redirect?: RequestRedirect;
      /** Per-attempt HTTP timeout in ms (default: the client's base timeout). */
      timeout?: number;
    },
  ): Promise<any> {
    // Conway LB has an intermittent routing bug that returns 404 for valid
    // sandbox endpoints. Retry 404s here (outside ResilientHttpClient) to
    // avoid tripping the circuit breaker on transient routing failures.
    // Re-sends reuse the same idempotency key.
    // A keyless non-idempotent request is sent once: a 404 from a backend
    // that did the work would otherwise repeat it.
    const resendable = IDEMPOTENT_METHODS.has(method.toUpperCase()) || !!requestOptions?.idempotencyKey;
    const max404Retries = resendable ? (requestOptions?.retries404 ?? 3) : 0;
    requestOptions?.onSend?.();
    for (let attempt = 0; attempt <= max404Retries; attempt++) {
      const resp = await httpClient.request(`${apiUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        idempotencyKey: requestOptions?.idempotencyKey,
        retries: requestOptions?.retries,
        ...(requestOptions?.timeout !== undefined ? { timeout: requestOptions.timeout } : {}),
        ...(requestOptions?.redirect ? { redirect: requestOptions.redirect } : {}),
      });

      if (resp.status === 404 && attempt < max404Retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }

      if (!resp.ok) {
        const text = await resp.text();
        throw httpError(method, path, resp.status, text);
      }

      return resp.headers.get("content-type")?.includes("application/json")
        ? resp.json()
        : resp.text();
    }

    throw new Error("Unreachable");
  }

  const canonicalizePayload = (payload: Record<string, string>): string => {
    const sortedKeys = Object.keys(payload).sort();
    const sorted: Record<string, string> = {};
    for (const key of sortedKeys) {
      sorted[key] = payload[key];
    }
    return JSON.stringify(sorted);
  };

  const hashIdentityPayload = (payload: Record<string, string>): `0x${string}` => {
    const canonical = canonicalizePayload(payload);
    return keccak256(toHex(canonical));
  };


  // ─── Sandbox Operations (own sandbox) ────────────────────────
  // When sandboxId is empty, automatically fall back to local execution.

  const isLocal = !sandboxId;

  const exec = async (
    command: string,
    timeout?: number,
  ): Promise<ExecResult> => {
    if (isLocal) return execLocalCommand(command, timeout);

    // Remote sandboxes default to / as cwd. Wrap commands to run from /root
    // (matching local exec behavior) unless the command already sets a directory.
    const wrappedCommand = `cd /root && ${command}`;
    const commandTimeout = timeout && timeout > 0 ? timeout : DEFAULT_EXEC_TIMEOUT_MS;

    try {
      // The HTTP call lasts as long as the command plus a margin, and is
      // never re-sent after a client-side abort: the command may be running.
      const result = await request(
        "POST",
        `/v1/sandboxes/${sandboxId}/exec`,
        { command: wrappedCommand, timeout: commandTimeout },
        {
          idempotencyKey: ulid(),
          timeout: commandTimeout + REMOTE_EXEC_HTTP_MARGIN_MS,
          retries: 0,
        },
      );
      return {
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        exitCode: result.exit_code ?? result.exitCode ?? -1,
      };
    } catch (err: any) {
      // SECURITY: Never silently fall back to local execution on auth failure.
      // A 403 indicates a credentials mismatch — falling back to local exec
      // would bypass the sandbox security boundary entirely.
      if (err?.status === 403) {
        throw new Error(
          `Conway API authentication failed (403). Sandbox exec refused. ` +
            `This may indicate a misconfigured or revoked API key. ` +
            `Command will NOT be executed locally for security reasons.`,
        );
      }
      throw err;
    }
  };

  const resolveLocalPath = (filePath: string): string =>
    filePath.startsWith("~")
      ? nodePath.join(process.env.HOME || "/root", filePath.slice(1))
      : filePath;

  const writeFile = async (
    filePath: string,
    content: string,
  ): Promise<void> => {
    if (isLocal) {
      const resolved = resolveLocalPath(filePath);
      const dir = nodePath.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(resolved, content, "utf-8");
      return;
    }
    try {
      // The key makes the LB-404 re-sends safe; never auto-retried otherwise.
      await request(
        "POST",
        `/v1/sandboxes/${sandboxId}/files/upload/json`,
        { path: filePath, content },
        { idempotencyKey: ulid() },
      );
    } catch (err: any) {
      // SECURITY: Never silently fall back to local FS on auth failure.
      if (err?.status === 403) {
        throw new Error(
          `Conway API authentication failed (403). File write refused. ` +
            `File will NOT be written locally for security reasons.`,
        );
      }
      throw err;
    }
  };

  const readFile = async (filePath: string): Promise<string> => {
    if (isLocal) {
      return fs.readFileSync(resolveLocalPath(filePath), "utf-8");
    }
    try {
      const result = await request(
        "GET",
        `/v1/sandboxes/${sandboxId}/files/read?path=${encodeURIComponent(filePath)}`,
        undefined,
        { retries404: 0 },
      );
      return typeof result === "string" ? result : result.content || "";
    } catch (err: any) {
      // SECURITY: Never silently fall back to local FS on auth failure.
      if (err?.status === 403) {
        throw new Error(
          `Conway API authentication failed (403). File read refused. ` +
            `File will NOT be read locally for security reasons.`,
        );
      }
      throw err;
    }
  };

  const exposePort = async (port: number): Promise<PortInfo> => {
    if (isLocal) {
      return {
        port,
        publicUrl: `http://localhost:${port}`,
        sandboxId: "local",
      };
    }
    const result = await request(
      "POST",
      `/v1/sandboxes/${sandboxId}/ports/expose`,
      { port },
      { idempotencyKey: ulid() },
    );
    return {
      port: result.port,
      publicUrl: result.public_url || result.publicUrl || result.url,
      sandboxId,
    };
  };

  const removePort = async (port: number): Promise<void> => {
    if (isLocal) return;
    await request("DELETE", `/v1/sandboxes/${sandboxId}/ports/${port}`);
  };

  // ─── Sandbox Management (other sandboxes) ────────────────────

  const createSandbox = async (
    options: CreateSandboxOptions,
  ): Promise<SandboxInfo> => {
    // Sandboxes are prepaid and non-refundable: never auto-retry, and send
    // an idempotency key so a server that honours it creates at most one.
    const result = await request(
      "POST",
      "/v1/sandboxes",
      {
        name: options.name,
        vcpu: options.vcpu || 1,
        memory_mb: options.memoryMb || 512,
        disk_gb: options.diskGb || 5,
        region: options.region,
      },
      {
        idempotencyKey: options.idempotencyKey ?? ulid(),
        onSend: options.onSend,
        retries: 0,
        redirect: "manual",
      },
    );
    return {
      id: result.id || result.sandbox_id,
      status: result.status || "running",
      region: result.region || "",
      vcpu: result.vcpu || options.vcpu || 1,
      memoryMb: result.memory_mb || options.memoryMb || 512,
      diskGb: result.disk_gb || options.diskGb || 5,
      terminalUrl: result.terminal_url,
      createdAt: result.created_at || new Date().toISOString(),
    };
  };

  const deleteSandbox = async (_targetId: string): Promise<void> => {
    // Conway API no longer supports sandbox deletion.
    // Sandboxes are prepaid and non-refundable — this is a no-op.
  };

  const listSandboxes = async (): Promise<SandboxInfo[]> => {
    const result = await request("GET", "/v1/sandboxes");
    const sandboxes = Array.isArray(result) ? result : result.sandboxes || [];
    return sandboxes.map((s: any) => ({
      id: s.id || s.sandbox_id,
      status: s.status || "unknown",
      region: s.region || "",
      vcpu: s.vcpu || 0,
      memoryMb: s.memory_mb || 0,
      diskGb: s.disk_gb || 0,
      terminalUrl: s.terminal_url,
      createdAt: s.created_at || "",
    }));
  };

  // ─── Credits ─────────────────────────────────────────────────

  /** Throws BalanceUnavailableError unless the body holds a numeric balance. */
  const getCreditsBalance = async (): Promise<number> => {
    const result = await request("GET", "/v1/credits/balance");
    if (typeof result === "string") {
      throw new BalanceUnavailableError("malformed_response", "credit balance response is not JSON");
    }
    return parseCreditBalanceBody(result);
  };

  const getCreditsPricing = async (): Promise<PricingTier[]> => {
    const result = await request("GET", "/v1/credits/pricing");
    const tiers = result.tiers || result.pricing || [];
    return tiers.map((t: any) => ({
      name: t.name || "",
      vcpu: t.vcpu || 0,
      memoryMb: t.memory_mb || 0,
      diskGb: t.disk_gb || 0,
      monthlyCents: t.monthly_cents || 0,
    }));
  };

  const transferCredits = async (
    toAddress: string,
    amountCents: number,
    note?: string,
    opts?: OutflowRequestOptions,
  ): Promise<CreditTransferResult> => {
    const payload = {
      to_address: toAddress,
      amount_cents: amountCents,
      note,
    };

    // One key for both endpoint shapes, and the caller's key when given, so
    // a retried logical transfer is recognisable by the server.
    const idempotencyKey = opts?.idempotencyKey ?? ulid();
    const paths = ["/v1/credits/transfer", "/v1/credits/transfers"];

    let last404: { path: string; text: string } | undefined;
    opts?.onSend?.();

    for (const path of paths) {
      const resp = await httpClient.request(`${apiUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
        },
        body: JSON.stringify(payload),
        idempotencyKey,
        retries: 0, // Mutating: do not auto-retry transfers
        // A redirect is not followed: it would re-send the transfer elsewhere,
        // and a failure on the second hop would look like nothing was sent.
        redirect: "manual",
      });

      if (!resp.ok) {
        const text = await resp.text();
        // Try next known endpoint shape before failing.
        if (resp.status === 404) {
          last404 = { path, text };
          continue;
        }
        throw httpError("POST", path, resp.status, text);
      }

      const data = await resp.json().catch(() => ({}) as any);
      return {
        transferId: data.transfer_id || data.id || "",
        status: data.status || "submitted",
        toAddress: data.to_address || toAddress,
        amountCents: data.amount_cents ?? amountCents,
        balanceAfterCents:
          data.balance_after_cents ?? data.new_balance_cents ?? undefined,
      };
    }

    throw httpError("POST", "/v1/credits/transfer", 404, last404?.text ?? "Unknown transfer error");
  };

  const registerAutomaton = async (params: {
    automatonId: string;
    automatonAddress: string;
    creatorAddress: string;
    name: string;
    bio?: string;
    genesisPromptHash?: `0x${string}`;
    account: PrivateKeyAccount;
    nonce?: string;
    chainType?: ChainType;
    chainIdentity?: ChainIdentity;
  }): Promise<{ automaton: Record<string, unknown> }> => {
    const {
      automatonId,
      automatonAddress,
      creatorAddress,
      name,
      bio,
      genesisPromptHash,
      account,
      chainIdentity,
    } = params;
    const nonce = params.nonce ?? randomUUID();
    const isSolana = params.chainType === "solana";

    const payload: Record<string, string> = {
      automaton_id: automatonId,
      automaton_address: automatonAddress,
      creator_address: creatorAddress,
      name,
      bio: bio || "",
    };
    if (genesisPromptHash) {
      payload.genesis_prompt_hash = genesisPromptHash;
    }

    const payloadHash = hashIdentityPayload(payload);
    let signature: string;

    if (isSolana && chainIdentity) {
      // Solana path: Ed25519 sign of canonical JSON
      const sigMessage = JSON.stringify({ automatonId, nonce, payloadHash });
      signature = await chainIdentity.signMessage(sigMessage);
    } else if (isSolana && !chainIdentity) {
      throw new Error("Solana registration requires chainIdentity. Pass the ChainIdentity from getWallet().");
    } else {
      // EVM path: EIP-712 typed data (unchanged)
      const domain = {
        name: "AIWS Automaton",
        version: "1",
        chainId: 8453,
      };
      const types = {
        Register: [
          { name: "automatonId", type: "string" },
          { name: "nonce", type: "string" },
          { name: "payloadHash", type: "bytes32" },
        ],
      };
      const message = {
        automatonId,
        nonce,
        payloadHash,
      };
      signature = await account.signTypedData({
        domain,
        types,
        primaryType: "Register",
        message,
      });
    }

    const body: Record<string, unknown> = {
      automaton_id: automatonId,
      automaton_address: automatonAddress,
      creator_address: creatorAddress,
      name,
      bio: bio || "",
      nonce,
      signature,
      payload_hash: payloadHash,
    };
    if (genesisPromptHash) {
      body.genesis_prompt_hash = genesisPromptHash;
    }
    if (isSolana) {
      body.chain_type = "solana";
    }

    return request("POST", "/v1/automatons/register", body, { idempotencyKey: ulid() });
  };

  // ─── Domains ──────────────────────────────────────────────────

  const searchDomains = async (
    query: string,
    tlds?: string,
  ): Promise<DomainSearchResult[]> => {
    const params = new URLSearchParams({ query });
    if (tlds) params.set("tlds", tlds);
    const result = await request("GET", `/v1/domains/search?${params}`);
    const results = result.results || result.domains || [];
    return results.map((d: any) => ({
      domain: d.domain,
      available: d.available ?? d.purchasable ?? false,
      registrationPrice: d.registration_price ?? d.purchase_price,
      renewalPrice: d.renewal_price,
      currency: d.currency || "USD",
    }));
  };

  const registerDomain = async (
    domain: string,
    years: number = 1,
    opts?: OutflowRequestOptions,
  ): Promise<DomainRegistration> => {
    // Paid and not refundable: never auto-retry, always send a key.
    const result = await request(
      "POST",
      "/v1/domains/register",
      { domain, years },
      { idempotencyKey: opts?.idempotencyKey ?? ulid(), onSend: opts?.onSend, retries: 0, redirect: "manual" },
    );
    return {
      domain: result.domain || domain,
      status: result.status || "registered",
      expiresAt: result.expires_at || result.expiry,
      transactionId: result.transaction_id || result.id,
    };
  };

  const listDnsRecords = async (domain: string): Promise<DnsRecord[]> => {
    const result = await request(
      "GET",
      `/v1/domains/${encodeURIComponent(domain)}/dns`,
    );
    const records = result.records || result || [];
    return (Array.isArray(records) ? records : []).map((r: any) => ({
      id: r.id || r.record_id || "",
      type: r.type || "",
      host: r.host || r.name || "",
      value: r.value || r.answer || "",
      ttl: r.ttl,
      distance: r.distance ?? r.priority,
    }));
  };

  const addDnsRecord = async (
    domain: string,
    type: string,
    host: string,
    value: string,
    ttl?: number,
  ): Promise<DnsRecord> => {
    const result = await request(
      "POST",
      `/v1/domains/${encodeURIComponent(domain)}/dns`,
      { type, host, value, ttl: ttl || 3600 },
      { idempotencyKey: ulid() },
    );
    return {
      id: result.id || result.record_id || "",
      type: result.type || type,
      host: result.host || host,
      value: result.value || value,
      ttl: result.ttl || ttl || 3600,
    };
  };

  const deleteDnsRecord = async (
    domain: string,
    recordId: string,
  ): Promise<void> => {
    await request(
      "DELETE",
      `/v1/domains/${encodeURIComponent(domain)}/dns/${encodeURIComponent(recordId)}`,
    );
  };

  // ─── Model Discovery ───────────────────────────────────────────

  const listModels = async (): Promise<ModelInfo[]> => {
    // Try inference.conway.tech first (has availability info), fall back to control plane
    const urls = [
      "https://inference.conway.tech/v1/models",
      `${apiUrl}/v1/models`,
    ];
    for (const url of urls) {
      try {
        const resp = await httpClient.request(url, {
          headers: { Authorization: apiKey },
        });
        if (!resp.ok) continue;
        const result = (await resp.json()) as any;
        const raw = result.data || result.models || [];
        return raw
          .filter((m: any) => m.available !== false)
          .map((m: any) => ({
            id: m.id,
            provider: m.provider || m.owned_by || "unknown",
            pricing: {
              inputPerMillion:
                m.pricing?.input_per_million ??
                m.pricing?.input_per_1m_tokens_usd ??
                0,
              outputPerMillion:
                m.pricing?.output_per_million ??
                m.pricing?.output_per_1m_tokens_usd ??
                0,
            },
          }));
      } catch {
        continue;
      }
    }
    return [];
  };

  // Raw on purpose: the guarded wrapper re-guards scoped clients, so each
  // outflow is gated exactly once.
  const createScopedClient = (targetSandboxId: string): ConwayClient => {
    return createRawConwayClient({ apiUrl, apiKey, sandboxId: targetSandboxId });
  };

  const client: ConwayClient = {
    exec,
    writeFile,
    readFile,
    exposePort,
    removePort,
    createSandbox,
    deleteSandbox,
    listSandboxes,
    getCreditsBalance,
    getCreditsPricing,
    transferCredits,
    registerAutomaton,
    searchDomains,
    registerDomain,
    listDnsRecords,
    addDnsRecord,
    deleteDnsRecord,
    listModels,
    createScopedClient,
  };

  // SECURITY: API credentials are NOT exposed on the client object.
  // If child spawning or other modules need API configuration, pass it
  // explicitly through a dedicated typed interface — never via dynamic getters
  // that any code with a client reference could access.

  return client;
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

/** A Conway API error carrying the HTTP status and body (message format unchanged). */
function httpError(method: string, path: string, status: number, text: string): Error {
  const err: any = new Error(`Conway API error: ${method} ${path} -> ${status}: ${text}`);
  err.status = status;
  err.responseText = text;
  err.method = method;
  err.path = path;
  return err;
}

/** True when this sandbox id means "run on this machine" (empty, whitespace, "undefined", "null"). */
export function isLocalSandboxId(value: string | null | undefined): boolean {
  return normalizeSandboxId(value) === "";
}

function normalizeSandboxId(value: string | null | undefined): string {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  if (trimmed === "undefined" || trimmed === "null") return "";
  return trimmed;
}
