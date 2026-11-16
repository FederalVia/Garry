/**
 * Zone policy: what the agent may write into the owner's zone. Pure
 * functions, applied before any network call.
 *
 * The agent works inside one zone, on names that hold none of the owner's
 * records, never on the owner's site or mail names, with public addresses
 * only. Names are ASCII (punycode for IDNs), so a homoglyph of the zone is
 * simply another domain.
 */

import net from "node:net";
import { isInternalHostname, isPublicAddress } from "../../registry/safe-fetch.js";
import { DnsPolicyError, type DnsRecordType, type ResolvedDnsConfig } from "../types.js";

export const MAX_TTL = 86_400;
export const MIN_TTL_FLOOR = 60;
export const MAX_TXT_CHARS = 2048;
const MAX_NAME_CHARS = 253;

/** Hostname label (letters, digits, hyphens). */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Record-name label: hostname labels plus underscores (_acme-challenge, _dmarc). */
const NAME_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** Names relative to the zone apex that hold the owner's site and mail settings. */
const PROTECTED_RELATIVE = ["www", "mail", "_dmarc", "mta-sts", "_mta-sts", "_smtp._tls", "autoconfig", "autodiscover"];

/** Top-level names used on private networks or reserved, never served on the public internet. */
const PRIVATE_TLDS = new Set(["lan", "corp", "home", "intranet", "private", "test", "invalid"]);

/** Lowercase, one trailing dot dropped; null for non-ASCII, empty labels or bad characters. */
export function normalizeName(input: unknown, opts: { underscores?: boolean } = {}): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s === "" || s.length > MAX_NAME_CHARS) return null;
  // eslint-disable-next-line no-control-regex
  if (!/^[\x21-\x7e]+$/.test(s)) return null;
  const re = opts.underscores === false ? HOST_LABEL : NAME_LABEL;
  return s.split(".").every((l) => re.test(l)) ? s : null;
}

/** A zone name: hostname labels only, at least two. */
export function normalizeZone(input: unknown): string | null {
  const z = normalizeName(input, { underscores: false });
  return z && z.includes(".") ? z : null;
}

/** True when `name` is `parent` or below it. Both normalised. */
export function isAtOrUnder(name: string, parent: string): boolean {
  return name === parent || name.endsWith(`.${parent}`);
}

function hasNonAscii(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7f]/.test(s);
}

export interface CheckedRecord {
  type: DnsRecordType;
  /** FQDN. */
  name: string;
  content: string;
  ttl: number;
}

export interface PolicyOptions {
  /** Names (FQDNs) the runtime routes itself, e.g. the port gateway's wildcard suffix. */
  reservedSubtrees?: readonly string[];
}

export class DnsZonePolicy {
  readonly zone: string;
  private readonly cfg: ResolvedDnsConfig;
  private readonly reserved: string[];

  constructor(cfg: ResolvedDnsConfig, opts: PolicyOptions = {}) {
    this.cfg = cfg;
    this.zone = cfg.zone;
    this.reserved = (opts.reservedSubtrees ?? [])
      .map((s) => normalizeName(s))
      .filter((s): s is string => s !== null && isAtOrUnder(s, cfg.zone));
  }

  covers(domain: string): boolean {
    const d = normalizeName(domain);
    return d !== null && isAtOrUnder(d, this.zone);
  }

  /** Step 1: the domain argument, normalised; DNS_OUTSIDE_ZONE otherwise. */
  checkDomain(domain: unknown): string {
    const outside = () =>
      new DnsPolicyError("DNS_OUTSIDE_ZONE", `only records under ${this.zone} can be changed`);
    if (typeof domain !== "string") throw outside();
    if (hasNonAscii(domain)) {
      throw new DnsPolicyError("DNS_OUTSIDE_ZONE", `only records under ${this.zone} can be changed (names must be ASCII; use the xn-- form)`);
    }
    const d = normalizeName(domain);
    if (d === null || d.split(".").includes("*")) throw outside();
    if (!isAtOrUnder(d, this.zone)) throw outside();
    return d;
  }

