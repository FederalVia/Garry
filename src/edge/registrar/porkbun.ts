/**
 * Porkbun registrar client with the owner's policy applied.
 *
 * The treasury guard reads searchDomains for an exact quote, reserves that
 * many cents and calls registerDomain with quotedCents set to the reserved
 * amount. This client sends exactly that amount as Porkbun's `cost`, and
 * Porkbun refuses when its price differs, so the price paid is the price
 * reserved. Every refusal here happens before onSend, so the treasury
 * releases the reservation.
 */

import type { DomainRegistration, DomainSearchResult } from "../../types.js";
import { normalizeZone } from "../dns/policy.js";
import { RegistrarError, type DomainQuote, type RegistrarClient, type RegistrarSendOptions, type ResolvedRegistrarConfig } from "../types.js";
import { parsePriceCents, PorkbunRegistrarApi } from "./raw-client.js";
import { createLogger } from "../../observability/logger.js";

const logger = createLogger("edge.registrar");

export const QUOTE_CACHE_MS = 60_000;
/** Domains the agent bought, with their renewal date and auto-renew state. */
export const REGISTRAR_RENEWALS_KV = "edge.registrar.renewals";
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_SEARCH_NAMES = 3;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A refusal decided locally, before anything is sent or reserved money moves. */
export class RegistrarRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrarRefusedError";
  }
}

export interface RenewalRecord {
  domain: string;
  /** ISO date the registration runs out (one year after purchase). */
  renewalDue: string;
  /** "off" once Porkbun confirmed it; "unknown" when turning it off failed. */
  autoRenew: "off" | "unknown";
}

export interface PorkbunRegistrarDeps {
  now?: () => number;
  /** Where renewal records are kept (the runtime's KV). */
  kv?: { getKV(key: string): string | undefined; setKV(key: string, value: string): void };
  /** Test hook: the raw API. */
  api?: PorkbunRegistrarApi;
  timeoutMs?: number;
}

function tldOf(domain: string): string {
  return domain.slice(domain.lastIndexOf(".") + 1);
}

export class PorkbunRegistrar implements RegistrarClient {
  readonly provider = "porkbun";
  private readonly cfg: ResolvedRegistrarConfig;
  private readonly api: PorkbunRegistrarApi;
  private readonly now: () => number;
  private readonly kv: PorkbunRegistrarDeps["kv"];
  private readonly cache = new Map<string, { quote: DomainQuote; atMs: number }>();
  private readonly renewalsInMemory: RenewalRecord[] = [];

  constructor(cfg: ResolvedRegistrarConfig, deps: PorkbunRegistrarDeps = {}) {
    this.cfg = cfg;
    this.kv = deps.kv;
    const c = cfg.credentials();
    this.api = deps.api ?? new PorkbunRegistrarApi({ apiUrl: cfg.apiUrl, apiKey: c.apiKey, secretApiKey: c.secretApiKey, timeoutMs: deps.timeoutMs });
    this.now = deps.now ?? Date.now;
  }

  /** True when the domain's TLD is on the owner's list. */
  tldAllowed(domain: string): boolean {
    return this.cfg.allowedTlds.includes(tldOf(domain));
  }

  private cached(domain: string): DomainQuote | null {
    const hit = this.cache.get(domain);
    if (!hit) return null;
    if (this.now() - hit.atMs > QUOTE_CACHE_MS) {
      this.cache.delete(domain);
      return null;
    }
    return hit.quote;
  }

  async quote(domain: string): Promise<DomainQuote | null> {
    const name = normalizeZone(domain);
    if (name === null) return null;
    const hit = this.cached(name);
    if (hit) return { ...hit };
    const raw = await this.api.checkDomain(name);
    const quote: DomainQuote = {
      domain: name,
      available: raw.avail === "yes" && raw.type === "registration",
      // Anything but an explicit "no" is treated as premium.
      premium: raw.premium !== "no",
      registrationCents: parsePriceCents(raw.price),
      renewalCents: parsePriceCents(raw.renewalPrice),
      currency: "USD",
    };
    this.cache.set(name, { quote, atMs: this.now() });
    return { ...quote };
  }

  private toResult(q: DomainQuote): DomainSearchResult {
    const available = q.available && !q.premium && this.tldAllowed(q.domain) && q.registrationCents !== null;
    return {
      domain: q.domain,
      available,
      ...(q.registrationCents !== null ? { registrationPrice: q.registrationCents } : {}),
      ...(q.renewalCents !== null ? { renewalPrice: q.renewalCents } : {}),
      currency: "USD",
    };
  }

