/**
 * Treasury registry and origin
 *
 * Holds the process-wide Treasury and the AsyncLocalStorage that carries the
 * origin of an outflow (which tool or automatic caller started it). Both live
 * on a globalThis symbol, so a second copy of this module (vitest module
 * resets, mixed .ts/.js specifiers) sees the same instance and the same
 * origin instead of silently losing attribution.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { ulid } from "ulid";
import { isInboxSource } from "../agent/inbox-isolation.js";
import { TreasuryNotInstalledError } from "./types.js";
import type { TreasuryOrigin } from "./types.js";
import type { Treasury } from "./treasury.js";

/** An explicit Treasury, or a function resolving one at call time. */
export type TreasuryResolver = Treasury | (() => Treasury | undefined);

interface RegistryState {
  treasury: Treasury | undefined;
  readonly origin: AsyncLocalStorage<TreasuryOrigin>;
  /** Identifies this process on ledger rows, so recovery never touches a live process's rows. */
  readonly bootId: string;
}

const REGISTRY_KEY = Symbol.for("automaton.treasury");

function state(): RegistryState {
  const g = globalThis as unknown as Record<symbol, RegistryState | undefined>;
  let s = g[REGISTRY_KEY];
  if (!s) {
    s = { treasury: undefined, origin: new AsyncLocalStorage<TreasuryOrigin>(), bootId: ulid() };
    g[REGISTRY_KEY] = s;
  }
  return s;
}

const UNATTRIBUTED: TreasuryOrigin = Object.freeze({ type: "unattributed" });

export function installTreasury(t: Treasury): void {
  state().treasury = t;
}

export function getInstalledTreasury(): Treasury | undefined {
  return state().treasury;
}

/**
 * Resolve the gate for one outflow: the explicit one, else the installed one.
 * With neither, throws TreasuryNotInstalledError so nothing is sent or signed.
 */
export function requireTreasury(explicit?: TreasuryResolver): Treasury {
  const resolved = typeof explicit === "function" ? explicit() : explicit;
  const t = resolved ?? state().treasury;
  if (!t) throw new TreasuryNotInstalledError();
  return t;
}

export function resetTreasuryForTests(): void {
  state().treasury = undefined;
}

/** Per-process boot id stamped on every ledger row. */
export function processBootId(): string {
  return state().bootId;
}

/**
 * Run fn with an outflow origin. An untrusted input source is sticky: a
 * nested origin started from an untrusted turn keeps that source, so an
 * inner wrapper can never launder an inbox-driven call into a trusted one.
 */
export function runWithTreasuryOrigin<T>(o: TreasuryOrigin, fn: () => Promise<T>): Promise<T> {
  const outer = state().origin.getStore();
  const next: TreasuryOrigin =
    outer && isInboxSource(outer.inputSource) && !isInboxSource(o.inputSource)
      ? { ...o, inputSource: outer.inputSource }
      : { ...o };
  return state().origin.run(next, fn);
}

/** Origin of the current async context; { type: "unattributed" } outside any wrapper. */
export function currentTreasuryOrigin(): TreasuryOrigin {
  return state().origin.getStore() ?? UNATTRIBUTED;
}
