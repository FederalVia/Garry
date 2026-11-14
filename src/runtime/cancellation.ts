/**
 * Cancellation scope
 *
 * The heartbeat scheduler runs each task inside a scope that carries an
 * AbortSignal. The work to cancel sits several calls below the task (task ->
 * monitor -> Conway client -> HTTP client -> fetch), so the signal travels in
 * an AsyncLocalStorage instead of through every signature. Code outside a
 * scope (agent-loop tools, workers, startup) sees no signal and behaves as
 * before.
 *
 * A scope also knows its shutdown signal. A paid request that has already
 * been sent runs under that signal only (runShieldedFromTimeout): a task
 * timeout must not turn a payment that would have completed into an
 * unconfirmed one. Shutdown still aborts it, and its own HTTP deadline still
 * bounds it.
 *
 * The storage lives on a globalThis symbol, like the treasury origin, so a
 * second copy of this module (vitest module resets) shares the same scope.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type CancelReason = "timeout" | "shutdown";

/** Why a scope was aborted. Named AbortError so every abort check treats it as one. */
export class TaskAbortedError extends Error {
  constructor(
    readonly why: CancelReason,
    message: string,
  ) {
    super(message);
    this.name = "AbortError";
  }
}

/** Shared by a scheduler run and the code inside it. */
export interface CancellationState {
  /** Shielded sections (paid requests already sent) still running. */
  shielded: number;
}

interface CancellationScope {
  readonly signal: AbortSignal;
  readonly shutdownSignal: AbortSignal;
  readonly state?: CancellationState;
}

const STORE_KEY = Symbol.for("automaton.cancellation");

function store(): AsyncLocalStorage<CancellationScope> {
  const g = globalThis as unknown as Record<symbol, AsyncLocalStorage<CancellationScope> | undefined>;
  let s = g[STORE_KEY];
  if (!s) {
    s = new AsyncLocalStorage<CancellationScope>();
    g[STORE_KEY] = s;
  }
  return s;
}

/**
 * Run fn with signal as the ambient cancellation signal. shutdownSignal is
 * the part of it that a shielded section still obeys; it defaults to signal
 * itself (nothing is shielded).
 */
export function runWithCancellation<T>(
  signal: AbortSignal,
  fn: () => Promise<T>,
  opts: { shutdownSignal?: AbortSignal; state?: CancellationState } = {},
): Promise<T> {
  return store().run({ signal, shutdownSignal: opts.shutdownSignal ?? signal, state: opts.state }, fn);
}

/** Run fn with no ambient signal: for long-lived resources a task merely started. */
export function runOutsideCancellation<T>(fn: () => T): T {
  return store().exit(fn);
}

export function currentCancellationSignal(): AbortSignal | undefined {
  return store().getStore()?.signal;
}

/**
 * Run fn under the scope's shutdown signal only. Used once a paid request
 * has been sent: a timeout would only turn its outcome into 'unknown'.
 */
export async function runShieldedFromTimeout<T>(fn: () => Promise<T>): Promise<T> {
  const scope = store().getStore();
  if (!scope) return fn();
  const state = scope.state;
  // A short-lived signal linked to shutdown, so requests do not attach
  // dependents to the process-lifetime root signal.
  const link = linkedAbortController(scope.shutdownSignal);
  if (state) state.shielded++;
  try {
    return await store().run({ signal: link.controller.signal, shutdownSignal: scope.shutdownSignal, state }, fn);
  } finally {
    if (state) state.shielded--;
    link.release();
  }
}

/** The error a signal was aborted with, as an Error named AbortError when it had none. */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" && reason ? reason : "The operation was aborted");
  err.name = "AbortError";
  return err;
}

/** Throws the ambient signal's reason when it is aborted. */
export function throwIfCancelled(): void {
  const signal = currentCancellationSignal();
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * For the top of a catch: when the ambient signal is aborted, the error is
 * almost always its consequence, so the abort is thrown instead of being
 * turned into state (a backoff, a failure notice, a failed probe).
 */
export function rethrowIfCancelled(_err: unknown): void {
  throwIfCancelled();
}

export function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "AbortError";
}

/** One signal that aborts when any of the given ones does; undefined when none is given. */
export function mergeSignals(...signals: (AbortSignal | null | undefined)[]): AbortSignal | undefined {
  const list = signals.filter((s): s is AbortSignal => !!s);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  const unique = [...new Set(list)];
  return unique.length === 1 ? unique[0] : AbortSignal.any(unique);
}

/**
 * A controller that aborts when parent does. release() removes the listener
 * from parent; call it once the work settles, so a long-lived parent does
 * not collect listeners.
 */
export function linkedAbortController(parent: AbortSignal): { controller: AbortController; release: () => void } {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { controller, release: () => {} };
  }
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  return { controller, release: () => parent.removeEventListener("abort", onAbort) };
}

/** setTimeout as a promise that rejects with the signal's reason on abort. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Settle with p, or reject with the signal's reason when it aborts first.
 * p keeps running (for reads bounded by their own timeout).
 */
export function raceWithSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      p.catch(() => {});
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
