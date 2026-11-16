/**
 * Loopback fake of the Porkbun JSON API v3 subset used here: ping, DNS
 * retrieve/create/delete, checkDomain and domain create. Keys are checked in
 * the body; a request log, scripted responses, price changes, a check limit
 * and an echo mode that repeats the keys in error messages.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface PbRequest {
  path: string;
  method: string;
  query: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | null;
}

export interface PbScripted {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
  destroy?: boolean;
}

export interface PbRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: string;
  prio: string | null;
  notes: string;
}

export interface PbDomainPrice {
  avail: string;
  type: string;
  price: string;
  premium: string;
  renewal?: string;
}

const PREFIX = "/api/json/v3";

export class FakePorkbun {
  readonly apiKey: string;
  readonly secretApiKey: string;
  readonly requests: PbRequest[] = [];
  /** Zones with API access enabled. */
  readonly zones = new Map<string, PbRecord[]>();
  readonly prices = new Map<string, PbDomainPrice>();
  readonly created: { domain: string; cost: unknown; agreeToTerms: unknown }[] = [];
  /** Auto-renew per domain; a new registration starts with it on, as at Porkbun. */
  readonly autoRenew = new Map<string, string>();
  balanceCents = 100_000;
  echoKeys = false;
  /** Availability checks allowed before the limit error (Infinity: no limit). */
  checkLimit = Infinity;
  private checksUsed = 0;
  private nextId = 400_000_000;
  private orderId = 9000;
  private scripted: { match?: (r: PbRequest) => boolean; script: PbScripted | ((r: PbRequest) => PbScripted) }[] = [];
  private server: http.Server | null = null;
  private sockets = new Set<import("node:net").Socket>();
  url = "";

  constructor(opts: { apiKey?: string; secretApiKey?: string } = {}) {
    this.apiKey = opts.apiKey ?? "pk1_test_0123456789abcdef0123456789abcdef";
    this.secretApiKey = opts.secretApiKey ?? "sk1_test_fedcba9876543210fedcba9876543210";
  }

  enableZone(zone: string): void {
    if (!this.zones.has(zone)) this.zones.set(zone, []);
  }

  seed(zone: string, r: { name: string; type: string; content: string; ttl?: number }): PbRecord {
    this.enableZone(zone);
    const rec: PbRecord = { id: String(this.nextId++), name: r.name, type: r.type, content: r.content, ttl: String(r.ttl ?? 600), prio: null, notes: "" };
    this.zones.get(zone)!.push(rec);
    return rec;
  }

  setPrice(domain: string, p: PbDomainPrice): void {
    this.prices.set(domain, p);
  }

  respondNext(script: PbScripted | ((r: PbRequest) => PbScripted), match?: (r: PbRequest) => boolean): void {
    this.scripted.push({ script, match });
  }

  requestsTo(pathPart: string): PbRequest[] {
    return this.requests.filter((r) => r.path.includes(pathPart));
  }

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}${PREFIX}`;
    return this;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: Record<string, unknown> | null = null;
    try {
      const t = Buffer.concat(chunks).toString("utf-8");
      body = t ? (JSON.parse(t) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    const u = new URL(req.url ?? "/", "http://x");
    const rec: PbRequest = { path: u.pathname, method: req.method ?? "GET", query: u.search, headers: req.headers, body };
    this.requests.push(rec);

    const i = this.scripted.findIndex((s) => !s.match || s.match(rec));
    let out: PbScripted;
    if (i >= 0) {
      const { script } = this.scripted.splice(i, 1)[0];
      out = typeof script === "function" ? script(rec) : script;
    } else {
      out = this.route(rec);
    }
    if (out.delayMs) await new Promise((x) => setTimeout(x, out.delayMs));
    if (out.destroy) {
      req.socket.destroy();
      return;
    }
    res.writeHead(out.status, { "content-type": "application/json", ...(out.headers ?? {}) });
    res.end(out.body === undefined ? "" : JSON.stringify(out.body));
  }

  private err(rec: PbRequest, status: number, message: string): PbScripted {
    const m = this.echoKeys ? `${message} [${String(rec.body?.apikey)} / ${String(rec.body?.secretapikey)}]` : message;
    return { status, body: { status: "ERROR", message: m } };
  }

  private route(rec: PbRequest): PbScripted {
    if (rec.method !== "POST") return this.err(rec, 405, "POST required");
    if (rec.body?.apikey !== this.apiKey || rec.body?.secretapikey !== this.secretApiKey) {
      return this.err(rec, 400, "Invalid API key. (002)");
    }
    const parts = rec.path.slice(PREFIX.length).split("/").filter(Boolean).map(decodeURIComponent);
    const [a, b, zone, id] = parts;
    if (a === "ping") return { status: 200, body: { status: "SUCCESS", yourIp: "127.0.0.1" } };

    if (a === "dns") {
      const records = zone ? this.zones.get(zone) : undefined;
      if (!records) return this.err(rec, 400, `Domain is not opted in to API access.`);
      if (b === "retrieve") return { status: 200, body: { status: "SUCCESS", cloudflare: "enabled", records } };
      if (b === "create") {
        const name = String(rec.body?.name ?? "");
        const fqdn = name === "" ? zone : `${name}.${zone}`;
        const newRec: PbRecord = {
          id: String(this.nextId++),
          name: fqdn,
          type: String(rec.body?.type ?? ""),
          content: String(rec.body?.content ?? ""),
          ttl: String(rec.body?.ttl ?? "600"),
          prio: null,
          notes: "",
        };
        records.push(newRec);
        return { status: 200, body: { status: "SUCCESS", id: Number(newRec.id) } };
      }
      if (b === "delete" && id) {
        const idx = records.findIndex((r) => r.id === id);
        if (idx < 0) return this.err(rec, 400, "Invalid record id.");
        records.splice(idx, 1);
        return { status: 200, body: { status: "SUCCESS" } };
      }
    }

    if (a === "domain" && b === "checkDomain" && zone) {
      this.checksUsed++;
      if (this.checksUsed > this.checkLimit) {
        return this.err(rec, 400, `${this.checkLimit} out of ${this.checkLimit} checks within 10 seconds used.`);
      }
      const p = this.prices.get(zone) ?? { avail: "no", type: "registration", price: "0.00", premium: "no" };
      return {
        status: 200,
        body: {
          status: "SUCCESS",
          response: {
            avail: p.avail,
            type: p.type,
            price: p.price,
            firstYearPromo: "no",
            regularPrice: p.price,
            premium: p.premium,
            additional: { renewal: { type: "renewal", price: p.renewal ?? p.price, regularPrice: p.renewal ?? p.price } },
          },
          limits: { TTL: "10", limit: "1", used: this.checksUsed },
        },
      };
    }

    if (a === "domain" && b === "create" && zone) {
      const p = this.prices.get(zone);
      if (!p || p.avail !== "yes") return this.err(rec, 400, "Domain is not available.");
      const cents = Math.round(Number(p.price) * 100);
      if (rec.body?.agreeToTerms !== "yes") return this.err(rec, 400, "You must agree to the terms.");
      if (rec.body?.cost !== cents) return this.err(rec, 400, `The cost does not match the current price (${cents}).`);
      if (this.balanceCents < cents) return this.err(rec, 400, "Insufficient funds.");
      this.balanceCents -= cents;
      this.created.push({ domain: zone, cost: rec.body?.cost, agreeToTerms: rec.body?.agreeToTerms });
      this.autoRenew.set(zone, "on");
      p.avail = "no";
      return { status: 200, body: { status: "SUCCESS", domain: zone, cost: cents, orderId: this.orderId++, balance: this.balanceCents } };
    }
    if (a === "domain" && b === "updateAutoRenew" && zone) {
      const status = String(rec.body?.status ?? "");
      if (!this.autoRenew.has(zone)) {
        return { status: 200, body: { status: "SUCCESS", results: { [zone]: { status: "ERROR", message: "Domain not found in account." } } } };
      }
      if (status !== "on" && status !== "off") return this.err(rec, 400, "Invalid status.");
      this.autoRenew.set(zone, status);
      return { status: 200, body: { status: "SUCCESS", results: { [zone]: { status: "SUCCESS", message: "ok" } } } };
    }
    return this.err(rec, 404, "Unknown endpoint");
  }
}
