/**
 * Guarded Conway client
 *
 * Wraps a raw Conway client so its value-moving calls (transferCredits,
 * createSandbox, registerDomain) pass through the Treasury, resolved at call
 * time: the explicit resolver, else the installed Treasury, else the call is
 * refused with TreasuryNotInstalledError and nothing is sent. Scoped clients
 * are wrapped the same way, so every outflow is gated exactly once. Every
 * other method passes through.
 *
 * Each guarded call reserves first (the gate checks every limit and writes a
 * ledger row), hands the reservation's idempotency key and a markSent hook to
 * the raw primitive, and settles the row from the primitive's outcome.
 */

import type {
  ConwayClient,
  CreateSandboxOptions,
  CreditTransferResult,
  DomainRegistration,
  OutflowRequestOptions,
  PricingTier,
  SandboxInfo,
} from "../types.js";
import { createLogger } from "../observability/logger.js";
import { classifyTransferStatus } from "../conway/transfer-status.js";
import {
  domainDedupeKey,
  domainRegistrationCents,
  sandboxDedupeKey,
  transferDedupeKey,
} from "./policy.js";
import { currentTreasuryOrigin, requireTreasury, type TreasuryResolver } from "./registry.js";
import { classifySendError, type Treasury } from "./treasury.js";
import {
  TransferRejectedError,
  TreasuryDeniedError,
  type AmountBasis,
  type ClassifyInfo,
  type Settlement,
} from "./types.js";

export type { TreasuryResolver };

const logger = createLogger("treasury.conway");

/** Pricing is cached this long per guarded client. */
const PRICING_CACHE_MS = 10 * 60_000;

/** Sandbox argument bounds: the largest tier Conway sells is 4 vCPU / 8 GB / 80 GB. */
export const SANDBOX_BOUNDS = Object.freeze({
  vcpu: { min: 1, max: 4, default: 1 },
  memoryMb: { min: 256, max: 8192, default: 512 },
  diskGb: { min: 1, max: 80, default: 5 },
});

/** Longest domain registration the gate accepts. */
export const MAX_DOMAIN_YEARS = 10;

/** A 2xx transfer answer whose status says the transfer did not happen. */
export function isRejectedTransferStatus(status: unknown): boolean {
  return classifyTransferStatus(status) === "rejected";
}

