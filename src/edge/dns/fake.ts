/**
 * In-memory DnsProvider for tests: records, a call log, injectable failures.
 */

import {
  DnsProviderError,
  type DnsCallOptions,
  type DnsProvider,
  type DnsVerifyResult,
  type NewZoneRecord,
  type ZoneRecord,
} from "../types.js";

export interface FakeDnsCall {
  method: "verify" | "list" | "create" | "delete";
  arg?: unknown;
}

interface ScriptedFailure {
  status?: number;
  message: string;
  sent: boolean;
  retryAfterMs?: number;
  /** For create: apply the change, then fail (a lost answer). */
  applied?: boolean;
  only?: FakeDnsCall["method"];
}

export class FakeDnsProvider implements DnsProvider {
  readonly id = "fake" as const;
  readonly zone: string;
  readonly minTtl: number;
  readonly calls: FakeDnsCall[] = [];
  readonly records = new Map<string, ZoneRecord>();
  verifyResult: DnsVerifyResult = { ok: true, broadToken: false };
  private failures: ScriptedFailure[] = [];
  private nextId = 1;
  /** Called inside create before it resolves (to interleave concurrent calls in tests). */
  createDelayMs = 0;

  constructor(zone: string, opts: { minTtl?: number } = {}) {
    this.zone = zone;
    this.minTtl = opts.minTtl ?? 60;
  }

  /** A record the owner made outside the agent. */
  seed(r: Omit<ZoneRecord, "id"> & { id?: string }): ZoneRecord {
    const rec = { ...r, id: r.id ?? `owner-${this.nextId++}` };
    this.records.set(rec.id, rec);
    return rec;
  }

  /** The next call (or next call of `only`) fails. */
  failNext(status: number | undefined, message: string, opts: { sent?: boolean; applied?: boolean; only?: FakeDnsCall["method"]; retryAfterMs?: number } = {}): void {
    this.failures.push({ status, message, sent: opts.sent ?? true, applied: opts.applied, only: opts.only, retryAfterMs: opts.retryAfterMs });
  }

  callCount(method?: FakeDnsCall["method"]): number {
    return method ? this.calls.filter((c) => c.method === method).length : this.calls.length;
  }

  private takeFailure(method: FakeDnsCall["method"]): ScriptedFailure | undefined {
    const i = this.failures.findIndex((f) => !f.only || f.only === method);
    return i >= 0 ? this.failures.splice(i, 1)[0] : undefined;
  }

  private error(f: ScriptedFailure): DnsProviderError {
    return new DnsProviderError({ message: f.message, status: f.status, sent: f.sent, retryAfterMs: f.retryAfterMs });
  }

  async verify(_o?: DnsCallOptions): Promise<DnsVerifyResult> {
    this.calls.push({ method: "verify" });
    const f = this.takeFailure("verify");
    if (f) throw this.error(f);
    return this.verifyResult;
  }

  async list(_o?: DnsCallOptions): Promise<ZoneRecord[]> {
    this.calls.push({ method: "list" });
    const f = this.takeFailure("list");
    if (f) throw this.error(f);
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  async create(r: NewZoneRecord, _o?: DnsCallOptions): Promise<ZoneRecord> {
    this.calls.push({ method: "create", arg: { ...r } });
    if (this.createDelayMs > 0) await new Promise((res) => setTimeout(res, this.createDelayMs));
    const f = this.takeFailure("create");
    const apply = () => {
      const rec: ZoneRecord = { id: `rec-${this.nextId++}`, type: r.type, name: r.name, content: r.content, ttl: Math.max(r.ttl, this.minTtl) };
      this.records.set(rec.id, rec);
      return rec;
    };
    if (f) {
      if (f.applied) apply();
      throw this.error(f);
    }
    return { ...apply() };
  }

  async delete(id: string, _o?: DnsCallOptions): Promise<void> {
    this.calls.push({ method: "delete", arg: id });
    const f = this.takeFailure("delete");
    if (f) {
      if (f.applied) this.records.delete(id);
      throw this.error(f);
    }
    if (!this.records.delete(id)) throw new DnsProviderError({ message: "record not found", status: 404, sent: true });
  }
}