  async searchDomains(query: string, tlds?: string): Promise<DomainSearchResult[]> {
    const q = typeof query === "string" ? query.trim().toLowerCase().replace(/\.$/, "") : "";
    if (q.includes(".")) {
      const name = normalizeZone(q);
      if (name === null) throw new RegistrarRefusedError(`"${query}" is not a domain name`);
      if (!this.tldAllowed(name)) return [{ domain: name, available: false, currency: "USD" }];
      const quote = await this.quote(name);
      return quote ? [this.toResult(quote)] : [];
    }
    if (!LABEL.test(q)) throw new RegistrarRefusedError(`"${query}" is not a valid name (letters, digits and hyphens)`);
    const wanted = typeof tlds === "string" && tlds.trim() !== ""
      ? tlds.split(",").map((t) => t.trim().toLowerCase().replace(/^\./, ""))
      : this.cfg.allowedTlds;
    const picked = [...new Set(wanted)].filter((t) => this.cfg.allowedTlds.includes(t)).slice(0, MAX_SEARCH_NAMES);
    const out: DomainSearchResult[] = [];
    // One after another: Porkbun rate-limits availability checks, and a
    // limit error ends the search with what was found.
    for (const tld of picked) {
      try {
        const quote = await this.quote(`${q}.${tld}`);
        if (quote) out.push(this.toResult(quote));
      } catch (err) {
        if (out.length === 0 && !(err instanceof RegistrarError && err.providerCode === "RATE_LIMITED")) throw err;
        break;
      }
    }
    return out;
  }

  async registerDomain(domain: string, years: number = 1, opts: RegistrarSendOptions = {}): Promise<DomainRegistration> {
    const name = normalizeZone(domain);
    if (name === null) throw new RegistrarRefusedError(`"${String(domain)}" is not a domain name`);
    if (years !== 1) throw new RegistrarRefusedError("only one-year registrations are made");
    if (!this.tldAllowed(name)) {
      throw new RegistrarRefusedError(`.${tldOf(name)} is not an allowed TLD (allowed: ${this.cfg.allowedTlds.join(", ")})`);
    }
    const cents = opts.quotedCents;
    if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents <= 0) {
      throw new RegistrarRefusedError("a registration needs the exact reserved price (quotedCents)");
    }
    if (cents > this.cfg.maxPriceCents) {
      throw new RegistrarRefusedError(`the price ${cents} cents is above the owner's limit of ${this.cfg.maxPriceCents} cents`);
    }
    const quote = this.cached(name) ?? (await this.quote(name));
    if (!quote || !quote.available) throw new RegistrarRefusedError(`${name} is not available for registration`);
    if (quote.premium) throw new RegistrarRefusedError(`${name} is a premium domain; premium domains are not bought`);
    if (quote.registrationCents !== cents) {
      throw new RegistrarRefusedError(
        `the quoted price (${String(quote.registrationCents)} cents) does not match the reserved amount (${cents} cents)`,
      );
    }
    opts.onSend?.();
    this.cache.delete(name);
    const { orderId } = await this.api.createDomain(name, cents);
    // Porkbun renews new domains by default and charges the account a year
    // later, outside the treasury. Turn that off; the purchase stands either way.
    const renewalDue = new Date(this.now() + YEAR_MS).toISOString();
    let note: string;
    let autoRenew: RenewalRecord["autoRenew"];
    try {
      await this.api.setAutoRenew(name, false);
      autoRenew = "off";
      note = `Auto-renew is off; the registration runs out on ${renewalDue.slice(0, 10)} unless your owner renews it.`;
    } catch (err) {
      autoRenew = "unknown";
      note =
        "Auto-renew could not be turned off; " +
        `Porkbun may charge your owner's account on ${renewalDue.slice(0, 10)} outside your treasury. Tell your owner.`;
      logger.warn(`Registered ${name} but could not turn its auto-renew off: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.recordRenewal({ domain: name, renewalDue, autoRenew });
    return { domain: name, status: "registered", expiresAt: renewalDue, note, ...(orderId ? { transactionId: orderId } : {}) };
  }

  /** Every domain bought through this registrar, newest last. */
  renewals(): RenewalRecord[] {
    if (!this.kv) return this.renewalsInMemory.map((r) => ({ ...r }));
    try {
      const rows: unknown = JSON.parse(this.kv.getKV(REGISTRAR_RENEWALS_KV) ?? "[]");
      if (!Array.isArray(rows)) return [];
      return rows.filter(
        (r): r is RenewalRecord =>
          !!r && typeof r.domain === "string" && typeof r.renewalDue === "string" && (r.autoRenew === "off" || r.autoRenew === "unknown"),
      );
    } catch {
      return [];
    }
  }

  private recordRenewal(r: RenewalRecord): void {
    if (!this.kv) {
      this.renewalsInMemory.push(r);
      return;
    }
    const rows = this.renewals().filter((x) => x.domain !== r.domain);
    rows.push(r);
    try {
      this.kv.setKV(REGISTRAR_RENEWALS_KV, JSON.stringify(rows.slice(-50)));
    } catch (err) {
      logger.warn(`Could not record the renewal date of ${r.domain}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** For the prompt: domains whose auto-renew may still be on. */
  statusLines(): string[] {
    const open = this.renewals().filter((r) => r.autoRenew === "unknown");
    return open.map(
      (r) => `Domain ${r.domain}: auto-renew could not be turned off; Porkbun may charge your owner on ${r.renewalDue.slice(0, 10)} outside your treasury`,
    );
  }
}
