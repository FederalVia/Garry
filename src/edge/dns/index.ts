/**
 * DNS on a zone the owner already owns. The in-memory fake lives in
 * ./fake.ts and is imported directly by tests, not re-exported here.
 */

export { DNS_DEFAULT_API_URLS, DNS_DEFAULTS, DNS_ENV_NAMES, parseDnsSection } from "./config.js";
export { DnsZonePolicy, isAtOrUnder, normalizeName, normalizeZone, relativeHost, sameContent } from "./policy.js";
export { ensureDnsTables, listChanges, liveOwnedRecords, pruneDnsChanges } from "./changelog.js";
export { createDnsProvider, createDnsService, ZoneDnsService, type DnsServiceDeps } from "./service.js";
export { CloudflareDnsProvider, createCloudflareProvider, CLOUDFLARE_MIN_TTL } from "./cloudflare.js";
export { PorkbunDnsProvider, createPorkbunDnsProvider, PORKBUN_MIN_TTL } from "./porkbun.js";
