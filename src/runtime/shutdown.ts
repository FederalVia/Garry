/**
 * Cooperative shutdown.
 *
 * The first SIGTERM/SIGINT asks the runtime to stop: the agent loop stops at
 * its next tool boundary and saves the turn, then the entrypoint drains the
 * heartbeat and workers and exits 0. A second signal, or the grace deadline,
 * forces exit 1.
 */

export const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;
export const SHUTDOWN_GRACE_ENV = "AUTOMATON_SHUTDOWN_GRACE_MS";

export interface ShutdownController {
  /** True once a stop was requested. */
  readonly stopping: boolean;
  /** What asked for the stop (a signal name), or null. */
  readonly reason: string | null;
  /** Aborted when a stop is requested. */
  readonly signal: AbortSignal;
  /** Idempotent; returns true only for the first request. */
  requestStop(reason: string): boolean;
  /** Resolves true after ms, or false as soon as a stop is requested. */
  sleep(ms: number): Promise<boolean>;
}

export function createShutdownController(): ShutdownController {
  const abort = new AbortController();
  let reason: string | null = null;
  return {
    get stopping() {
      return abort.signal.aborted;
    },
    get reason() {
      return reason;
    },
    signal: abort.signal,
    requestStop(why: string): boolean {
      if (abort.signal.aborted) return false;
      reason = why;
      abort.abort();
      return true;
    },
    sleep(ms: number): Promise<boolean> {
      if (abort.signal.aborted) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve(false);
        };
        const timer = setTimeout(() => {
          abort.signal.removeEventListener("abort", onAbort);
          resolve(true);
        }, Math.max(0, ms));
        abort.signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

/**
 * Wait for a promise for at most ms. Resolves with its value, or undefined
 * on timeout or rejection; never rejects. The timer does not keep the
 * process alive.
 */
export async function withDeadline<T>(promise: Promise<T> | T, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve(promise).catch(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Grace period from AUTOMATON_SHUTDOWN_GRACE_MS, else 30 s. */
export function resolveShutdownGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SHUTDOWN_GRACE_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_SHUTDOWN_GRACE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SHUTDOWN_GRACE_MS;
}

export interface ShutdownSignalsOptions {
  controller: ShutdownController;
  graceMs: number;
  /** Must not return: best-effort cleanup, then process.exit(1). */
  forceExit: (why: string) => void;
  log?: (message: string) => void;
  signals?: NodeJS.Signals[];
}

export interface ShutdownSignals {
  /** Epoch ms by which the shutdown must finish, once a stop was requested. */
  deadline(): number | null;
  /** Milliseconds left before the deadline (the full grace if none yet). */
  remainingMs(): number;
  dispose(): void;
}

/**
 * First signal: request a stop and arm the forced-exit timer. Second
 * signal: force exit at once.
 */
export function installShutdownSignals(opts: ShutdownSignalsOptions): ShutdownSignals {
  const { controller, graceMs, forceExit } = opts;
  const log = opts.log ?? (() => {});
  const signals = opts.signals ?? ["SIGTERM", "SIGINT"];
  let deadline: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const armDeadline = (): void => {
    if (deadline !== null) return;
    deadline = Date.now() + graceMs;
    timer = setTimeout(() => {
      log(`Shutdown did not finish within ${graceMs} ms; forcing exit.`);
      forceExit("deadline");
    }, graceMs);
    // The timer must not be what keeps a finished process alive.
    timer.unref?.();
  };

  const onSignal = (sig: NodeJS.Signals): void => {
    if (controller.stopping) {
      log(`Received ${sig} again; forcing exit.`);
      forceExit(sig);
      return;
    }
    log(`Received ${sig}; stopping after the current step (at most ${Math.round(graceMs / 1000)} s).`);
    controller.requestStop(sig);
    armDeadline();
  };

  // A stop requested by other code also gets the deadline.
  controller.signal.addEventListener("abort", armDeadline, { once: true });
  for (const sig of signals) process.on(sig, onSignal);

  return {
    deadline: () => deadline,
    remainingMs: () => (deadline === null ? graceMs : Math.max(0, deadline - Date.now())),
    dispose(): void {
      for (const sig of signals) process.off(sig, onSignal);
      controller.signal.removeEventListener("abort", armDeadline);
      if (timer) clearTimeout(timer);
    },
  };
}

export interface ShutdownSteps {
  /** Milliseconds left in the grace period; each wait is bounded by it. */
  remainingMs(): number;
  stopHeartbeat(): void;
  /** Waits for the in-flight heartbeat tick. */
  drainHeartbeat(ms: number): Promise<unknown>;
  /** Aborts the in-process workers and waits for them to settle. */
  drainWorkers(ms: number): Promise<unknown>;
  /** Leaves the agent state as a stopped runtime should. */
  leaveState(): void;
  releaseLock(): void;
  closeDb(): void;
  log?: (message: string) => void;
}

/**
 * The clean-stop sequence after the loop has saved its turn. Each step runs
 * even if an earlier one failed or ran out of time, so the state, the lock
 * and the database are always handled. Never rejects.
 */
export async function finishShutdown(steps: ShutdownSteps): Promise<void> {
  const log = steps.log ?? (() => {});
  const attempt = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      log(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  attempt("Heartbeat stop", () => steps.stopHeartbeat());
  await withDeadline(
    Promise.resolve().then(() => steps.drainHeartbeat(steps.remainingMs())),
    steps.remainingMs(),
  );
  await withDeadline(
    Promise.resolve().then(() => steps.drainWorkers(steps.remainingMs())),
    steps.remainingMs(),
  );
  attempt("Saving the agent state", () => steps.leaveState());
  attempt("Releasing the instance lock", () => steps.releaseLock());
  attempt("Closing the database", () => steps.closeDb());
}
