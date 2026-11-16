/**
 * `publicAccess.registrar`: optional automated domain registration.
 *
 * Off unless `enabled: true`. A present but disabled section is off and
 * says nothing; its keys are still registered for redaction.
 */

import { registerSecret } from "../../security/secret-redaction.js";
import { parseApiUrl, rejectUnknownKeys } from "../dns/config.js";
import { EdgeConfigError, type ResolvedRegistrarConfig } from "../types.js";

/** Environment variables that may carry registrar keys. Their values are secrets. */
export const REGISTRAR_ENV_NAMES = Object.freeze([
  "AUTOMATON_REGISTRAR_API_KEY",
  "AUTOMATON_REGISTRAR_SECRET_API_KEY",
] as const);

export const REGISTRAR_DEFAULT_API_URL = "https://api.porkbun.com/api/json/v3";
export const REGISTRAR_DEFAULTS = Object.freeze({
  allowedTlds: Object.freeze(["com", "net", "org", "dev"]),
  maxPriceCents: 2000,
});

const KNOWN_KEYS = new Set(["provider", "enabled", "apiKey", "secretApiKey", "apiUrl", "allowedTlds", "maxPriceCents"]);
const TLD = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SECRET_LABEL = "edge-registrar";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, key: string, path: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.trim() === "") throw new EdgeConfigError(`${path}.${key}`, "must be a non-empty string");
  return v.trim();
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * The resolved registrar config, or null when the section is absent or not
 * enabled. Throws EdgeConfigError on any shape problem.
 */
export function parseRegistrarSection(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
  path = "publicAccess.registrar",
): ResolvedRegistrarConfig | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) throw new EdgeConfigError(path, "must be an object");
  rejectUnknownKeys(raw, KNOWN_KEYS, path);
  if (raw.provider !== "porkbun") throw new EdgeConfigError(`${path}.provider`, 'must be "porkbun"');
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new EdgeConfigError(`${path}.enabled`, "must be true or false");
  }

  const apiKey = str(raw, "apiKey", path) ?? envValue(env, "AUTOMATON_REGISTRAR_API_KEY");
  const secretApiKey = str(raw, "secretApiKey", path) ?? envValue(env, "AUTOMATON_REGISTRAR_SECRET_API_KEY");
  registerSecret(apiKey, SECRET_LABEL);
  registerSecret(secretApiKey, SECRET_LABEL);

  let allowedTlds: string[] = [...REGISTRAR_DEFAULTS.allowedTlds];
  if (raw.allowedTlds !== undefined) {
    if (!Array.isArray(raw.allowedTlds) || raw.allowedTlds.length === 0 || raw.allowedTlds.length > 50) {
      throw new EdgeConfigError(`${path}.allowedTlds`, "must be a list of 1 to 50 top-level domains");
    }
    allowedTlds = [];
    for (const t of raw.allowedTlds) {
      const v = typeof t === "string" ? t.trim().toLowerCase().replace(/^\./, "") : "";
      if (!TLD.test(v)) throw new EdgeConfigError(`${path}.allowedTlds`, `"${String(t)}" is not a top-level domain`);
      if (!allowedTlds.includes(v)) allowedTlds.push(v);
    }
  }

  let maxPriceCents: number = REGISTRAR_DEFAULTS.maxPriceCents;
  if (raw.maxPriceCents !== undefined) {
    const v = raw.maxPriceCents;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 100_000) {
      throw new EdgeConfigError(`${path}.maxPriceCents`, "must be a whole number of cents from 1 to 100000");
    }
    maxPriceCents = v;
  }

  const apiUrl = parseApiUrl(raw, path, REGISTRAR_DEFAULT_API_URL);

  if (raw.enabled !== true) return null;
  if (!apiKey || !secretApiKey) {
    throw new EdgeConfigError(
      `${path}.apiKey`,
      "apiKey and secretApiKey are required when enabled (or set AUTOMATON_REGISTRAR_API_KEY and AUTOMATON_REGISTRAR_SECRET_API_KEY)",
    );
  }
  const creds = Object.freeze({ apiKey, secretApiKey });
  return Object.freeze({
    provider: "porkbun" as const,
    apiUrl,
    credentials: () => creds,
    allowedTlds,
    maxPriceCents,
    years: 1 as const,
  });
}
