/**
 * The edge facade: a ConwayClient whose port, DNS and (standalone) domain
 * calls go to what the owner configured in publicAccess. Without that block
 * the client is returned unchanged, so local and Conway behaviour stay
 * exactly as before.
 */

import type { ConwayClient, DnsRecord, PortInfo } from "../types.js";
import { FeatureDisabledError } from "../providers/features.js";
import { guardConwayClient, type TreasuryResolver } from "../treasury/guarded-conway.js";
import { TreasuryDeniedError } from "../treasury/types.js";
import { DnsPolicyError, type ManagedRecord, type RegistrarClient, type ResolvedRegistrarConfig } from "./types.js";
import { PortRefusedError, type Exposure } from "./ports.js";
import type { Edge } from "./index.js";

/** A registration the registrar pre-check refused before any ledger row. */
export class DomainPurchaseRefusedError extends Error {
  constructor(
    readonly code: "REGISTRAR_YEARS" | "REGISTRAR_TLD_NOT_ALLOWED" | "REGISTRAR_PRICE_ABOVE_MAX" | "REGISTRAR_NAME_INVALID",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DomainPurchaseRefusedError";
  }
}

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The text that goes after "Port N is public at URL." */
export function exposureNote(e: Exposure, mode: string): string {
  const notes: string[] = [];
  if (mode === "proxy") notes.push("The service must listen on 127.0.0.1 or 0.0.0.0 (a service bound only to ::1 is not reached).");
  if (mode === "tunnel") notes.push("The address changes whenever the tunnel restarts.");
  if (e.readyPending) notes.push("The tunnel may need a few more seconds before it answers.");
  if (e.listening === false) notes.push(`Nothing is listening on 127.0.0.1:${e.port} yet.`);
  return notes.join(" ");
}

function toDnsRecord(r: ManagedRecord): DnsRecord {
  return { id: r.id, type: r.type, host: r.host, value: r.value, ttl: r.ttl, managed: r.managed };
}

/** A ConwayClient that can only quote and buy through the registrar; everything else is disabled. */
function registrarShim(registrar: RegistrarClient): ConwayClient {
  const disabled = (what: string) => async (): Promise<never> => {
    throw new FeatureDisabledError(what, "providers.conway.apiKey");
  };
  return {
    exec: disabled("commands"),
    writeFile: disabled("files"),
    readFile: disabled("files"),
    exposePort: disabled("ports"),
    removePort: disabled("ports"),
    createSandbox: disabled("sandboxes"),
    deleteSandbox: disabled("sandboxes"),
    listSandboxes: disabled("sandboxes"),
    getCreditsBalance: disabled("Conway credits"),
    getCreditsPricing: disabled("Conway credits"),
    transferCredits: disabled("credit transfers"),
    registerAutomaton: disabled("Conway registration"),
    searchDomains: (query, tlds) => registrar.searchDomains(query, tlds),
    registerDomain: (domain, years, opts) => registrar.registerDomain(domain, years, opts),
    listDnsRecords: disabled("DNS"),
    addDnsRecord: disabled("DNS"),
    deleteDnsRecord: disabled("DNS"),
    listModels: disabled("Conway model discovery"),
    createScopedClient: () => {
      throw new FeatureDisabledError("child sandboxes", "providers.conway.apiKey");
    },
  };
}

/**
 * Refuse what the registrar would refuse anyway, before the treasury writes
 * a ledger row: one year only, an allowed TLD, an exact price within the cap.
 */
async function precheckRegistration(
  registrar: RegistrarClient,
  cfg: Pick<ResolvedRegistrarConfig, "allowedTlds" | "maxPriceCents">,
  domain: string,
  years: number,
): Promise<string> {
  if (years !== 1) throw new DomainPurchaseRefusedError("REGISTRAR_YEARS", "only one-year registrations are made");
  const name = typeof domain === "string" ? domain.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!DOMAIN_RE.test(name)) throw new DomainPurchaseRefusedError("REGISTRAR_NAME_INVALID", `${String(domain)} is not a domain name`);
  const tld = name.slice(name.lastIndexOf(".") + 1);
  if (!cfg.allowedTlds.includes(tld)) {
    throw new DomainPurchaseRefusedError(
      "REGISTRAR_TLD_NOT_ALLOWED",
      `.${tld} is not a TLD your owner allows (${cfg.allowedTlds.map((t) => `.${t}`).join(", ")})`,
    );
  }
  const q = await registrar.quote(name);
  if (!q || !q.available || q.premium || q.registrationCents === null || q.currency !== "USD") {
    throw new TreasuryDeniedError(
      "PRICE_UNKNOWN",
      `No exact registration price for ${name} (unavailable, premium or not priced); check it with search_domains first`,
      "infra",
    );
  }
  if (q.registrationCents > cfg.maxPriceCents) {
    throw new DomainPurchaseRefusedError(
      "REGISTRAR_PRICE_ABOVE_MAX",
      `${name} costs $${(q.registrationCents / 100).toFixed(2)}, above the $${(cfg.maxPriceCents / 100).toFixed(2)} your owner allows per domain`,
    );
  }
  return name;
}

