/**
 * Inference errors and their classification.
 *
 * Both inference paths (the router with the legacy client, and the unified
 * client) settle each HTTP attempt and decide on retry, failover and circuit
 * breaking from the same table, so the two cannot drift apart.
 */

export type BudgetClass = "main" | "orchestration" | "survival";

export type RefusalCode =
  | "PER_CALL_CEILING"
  | "HOURLY_CAP"
  | "DAILY_CAP"
  | "SESSION_CAP"
  | "TASK_CAP"
  | "ORCHESTRATION_SHARE"
  | "SURVIVAL_ALLOWANCE"
  | "SURVIVAL_TIER"
  | "NO_MODEL"
  | "GATE_UNAVAILABLE"
  | "UNGATED_CALL";

/** The gate refused to reserve budget. Nothing was sent. */
export class InferenceRefusedError extends Error {
  readonly code: RefusalCode;
  /** When the refusal clears on its own; null when it does not (config or task cap). */
  readonly retryAfterMs: number | null;
  readonly budgetClass: BudgetClass;

  constructor(
    code: RefusalCode,
    message: string,
    opts: { retryAfterMs?: number | null; budgetClass?: BudgetClass } = {},
  ) {
    super(message);
    this.name = "InferenceRefusedError";
    this.code = code;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.budgetClass = opts.budgetClass ?? "orchestration";
  }
}

/** Every attempt of a logical call failed with errors (not refusals). */
export class InferenceCallError extends Error {
  readonly attempts: number;
  readonly lastCause: unknown;
  readonly classification?: ErrorClassification;

  constructor(
    message: string,
    opts: { attempts: number; cause?: unknown; classification?: ErrorClassification },
  ) {
    super(message);
    this.name = "InferenceCallError";
    this.attempts = opts.attempts;
    this.lastCause = opts.cause;
    this.classification = opts.classification;
  }
}

/** A non-2xx response from a provider (legacy client). */
export class InferenceHttpError extends Error {
  readonly status: number;
  readonly backend: string;
  readonly retryAfterMs?: number;
  readonly body: string;

  constructor(backend: string, status: number, body: string, retryAfterMs?: number) {
    super(`Inference error (${backend}): ${status}: ${body.slice(0, 500)}`);
    this.name = "InferenceHttpError";
    this.status = status;
    this.backend = backend;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A 2xx response that carried no usable completion (no choice, unparseable
 * body). The provider may have billed it, so it is never released.
 */
export class InferenceResponseError extends Error {
  readonly usage?: { inputTokens: number; outputTokens: number };

  constructor(message: string, usage?: { inputTokens: number; outputTokens: number }) {
    super(message);
    this.name = "InferenceResponseError";
    this.usage = usage;
  }
}

export interface ErrorClassification {
  kind: "refused" | "caller" | "auth" | "model" | "rate_limit" | "server" | "not_sent" | "ambiguous" | "aborted";
  status?: number;
  /** Parsed Retry-After. */
  retryAfterMs?: number;
  settle: "release" | "unknown" | "none";
  retrySameProvider: boolean;
  failover: boolean;
  countsForBreaker: boolean;
  /** Set for 401/403: a misconfigured key. */
  disableProviderMs?: number;
}

export const AUTH_DISABLE_MS = 30 * 60_000;

/** Connection failures that happen before any byte of the request is sent. */
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "ERR_INVALID_URL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const CALLER_STATUSES = new Set([400, 409, 413, 422]);
const RETRY_STATUSES = new Set([429, 500, 503]);
/** Gateway errors and request timeouts that may come after the upstream billed. */
const GATEWAY_STATUSES = new Set([408, 502, 504]);

const MODEL_MISSING_RE = /model_not_found|model[^.\n]{0,60}(does not exist|not found|not supported|unknown)|unknown model|no such model/i;

function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let cur: any = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (typeof cur.code === "string") codes.push(cur.code);
    if (typeof cur.errno === "string") codes.push(cur.errno);
    cur = cur.cause;
  }
  return codes;
}

function errorNames(err: unknown): string[] {
  const names: string[] = [];
  let cur: any = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (typeof cur.name === "string") names.push(cur.name);
    if (cur.constructor?.name) names.push(cur.constructor.name);
    cur = cur.cause;
  }
  return names;
}

/** Retry-After in seconds or as an HTTP date; undefined when absent or invalid. */
export function parseRetryAfter(value: unknown, nowMs: number = Date.now()): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const date = Date.parse(s);
  if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  return undefined;
}

function headerValue(headers: unknown, name: string): unknown {
  if (!headers) return undefined;
  if (typeof (headers as any).get === "function") return (headers as any).get(name);
  if (typeof headers === "object") {
    const rec = headers as Record<string, unknown>;
    return rec[name] ?? rec[name.toLowerCase()];
  }
  return undefined;
}

function retryAfterOf(err: any): number | undefined {
  if (typeof err?.retryAfterMs === "number" && Number.isFinite(err.retryAfterMs)) return err.retryAfterMs;
  const ms = headerValue(err?.headers, "retry-after-ms");
  if (ms !== undefined && ms !== null && /^\d+$/.test(String(ms))) return Number(ms);
  return parseRetryAfter(headerValue(err?.headers, "retry-after"));
}

