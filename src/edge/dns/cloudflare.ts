/**
 * Cloudflare DNS adapter (API v4, token auth).
 *
 * Envelope: { success, errors: [{ code, message }], result, result_info }.
 * A token that can see more than one zone is reported as broad; the service
 * refuses it unless the owner allows that explicitly.
 */

import { registerSecret } from "../../security/secret-redaction.js";
import { cleanMessage, edgeFetchJson, type EdgeFetchOptions } from "../http.js";
import {
  DnsProviderError,
  type DnsCallOptions,
  type DnsProvider,
  type DnsVerifyResult,
  type NewZoneRecord,
  type ZoneRecord,
} from "../types.js";

export const CLOUDFLARE_MIN_TTL = 60;
const MAX_PAGES = 20;
/** Types Cloudflare can proxy; records are always created DNS-only. */
const PROXIABLE = new Set(["A", "AAAA", "CNAME"]);

export interface CloudflareProviderOptions {
  zone: string;
  apiToken: string;
  apiUrl: string;
  zoneId?: string;
  /** Records per list page (100 in production; small in tests). */
  pageSize?: number;
  timeoutMs?: number;
  backoffMs?: readonly number[];
}

interface CfEnvelope<T> {
  success?: boolean;
  errors?: { code?: number | string; message?: string }[];
  result?: T;
  result_info?: { page?: number; total_pages?: number; total_count?: number; per_page?: number };
}

interface CfZone {
  id?: string;
  name?: string;
}

interface CfRecord {
  id?: string;
  type?: string;
  name?: string;
  content?: string;
  ttl?: number;
  comment?: string | null;
}

/** Written on every record this adapter creates, and read back to tell ours from the owner's. */
const RECORD_COMMENT = "automaton";

function describeCf(body: unknown): { message?: string; providerCode?: string } | undefined {
  const errs = (body as CfEnvelope<unknown> | null)?.errors;
  if (Array.isArray(errs) && errs.length > 0) {
    const first = errs[0] ?? {};
    return {
      message: typeof first.message === "string" ? first.message : undefined,
      providerCode: first.code !== undefined ? String(first.code) : undefined,
    };
  }
  return undefined;
}

function toZoneRecord(r: CfRecord): ZoneRecord | null {
  if (typeof r?.id !== "string" || typeof r.type !== "string" || typeof r.name !== "string") return null;
  return {
    id: r.id,
    type: r.type.toUpperCase(),
    name: r.name.toLowerCase().replace(/\.$/, ""),
    content: typeof r.content === "string" ? r.content : "",
    ttl: typeof r.ttl === "number" ? r.ttl : 0,
    ours: r.comment === RECORD_COMMENT,
  };
}

export class CloudflareDnsProvider implements DnsProvider {
  readonly id = "cloudflare" as const;
  readonly zone: string;
  readonly minTtl = CLOUDFLARE_MIN_TTL;
  private readonly token: string;
  private readonly base: string;
  private readonly configuredZoneId?: string;
  private readonly pageSize: number;
  private readonly timeoutMs?: number;
  private readonly backoffMs?: readonly number[];
  private zoneId: string | null = null;

  constructor(o: CloudflareProviderOptions) {
    this.zone = o.zone;
    this.token = o.apiToken;
    this.base = o.apiUrl.replace(/\/+$/, "");
    this.configuredZoneId = o.zoneId;
    this.pageSize = o.pageSize ?? 100;
    this.timeoutMs = o.timeoutMs;
    this.backoffMs = o.backoffMs;
    registerSecret(o.apiToken, "edge-dns");
  }

