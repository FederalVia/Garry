/**
 * `publicAccess.dns`: parse and validate the owner's DNS section.
 *
 * Credentials come from the section or from the environment. Either way they
 * are registered for redaction here, at load, and kept only behind the
 * resolved config's credentials() function; the raw config object is never
 * changed, so saving the config cannot write an env-sourced token to disk.
 */

import { registerSecret } from "../../security/secret-redaction.js";
import { isAllowedApiUrl } from "../http.js";
import {
  AGENT_DNS_TYPES,
  EdgeConfigError,
  type DnsCredentials,
  type DnsRecordType,
  type ResolvedDnsConfig,
} from "../types.js";
import { isAtOrUnder, MAX_TTL, MIN_TTL_FLOOR, normalizeName, normalizeZone } from "./policy.js";
import { CLOUDFLARE_MIN_TTL } from "./cloudflare.js";
import { PORKBUN_MIN_TTL } from "./porkbun.js";

/** Environment variables that may carry DNS credentials. Their values are secrets. */
export const DNS_ENV_NAMES = Object.freeze([
  "AUTOMATON_DNS_API_TOKEN",
  "AUTOMATON_DNS_API_KEY",
  "AUTOMATON_DNS_SECRET_API_KEY",
] as const);

export const DNS_DEFAULT_API_URLS = Object.freeze({
  cloudflare: "https://api.cloudflare.com/client/v4",
  porkbun: "https://api.porkbun.com/api/json/v3",
});

export const DNS_DEFAULTS = Object.freeze({
  maxRecords: 25,
  maxChangesPerHour: 20,
  maxChangesPerDay: 100,
  defaultTtl: 300,
});

/** The TTL a record gets when the agent gives none: the owner's default, raised to the provider's minimum. */
export function effectiveDefaultTtl(cfg: Pick<ResolvedDnsConfig, "provider" | "defaultTtl">): number {
  const providerMin = cfg.provider === "porkbun" ? PORKBUN_MIN_TTL : CLOUDFLARE_MIN_TTL;
  return Math.min(Math.max(cfg.defaultTtl, providerMin, MIN_TTL_FLOOR), MAX_TTL);
}

/** Types that redirect mail, delegate the zone or limit certificates: never the agent's. */
const REFUSED_TYPES = new Set(["NS", "SOA", "DS", "DNSKEY", "MX", "CAA", "SRV"]);

const KNOWN_KEYS = new Set([
  "provider",
  "zone",
  "zoneId",
  "apiToken",
  "apiKey",
  "secretApiKey",
  "apiUrl",
  "allowedTypes",
  "allowedSubtree",
  "allowApex",
  "manageExisting",
  "extraProtectedNames",
  "maxRecords",
  "maxChangesPerHour",
  "maxChangesPerDay",
  "defaultTtl",
  "allowPrivateAddresses",
  "allowBroadToken",
]);

const SECRET_LABEL = "edge-dns";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optBool(o: Record<string, unknown>, key: string, path: string, def: boolean): boolean {
  const v = o[key];
  if (v === undefined) return def;
  if (typeof v !== "boolean") throw new EdgeConfigError(`${path}.${key}`, "must be true or false");
  return v;
}

function optInt(o: Record<string, unknown>, key: string, path: string, def: number, min: number, max: number): number {
  const v = o[key];
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new EdgeConfigError(`${path}.${key}`, `must be a whole number from ${min} to ${max}`);
  }
  return v;
}

function optString(o: Record<string, unknown>, key: string, path: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.trim() === "") throw new EdgeConfigError(`${path}.${key}`, "must be a non-empty string");
  return v.trim();
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** An API base URL: https, or http on loopback (local fakes). */
export function parseApiUrl(o: Record<string, unknown>, path: string, def: string): string {
  const v = optString(o, "apiUrl", path);
  if (v === undefined) return def;
  if (!isAllowedApiUrl(v)) throw new EdgeConfigError(`${path}.apiUrl`, "must be an https URL (http only on loopback)");
  return v.replace(/\/+$/, "");
}

/** Reject keys nobody reads, so a misspelt limit is not silently the default. */
export function rejectUnknownKeys(o: Record<string, unknown>, known: ReadonlySet<string>, path: string): void {
  for (const k of Object.keys(o)) {
    if (!known.has(k)) throw new EdgeConfigError(`${path}.${k}`, "unknown setting");
  }
}

/**
 * The resolved DNS config, or null when the section is absent.
 * Throws EdgeConfigError on any shape problem.
 */
