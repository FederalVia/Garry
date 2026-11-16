/**
 * Porkbun DNS adapter (JSON API v3).
 *
 * Every call is a POST with the keys in the JSON body (never in the URL,
 * so they stay out of proxy and access logs); answers are
 * { status: "SUCCESS" | "ERROR", message }. Porkbun keys reach every domain
 * on the account, so verify always reports a broad token.
 */

import { registerSecret } from "../../security/secret-redaction.js";
import { cleanMessage, edgeFetchJson } from "../http.js";
import {
  DnsProviderError,
  type DnsCallOptions,
  type DnsProvider,
  type DnsVerifyResult,
  type NewZoneRecord,
  type ZoneRecord,
} from "../types.js";

export const PORKBUN_MIN_TTL = 600;

export interface PorkbunDnsOptions {
  zone: string;
  apiKey: string;
  secretApiKey: string;
  apiUrl: string;
  timeoutMs?: number;
  backoffMs?: readonly number[];
}

interface PbAnswer {
  status?: string;
  message?: string;
  id?: number | string;
  records?: { id?: number | string; name?: string; type?: string; content?: string; ttl?: number | string }[];
}

function describePb(body: unknown): { message?: string } | undefined {
  const m = (body as PbAnswer | null)?.message;
  return typeof m === "string" ? { message: m } : undefined;
}

export class PorkbunDnsProvider implements DnsProvider {
  readonly id = "porkbun" as const;
  readonly zone: string;
  readonly minTtl = PORKBUN_MIN_TTL;
  private readonly keys: { apikey: string; secretapikey: string };
  private readonly base: string;
  private readonly timeoutMs?: number;
  private readonly backoffMs?: readonly number[];

  constructor(o: PorkbunDnsOptions) {
    this.zone = o.zone;
    this.keys = { apikey: o.apiKey, secretapikey: o.secretApiKey };
    this.base = o.apiUrl.replace(/\/+$/, "");
    this.timeoutMs = o.timeoutMs;
    this.backoffMs = o.backoffMs;
    registerSecret(o.apiKey, "edge-dns");
    registerSecret(o.secretApiKey, "edge-dns");
  }

  private async call(path: string, extra: Record<string, unknown>, o: DnsCallOptions & { idempotent?: boolean }): Promise<PbAnswer> {
    const secrets = [this.keys.apikey, this.keys.secretapikey];
    const res = await edgeFetchJson<PbAnswer>(`${this.base}${path}`, {
      method: "POST",
      body: { ...this.keys, ...extra },
      label: "Porkbun",
      describeError: describePb,
      secrets,
      idempotent: o.idempotent,
      signal: o.signal,
      timeoutMs: this.timeoutMs,
      backoffMs: this.backoffMs,
    });
    const a = res.body;
    if (!a || a.status !== "SUCCESS") {
      throw new DnsProviderError({
        message: cleanMessage(`Porkbun refused the request${a?.message ? `: ${a.message}` : ""}`, secrets),
        status: res.status,
        sent: true,
      });
    }
    return a;
  }

  private zonePath(): string {
    return encodeURIComponent(this.zone);
  }

  async verify(o: DnsCallOptions = {}): Promise<DnsVerifyResult> {
    try {
      await this.call("/ping", {}, { ...o, idempotent: true });
      // Fails unless API access is enabled on this domain.
      await this.call(`/dns/retrieve/${this.zonePath()}`, {}, { ...o, idempotent: true });
      return { ok: true, broadToken: true };
    } catch (err) {
      if (err instanceof DnsProviderError) return { ok: false, reason: err.message };
      throw err;
    }
  }

  async list(o: DnsCallOptions = {}): Promise<ZoneRecord[]> {
    const a = await this.call(`/dns/retrieve/${this.zonePath()}`, {}, { ...o, idempotent: true });
    const out: ZoneRecord[] = [];
    for (const r of Array.isArray(a.records) ? a.records : []) {
      if (r?.id === undefined || typeof r.type !== "string" || typeof r.name !== "string") continue;
      const ttl = Number(r.ttl);
      out.push({
        id: String(r.id),
        type: r.type.toUpperCase(),
        name: r.name.toLowerCase().replace(/\.$/, ""),
        content: typeof r.content === "string" ? r.content : "",
        ttl: Number.isFinite(ttl) ? ttl : 0,
      });
    }
    return out;
  }

  async create(r: NewZoneRecord, o: DnsCallOptions = {}): Promise<ZoneRecord> {
    // Porkbun takes the name relative to the domain, "" for the apex.
    const relative = r.name === this.zone ? "" : r.name.endsWith(`.${this.zone}`) ? r.name.slice(0, -(this.zone.length + 1)) : null;
    if (relative === null) throw new DnsProviderError({ message: `${r.name} is not under ${this.zone}`, sent: false });
    const ttl = Math.max(r.ttl, PORKBUN_MIN_TTL);
    const a = await this.call(`/dns/create/${this.zonePath()}`, { name: relative, type: r.type, content: r.content, ttl: String(ttl) }, o);
    if (a.id === undefined || a.id === null || String(a.id) === "") {
      throw new DnsProviderError({ message: "Porkbun answered without the new record id", status: 200, sent: true });
    }
    return { id: String(a.id), type: r.type, name: r.name, content: r.content, ttl };
  }

  async delete(id: string, o: DnsCallOptions = {}): Promise<void> {
    await this.call(`/dns/delete/${this.zonePath()}/${encodeURIComponent(id)}`, {}, o);
  }
}

export function createPorkbunDnsProvider(o: PorkbunDnsOptions): PorkbunDnsProvider {
  return new PorkbunDnsProvider(o);
}
