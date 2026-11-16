/**
 * Tunnel supervision: one tunnel process (cloudflared, ngrok or an owner's
 * own command) per exposed port.
 *
 * The process runs in its own group with no shell and an environment that
 * holds only what the owner named for it. Its public URL is taken from its
 * output by a strict parser, so tunnel output (which, once the URL is up,
 * includes details of requests from the internet) never decides anything
 * but which validated https origin the port has. A crash after the URL was
 * up restarts it with backoff, bounded per window; then it stays failed.
 */

import type { ChildProcess } from "node:child_process";
import { isInternalHostname } from "../registry/safe-fetch.js";
import { killGroup, spawnInGroup, terminateGroup } from "../runtime/process-group.js";
import {
  abortReason,
  currentCancellationSignal,
  raceWithSignal,
  runOutsideCancellation,
} from "../runtime/cancellation.js";
import { redactSecrets } from "../security/secret-redaction.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("edge.tunnel");

export type ExposureState = "starting" | "up" | "restarting" | "failed";

export interface TunnelSpec {
  command: string;
  /** `{port}` is replaced by the validated port number. */
  args: string[];
  urlPattern: RegExp;
  readyPattern?: RegExp;
  /** The complete environment of the tunnel process. */
  env: NodeJS.ProcessEnv;
  startTimeoutMs: number;
  restart: { maxRestarts: number; windowMs: number; backoffMs: number[] };
}

export const DEFAULT_BACKOFF_MS: readonly number[] = Object.freeze([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);

const TAIL_BYTES = 4_096;
const FAILURE_TAIL_BYTES = 1_024;
// Raw output kept well beyond the window, so redaction sees a secret whole
// before the window is cut (a secret cut in half is no longer recognised).
const RAW_TAIL_BYTES = 16_384;
const MAX_LINE_FOR_MATCH = 8_192;
const MAX_SCAN_BEFORE_URL = 256 * 1024;
const DEFAULT_STOP_GRACE_MS = 3_000;

export interface TunnelSupervisorOptions {
  /** A restart brought a different URL. */
  onUrlChange?: (oldUrl: string | null, newUrl: string) => void;
  /** Any change of state or URL. */
  onStateChange?: (state: ExposureState, url: string | null) => void;
  /** A tunnel process was just started (first start or restart). */
  onSpawn?: (pid: number | null) => void;
  now?: () => number;
}

// Characters that end a URL token in log output (quotes, brackets, pipes, spaces).
const URL_TOKEN_RE = /https?:\/\/[^\s"'<>|\\`]+/gi;

function anchored(re: RegExp): RegExp {
  const flags = re.flags.replace(/[gy]/g, "");
  return new RegExp(`^(?:${re.source})$`, flags);
}

/**
 * The validated public URL in one line of tunnel output, or null. Only an
 * https origin (no userinfo, no port but 443, no path, query or fragment)
 * whose origin or hostname matches the pattern in full, and that does not
 * name an internal host.
 */
export function findTunnelUrl(line: string, pattern: RegExp): string | null {
  const full = anchored(pattern);
  for (const m of line.matchAll(URL_TOKEN_RE)) {
    const token = m[0].replace(/[.,;:)\]}]+$/, "");
    let url: URL;
    try {
      url = new URL(token);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    if (url.username || url.password) continue;
    if (url.port !== "" && url.port !== "443") continue;
    if (url.pathname !== "/" && url.pathname !== "") continue;
    if (url.search || url.hash || token.includes("?") || token.includes("#")) continue;
    // A path of "/" is allowed only as written: "https://h/" or "https://h".
    const host = url.hostname.toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(host)) continue;
    if (isInternalHostname(host)) continue;
    const origin = `https://${host}`;
    if (!full.test(origin) && !full.test(host)) continue;
    return origin;
  }
  return null;
}

/** Splits a stream into lines for matching, bounding each line. */
class LineSplitter {
  private buf = "";
  private skipping = false;
  constructor(private readonly onLine: (line: string) => void) {}
  push(chunk: string): void {
    let s = chunk;
    for (;;) {
      const nl = s.indexOf("\n");
      if (nl < 0) break;
      const piece = s.slice(0, nl);
      s = s.slice(nl + 1);
      if (this.skipping) {
        this.skipping = false;
        this.buf = "";
        continue;
      }
      this.onLine(this.buf + piece);
      this.buf = "";
    }
    if (this.skipping) return;
    this.buf += s;
    if (this.buf.length > MAX_LINE_FOR_MATCH) {
      // A very long line is matched on its first 8 KB only.
      this.onLine(this.buf.slice(0, MAX_LINE_FOR_MATCH));
      this.buf = "";
      this.skipping = true;
    }
  }
}

