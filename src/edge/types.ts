/**
 * Shared types of the edge module: DNS on a zone the owner already owns and
 * an optional registrar. Nothing here performs I/O.
 *
 * Resolved configs carry their credentials behind a function, so a config
 * object that ends up in a log line, a JSON dump or util.inspect output
 * never shows the token itself.
 */

import type { DomainRegistration, DomainSearchResult, OutflowRequestOptions } from "../types.js";

// ─── Config errors ─────────────────────────────────────────────

/** A shape error in `publicAccess`; `path` is the config path of the bad value. */
export class EdgeConfigError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "EdgeConfigError";
  }
}

// ─── Provider errors ───────────────────────────────────────────

export interface EdgeHttpErrorInit {
  message: string;
  /** HTTP status of the answer, when one arrived. */
  status?: number;
  /** The provider's own error code, when it gave one. */
  providerCode?: string;
  /** Parsed Retry-After, uncapped. */
  retryAfterMs?: number;
  /** False only when the request certainly never left (bad URL, connection refused). */
  sent: boolean;
  /** Node error code of a connection failure (ECONNREFUSED ...), read by the treasury's classifier. */
  code?: string;
}

/** An HTTP-level failure talking to a DNS provider or registrar. Messages are already redacted. */
export class EdgeHttpError extends Error {
  status?: number;
  providerCode?: string;
  retryAfterMs?: number;
  sent: boolean;
  code?: string;

  constructor(init: EdgeHttpErrorInit) {
    super(init.message);
    this.name = "EdgeHttpError";
    this.status = init.status;
    this.providerCode = init.providerCode;
    this.retryAfterMs = init.retryAfterMs;
    this.sent = init.sent;
    this.code = init.code;
  }
}

export class DnsProviderError extends EdgeHttpError {
  constructor(init: EdgeHttpErrorInit) {
    super(init);
    this.name = "DnsProviderError";
  }
}

export class RegistrarError extends EdgeHttpError {
  constructor(init: EdgeHttpErrorInit) {
    super(init);
    this.name = "RegistrarError";
  }
}

// ─── DNS provider adapters ─────────────────────────────────────

export const AGENT_DNS_TYPES = Object.freeze(["A", "AAAA", "CNAME", "TXT"] as const);
export type DnsRecordType = (typeof AGENT_DNS_TYPES)[number];

export interface ZoneRecord {
  id: string;
  type: string;
  /** FQDN, lowercase, no trailing dot. */
  name: string;
  content: string;
  ttl: number;
  /**
   * Whether this runtime's adapter created the record, where the provider
   * keeps a marker (Cloudflare's comment). Undefined when it cannot tell.
   */
  ours?: boolean;
}

export interface NewZoneRecord {
  type: DnsRecordType;
  /** FQDN, lowercase, no trailing dot. */
  name: string;
  content: string;
  ttl: number;
}

export interface DnsCallOptions {
  signal?: AbortSignal;
}

export type DnsVerifyResult = { ok: true; broadToken: boolean } | { ok: false; reason: string };

export interface DnsProvider {
  readonly id: "cloudflare" | "porkbun" | "fake";
  readonly zone: string;
  /** Smallest TTL the provider accepts (Cloudflare 60, Porkbun 600). */
  readonly minTtl: number;
  verify(o?: DnsCallOptions): Promise<DnsVerifyResult>;
  /** Every record of the zone; throws rather than return a partial list. */
  list(o?: DnsCallOptions): Promise<ZoneRecord[]>;
  create(r: NewZoneRecord, o?: DnsCallOptions): Promise<ZoneRecord>;
  delete(id: string, o?: DnsCallOptions): Promise<void>;
}

// ─── Zone policy ───────────────────────────────────────────────

export type DnsPolicyCode =
  | "DNS_OUTSIDE_ZONE"
  | "DNS_NAME_INVALID"
  | "DNS_TYPE_NOT_ALLOWED"
  | "DNS_CONTENT_INVALID"
  | "DNS_TTL_INVALID"
  | "DNS_PROTECTED_NAME"
  | "DNS_NAME_HELD_BY_OWNER"
  | "DNS_NOT_OWNED"
  | "DNS_RECORD_LIMIT"
  | "DNS_RATE_LIMITED"
  | "DNS_UNAVAILABLE";

