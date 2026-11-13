/**
 * Rate limits and resource bounds.
 *
 * DB-backed limits (per sender, per recipient, mailbox, total) are counted in
 * store.ts over stored, signature-checked messages only. The in-memory token
 * buckets here guard the cheap pre-auth path (per IP), stored messages per
 * IP, and polling (per authenticated address); losing them on restart only
 * hands out one fresh budget.
 */

import { isIPv4, isIPv6 } from "node:net";

export interface RelayLimits {
  /** Send body cap. Must fit the client's largest message: 64 000 UTF-16 units can be 6 bytes each once JSON-escaped. */
  maxBodyBytes: number;
  maxPollBodyBytes: number;
  ipPerMinute: number;
  /** Messages stored per client IP (IPv6 grouped by /64) per hour; sender keys cost nothing, IPs do. */
  ipStoredPerHour: number;
  senderPerMinute: number;
  senderPerHour: number;
  recipientPerHour: number;
  recipientMailbox: number;
  totalMessages: number;
  /** Retained content plus signature bytes in total; bounds disk use whatever the message count. */
  totalBytes: number;
  pollPerMinute: number;
}

export const DEFAULT_LIMITS: RelayLimits = Object.freeze({
  maxBodyBytes: 524_288,
  maxPollBodyBytes: 4_096,
  ipPerMinute: 120,
  ipStoredPerHour: 1_000,
  senderPerMinute: 20,
  senderPerHour: 100,
  recipientPerHour: 1_000,
  recipientMailbox: 5_000,
  totalMessages: 200_000,
  totalBytes: 1_000_000_000,
  pollPerMinute: 60,
});

export function resolveLimits(overrides: Partial<RelayLimits> | undefined): RelayLimits {
  const out: RelayLimits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof RelayLimits)[]) {
    const v = overrides?.[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      throw new Error(`relay limit ${key} must be a positive integer`);
    }
    out[key] = v;
  }
  return out;
}

const IDLE_PRUNE_MS = 10 * 60_000;

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * Token buckets keyed by IP or address. The map is bounded: idle keys are
 * dropped once they would be full again (at least 10 minutes) and, past maxKeys, the least recently used key is
 * evicted (an evicted key simply starts again with a full bucket).
 */
export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;
  /** Idle this long, a bucket is full again, so dropping it changes nothing. */
  private readonly idleMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly now: () => number,
    private readonly maxKeys = 10_000,
  ) {
    this.idleMs = Math.max(IDLE_PRUNE_MS, Math.ceil(capacity / refillPerMs));
  }

  /** Takes one token. Returns 0 when allowed, else the seconds until one is available. */
  take(key: string): number {
    const now = this.now();
    this.sweep(now);
    const existing = this.buckets.get(key);
    let bucket: Bucket;
    if (existing) {
      const elapsed = Math.max(0, now - existing.at);
      bucket = { tokens: Math.min(this.capacity, existing.tokens + elapsed * this.refillPerMs), at: now };
      this.buckets.delete(key); // re-insert below keeps the map in LRU order
    } else {
      bucket = { tokens: this.capacity, at: now };
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
    }
    let wait = 0;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
    } else {
      wait = Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerMs / 1000));
    }
    this.buckets.set(key, bucket);
    return wait;
  }

  get size(): number {
    return this.buckets.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, b] of this.buckets) {
      if (now - b.at > this.idleMs) this.buckets.delete(key);
    }
  }
}

/** Per-IP pre-auth bucket: a quarter of the minute's budget as burst (120/min gives 30, refilled at 2/s). */
export function ipBuckets(limits: RelayLimits, now: () => number): TokenBuckets {
  return new TokenBuckets(Math.max(1, Math.ceil(limits.ipPerMinute / 4)), limits.ipPerMinute / 60_000, now);
}

/** Per-IP stored-message bucket: the full hour's budget, refilled evenly. Taken only for a message about to be stored. */
export function ipStoreBuckets(limits: RelayLimits, now: () => number): TokenBuckets {
  return new TokenBuckets(limits.ipStoredPerHour, limits.ipStoredPerHour / 3_600_000, now);
}

/**
 * Rate-limit key for a client IP. IPv6 is grouped by /64, the block one host
 * usually gets, so rotating addresses inside it gains nothing. IPv4-mapped
 * IPv6 counts as the IPv4 address.
 */
export function ipKey(ip: string): string {
  let v = ip.trim().toLowerCase();
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
  const zone = v.indexOf("%");
  if (zone >= 0) v = v.slice(0, zone);
  if (isIPv4(v)) return v;
  if (!isIPv6(v)) return v;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped) return mapped[1]!;
  // A trailing dotted IPv4 part counts as two groups.
  const parts = v.split("::");
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(":") : [];
  const expand = (groups: string[]) =>
    groups.flatMap((g) => {
      if (!g.includes(".")) return [g];
      const o = g.split(".").map(Number);
      return [((o[0]! << 8) | o[1]!).toString(16), ((o[2]! << 8) | o[3]!).toString(16)];
    });
  const h = expand(head);
  const t = expand(tail);
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** Per-address poll bucket: the full minute's budget, refilled evenly. */
export function pollBuckets(limits: RelayLimits, now: () => number): TokenBuckets {
  return new TokenBuckets(limits.pollPerMinute, limits.pollPerMinute / 60_000, now);
}
