/**
 * Shared test helpers: a relay on 127.0.0.1:0 with a temp DB and an injected
 * clock, signers for both chains built on the relay's own protocol module,
 * and a node:http request helper (no proxy, raw headers allowed).
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createRelay, type Relay, type RelayOptions } from "../src/server.js";
import { PREFIX_V1, type Prefix, canonicalPoll, canonicalSend, normalize } from "../src/protocol.js";

export const T0 = Date.parse("2026-03-01T12:00:00.000Z");

export interface Clock {
  t: number;
  now: () => number;
  advance: (ms: number) => void;
}

export function makeClock(start = T0): Clock {
  const clock: Clock = {
    t: start,
    now: () => clock.t,
    advance: (ms) => {
      clock.t += ms;
    },
  };
  return clock;
}

export interface Signer {
  address: string;
  chain: "evm" | "solana";
  sign(message: string): Promise<string>;
}

export function evmSigner(): Signer {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    address: account.address.toLowerCase(),
    chain: "evm",
    sign: (message) => account.signMessage({ message }),
  };
}

export function solanaSigner(): Signer {
  const kp = nacl.sign.keyPair();
  return {
    address: bs58.encode(kp.publicKey),
    chain: "solana",
    sign: async (message) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)),
  };
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
}

export interface Harness {
  relay: Relay;
  url: string;
  clock: Clock;
  dir: string;
  dbPath: string;
  logs: string[];
  stop: () => Promise<void>;
}

/** Pre-auth IP limiting is effectively off unless a test sets it: every test client is 127.0.0.1. */
export async function startRelay(
  opts: Partial<RelayOptions> = {},
  clock: Clock = makeClock(),
  dir = tempDir(),
): Promise<Harness> {
  const dbPath = opts.dbPath ?? path.join(dir, "relay.db");
  const logs: string[] = [];
  const relay = createRelay({
    ...opts,
    dbPath,
    now: opts.now ?? clock.now,
    limits: { ipPerMinute: 1_000_000, ...opts.limits },
    log: opts.log ?? ((level, msg) => logs.push(`${level} ${msg}`)),
  });
  const url = await relay.listen(0, "127.0.0.1");
  return {
    relay,
    url,
    clock,
    dir,
    dbPath,
    logs,
    stop: async () => {
      await relay.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface SendPayload {
  from: string;
  to: string;
  content: string;
  signed_at: string;
  signature: string;
  reply_to?: string;
}

export async function signSend(
  signer: Signer,
  to: string,
  content: string,
  signedAtMs: number,
  opts: { prefix?: Prefix; replyTo?: string } = {},
): Promise<SendPayload> {
  const signedAt = new Date(signedAtMs).toISOString();
  const normalizedTo = normalize(to) ?? to;
  const signature = await signer.sign(canonicalSend(opts.prefix ?? PREFIX_V1, normalizedTo, content, signedAt));
  return { from: signer.address, to: normalizedTo, content, signed_at: signedAt, signature, reply_to: opts.replyTo };
}

export function freshNonce(): string {
  return randomBytes(16).toString("hex");
}

export async function pollHeaders(
  signer: Signer,
  atMs: number,
  opts: { prefix?: Prefix; nonce?: string | null } = {},
): Promise<Record<string, string>> {
  const prefix = opts.prefix ?? PREFIX_V1;
  const timestamp = new Date(atMs).toISOString();
  const headers: Record<string, string> = { "X-Wallet-Address": signer.address, "X-Timestamp": timestamp };
  if (prefix === PREFIX_V1) {
    const nonce = opts.nonce === undefined ? freshNonce() : opts.nonce;
    headers["X-Signature"] = await signer.sign(canonicalPoll(prefix, signer.address, timestamp, nonce ?? undefined));
    if (nonce !== null) headers["X-Auth-Nonce"] = nonce;
  } else {
    headers["X-Signature"] = await signer.sign(canonicalPoll(prefix, signer.address, timestamp));
  }
  return headers;
}

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: any;
  text: string;
}

export function request(
  url: string,
  route: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer; agent?: http.Agent } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${url}${route}`,
      { method: opts.method ?? "POST", headers: opts.headers, agent: opts.agent },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = undefined;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export function postJson(url: string, route: string, body: unknown, headers: Record<string, string> = {}) {
  return request(url, route, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function send(url: string, payload: unknown) {
  return postJson(url, "/v1/messages", payload);
}

export async function poll(h: Harness, signer: Signer, body: unknown = {}, headers?: Record<string, string>) {
  return postJson(h.url, "/v1/messages/poll", body, headers ?? (await pollHeaders(signer, h.clock.now())));
}

export function rowCount(h: Harness): number {
  return (h.relay.db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n;
}