function bodyText(err: any): string {
  const parts: string[] = [];
  if (typeof err?.body === "string") parts.push(err.body);
  if (typeof err?.code === "string") parts.push(err.code);
  if (err?.error) {
    try {
      parts.push(JSON.stringify(err.error));
    } catch {
      /* ignore */
    }
  }
  if (typeof err?.message === "string") parts.push(err.message);
  return parts.join(" ");
}

function byStatus(status: number, err: any): ErrorClassification {
  const retryAfterMs = retryAfterOf(err);
  const base = { status, retryAfterMs, settle: "release" as const };
  if ((status === 404 || status === 400) && MODEL_MISSING_RE.test(bodyText(err))) {
    return { ...base, kind: "model", retrySameProvider: false, failover: true, countsForBreaker: false };
  }
  if (status === 404) {
    return { ...base, kind: "model", retrySameProvider: false, failover: true, countsForBreaker: false };
  }
  if (CALLER_STATUSES.has(status)) {
    return { ...base, kind: "caller", retrySameProvider: false, failover: false, countsForBreaker: false };
  }
  if (status === 401 || status === 403) {
    return {
      ...base,
      kind: "auth",
      retrySameProvider: false,
      failover: true,
      countsForBreaker: false,
      disableProviderMs: AUTH_DISABLE_MS,
    };
  }
  if (status === 402) {
    // Out of credits at that backend: it did not bill, another backend may serve.
    return { ...base, kind: "auth", retrySameProvider: false, failover: true, countsForBreaker: false };
  }
  if (status === 429) {
    return { ...base, kind: "rate_limit", retrySameProvider: true, failover: true, countsForBreaker: true };
  }
  if (RETRY_STATUSES.has(status)) {
    return { ...base, kind: "server", retrySameProvider: true, failover: true, countsForBreaker: true };
  }
  if (GATEWAY_STATUSES.has(status)) {
    // A gateway (Conway, a CDN) or request timeout can answer after the
    // upstream model generated and billed: hold the attempt like a timeout.
    return { ...base, kind: "server", settle: "unknown", retrySameProvider: false, failover: true, countsForBreaker: true };
  }
  if (status >= 500) {
    return { ...base, kind: "server", retrySameProvider: false, failover: true, countsForBreaker: true };
  }
  if (status >= 400) {
    return { ...base, kind: "caller", retrySameProvider: false, failover: false, countsForBreaker: false };
  }
  // A 2xx/3xx surfaced as an error: the request reached the provider.
  return { status, kind: "server", settle: "unknown", retrySameProvider: false, failover: true, countsForBreaker: true };
}

const AMBIGUOUS: Omit<ErrorClassification, "kind"> = {
  settle: "unknown",
  retrySameProvider: false,
  failover: true,
  countsForBreaker: true,
};

/**
 * Classify a failed attempt. Anything not recognised is treated as ambiguous:
 * held at the reserved amount, since releasing it could under-record spend.
 */
export function classifyInferenceError(
  err: unknown,
  opts: { callerAborted?: boolean } = {},
): ErrorClassification {
  if (err instanceof InferenceRefusedError || (err as any)?.name === "InferenceRefusedError") {
    return { kind: "refused", settle: "none", retrySameProvider: false, failover: true, countsForBreaker: false };
  }
  if (opts.callerAborted) {
    return { kind: "aborted", settle: "unknown", retrySameProvider: false, failover: false, countsForBreaker: false };
  }
  if (err instanceof InferenceResponseError || (err as any)?.name === "InferenceResponseError") {
    return { kind: "server", status: 200, ...AMBIGUOUS };
  }

  const names = errorNames(err);
  const codes = errorCodes(err);

  // Thrown before any I/O: circuit open, insecure or invalid URL.
  if (names.includes("CircuitOpenError")) {
    return { kind: "not_sent", settle: "release", retrySameProvider: false, failover: true, countsForBreaker: false };
  }
  const message = typeof (err as any)?.message === "string" ? (err as any).message : "";
  if (/^HTTPS required|^Invalid URL/.test(message)) {
    return { kind: "not_sent", settle: "release", retrySameProvider: false, failover: true, countsForBreaker: false };
  }

  const status = (err as any)?.status;
  if (typeof status === "number" && Number.isFinite(status) && status > 0) {
    return byStatus(status, err);
  }

  if (codes.some((c) => NOT_SENT_CODES.has(c))) {
    return { kind: "not_sent", settle: "release", retrySameProvider: false, failover: true, countsForBreaker: true };
  }

  // Timeouts, aborts not caused by the caller, resets and body read failures
  // may all happen after the provider started generating.
  return { kind: "ambiguous", ...AMBIGUOUS };
}

export function isInferenceRefusal(err: unknown): err is InferenceRefusedError {
  return err instanceof InferenceRefusedError || (err as any)?.name === "InferenceRefusedError";
}
