/**
 * In-memory RegistrarClient for tests. Like Porkbun, a registration whose
 * quotedCents differs from the current price is refused with HTTP 400 after
 * it was sent.
 */

import type { DomainRegistration, DomainSearchResult } from "../../types.js";
import { RegistrarError, type DomainQuote, type RegistrarClient, type RegistrarSendOptions } from "../types.js";

export interface FakeDomainEntry {
  available: boolean;
  premium?: boolean;
  registrationCents: number | null;
  renewalCents?: number | null;
}

export class FakeRegistrar implements RegistrarClient {
  readonly provider = "fake";
  readonly domains = new Map<string, FakeDomainEntry>();
  readonly registered: { domain: string; years: number; quotedCents?: number; optKeys: string[] }[] = [];
  readonly searches: string[] = [];
  private nextRegisterError: Error | null = null;
  private orderId = 1000;

  setDomain(domain: string, entry: FakeDomainEntry): void {
    this.domains.set(domain.toLowerCase(), entry);
  }

  /** The next registerDomain throws this after onSend (a send that failed). */
  failNextRegister(err: Error): void {
    this.nextRegisterError = err;
  }

  async quote(domain: string): Promise<DomainQuote | null> {
    const e = this.domains.get(domain.toLowerCase());
    if (!e) return null;
    return {
      domain: domain.toLowerCase(),
      available: e.available,
      premium: e.premium ?? false,
      registrationCents: e.registrationCents,
      renewalCents: e.renewalCents ?? null,
      currency: "USD",
    };
  }

  async searchDomains(query: string, _tlds?: string): Promise<DomainSearchResult[]> {
    this.searches.push(query);
    const q = await this.quote(query);
    if (!q) return [];
    return [
      {
        domain: q.domain,
        available: q.available && !q.premium && q.registrationCents !== null,
        ...(q.registrationCents !== null ? { registrationPrice: q.registrationCents } : {}),
        ...(q.renewalCents !== null ? { renewalPrice: q.renewalCents } : {}),
        currency: "USD",
      },
    ];
  }

  async registerDomain(domain: string, years: number = 1, opts: RegistrarSendOptions = {}): Promise<DomainRegistration> {
    opts.onSend?.();
    this.registered.push({ domain, years, quotedCents: opts.quotedCents, optKeys: Object.keys(opts).sort() });
    if (this.nextRegisterError) {
      const err = this.nextRegisterError;
      this.nextRegisterError = null;
      throw err;
    }
    const e = this.domains.get(domain.toLowerCase());
    if (!e || !e.available || e.registrationCents !== opts.quotedCents) {
      throw new RegistrarError({ message: "Porkbun answered HTTP 400: price mismatch or unavailable", status: 400, sent: true });
    }
    e.available = false;
    return { domain, status: "registered", transactionId: String(this.orderId++) };
  }
}
