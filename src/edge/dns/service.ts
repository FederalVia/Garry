/**
 * DnsService: the zone policy plus ownership, rate caps and a change log
 * around one DnsProvider.
 *
 * Every refusal the policy can decide (zone, name, protected names, type,
 * content, TTL, rate, ownership in the database) is made before any network
 * call. Writes to a zone are serialised in-process (the instance lock means
 * one process), so concurrent adds cannot exceed maxRecords, and they run
 * shielded from task timeouts: a timeout must not turn a sent write into an
 * unknown one.
 */

import type Database from "better-sqlite3";
import {
  currentCancellationSignal,
  isAbortError,
  raceWithSignal,
  runOutsideCancellation,
  runShieldedFromTimeout,
} from "../../runtime/cancellation.js";
import { cleanMessage } from "../http.js";
import {
  DnsPolicyError,
  DnsProviderError,
  EdgeHttpError,
  type DnsAvailability,
  type DnsProvider,
  type DnsService,
  type ManagedRecord,
  type ResolvedDnsConfig,
  type ZoneRecord,
} from "../types.js";
import {
  ADOPT_WINDOW_MS,
  countChangesSince,
  ensureDnsTables,
  getLiveOwnedRecord,
  insertChange,
  insertOwnedRecord,
  liveOwnedRecords,
  markInterruptedAsUnknown,
  markRecordDeleted,
  oldestChangeSince,
  pruneDnsChanges,
  settleChange,
  unconfirmedCreates,
} from "./changelog.js";
import { CloudflareDnsProvider } from "./cloudflare.js";
import { DnsZonePolicy, isAtOrUnder, relativeHost, sameContent } from "./policy.js";
import { PorkbunDnsProvider } from "./porkbun.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const VERIFY_TIMEOUT_MS = 10_000;
/** A failed verification is retried by the next call after this long. */
const VERIFY_RETRY_MS = 60_000;

const PROVIDER_NAMES: Record<string, string> = { cloudflare: "Cloudflare", porkbun: "Porkbun", fake: "the DNS provider" };

export interface DnsServiceDeps {
  db: Database.Database;
  provider?: DnsProvider;
  now?: () => number;
  /** FQDNs the runtime routes itself (the port gateway's suffix); the agent may not write there. */
  reservedSubtrees?: readonly string[];
  verifyTimeoutMs?: number;
}

/** The adapter the config names. */
export function createDnsProvider(cfg: ResolvedDnsConfig): DnsProvider {
  const c = cfg.credentials();
  if (c.provider === "cloudflare") {
    return new CloudflareDnsProvider({ zone: cfg.zone, apiToken: c.apiToken, zoneId: c.zoneId, apiUrl: cfg.apiUrl });
  }
  return new PorkbunDnsProvider({ zone: cfg.zone, apiKey: c.apiKey, secretApiKey: c.secretApiKey, apiUrl: cfg.apiUrl });
}

// Per-zone write chains and in-flight change ids, shared by every service
// instance in the process.
const zoneChains = new Map<string, Promise<unknown>>();
const inflightChanges = new Set<string>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = zoneChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  zoneChains.set(key, tail);
  void tail.then(() => {
    if (zoneChains.get(key) === tail) zoneChains.delete(key);
  });
  return run;
}

/** The provider certainly did not apply the change. */
function definitelyNotApplied(err: unknown): boolean {
  if (!(err instanceof EdgeHttpError)) return false;
  if (!err.sent) return true;
  return err.status !== undefined && err.status < 500 && err.status !== 408;
}

export class ZoneDnsService implements DnsService {
  readonly zone: string;
  readonly provider: string;
  private readonly cfg: ResolvedDnsConfig;
  private readonly dns: DnsProvider;
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly policy: DnsZonePolicy;
  private readonly verifyTimeoutMs: number;
  private readonly key: string;
  private state: DnsAvailability = { state: "unverified" };
  private failedAtMs = 0;
  private verifying: Promise<void> | null = null;