  /** Step 2: the record's full name from host and domain. */
  resolveName(domain: string, host: unknown): string {
    if (typeof host !== "string" || host.trim() === "") {
      throw new DnsPolicyError("DNS_NAME_INVALID", `host is required ("@" for ${domain} itself)`);
    }
    const raw = host.trim().toLowerCase();
    if (hasNonAscii(raw)) {
      throw new DnsPolicyError("DNS_NAME_INVALID", "names must be ASCII; use the xn-- form");
    }
    if (raw.split(".").includes("*") || raw.includes("*")) {
      throw new DnsPolicyError("DNS_NAME_INVALID", "wildcard names are not allowed");
    }
    let name: string;
    if (raw === "@") {
      name = domain;
    } else if (raw.endsWith(".")) {
      // Fully qualified: taken as written, and must sit inside the zone.
      const fq = normalizeName(raw);
      if (fq === null) throw new DnsPolicyError("DNS_NAME_INVALID", `"${host}" is not a valid name`);
      name = fq;
    } else {
      const rel = normalizeName(raw);
      if (rel === null || raw.includes("..")) throw new DnsPolicyError("DNS_NAME_INVALID", `"${host}" is not a valid name`);
      if (isAtOrUnder(rel, domain)) {
        name = rel;
      } else {
        // "x.example.com.evil.com" is a full name outside the zone written
        // without the final dot, not a subdomain the agent meant to create.
        const zoneLabels = this.zone.split(".");
        const labels = rel.split(".");
        for (let i = 0; i + zoneLabels.length <= labels.length; i++) {
          if (labels.slice(i, i + zoneLabels.length).join(".") === this.zone) {
            throw new DnsPolicyError("DNS_OUTSIDE_ZONE", `only records under ${this.zone} can be changed`);
          }
        }
        name = `${rel}.${domain}`;
      }
    }
    if (name.length > MAX_NAME_CHARS || normalizeName(name) === null) {
      throw new DnsPolicyError("DNS_NAME_INVALID", `"${host}" makes a name longer than ${MAX_NAME_CHARS} characters or invalid`);
    }
    if (!isAtOrUnder(name, this.zone)) {
      throw new DnsPolicyError("DNS_OUTSIDE_ZONE", `only records under ${this.zone} can be changed`);
    }
    if (this.cfg.allowedSubtree && !isAtOrUnder(name, this.cfg.allowedSubtree)) {
      throw new DnsPolicyError("DNS_OUTSIDE_ZONE", `only records at or under ${this.cfg.allowedSubtree} can be changed`);
    }
    return name;
  }

  /** Step 3: the owner's site, mail and identity names, and the runtime's own names. */
  checkProtected(name: string): void {
    const why = this.protectedReason(name);
    if (why) throw new DnsPolicyError("DNS_PROTECTED_NAME", `${name} is protected: ${why}`);
  }

  protectedReason(name: string): string | null {
    const z = this.zone;
    for (const r of this.reserved) {
      if (isAtOrUnder(name, r)) return `names under ${r} are routed by the runtime's port gateway`;
    }
    if (name.split(".").includes("_domainkey")) return "mail signing keys belong to the owner";
    // default._bimi sets the logo mail clients show for the whole domain.
    if (name.split(".").includes("_bimi")) return "the brand logo mail clients show belongs to the owner";
    if (name === z && !this.cfg.allowApex) return "the zone apex belongs to the owner";
    for (const rel of PROTECTED_RELATIVE) {
      if (name === `${rel}.${z}`) return "the owner's site and mail settings";
    }
    for (const extra of this.cfg.extraProtectedNames) {
      if (name === extra) return "listed as protected by the owner";
    }
    // Underscore names attach to their parent: _acme-challenge.<apex> can get
    // a certificate for the whole domain and _atproto.<apex> claims its
    // identity, so they are protected whenever the parent is. The apex counts
    // as protected here even when allowApex is set.
    const labels = name.split(".");
    let i = 0;
    while (i < labels.length && labels[i].startsWith("_")) i++;
    if (i > 0 && i < labels.length) {
      const parent = labels.slice(i).join(".");
      if (parent === z) return "records attached to the zone apex speak for the whole domain";
      if (isAtOrUnder(parent, z) && this.protectedReason(parent)) return `it belongs to ${parent}, which is protected`;
    }
    return null;
  }