export function guardConwayClient(inner: ConwayClient, resolve?: TreasuryResolver): ConwayClient {
  let pricingCache: { tiers: PricingTier[]; at: number } | undefined;

  async function readPricing(): Promise<PricingTier[]> {
    const now = Date.now();
    if (pricingCache && now - pricingCache.at < PRICING_CACHE_MS && now >= pricingCache.at) {
      return pricingCache.tiers;
    }
    const tiers = await inner.getCreditsPricing();
    pricingCache = { tiers: Array.isArray(tiers) ? tiers : [], at: now };
    return pricingCache.tiers;
  }

  /**
   * Price a sandbox: the cheapest priced tier covering the request, never
   * below the configured floor. No matching tier or a pricing error means
   * the price is unknown, and nothing is reserved or sent (PRICE_UNKNOWN):
   * the infra cap is not an upper bound on what Conway bills.
   */
  async function priceSandbox(
    t: Treasury,
    spec: { vcpu: number; memoryMb: number; diskGb: number },
  ): Promise<{ cents: number; basis: AmountBasis }> {
    const describe = `${spec.vcpu} vCPU / ${spec.memoryMb}MB / ${spec.diskGb}GB`;
    let tiers: PricingTier[];
    try {
      tiers = await readPricing();
    } catch (err) {
      logger.warn("Sandbox pricing unavailable; refusing the sandbox", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new TreasuryDeniedError(
        "PRICE_UNKNOWN",
        `Sandbox pricing is unavailable, so a ${describe} sandbox cannot be priced; try again later`,
        "infra",
      );
    }
    let best: number | undefined;
    for (const tier of tiers) {
      const monthly = Number(tier?.monthlyCents);
      if (!Number.isFinite(monthly) || monthly <= 0) continue;
      if (
        Number(tier.vcpu) >= spec.vcpu &&
        Number(tier.memoryMb) >= spec.memoryMb &&
        Number(tier.diskGb) >= spec.diskGb
      ) {
        const cents = Math.ceil(monthly);
        if (best === undefined || cents < best) best = cents;
      }
    }
    if (best === undefined) {
      throw new TreasuryDeniedError(
        "PRICE_UNKNOWN",
        `No priced sandbox tier covers ${describe}`,
        "infra",
      );
    }
    return { cents: Math.max(best, t.policy.minSandboxEstimateCents), basis: "estimate" };
  }

  function classifyPost<T extends { id?: string; transactionId?: string }>(
    o: { value: T } | { error: unknown },
    info: ClassifyInfo,
  ): Settlement {
    if ("error" in o) {
      const outcome = classifySendError(o.error, info);
      return outcome === "released"
        ? { outcome: "released", reason: errorText(o.error) }
        : { outcome: "unknown", reason: errorText(o.error) };
    }
    const ref = o.value?.id ?? o.value?.transactionId;
    return { outcome: "committed", externalRef: typeof ref === "string" && ref ? ref : undefined };
  }

  return {
    exec: (command, timeout) => inner.exec(command, timeout),
    writeFile: (path, content) => inner.writeFile(path, content),
    readFile: (path) => inner.readFile(path),
    exposePort: (port) => inner.exposePort(port),
    removePort: (port) => inner.removePort(port),
    deleteSandbox: (sandboxId) => inner.deleteSandbox(sandboxId),
    listSandboxes: () => inner.listSandboxes(),
    getCreditsBalance: () => inner.getCreditsBalance(),
    getCreditsPricing: () => inner.getCreditsPricing(),
    registerAutomaton: (params) => inner.registerAutomaton(params),
    searchDomains: (query, tlds) => inner.searchDomains(query, tlds),
    listDnsRecords: (domain) => inner.listDnsRecords(domain),
    addDnsRecord: (domain, type, host, value, ttl) => inner.addDnsRecord(domain, type, host, value, ttl),
    deleteDnsRecord: (domain, recordId) => inner.deleteDnsRecord(domain, recordId),
    listModels: () => inner.listModels(),
    createScopedClient: (targetSandboxId) =>
      guardConwayClient(inner.createScopedClient(targetSandboxId), resolve),

    // The caller's OutflowRequestOptions are ignored: the gate supplies the
    // idempotency key and the send hook.
    async transferCredits(
      toAddress: string,
      amountCents: number,
      note?: string,
      _opts?: OutflowRequestOptions,
    ): Promise<CreditTransferResult> {
      const t = requireTreasury(resolve);
      const to = typeof toAddress === "string" ? toAddress : "";
      const origin = currentTreasuryOrigin();
      const result = await t.guard(
        {
          kind: "credit_transfer",
          amountCents,
          amountBasis: "exact",
          counterparty: to,
          dedupeKey: to ? transferDedupeKey(to, amountCents, origin.name) : "",
          description: note ? `Transfer to ${to}: ${note}` : `Transfer to ${to}`,
        },
        (r) =>
          inner.transferCredits(to, amountCents, note, {
            idempotencyKey: r.idempotencyKey,
            onSend: () => t.markSent(r),
          }),
        (o, info): Settlement => {
          if ("error" in o) {
            const outcome = classifySendError(o.error, info);
            return outcome === "released"
              ? { outcome: "released", reason: errorText(o.error) }
              : { outcome: "unknown", reason: errorText(o.error) };
          }
          const v = o.value;
          const statusClass = classifyTransferStatus(v?.status);
          if (statusClass === "rejected") {
            return { outcome: "released", reason: `transfer rejected (status ${v.status})` };
          }
          if (statusClass === "unknown") {
            // Not provably moved or refused: hold the amount, do not report success.
            return { outcome: "unknown", reason: `unrecognised transfer status ${JSON.stringify(v?.status)}` };
          }
          // settle counts max(reserved, reported), so a low report never under-counts.
          return {
            outcome: "committed",
            amountCents: typeof v?.amountCents === "number" ? v.amountCents : undefined,
            externalRef: v?.transferId || undefined,
            balanceAfterCents:
              typeof v?.balanceAfterCents === "number" ? v.balanceAfterCents : null,
          };
        },
      );
      if (isRejectedTransferStatus(result?.status)) {
        throw new TransferRejectedError(result.status);
      }
      return result;
    },

    async createSandbox(options: CreateSandboxOptions): Promise<SandboxInfo> {
      const t = requireTreasury(resolve);
      const opts = options ?? {};
      const spec = {
        vcpu: boundedInt("vcpu", opts.vcpu, SANDBOX_BOUNDS.vcpu),
        memoryMb: boundedInt("memoryMb", opts.memoryMb, SANDBOX_BOUNDS.memoryMb),
        diskGb: boundedInt("diskGb", opts.diskGb, SANDBOX_BOUNDS.diskGb),
      };
      const name = typeof opts.name === "string" ? opts.name : "";
      const { cents, basis } = await priceSandbox(t, spec);
      const { idempotencyKey: _key, onSend: _onSend, ...rest } = opts;
      return t.guard(
        {
          kind: "sandbox_create",
          amountCents: cents,
          amountBasis: basis,
          counterparty: "conway:sandbox",
          dedupeKey: sandboxDedupeKey(name, spec.vcpu, spec.memoryMb, spec.diskGb),
          description: `Sandbox ${name || "(unnamed)"} (${spec.vcpu} vCPU, ${spec.memoryMb}MB, ${spec.diskGb}GB)`,
        },
        // The resolved spec is sent, so what was priced is what is created.
        (r) =>
          inner.createSandbox({
            ...rest,
            ...spec,
            idempotencyKey: r.idempotencyKey,
            onSend: () => t.markSent(r),
          }),
        classifyPost,
      );
    },

    async registerDomain(
      domain: string,
      years: number = 1,
      _opts?: OutflowRequestOptions,
    ): Promise<DomainRegistration> {
      const t = requireTreasury(resolve);
      if (!Number.isInteger(years) || years < 1 || years > MAX_DOMAIN_YEARS) {
        throw new TreasuryDeniedError(
          "INVALID_AMOUNT",
          `years must be a whole number from 1 to ${MAX_DOMAIN_YEARS} (got ${String(years)})`,
          "infra",
        );
      }
      if (typeof domain !== "string" || domain.trim() === "") {
        throw new TreasuryDeniedError("INVALID_QUOTE", "A domain name is required", "infra");
      }
      const name = domain.trim();
      const quoteResult = await quoteDomain(inner, name);
      if (quoteResult === undefined) {
        throw new TreasuryDeniedError(
          "PRICE_UNKNOWN",
          `No registration price for ${name}; check availability with search_domains first`,
          "infra",
        );
      }
      const amountCents = domainRegistrationCents(quoteResult.registration, quoteResult.renewal, years);
      if (amountCents === null) {
        throw new TreasuryDeniedError(
          "PRICE_UNKNOWN",
          `The quote for ${name} is not a whole number of cents ` +
            `(registration ${String(quoteResult.registration)}, renewal ${String(quoteResult.renewal)})`,
          "infra",
        );
      }
      return t.guard(
        {
          kind: "domain_register",
          amountCents,
          amountBasis: "quote",
          counterparty: name.toLowerCase(),
          dedupeKey: domainDedupeKey(name, years),
          description: `Domain ${name} (${years}y)`,
        },
        (r) =>
          inner.registerDomain(name, years, {
            idempotencyKey: r.idempotencyKey,
            onSend: () => t.markSent(r),
          }),
        classifyPost,
      );
    },
  };
}

/** Prices of an exact, available, USD-priced match from searchDomains, or undefined. */
async function quoteDomain(
  inner: ConwayClient,
  domain: string,
): Promise<{ registration: number; renewal?: unknown } | undefined> {
  let results;
  try {
    results = await inner.searchDomains(domain);
  } catch (err) {
    logger.warn("Domain price lookup failed", {
      domain,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  const wanted = domain.toLowerCase();
  const match = (Array.isArray(results) ? results : []).find(
    (d) => typeof d?.domain === "string" && d.domain.toLowerCase() === wanted,
  );
  const price = match?.registrationPrice;
  if (!match?.available || typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    return undefined;
  }
  if (typeof match.currency === "string" && match.currency.trim().toUpperCase() !== "USD") {
    return undefined;
  }
  return { registration: price, renewal: match.renewalPrice };
}

/** undefined -> the default; otherwise an integer within bounds, else INVALID_AMOUNT. */
function boundedInt(
  field: string,
  value: unknown,
  bounds: { min: number; max: number; default: number },
): number {
  if (value === undefined || value === null) return bounds.default;
  if (typeof value !== "number" || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new TreasuryDeniedError(
      "INVALID_AMOUNT",
      `${field} must be a whole number from ${bounds.min} to ${bounds.max} (got ${String(value)})`,
      "infra",
    );
  }
  return value;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