  constructor(cfg: ResolvedDnsConfig, deps: DnsServiceDeps) {
    this.cfg = cfg;
    this.zone = cfg.zone;
    this.dns = deps.provider ?? createDnsProvider(cfg);
    this.provider = this.dns.id;
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.policy = new DnsZonePolicy(cfg, { reservedSubtrees: deps.reservedSubtrees });
    this.verifyTimeoutMs = deps.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
    this.key = `${this.provider}\u0000${this.zone}`;
    ensureDnsTables(this.db);
    pruneDnsChanges(this.db, this.now());
    markInterruptedAsUnknown(this.db, this.provider, this.zone, inflightChanges);
  }

  private get providerName(): string {
    return PROVIDER_NAMES[this.provider] ?? this.provider;
  }

  covers(domain: string): boolean {
    return this.policy.covers(domain);
  }

  availability(): DnsAvailability {
    return { ...this.state };
  }

  // ─── Verification ───────────────────────────────────────────

  async verify(): Promise<void> {
    if (this.state.state === "ok") return;
    if (this.state.state === "unavailable" && this.now() - this.failedAtMs < VERIFY_RETRY_MS) {
      throw new DnsPolicyError("DNS_UNAVAILABLE", `DNS for ${this.zone} is unavailable: ${this.state.reason}`);
    }
    // One check shared by every caller, outside any task scope: it has its
    // own deadline, and a caller's abort only stops that caller's wait.
    this.verifying ??= runOutsideCancellation(() => this.runVerify()).finally(() => {
      this.verifying = null;
    });
    await raceWithSignal(this.verifying, currentCancellationSignal());
    const s = this.state as DnsAvailability;
    if (s.state === "unavailable") {
      throw new DnsPolicyError("DNS_UNAVAILABLE", `DNS for ${this.zone} is unavailable: ${s.reason}`);
    }
  }

  private markUnavailable(reason: string): void {
    this.state = { state: "unavailable", reason: cleanMessage(reason) };
    this.failedAtMs = this.now();
  }