export function parseDnsSection(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
  path = "publicAccess.dns",
): ResolvedDnsConfig | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) throw new EdgeConfigError(path, "must be an object");
  rejectUnknownKeys(raw, KNOWN_KEYS, path);

  const provider = raw.provider;
  if (provider !== "cloudflare" && provider !== "porkbun") {
    throw new EdgeConfigError(`${path}.provider`, 'must be "cloudflare" or "porkbun"');
  }

  if (typeof raw.zone !== "string") throw new EdgeConfigError(`${path}.zone`, "is required (the domain you own, e.g. example.com)");
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(raw.zone)) {
    throw new EdgeConfigError(`${path}.zone`, "must be ASCII; write an internationalised name in its xn-- form");
  }
  const zone = normalizeZone(raw.zone);
  if (zone === null) throw new EdgeConfigError(`${path}.zone`, "must be a domain name with at least two labels");

  // Secrets first, so even a config that fails later has them registered.
  const apiToken = optString(raw, "apiToken", path) ?? envValue(env, "AUTOMATON_DNS_API_TOKEN");
  const apiKey = optString(raw, "apiKey", path) ?? envValue(env, "AUTOMATON_DNS_API_KEY");
  const secretApiKey = optString(raw, "secretApiKey", path) ?? envValue(env, "AUTOMATON_DNS_SECRET_API_KEY");
  registerSecret(apiToken, SECRET_LABEL);
  registerSecret(apiKey, SECRET_LABEL);
  registerSecret(secretApiKey, SECRET_LABEL);

  let credentials: DnsCredentials;
  if (provider === "cloudflare") {
    if (!apiToken) {
      throw new EdgeConfigError(`${path}.apiToken`, "is required for Cloudflare (or set AUTOMATON_DNS_API_TOKEN)");
    }
    const zoneId = optString(raw, "zoneId", path);
    if (zoneId !== undefined && !/^[a-f0-9]{32}$/i.test(zoneId)) {
      throw new EdgeConfigError(`${path}.zoneId`, "must be a Cloudflare zone id (32 hex characters)");
    }
    credentials = { provider, apiToken, ...(zoneId ? { zoneId: zoneId.toLowerCase() } : {}) };
  } else {
    if (raw.zoneId !== undefined) throw new EdgeConfigError(`${path}.zoneId`, "applies to Cloudflare only");
    if (!apiKey || !secretApiKey) {
      throw new EdgeConfigError(
        `${path}.apiKey`,
        "apiKey and secretApiKey are required for Porkbun (or set AUTOMATON_DNS_API_KEY and AUTOMATON_DNS_SECRET_API_KEY)",
      );
    }
    credentials = { provider, apiKey, secretApiKey };
  }

  const apiUrl = parseApiUrl(raw, path, DNS_DEFAULT_API_URLS[provider]);

  let allowedTypes: DnsRecordType[] = [...AGENT_DNS_TYPES];
  if (raw.allowedTypes !== undefined) {
    if (!Array.isArray(raw.allowedTypes) || raw.allowedTypes.length === 0) {
      throw new EdgeConfigError(`${path}.allowedTypes`, "must be a non-empty list of A, AAAA, CNAME, TXT");
    }
    const seen = new Set<DnsRecordType>();
    for (const t of raw.allowedTypes) {
      const up = typeof t === "string" ? t.trim().toUpperCase() : "";
      if (REFUSED_TYPES.has(up)) throw new EdgeConfigError(`${path}.allowedTypes`, `${up} records cannot be given to the agent`);
      if (!(AGENT_DNS_TYPES as readonly string[]).includes(up)) {
        throw new EdgeConfigError(`${path}.allowedTypes`, `unknown type ${String(t)}; allowed: A, AAAA, CNAME, TXT`);
      }
      seen.add(up as DnsRecordType);
    }
    allowedTypes = AGENT_DNS_TYPES.filter((t) => seen.has(t));
  }

  const toFqdn = (value: unknown, key: string, underscores: boolean): string => {
    if (typeof value !== "string" || value.trim() === "") throw new EdgeConfigError(`${path}.${key}`, "must be a name");
    const n = normalizeName(value, { underscores });
    if (n === null) throw new EdgeConfigError(`${path}.${key}`, `"${value}" is not a valid name`);
    const fq = value.trim().endsWith(".") || isAtOrUnder(n, zone) ? n : `${n}.${zone}`;
    if (!isAtOrUnder(fq, zone)) throw new EdgeConfigError(`${path}.${key}`, `"${value}" is not under ${zone}`);
    return fq;
  };

  let allowedSubtree: string | undefined;
  if (raw.allowedSubtree !== undefined) allowedSubtree = toFqdn(raw.allowedSubtree, "allowedSubtree", false);

  let extraProtectedNames: string[] = [];
  if (raw.extraProtectedNames !== undefined) {
    if (!Array.isArray(raw.extraProtectedNames) || raw.extraProtectedNames.length > 200) {
      throw new EdgeConfigError(`${path}.extraProtectedNames`, "must be a list of at most 200 names");
    }
    extraProtectedNames = raw.extraProtectedNames.map((n) => toFqdn(n, "extraProtectedNames", true));
  }

  const maxRecords = optInt(raw, "maxRecords", path, DNS_DEFAULTS.maxRecords, 1, 500);
  const maxChangesPerHour = optInt(raw, "maxChangesPerHour", path, DNS_DEFAULTS.maxChangesPerHour, 1, 1000);
  const maxChangesPerDay = optInt(raw, "maxChangesPerDay", path, DNS_DEFAULTS.maxChangesPerDay, 1, 10_000);
  if (maxChangesPerDay < maxChangesPerHour) {
    throw new EdgeConfigError(`${path}.maxChangesPerDay`, "must be at least maxChangesPerHour");
  }
  const defaultTtl = optInt(raw, "defaultTtl", path, DNS_DEFAULTS.defaultTtl, 60, 86_400);
  const allowBroadToken = optBool(raw, "allowBroadToken", path, false);
  if (provider === "porkbun" && !allowBroadToken) {
    throw new EdgeConfigError(
      `${path}.allowBroadToken`,
      "must be true for Porkbun: its API keys reach every domain on the account, so enable API access only on this domain",
    );
  }

  const frozen = Object.freeze({ ...credentials });
  return Object.freeze({
    provider,
    zone,
    apiUrl,
    credentials: () => frozen,
    allowedTypes,
    ...(allowedSubtree ? { allowedSubtree } : {}),
    allowApex: optBool(raw, "allowApex", path, false),
    manageExisting: optBool(raw, "manageExisting", path, false),
    extraProtectedNames,
    maxRecords,
    maxChangesPerHour,
    maxChangesPerDay,
    defaultTtl,
    allowPrivateAddresses: optBool(raw, "allowPrivateAddresses", path, false),
    allowBroadToken,
  }) as ResolvedDnsConfig;
}