  /** Step 4: type and content. Returns the content as it will be sent. */
  checkContent(type: unknown, value: unknown, name: string): { type: DnsRecordType; content: string } {
    const t = typeof type === "string" ? type.trim().toUpperCase() : "";
    if (!(this.cfg.allowedTypes as string[]).includes(t)) {
      throw new DnsPolicyError("DNS_TYPE_NOT_ALLOWED", `record type ${String(type)} is not allowed; allowed: ${this.cfg.allowedTypes.join(", ")}`);
    }
    const recordType = t as DnsRecordType;
    if (typeof value !== "string") throw new DnsPolicyError("DNS_CONTENT_INVALID", "value must be a string");
    const v = recordType === "TXT" ? value : value.trim();
    const bad = (msg: string) => new DnsPolicyError("DNS_CONTENT_INVALID", msg);
    switch (recordType) {
      case "A": {
        if (!/^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(v)) {
          throw bad("an A record needs a dotted IPv4 address");
        }
        if (!this.cfg.allowPrivateAddresses && !isPublicAddress(v)) {
          throw bad(`${v} is not a public address (loopback, private, link-local and reserved ranges are refused)`);
        }
        return { type: recordType, content: v };
      }
      case "AAAA": {
        if (v.includes("%") || net.isIPv6(v) === false) throw bad("an AAAA record needs an IPv6 address");
        const lower = v.toLowerCase();
        if (!this.cfg.allowPrivateAddresses && !isPublicAddress(lower)) {
          throw bad(`${v} is not a public address (loopback, unique-local, link-local and reserved ranges are refused)`);
        }
        return { type: recordType, content: lower };
      }
      case "CNAME": {
        const target = normalizeName(v, { underscores: false });
        if (target === null || !target.includes(".") || net.isIP(target) !== 0) {
          throw bad("a CNAME record needs a host name such as app.example.net");
        }
        if (isInternalHostname(target)) throw bad(`${target} is an internal name`);
        // The target is not resolved, so only its name can be screened.
        if (!this.cfg.allowPrivateAddresses && PRIVATE_TLDS.has(target.slice(target.lastIndexOf(".") + 1))) {
          throw bad(`${target} is a private-network name`);
        }
        if (target === name) throw bad("a CNAME record cannot point at its own name");
        return { type: recordType, content: target };
      }
      case "TXT": {
        if (v.length === 0 || v.length > MAX_TXT_CHARS) throw bad(`a TXT value must be 1 to ${MAX_TXT_CHARS} characters`);
        if (!/^[\x20-\x7e]+$/.test(v)) throw bad("a TXT value must be printable ASCII (no control characters)");
        return { type: recordType, content: v };
      }
    }
  }

  /** Step 5: TTL within the provider's minimum and a day. */
  resolveTtl(ttl: unknown, providerMinTtl: number): number {
    const min = Math.max(providerMinTtl, MIN_TTL_FLOOR);
    if (ttl === undefined || ttl === null) return Math.min(Math.max(this.cfg.defaultTtl, min), MAX_TTL);
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < min || ttl > MAX_TTL) {
      throw new DnsPolicyError("DNS_TTL_INVALID", `ttl must be a whole number of seconds from ${min} to ${MAX_TTL}`);
    }
    return ttl;
  }

  /** Steps 1 to 5 for an add. */
  checkAdd(
    domain: unknown,
    input: { type: unknown; host: unknown; value: unknown; ttl?: unknown },
    providerMinTtl: number,
  ): CheckedRecord & { domain: string } {
    const d = this.checkDomain(domain);
    const name = this.resolveName(d, input.host);
    this.checkProtected(name);
    const { type, content } = this.checkContent(input.type, input.value, name);
    const ttl = this.resolveTtl(input.ttl, providerMinTtl);
    return { domain: d, type, name, content, ttl };
  }
}

/** Content equality as providers echo it back (quoted TXT, CNAME case and dot). */
export function sameContent(type: string, a: string, b: string): boolean {
  const norm = (s: string) => {
    let v = String(s ?? "");
    if (type.toUpperCase() === "TXT") {
      if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      return v;
    }
    v = v.trim().toLowerCase();
    return v.endsWith(".") ? v.slice(0, -1) : v;
  };
  return norm(a) === norm(b);
}

/** Name relative to `domain`, "@" for the domain itself. */
export function relativeHost(name: string, domain: string): string {
  if (name === domain) return "@";
  return name.endsWith(`.${domain}`) ? name.slice(0, -(domain.length + 1)) : name;
}