/** A refusal by the zone policy or the service. The message never carries a credential. */
export class DnsPolicyError extends Error {
  constructor(
    readonly code: DnsPolicyCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "DnsPolicyError";
  }
}

// ─── DNS service ───────────────────────────────────────────────

export interface ManagedRecord {
  id: string;
  type: string;
  /** FQDN. */
  name: string;
  /** Relative to the domain that was listed, "@" for the domain itself. */
  host: string;
  value: string;
  ttl: number;
  /** True when the agent created it (and so may delete it). */
  managed: boolean;
}

export type DnsAvailability =
  | { state: "unverified" }
  | { state: "ok"; broadToken: boolean }
  | { state: "unavailable"; reason: string };

export interface DnsService {
  readonly zone: string;
  readonly provider: string;
  /** True when `domain` is the zone or a name under it. */
  covers(domain: string): boolean;
  /** Checks the token once; throws DnsPolicyError("DNS_UNAVAILABLE") with the reason. */
  verify(): Promise<void>;
  /** Last verification state, for status lines. Never contains the token. */
  availability(): DnsAvailability;
  list(domain: string): Promise<ManagedRecord[]>;
  add(domain: string, input: { type: string; host: string; value: string; ttl?: number }): Promise<ManagedRecord>;
  remove(domain: string, recordId: string): Promise<void>;
}

// ─── Resolved configs ──────────────────────────────────────────

export type DnsProviderId = "cloudflare" | "porkbun";

export type DnsCredentials =
  | { provider: "cloudflare"; apiToken: string; zoneId?: string }
  | { provider: "porkbun"; apiKey: string; secretApiKey: string };

export interface ResolvedDnsConfig {
  provider: DnsProviderId;
  /** Lowercase ASCII, no trailing dot. */
  zone: string;
  apiUrl: string;
  /** Behind a function so the config never serialises its secret. */
  credentials: () => DnsCredentials;
  allowedTypes: DnsRecordType[];
  /** FQDN; when set, only this name and names below it. */
  allowedSubtree?: string;
  allowApex: boolean;
  manageExisting: boolean;
  /** FQDNs. */
  extraProtectedNames: string[];
  maxRecords: number;
  maxChangesPerHour: number;
  maxChangesPerDay: number;
  defaultTtl: number;
  allowPrivateAddresses: boolean;
  allowBroadToken: boolean;
}

export interface RegistrarCredentials {
  apiKey: string;
  secretApiKey: string;
}

export interface ResolvedRegistrarConfig {
  provider: "porkbun";
  apiUrl: string;
  credentials: () => RegistrarCredentials;
  /** Lowercase labels. */
  allowedTlds: string[];
  maxPriceCents: number;
  /** Only one-year registrations are made. */
  years: 1;
}

// ─── Registrar ─────────────────────────────────────────────────

export interface DomainQuote {
  domain: string;
  /** Free to register as a normal (non-transfer, non-aftermarket) registration. */
  available: boolean;
  premium: boolean;
  registrationCents: number | null;
  renewalCents: number | null;
  currency: "USD";
}

export interface RegistrarSendOptions extends OutflowRequestOptions {
  /** The amount the treasury reserved; the registrar is sent exactly this. */
  quotedCents?: number;
}

export interface RegistrarClient {
  readonly provider: string;
  /** ConwayClient-shaped: what the treasury guard's quote lookup reads. Prices in whole cents. */
  searchDomains(query: string, tlds?: string): Promise<DomainSearchResult[]>;
  registerDomain(domain: string, years?: number, opts?: RegistrarSendOptions): Promise<DomainRegistration>;
  quote(domain: string): Promise<DomainQuote | null>;
  /** Lines for the prompt that need the owner's attention (a renewal the treasury cannot see). */
  statusLines?(): string[];
}