export class TunnelStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TunnelStartError";
  }
}

export class TunnelSupervisor {
  private child: ChildProcess | null = null;
  private _state: ExposureState = "starting";
  private _url: string | null = null;
  private lastUrl: string | null = null;
  private stopping = false;
  private restartTimes: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private tail = "";
  private _detail: string | undefined;
  private _readyPending = false;
  private readonly now: () => number;

  constructor(
    readonly port: number,
    private readonly spec: TunnelSpec,
    private readonly opts: TunnelSupervisorOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  get state(): ExposureState {
    return this._state;
  }
  get url(): string | null {
    return this._url;
  }
  get pid(): number | null {
    return this.child?.pid ?? null;
  }
  /** Short reason for restarting or failed; never tunnel output. */
  get detail(): string | undefined {
    return this._detail;
  }
  /** The URL was seen but the tunnel had not reported ready within the start timeout. */
  get readyPending(): boolean {
    return this._readyPending;
  }

  /** The last 4 KB of output, redacted. For logs, never for the prompt. */
  outputTail(): string {
    return this.redactedTail(TAIL_BYTES);
  }

  /** Redact first, then cut, then drop a partial first line. */
  private redactedTail(bytes: number): string {
    const red = redactSecrets(this.tail);
    if (red.length <= bytes) return red;
    const cut = red.slice(-bytes);
    if (red[red.length - bytes - 1] === "\n") return cut;
    const nl = cut.indexOf("\n");
    return nl >= 0 ? cut.slice(nl + 1) : cut;
  }

  /**
   * Start the tunnel and resolve with its validated URL. On abort the tunnel
   * is stopped and nothing is left running. A failed first start is not
   * restarted.
   */
  async start(signal: AbortSignal | undefined = currentCancellationSignal()): Promise<string> {
    if (signal?.aborted) throw abortReason(signal);
    this.stopping = false;
    this.restartTimes = [];
    this._detail = undefined;
    this.setState("starting", null);
    try {
      const url = await raceWithSignal(this.launch(), signal);
      this.lastUrl = url;
      this.setState("up", url);
      return url;
    } catch (err) {
      await this.stop(500);
      this.setState("failed", null);
      throw err;
    }
  }

  /** Stop for good: no restart, SIGTERM to the group, SIGKILL after graceMs. */
  async stop(graceMs = DEFAULT_STOP_GRACE_MS): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (child) await terminateGroup(child, graceMs);
    this._url = null;
  }