  private async call<T>(path: string, init: Omit<EdgeFetchOptions, "headers" | "label" | "describeError" | "secrets">): Promise<CfEnvelope<T>> {
    const res = await edgeFetchJson<CfEnvelope<T>>(`${this.base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}` },
      label: "Cloudflare",
      describeError: describeCf,
      secrets: [this.token],
      timeoutMs: this.timeoutMs,
      backoffMs: this.backoffMs,
    });
    const env = res.body;
    if (!env || typeof env !== "object" || env.success !== true) {
      const d = describeCf(env);
      throw new DnsProviderError({
        message: cleanMessage(
          `Cloudflare refused the request${d?.providerCode ? ` (code ${d.providerCode})` : ""}${d?.message ? `: ${d.message}` : ""}`,
          [this.token],
        ),
        status: res.status,
        providerCode: d?.providerCode,
        sent: true,
      });
    }
    return env;
  }

  async verify(o: DnsCallOptions = {}): Promise<DnsVerifyResult> {
    try {
      if (this.configuredZoneId) {
        const env = await this.call<CfZone>(`/zones/${encodeURIComponent(this.configuredZoneId)}`, { idempotent: true, signal: o.signal });
        if (String(env.result?.name ?? "").toLowerCase() !== this.zone) {
          return { ok: false, reason: `the configured zoneId does not belong to ${this.zone}` };
        }
        this.zoneId = this.configuredZoneId;
      } else {
        const env = await this.call<CfZone[]>(`/zones?name=${encodeURIComponent(this.zone)}&per_page=5`, { idempotent: true, signal: o.signal });
        const zones = (Array.isArray(env.result) ? env.result : []).filter((z) => String(z?.name ?? "").toLowerCase() === this.zone);
        if (zones.length !== 1 || typeof zones[0].id !== "string") {
          return { ok: false, reason: `the token cannot see the zone ${this.zone}` };
        }
        this.zoneId = zones[0].id;
      }
      const all = await this.call<CfZone[]>("/zones?per_page=1", { idempotent: true, signal: o.signal });
      const total = Number(all.result_info?.total_count ?? (Array.isArray(all.result) ? all.result.length : 0));
      return { ok: true, broadToken: total > 1 };
    } catch (err) {
      if (err instanceof DnsProviderError) {
        if (err.status === 401 || err.status === 403) return { ok: false, reason: `Cloudflare rejected the token (${err.message})` };
        return { ok: false, reason: err.message };
      }
      throw err;
    }
  }

  private async requireZoneId(o: DnsCallOptions): Promise<string> {
    if (this.zoneId) return this.zoneId;
    if (this.configuredZoneId) return (this.zoneId = this.configuredZoneId);
    const v = await this.verify(o);
    if (!v.ok || !this.zoneId) throw new DnsProviderError({ message: v.ok ? "zone not found" : v.reason, sent: true });
    return this.zoneId;
  }

  async list(o: DnsCallOptions = {}): Promise<ZoneRecord[]> {
    const zoneId = await this.requireZoneId(o);
    const out: ZoneRecord[] = [];
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) {
        throw new DnsProviderError({ message: `the zone has more than ${MAX_PAGES * this.pageSize} records; refusing a partial list`, sent: true });
      }
      const env = await this.call<CfRecord[]>(
        `/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=${this.pageSize}&page=${page}`,
        { idempotent: true, signal: o.signal },
      );
      for (const r of Array.isArray(env.result) ? env.result : []) {
        const z = toZoneRecord(r);
        if (z) out.push(z);
      }
      const totalPages = Number(env.result_info?.total_pages ?? 1);
      if (!Number.isFinite(totalPages) || page >= totalPages) break;
    }
    return out;
  }

  async create(r: NewZoneRecord, o: DnsCallOptions = {}): Promise<ZoneRecord> {
    const zoneId = await this.requireZoneId(o);
    const body: Record<string, unknown> = { type: r.type, name: r.name, content: r.content, ttl: r.ttl, comment: RECORD_COMMENT };
    if (PROXIABLE.has(r.type)) body.proxied = false;
    const env = await this.call<CfRecord>(`/zones/${encodeURIComponent(zoneId)}/dns_records`, { method: "POST", body, signal: o.signal });
    const rec = env.result ? toZoneRecord(env.result) : null;
    if (!rec) throw new DnsProviderError({ message: "Cloudflare answered without the new record", status: 200, sent: true });
    return rec;
  }

  async delete(id: string, o: DnsCallOptions = {}): Promise<void> {
    const zoneId = await this.requireZoneId(o);
    await this.call<unknown>(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`, { method: "DELETE", signal: o.signal });
  }
}

export function createCloudflareProvider(o: CloudflareProviderOptions): CloudflareDnsProvider {
  return new CloudflareDnsProvider(o);
}
