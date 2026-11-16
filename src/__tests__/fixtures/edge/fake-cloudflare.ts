/**
 * Loopback fake of the Cloudflare v4 API subset the DNS adapter uses:
 * zones (by name, by id), dns_records list/create/delete, pagination,
 * error envelopes, a request log, scripted responses and an echo mode that
 * repeats the Authorization header in error messages.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface ScriptedResponse {
  status: number;
  body?: unknown;
  /** Sent as is instead of JSON. */
  raw?: string | Buffer;
  headers?: Record<string, string>;
  /** Wait before answering. */
  delayMs?: number;
  /** Close the socket without an answer. */
  destroy?: boolean;
}

type Script = ScriptedResponse | ((req: RecordedRequest) => ScriptedResponse);

interface CfZone {
  id: string;
  name: string;
}

export interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  comment?: string;
}

const PREFIX = "/client/v4";

export class FakeCloudflare {
  readonly token: string;
  readonly requests: RecordedRequest[] = [];
  readonly zones: CfZone[] = [];
  readonly records = new Map<string, CfRecord[]>();
  /** Repeat the Authorization header in every error message. */
  echoAuth = false;
  private scripted: { match?: (r: RecordedRequest) => boolean; script: Script }[] = [];
  private server: http.Server | null = null;
  private sockets = new Set<import("node:net").Socket>();
  url = "";

  constructor(opts: { token?: string; zones?: string[] } = {}) {
    this.token = opts.token ?? "cf-test-token-0123456789abcdef";
    for (const z of opts.zones ?? ["example.com"]) this.addZone(z);
  }

  addZone(name: string): string {
    const id = randomBytes(16).toString("hex");
    this.zones.push({ id, name });
    this.records.set(id, []);
    return id;
  }

  zoneId(name: string): string {
    const z = this.zones.find((x) => x.name === name);
    if (!z) throw new Error(`no zone ${name}`);
    return z.id;
  }

  seed(zone: string, r: Omit<CfRecord, "id">): CfRecord {
    const rec = { ...r, id: randomBytes(16).toString("hex") };
    this.records.get(this.zoneId(zone))!.push(rec);
    return rec;
  }

  recordsOf(zone: string): CfRecord[] {
    return this.records.get(this.zoneId(zone)) ?? [];
  }

  /** The next matching request gets this answer instead of the normal one. */
  respondNext(script: Script, match?: (r: RecordedRequest) => boolean): void {
    this.scripted.push({ script, match });
  }

  requestsTo(method: string, pathPart: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.path.includes(pathPart));
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
    const text = Buffer.concat(chunks).toString("utf-8");
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    const u = new URL(req.url ?? "/", "http://x");
    const rec: RecordedRequest = {
      method: req.method ?? "GET",
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: req.headers,
      body,
    };
    this.requests.push(rec);

    const i = this.scripted.findIndex((s) => !s.match || s.match(rec));
    if (i >= 0) {
      const { script } = this.scripted.splice(i, 1)[0];
      const r = typeof script === "function" ? script(rec) : script;
      if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
      if (r.destroy) {
        req.socket.destroy();
        return;
      }
      res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(r.raw ?? (r.body === undefined ? "" : JSON.stringify(r.body)));
      return;
    }
    const out = this.route(rec);
    res.writeHead(out.status, { "content-type": "application/json", ...(out.headers ?? {}) });
    res.end(JSON.stringify(out.body));
  }

  private error(rec: RecordedRequest, status: number, code: number, message: string): ScriptedResponse {
    const m = this.echoAuth ? `${message} (${String(rec.headers.authorization)})` : message;
    return { status, body: { success: false, errors: [{ code, message: m }], messages: [], result: null } };
  }

  private ok(result: unknown, info?: Record<string, number>): ScriptedResponse {
    return { status: 200, body: { success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) } };
  }

  private page<T>(items: T[], q: Record<string, string>): ScriptedResponse {
    const perPage = Math.max(1, Math.min(Number(q.per_page ?? 20), 5000));
    const page = Math.max(1, Number(q.page ?? 1));
    const slice = items.slice((page - 1) * perPage, page * perPage);
    return this.ok(slice, {
      page,
      per_page: perPage,
      count: slice.length,
      total_count: items.length,
      total_pages: Math.max(1, Math.ceil(items.length / perPage)),
    });
  }

  private route(rec: RecordedRequest): ScriptedResponse {
    if (rec.headers.authorization !== `Bearer ${this.token}`) return this.error(rec, 403, 9109, "Invalid access token");
    if (!rec.path.startsWith(PREFIX)) return this.error(rec, 404, 7000, "No route for that URI");
    const parts = rec.path.slice(PREFIX.length).split("/").filter(Boolean);
    if (parts[0] !== "zones") return this.error(rec, 404, 7000, "No route for that URI");

    if (parts.length === 1 && rec.method === "GET") {
      const zones = rec.query.name ? this.zones.filter((z) => z.name === rec.query.name) : this.zones;
      return this.page(zones, rec.query);
    }
    const zone = this.zones.find((z) => z.id === parts[1]);
    if (!zone) return this.error(rec, 404, 7003, "Could not route to /zones/x, perhaps your object identifier is invalid?");
    if (parts.length === 2 && rec.method === "GET") return this.ok(zone);
    if (parts[2] !== "dns_records") return this.error(rec, 404, 7000, "No route for that URI");
    const list = this.records.get(zone.id)!;

    if (parts.length === 3 && rec.method === "GET") return this.page(list, rec.query);
    if (parts.length === 3 && rec.method === "POST") {
      const b = (rec.body ?? {}) as Partial<CfRecord>;
      if (!b.type || !b.name || typeof b.content !== "string" || typeof b.ttl !== "number") {
        return this.error(rec, 400, 9000, "DNS name, type and content are required");
      }
      if (b.name !== zone.name && !b.name.endsWith(`.${zone.name}`)) return this.error(rec, 400, 9005, "Content for name is invalid");
      if (list.some((r) => r.type === b.type && r.name === b.name && r.content === b.content)) {
        return this.error(rec, 400, 81057, "Record already exists.");
      }
      const created: CfRecord = {
        id: randomBytes(16).toString("hex"),
        type: b.type,
        name: b.name,
        content: b.content,
        ttl: b.ttl,
        ...(b.proxied !== undefined ? { proxied: b.proxied } : {}),
        ...(b.comment !== undefined ? { comment: b.comment } : {}),
      };
      list.push(created);
      return this.ok(created);
    }
    if (parts.length === 4 && rec.method === "DELETE") {
      const idx = list.findIndex((r) => r.id === parts[3]);
      if (idx < 0) return this.error(rec, 404, 81044, "Record does not exist.");
      list.splice(idx, 1);
      return this.ok({ id: parts[3] });
    }
    return this.error(rec, 405, 10000, "Method not allowed");
  }
}
