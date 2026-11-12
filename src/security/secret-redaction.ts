/**
 * Secret redaction.
 *
 * Two layers:
 * - redactSecrets: replaces values the runtime knows are secret (wallet key,
 *   API keys) plus their common re-encodings. Applied wherever text leaves
 *   the process for an inference provider or a log sink.
 * - redactKeyMaterial: shape-based, for untrusted text headed to the prompt
 *   (skills). Not applied to tool results, so transaction hashes survive.
 *
 * Secrets are registered where they are loaded, never by reading files here.
 */

const MIN_SECRET_LENGTH = 16;
const MIN_FRAGMENT_LENGTH = 16;

/** Env vars the runtime itself copies credentials into. */
const RUNTIME_KEY_ENV_VARS = [
  "CONWAY_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "TOGETHER_API_KEY",
  "LOCAL_API_KEY",
];

/** Key variables of custom providers (provider-registry customProviderKeyEnvVar). */
const CUSTOM_PROVIDER_KEY_ENV = /^AUTOMATON_PROVIDER_[A-Z0-9_]+_API_KEY$/;

const registered = new Map<string, string>();
let cache: { key: string; re: RegExp | null; labels: Map<string, string> } | null = null;

export function registerSecret(value: string | null | undefined, label: string): void {
  if (typeof value !== "string") return;
  const v = value.trim();
  if (v.length < MIN_SECRET_LENGTH) return;
  if (registered.get(v) === label) return;
  registered.set(v, label);
  cache = null;
}

/** Test helper: forget every registered secret. */
export function clearRegisteredSecrets(): void {
  registered.clear();
  cache = null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LINE_BREAK = /\r?\n/g;

/**
 * Pattern for `value` that also matches it wrapped across lines: the base64
 * CLI wraps at 76 columns and openssl at 64, so a long fragment always
 * contains a line break.
 */
function wrappedPattern(value: string): string {
  return [...value].map(escapeRegExp).join("(?:\\r?\\n)?");
}

/**
 * Base64 fragments of `value` that appear whatever its byte offset inside a
 * larger encoded file (e.g. `base64 wallet.json`). The first and last groups
 * depend on neighbouring bytes, so only the stable middle is kept.
 */
function base64Fragments(value: string): string[] {
  const bytes = Buffer.from(value, "utf-8");
  const out: string[] = [];
  for (let shift = 0; shift < 3; shift++) {
    const padded = Buffer.concat([Buffer.alloc(shift), bytes]);
    const fullGroups = Math.floor(padded.length / 3);
    const b64 = padded.subarray(0, fullGroups * 3).toString("base64");
    const frag = shift === 0 ? b64 : b64.slice(4);
    if (frag.length >= MIN_FRAGMENT_LENGTH) out.push(frag);
  }
  return out;
}

function variantsOf(value: string): string[] {
  const variants = new Set<string>([value]);
  const hex = /^0x([0-9a-fA-F]+)$/.exec(value);
  if (hex && hex[1].length >= MIN_SECRET_LENGTH) variants.add(hex[1]);
  for (const frag of base64Fragments(value)) variants.add(frag);
  return [...variants];
}

function currentSecrets(): Map<string, string> {
  const all = new Map(registered);
  const names = [
    ...RUNTIME_KEY_ENV_VARS,
    ...Object.keys(process.env).filter((n) => CUSTOM_PROVIDER_KEY_ENV.test(n)),
  ];
  for (const name of names) {
    const v = process.env[name]?.trim();
    if (v && v.length >= MIN_SECRET_LENGTH && !all.has(v)) all.set(v, "api-key");
  }
  return all;
}

function getMatcher(): { re: RegExp | null; labels: Map<string, string> } {
  const secrets = currentSecrets();
  const key = [...secrets.entries()].map(([v, l]) => `${l}\u0000${v}`).join("\u0001");
  if (cache && cache.key === key) return cache;
  const labels = new Map<string, string>();
  for (const [value, label] of secrets) {
    for (const variant of variantsOf(value)) {
      const lower = variant.toLowerCase();
      if (!labels.has(lower)) labels.set(lower, label);
    }
  }
  const alternatives = [...labels.keys()].sort((a, b) => b.length - a.length).map(wrappedPattern);
  const re = alternatives.length > 0 ? new RegExp(alternatives.join("|"), "gi") : null;
  cache = { key, re, labels };
  return cache;
}

/** Replace known secret values (and hex/base64 re-encodings) with a label. */
export function redactSecrets(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  const { re, labels } = getMatcher();
  if (!re) return text;
  return text.replace(
    re,
    (m) => `[REDACTED:${labels.get(m.replace(LINE_BREAK, "").toLowerCase()) ?? "secret"}]`,
  );
}

const BYTE = "(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)";
const KEY_SHAPES: { re: RegExp; label: string }[] = [
  {
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    label: "pem-private-key",
  },
  // Solana id.json: a JSON array of exactly 64 bytes.
  { re: new RegExp(`\\[\\s*(?:${BYTE}\\s*,\\s*){63}${BYTE}\\s*\\]`, "g"), label: "byte-array-key" },
  { re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, label: "anthropic-key" },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/g, label: "openai-key" },
  { re: /\bcnwy_k_[A-Za-z0-9_-]{8,}/g, label: "conway-key" },
  { re: /\b(?:0x)?[0-9a-fA-F]{64}\b/g, label: "hex-key" },
  // bs58 Ed25519 secret keys are 87-88 chars; 80-90 leaves margin.
  { re: /\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g, label: "base58-key" },
];

/**
 * Shape-based redaction of anything that looks like key material.
 * `keepHex64` leaves bare 64-hex strings alone (log lines carry transaction
 * hashes, which have the same shape as an EVM private key).
 */
export function redactKeyMaterial(text: string, opts: { keepHex64?: boolean } = {}): string {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const { re, label } of KEY_SHAPES) {
    if (opts.keepHex64 && label === "hex-key") continue;
    out = out.replace(re, `[REDACTED:${label}]`);
  }
  return out;
}

const MAX_DEPTH = 8;

/** Deep copy of a JSON-like value with redactSecrets applied to every string. */
export function redactSecretsDeep<T>(value: T): T {
  return redactDeep(value, 0) as T;
}

function redactDeep(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const proto = Object.getPrototypeOf(value);
  // Only plain objects are rebuilt; Dates, Errors, Buffers keep their identity.
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactDeep(v, depth + 1);
  }
  return out;
}

/**
 * Apply redactSecrets to every string inside message content (plain strings,
 * content-part arrays) and tool_call arguments. Returns new objects.
 */
export function redactChatMessages<T extends { content?: unknown; tool_calls?: unknown }>(messages: T[]): T[] {
  if (!Array.isArray(messages)) return messages;
  const { re } = getMatcher();
  if (!re) return messages;
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const copy = { ...msg } as T;
    if (msg.content !== undefined) (copy as any).content = redactDeep(msg.content, 0);
    if (msg.tool_calls !== undefined) (copy as any).tool_calls = redactDeep(msg.tool_calls, 0);
    return copy;
  });
}
