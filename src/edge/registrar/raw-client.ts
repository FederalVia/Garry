/**
 * Porkbun registrar endpoints, without policy: availability checks and the
 * purchase call. Keys travel in the JSON body only.
 *
 * Error shape matters to the treasury's classifier: a 4xx answer keeps its
 * status (nothing was bought, the reservation is released); a 2xx answer
 * without SUCCESS, a 5xx or no answer carries no 4xx status (the outcome is
 * unknown and counted).
 */

import { registerSecret } from "../../security/secret-redaction.js";
import { cleanMessage, edgeFetchJson } from "../http.js";
import { RegistrarError, type EdgeHttpErrorInit } from "../types.js";

/** Whole cents from a decimal price string ("10.99" -> 1099); null for anything else. */
export function parsePriceCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export interface RawDomainCheck {
  avail: string | null;
  type: string | null;
  price: string | null;
  premium: string | null;
  renewalPrice: string | null;
}

export interface PorkbunRegistrarApiOptions {
  apiUrl: string;
  apiKey: string;
  secretApiKey: string;
  timeoutMs?: number;
}

interface PbAnswer {
  status?: string;
  message?: string;
  orderId?: number | string;
  results?: Record<string, { status?: string; message?: string } | undefined>;
  response?: {
    avail?: unknown;
    type?: unknown;
    price?: unknown;
    premium?: unknown;
    additional?: { renewal?: { price?: unknown } };
  };
}

const asText = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
/** Porkbun's wording for exhausted availability checks. */
const RATE_LIMIT_TEXT = /limit|checks within/i;
const makeError = (init: EdgeHttpErrorInit) => new RegistrarError(init);

export class PorkbunRegistrarApi {
  private readonly base: string;
  private readonly keys: { apikey: string; secretapikey: string };
  private readonly timeoutMs?: number;

  constructor(o: PorkbunRegistrarApiOptions) {
    this.base = o.apiUrl.replace(/\/+$/, "");
    this.keys = { apikey: o.apiKey, secretapikey: o.secretApiKey };
    this.timeoutMs = o.timeoutMs;
    registerSecret(o.apiKey, "edge-registrar");
    registerSecret(o.secretApiKey, "edge-registrar");
  }

  private get secrets(): string[] {
    return [this.keys.apikey, this.keys.secretapikey];
  }

  /** Not retried: Porkbun allows few availability checks per window. */
  async checkDomain(domain: string, signal?: AbortSignal): Promise<RawDomainCheck> {
    let res;
    try {
      res = await edgeFetchJson<PbAnswer>(`${this.base}/domain/checkDomain/${encodeURIComponent(domain)}`, {
        method: "POST",
        body: { ...this.keys },
        label: "Porkbun",
        makeError,
        secrets: this.secrets,
        signal,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      if (err instanceof RegistrarError && (err.status === 429 || RATE_LIMIT_TEXT.test(err.message))) {
        err.providerCode = "RATE_LIMITED";
      }
      throw err;
    }
    const a = res.body;
    if (!a || a.status !== "SUCCESS" || !a.response) {
      const message = cleanMessage(`Porkbun could not check ${domain}${a?.message ? `: ${a.message}` : ""}`, this.secrets);
      throw new RegistrarError({ message, sent: true, providerCode: RATE_LIMIT_TEXT.test(message) ? "RATE_LIMITED" : undefined });
    }
    const r = a.response;
    return {
      avail: asText(r.avail),
      type: asText(r.type),
      price: asText(r.price),
      premium: asText(r.premium),
      renewalPrice: asText(r.additional?.renewal?.price),
    };
  }

  /** Turn the domain's auto-renewal on or off. Throws unless Porkbun confirms it for this domain. */
  async setAutoRenew(domain: string, on: boolean, signal?: AbortSignal): Promise<void> {
    const res = await edgeFetchJson<PbAnswer>(`${this.base}/domain/updateAutoRenew/${encodeURIComponent(domain)}`, {
      method: "POST",
      body: { ...this.keys, status: on ? "on" : "off" },
      label: "Porkbun",
      makeError,
      secrets: this.secrets,
      signal,
      timeoutMs: this.timeoutMs,
    });
    const a = res.body;
    const one = a?.results?.[domain];
    if (!a || a.status !== "SUCCESS" || (one && one.status !== "SUCCESS")) {
      const why = one?.message ?? a?.message;
      throw new RegistrarError({
        message: cleanMessage(`Porkbun did not confirm the auto-renew change for ${domain}${why ? `: ${why}` : ""}`, this.secrets),
        sent: true,
      });
    }
  }

  /** The purchase. Never retried; `costCents` must be the price Porkbun currently charges or it refuses. */
  async createDomain(domain: string, costCents: number, signal?: AbortSignal): Promise<{ orderId: string | null }> {
    const res = await edgeFetchJson<PbAnswer>(`${this.base}/domain/create/${encodeURIComponent(domain)}`, {
      method: "POST",
      body: { ...this.keys, cost: costCents, agreeToTerms: "yes" },
      label: "Porkbun",
      makeError,
      secrets: this.secrets,
      signal,
      timeoutMs: this.timeoutMs ?? 60_000,
    });
    const a = res.body;
    if (!a || a.status !== "SUCCESS") {
      // A 2xx without SUCCESS is not a clear refusal: no status, so the
      // treasury counts it as unknown.
      throw new RegistrarError({
        message: cleanMessage(`Porkbun did not confirm the registration of ${domain}${a?.message ? `: ${a.message}` : ""}`, this.secrets),
        sent: true,
      });
    }
    const id = asText(a.orderId);
    return { orderId: id && id !== "" ? id : null };
  }
}