  private async runVerify(): Promise<void> {
    const signal = AbortSignal.timeout(this.verifyTimeoutMs);
    try {
      const r = await this.dns.verify({ signal });
      if (!r.ok) {
        this.markUnavailable(`the ${this.providerName} credentials were refused: ${r.reason}`);
      } else if (r.broadToken && !this.cfg.allowBroadToken) {
        this.markUnavailable(`the token can change other zones; create a token limited to ${this.zone}`);
      } else {
        this.state = { state: "ok", broadToken: r.broadToken };
      }
    } catch (err) {
      if (signal.aborted) {
        this.markUnavailable(`${this.providerName} did not answer within ${Math.round(this.verifyTimeoutMs / 1000)} s`);
      } else {
        this.markUnavailable(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // ─── Shared steps ──────────────────────────────────────────

  /** Step 6: change caps from the log, so they survive restarts. */
  private checkRate(): void {
    const now = this.now();
    const limits: [number, number, string][] = [
      [HOUR_MS, this.cfg.maxChangesPerHour, "hour"],
      [DAY_MS, this.cfg.maxChangesPerDay, "day"],
    ];
    for (const [window, max, label] of limits) {
      if (countChangesSince(this.db, this.zone, now - window) >= max) {
        const oldest = oldestChangeSince(this.db, this.zone, now - window) ?? now;
        const retryAfterMs = Math.max(0, oldest + window - now);
        throw new DnsPolicyError(
          "DNS_RATE_LIMITED",
          `at most ${max} DNS changes per ${label} for ${this.zone}; try again in ${Math.ceil(retryAfterMs / 60_000)} min`,
          retryAfterMs,
        );
      }
    }
  }

  /** Maps provider rate limits and lost credentials; messages are redacted again whatever the adapter did. */
  private providerFailure(err: unknown): unknown {
    if (isAbortError(err)) return err;
    if (err instanceof EdgeHttpError) {
      err.message = cleanMessage(err.message);
      if (err.status === 429) {
        const secs = err.retryAfterMs !== undefined ? Math.ceil(err.retryAfterMs / 1000) : undefined;
        return new DnsPolicyError(
          "DNS_RATE_LIMITED",
          `${this.providerName} is limiting requests${secs !== undefined ? `; retry in ${secs} s` : "; retry later"}`,
          err.retryAfterMs,
        );
      }
      if (err.status === 401 || err.status === 403) {
        this.markUnavailable(`${this.providerName} rejected the credentials (HTTP ${err.status})`);
      }
      return err;
    }
    return new DnsProviderError({ message: cleanMessage(err instanceof Error ? err.message : String(err)), sent: true });
  }

  private async freshList(): Promise<ZoneRecord[]> {
    try {
      return await this.dns.list();
    } catch (err) {
      throw this.providerFailure(err);
    }
  }

  /**
   * Adopt unconfirmed creates that turned out to exist, and forget owned
   * records that are gone at the provider. `listedAtMs` protects records
   * created after the list was taken.
   */
  private reconcile(records: ZoneRecord[], listedAtMs: number): void {
    const now = this.now();
    this.db
      .transaction(() => {
        const owned = new Set(liveOwnedRecords(this.db, this.provider, this.zone).map((r) => r.record_id));
        for (const c of unconfirmedCreates(this.db, this.provider, this.zone, now - ADOPT_WINDOW_MS)) {
          const match = records.find(
            (r) =>
              !owned.has(r.id) &&
              // A provider that marks our records shows an identical one the owner made since.
              r.ours !== false &&
              r.type === c.type &&
              r.name === c.name &&
              sameContent(r.type, r.content, c.content ?? ""),
          );
          if (!match) continue;
          insertOwnedRecord(this.db, {
            provider: this.provider,
            zone: this.zone,
            record_id: match.id,
            type: match.type,
            name: match.name,
            content: c.content ?? match.content,
            ttl: match.ttl,
            created_at_ms: c.at_ms,
          });
          settleChange(this.db, c.id, "ok", { recordId: match.id, error: "adopted after an unconfirmed create" });
          owned.add(match.id);
        }
        const present = new Set(records.map((r) => r.id));
        for (const row of liveOwnedRecords(this.db, this.provider, this.zone)) {
          if (!present.has(row.record_id) && row.created_at_ms < listedAtMs) {
            markRecordDeleted(this.db, this.provider, this.zone, row.record_id, now);
          }
        }
      })
      .immediate();
  }

  private ownedIds(): Set<string> {
    return new Set(liveOwnedRecords(this.db, this.provider, this.zone).map((r) => r.record_id));
  }

  private toManaged(r: ZoneRecord, domain: string, managed: boolean): ManagedRecord {
    return { id: r.id, type: r.type, name: r.name, host: relativeHost(r.name, domain), value: r.content, ttl: r.ttl, managed };
  }

  // ─── Operations ────────────────────────────────────────────

  async list(domain: string): Promise<ManagedRecord[]> {
    const d = this.policy.checkDomain(domain);
    await this.verify();
    return serialize(this.key, async () => {
      const listedAt = this.now();
      const records = await this.freshList();
      this.reconcile(records, listedAt);
      const owned = this.ownedIds();
      // With a subtree the agent sees only that part of the zone (and its
      // own records): other owner records can reveal origin addresses.
      const subtree = this.cfg.allowedSubtree;
      return records
        .filter((r) => isAtOrUnder(r.name, d))
        .filter((r) => !subtree || isAtOrUnder(r.name, subtree) || owned.has(r.id))
        .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type))
        .map((r) => this.toManaged(r, d, owned.has(r.id)));
    });
  }

  async add(domain: string, input: { type: string; host: string; value: string; ttl?: number }): Promise<ManagedRecord> {
    const checked = this.policy.checkAdd(domain, input ?? ({} as never), this.dns.minTtl);
    this.checkRate();
    await this.verify();
    return serialize(this.key, async () => {
      this.checkRate();
      const listedAt = this.now();
      const records = await this.freshList();
      this.reconcile(records, listedAt);
      const owned = this.ownedIds();
      const atName = records.filter((r) => r.name === checked.name);
      const same = atName.find((r) => owned.has(r.id) && r.type === checked.type && sameContent(r.type, r.content, checked.content));
      if (same) return this.toManaged(same, checked.domain, true);
      if (!this.cfg.manageExisting && atName.some((r) => !owned.has(r.id))) {
        throw new DnsPolicyError(
          "DNS_NAME_HELD_BY_OWNER",
          `${checked.name} already holds records you did not create; pick another name`,
        );
      }
      // A name with no records is answered by the owner's wildcard above it,
      // if there is one: an explicit record would take the name from them.
      // A wildcard above allowedSubtree does not count: the owner gave the
      // subtree to the agent.
      const wildcard = atName.length === 0 ? coveringWildcard(checked.name, this.zone, records, owned) : null;
      const subtree = this.cfg.allowedSubtree;
      if (!this.cfg.manageExisting && wildcard && (!subtree || isAtOrUnder(wildcard.slice(2), subtree))) {
        throw new DnsPolicyError(
          "DNS_NAME_HELD_BY_OWNER",
          `${checked.name} is served by the wildcard record ${wildcard}, which you did not create; a record there would replace it. ` +
            "Pick a name the wildcard does not cover",
        );
      }
      // An underscore name speaks for its parent (_acme-challenge can get a
      // certificate for it), so a parent holding the owner's records is theirs too.
      const parent = underscoreParent(checked.name);
      if (!this.cfg.manageExisting && parent && records.some((r) => r.name === parent && !owned.has(r.id))) {
        throw new DnsPolicyError(
          "DNS_NAME_HELD_BY_OWNER",
          `${checked.name} attaches to ${parent}, which holds records you did not create; pick another name`,
        );
      }
      if (owned.size >= this.cfg.maxRecords) {
        throw new DnsPolicyError(
          "DNS_RECORD_LIMIT",
          `you already have ${owned.size} records in ${this.zone} (limit ${this.cfg.maxRecords}); delete one first`,
        );
      }
      const changeId = insertChange(this.db, {
        at_ms: this.now(),
        provider: this.provider,
        zone: this.zone,
        action: "create",
        record_id: null,
        type: checked.type,
        name: checked.name,
        content: checked.content,
        ttl: checked.ttl,
      });
      inflightChanges.add(changeId);
      try {
        const rec = await runShieldedFromTimeout(() =>
          this.dns.create({ type: checked.type, name: checked.name, content: checked.content, ttl: checked.ttl }),
        );
        const stored: ZoneRecord = { ...rec, name: checked.name, type: checked.type };
        this.db
          .transaction(() => {
            settleChange(this.db, changeId, "ok", { recordId: rec.id });
            insertOwnedRecord(this.db, {
              provider: this.provider,
              zone: this.zone,
              record_id: rec.id,
              type: checked.type,
              name: checked.name,
              content: checked.content,
              ttl: rec.ttl || checked.ttl,
              created_at_ms: this.now(),
            });
          })
          .immediate();
        return this.toManaged(stored, checked.domain, true);
      } catch (err) {
        throw this.settleFailedWrite(changeId, err, "create");
      } finally {
        inflightChanges.delete(changeId);
      }
    });
  }

  async remove(domain: string, recordId: string): Promise<void> {
    const d = this.policy.checkDomain(domain);
    this.checkRate();
    const notOwned = () =>
      new DnsPolicyError("DNS_NOT_OWNED", `record ${String(recordId)} under ${d} was not created by you; only your own records can be deleted`);
    if (typeof recordId !== "string" || recordId.trim() === "") throw notOwned();
    const id = recordId.trim();
    const row = getLiveOwnedRecord(this.db, this.provider, this.zone, id);
    if (!row || !isAtOrUnder(row.name, d)) throw notOwned();
    await this.verify();
    return serialize(this.key, async () => {
      this.checkRate();
      const listedAt = this.now();
      const records = await this.freshList();
      const live = records.find((r) => r.id === id);
      const current = getLiveOwnedRecord(this.db, this.provider, this.zone, id);
      if (!current) throw notOwned();
      if (!live) {
        // Already gone at the provider: nothing to send.
        markRecordDeleted(this.db, this.provider, this.zone, id, this.now());
        this.reconcile(records, listedAt);
        return;
      }
      if (live.type !== current.type || live.name !== current.name) throw notOwned();
      this.reconcile(records, listedAt);
      const changeId = insertChange(this.db, {
        at_ms: this.now(),
        provider: this.provider,
        zone: this.zone,
        action: "delete",
        record_id: id,
        type: current.type,
        name: current.name,
        content: current.content,
        ttl: current.ttl,
      });
      inflightChanges.add(changeId);
      try {
        await runShieldedFromTimeout(() => this.dns.delete(id));
        this.markDeleteOk(changeId, id);
      } catch (err) {
        if (err instanceof EdgeHttpError && err.status === 404) {
          this.markDeleteOk(changeId, id, "already gone");
          return;
        }
        throw this.settleFailedWrite(changeId, err, "delete");
      } finally {
        inflightChanges.delete(changeId);
      }
    });
  }

  private markDeleteOk(changeId: string, id: string, note?: string): void {
    this.db
      .transaction(() => {
        settleChange(this.db, changeId, "ok", { error: note });
        markRecordDeleted(this.db, this.provider, this.zone, id, this.now());
      })
      .immediate();
  }

  /** Records the outcome of a write that threw and returns the error to raise. */
  private settleFailedWrite(changeId: string, err: unknown, action: "create" | "delete"): unknown {
    const text = cleanMessage(err instanceof Error ? err.message : String(err));
    if (definitelyNotApplied(err)) {
      settleChange(this.db, changeId, "failed", { error: text });
      return this.providerFailure(err);
    }
    settleChange(this.db, changeId, "unknown", { error: text });
    if (isAbortError(err)) return err;
    const what = action === "create" ? "it is adopted as yours if it appears" : "list the records to see whether it is gone";
    return new DnsProviderError({
      message: cleanMessage(`The ${action} was sent to ${this.providerName} but no reliable answer came back (${text}); ${what}`),
      status: err instanceof EdgeHttpError ? err.status : undefined,
      sent: true,
    });
  }
}

export function createDnsService(cfg: ResolvedDnsConfig, deps: DnsServiceDeps): DnsService {
  return new ZoneDnsService(cfg, deps);
}

/**
 * The wildcard record (*.parent) not created by the agent that answers for
 * `name`, a name with no records of its own. A wildcard reaches down only
 * until the closest ancestor that exists.
 */
function coveringWildcard(name: string, zone: string, records: ZoneRecord[], owned: Set<string>): string | null {
  // Records below the name make it exist; no wildcard answers for it then.
  if (records.some((r) => r.name.endsWith(`.${name}`))) return null;
  let cur = name;
  while (cur !== zone) {
    const dot = cur.indexOf(".");
    if (dot < 0) return null;
    const parent = cur.slice(dot + 1);
    const wild = `*.${parent}`;
    if (records.some((r) => r.name === wild && !owned.has(r.id))) return wild;
    if (parent === zone || records.some((r) => isAtOrUnder(r.name, parent))) return null;
    cur = parent;
  }
  return null;
}

/** The first name without a leading underscore label, for a name that has one; else null. */
function underscoreParent(name: string): string | null {
  const labels = name.split(".");
  let i = 0;
  while (i < labels.length && labels[i].startsWith("_")) i++;
  return i > 0 && i < labels.length ? labels.slice(i).join(".") : null;
}