  private setState(state: ExposureState, url: string | null): void {
    const changed = state !== this._state || url !== this._url;
    this._state = state;
    this._url = url;
    if (changed) {
      try {
        this.opts.onStateChange?.(state, url);
      } catch (err) {
        logger.warn(`Tunnel state listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private appendTail(chunk: string): void {
    let t = this.tail + chunk;
    if (t.length > RAW_TAIL_BYTES) {
      t = t.slice(-RAW_TAIL_BYTES);
      // Start on a whole line, so a secret cut at the front is not kept.
      const nl = t.indexOf("\n");
      if (nl >= 0) t = t.slice(nl + 1);
    }
    this.tail = t;
  }

  /** Spawn once; resolve with the URL, reject when the process never reports one. */
  private launch(): Promise<string> {
    const args = this.spec.args.map((a) => a.split("{port}").join(String(this.port)));
    this.tail = "";
    this._readyPending = false;
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let url: string | null = null;
      let ready = !this.spec.readyPattern;
      let scanned = 0;
      let child: ChildProcess;
      try {
        // A heartbeat task that starts a tunnel must not own its lifetime.
        child = runOutsideCancellation(() =>
          spawnInGroup({ command: this.spec.command, args, env: this.spec.env, stdin: "ignore" }),
        );
      } catch (err) {
        reject(new TunnelStartError(`Tunnel could not start: ${redactSecrets(errorText(err))}`));
        return;
      }
      this.child = child;
      try {
        this.opts.onSpawn?.(child.pid ?? null);
      } catch (err) {
        logger.warn(`Tunnel spawn listener failed: ${errorText(err)}`);
      }

      // The error reaches the agent, so it carries a fixed reason only; the
      // output (which anyone on the internet can influence) goes to the log.
      const fail = (why: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killGroup(child);
        const last = this.redactedTail(FAILURE_TAIL_BYTES).trim();
        logger.warn(`Tunnel for port ${this.port} did not start (${why})${last ? `; output tail: ${last}` : ""}`);
        reject(new TunnelStartError(why));
      };
      const succeed = (): void => {
        if (settled || !url) return;
        settled = true;
        clearTimeout(timer);
        resolve(url);
      };
      const onLine = (line: string): void => {
        if (settled) return;
        if (scanned > MAX_SCAN_BEFORE_URL) return;
        scanned += line.length + 1;
        if (!url) url = findTunnelUrl(line, this.spec.urlPattern);
        if (!ready && this.spec.readyPattern && this.spec.readyPattern.test(line)) ready = true;
        if (url && ready) succeed();
      };
      const splitOut = new LineSplitter(onLine);
      const splitErr = new LineSplitter(onLine);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      // Both pipes are read for the life of the process, so a chatty tunnel never blocks.
      child.stdout?.on("data", (chunk: string) => {
        this.appendTail(chunk);
        if (!settled) splitOut.push(chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        this.appendTail(chunk);
        if (!settled) splitErr.push(chunk);
      });

      const timer = setTimeout(() => {
        if (url) {
          // The URL is known; the tunnel may need a few more seconds.
          this._readyPending = true;
          succeed();
          return;
        }
        fail(`Tunnel did not report a public URL within ${Math.round(this.spec.startTimeoutMs / 1000)} s`);
      }, this.spec.startTimeoutMs);
      timer.unref?.();

      child.once("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        fail(`Tunnel did not report a public URL (the process failed${typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? `: ${code}` : ""})`);
      });
      child.once("exit", (code, sig) => {
        if (this.child === child) this.child = null;
        if (!settled) {
          fail(`Tunnel did not report a public URL (exited ${sig ?? `with code ${String(code)}`})`);
          return;
        }
        this.onCrash(code, sig);
      });
    });
  }

  /** The process exited after its URL was up. */
  private onCrash(code: number | null, sig: NodeJS.Signals | null): void {
    if (this.stopping) return;
    const how = sig ?? `code ${String(code)}`;
    logger.warn(`Tunnel for port ${this.port} exited (${how}); output tail: ${this.outputTail().slice(-500)}`);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    const now = this.now();
    const { maxRestarts, windowMs, backoffMs } = this.spec.restart;
    this.restartTimes = this.restartTimes.filter((t) => now - t < windowMs);
    if (this.restartTimes.length >= maxRestarts) {
      this._detail =
        `the tunnel exited ${this.restartTimes.length + 1} time(s) within ${Math.round(windowMs / 60_000)} minute(s); ` +
        "expose the port again to retry";
      logger.warn(`Tunnel for port ${this.port} failed: ${this._detail}`);
      this.setState("failed", null);
      return;
    }
    const delays = backoffMs.length > 0 ? backoffMs : DEFAULT_BACKOFF_MS;
    const delay = delays[Math.min(this.restartTimes.length, delays.length - 1)];
    this.restartTimes.push(now);
    this._detail = "the tunnel exited and is restarting";
    this.setState("restarting", null);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.launch().then(
        (url) => {
          if (this.stopping) {
            void this.stop(500);
            return;
          }
          const old = this.lastUrl;
          this.lastUrl = url;
          this._detail = undefined;
          this.setState("up", url);
          if (old !== url) {
            logger.info(`Tunnel for port ${this.port} is up again at a new address: ${url}`);
            try {
              this.opts.onUrlChange?.(old, url);
            } catch (err) {
              logger.warn(`Tunnel URL listener failed: ${errorText(err)}`);
            }
          }
        },
        (err) => {
          logger.warn(`Tunnel for port ${this.port} did not come back: ${errorText(err)}`);
          this.scheduleRestart();
        },
      );
    }, delay);
    this.restartTimer.unref?.();
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