const CLIENT_METHODS: readonly (keyof ConwayClient)[] = Object.freeze([
  "exec",
  "writeFile",
  "readFile",
  "exposePort",
  "removePort",
  "createSandbox",
  "deleteSandbox",
  "listSandboxes",
  "getCreditsBalance",
  "getCreditsPricing",
  "transferCredits",
  "registerAutomaton",
  "searchDomains",
  "registerDomain",
  "listDnsRecords",
  "addDnsRecord",
  "deleteDnsRecord",
  "listModels",
  "createScopedClient",
]);

export interface WithEdgeOptions {
  /** Treasury for registrar purchases (tests); default: the installed one, resolved at call time. */
  treasury?: TreasuryResolver;
}

export function withEdge(
  client: ConwayClient,
  edge: Edge | null,
  mode: "conway" | "standalone",
  opts: WithEdgeOptions = {},
): ConwayClient {
  if (!edge || !edge.summary.configured) return client;
  // Delegate at call time (a class-based client keeps its prototype methods
  // and its `this`); only the methods below are replaced.
  const out = { ...client } as ConwayClient;
  const target = client as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const m of CLIENT_METHODS) {
    (out as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => target[m](...a);
  }

  const ports = edge.ports;
  const portsMode = edge.summary.ports;
  if (ports && (portsMode === "proxy" || portsMode === "tunnel")) {
    out.exposePort = async (port: number, o?: { name?: string }): Promise<PortInfo> => {
      const e = await ports.expose(port, { name: o?.name, managedBy: "agent" });
      return {
        port: e.port,
        publicUrl: e.url ?? "",
        sandboxId: "local",
        scope: "public",
        note: exposureNote(e, portsMode),
      };
    };
    out.removePort = async (port: number): Promise<void> => {
      // Say so rather than report a removal that did nothing.
      if (!(await ports.remove(port, { managedBy: "agent" }))) {
        throw new PortRefusedError("NOT_EXPOSED", `port ${port} was not public`);
      }
    };
  }

  const dns = edge.dns;
  if (dns) {
    const outside = <T>(domain: string, viaInner: () => Promise<T>): Promise<T> => {
      // Conway mode keeps Conway's DNS for its own domains.
      if (mode === "conway") return viaInner();
      return Promise.reject(
        new DnsPolicyError("DNS_OUTSIDE_ZONE", `only records under ${dns.zone} can be changed (got ${String(domain)})`),
      );
    };
    out.listDnsRecords = async (domain) =>
      dns.covers(domain) ? (await dns.list(domain)).map(toDnsRecord) : outside(domain, () => client.listDnsRecords(domain));
    out.addDnsRecord = async (domain, type, host, value, ttl) =>
      dns.covers(domain)
        ? toDnsRecord(await dns.add(domain, { type, host, value, ttl }))
        : outside(domain, () => client.addDnsRecord(domain, type, host, value, ttl));
    out.deleteDnsRecord = async (domain, recordId) =>
      dns.covers(domain) ? dns.remove(domain, recordId) : outside(domain, () => client.deleteDnsRecord(domain, recordId));
  }

  const registrar = edge.registrar;
  const registrarCfg = edge.registrarConfig();
  if (mode === "standalone" && registrar && registrarCfg) {
    const guarded = guardConwayClient(registrarShim(registrar), opts.treasury);
    out.searchDomains = (query, tlds) => registrar.searchDomains(query, tlds);
    out.registerDomain = async (domain, years = 1) => {
      const name = await precheckRegistration(registrar, registrarCfg, domain, years);
      return guarded.registerDomain(name, 1);
    };
  }
  return out;
}
