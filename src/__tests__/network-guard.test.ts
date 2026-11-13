/**
 * The test setup blocks every non-loopback fetch, socket and DNS lookup, and
 * keeps child git/npm processes off the network, so no test can reach a
 * public endpoint (Base mainnet RPC included).
 */

import { execFile } from "node:child_process";
import dns from "node:dns";
import { lookup as namedLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import tls from "node:tls";
import { describe, expect, it } from "vitest";

// Not imported from the setup file: these tests check that vitest loads it.
const isLoopbackTestHost = (host: string): boolean =>
  /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(host);

describe("F231: network guard", () => {
  it("rejects a fetch to Base mainnet before any socket opens", async () => {
    // Checked first, so without the setup file nothing is fetched for real.
    expect(isLoopbackTestHost(new URL(process.env.AUTOMATON_RPC_URL ?? "https://unset.invalid").hostname)).toBe(true);
    await expect(fetch("https://mainnet.base.org", { method: "POST", body: "{}" })).rejects.toThrow(
      /network disabled in tests: mainnet\.base\.org/,
    );
    await expect(fetch(new URL("https://example.com/x"))).rejects.toThrow(/network disabled in tests/);
  });

  it("points the default RPC URL at a closed local port", () => {
    const rpc = new URL(process.env.AUTOMATON_RPC_URL ?? "https://unset.invalid");
    expect(isLoopbackTestHost(rpc.hostname)).toBe(true);
  });

  it("lets loopback requests through", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe("ok");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(isLoopbackTestHost("[::1]")).toBe(true);
    expect(isLoopbackTestHost("localhost")).toBe(true);
    expect(isLoopbackTestHost("127.0.0.1.example.com")).toBe(false);
  });

  it("blocks node:https, tls and raw sockets to public hosts, not only fetch", async () => {
    const httpsErr = await new Promise<Error>((resolve) => {
      const req = https.request("https://cards.example.invalid/card.json", (res) => {
        res.resume();
        resolve(new Error(`unexpected response ${res.statusCode}`));
      });
      req.on("error", resolve);
      req.end();
    });
    expect(httpsErr.message).toMatch(/network disabled in tests: cards\.example\.invalid/);

    const tlsErr = await new Promise<Error>((resolve) => {
      const s = tls.connect({ host: "192.0.2.1", port: 443, servername: "cards.example.invalid" });
      s.on("error", resolve);
      s.on("secureConnect", () => resolve(new Error("connected")));
    });
    expect(tlsErr.message).toMatch(/network disabled in tests: 192\.0\.2\.1/);

    const rawErr = await new Promise<Error>((resolve) => {
      const s = net.connect(443, "cards.example.invalid");
      s.on("error", resolve);
      s.on("connect", () => resolve(new Error("connected")));
    });
    expect(rawErr.message).toMatch(/network disabled in tests/);
  });

  it("blocks node:http and node:https requests to IP literals at the socket, not only by DNS", async () => {
    for (const url of ["https://192.0.2.1/card.json", "http://192.0.2.1/card.json"]) {
      const mod = url.startsWith("https") ? https : http;
      const err = await new Promise<Error>((resolve) => {
        const req = mod.request(url, (res) => {
          res.resume();
          resolve(new Error(`unexpected response ${res.statusCode}`));
        });
        req.on("error", resolve);
        req.end();
      });
      expect(err.message).toMatch(/network disabled in tests: 192\.0\.2\.1/);
    }
  });

  it("blocks a pinned-address lookup that resolves a name to a public address", async () => {
    const err = await new Promise<Error>((resolve) => {
      const req = https.request(
        {
          host: "cards.example.invalid",
          path: "/card.json",
          lookup: ((_h: string, _o: unknown, cb: (e: null, a: string, f: number) => void) =>
            cb(null, "192.0.2.1", 4)) as unknown as https.RequestOptions["lookup"],
        },
        (res) => {
          res.resume();
          resolve(new Error(`unexpected response ${res.statusCode}`));
        },
      );
      req.on("error", resolve);
      req.end();
    });
    expect(err.message).toMatch(/network disabled in tests: 192\.0\.2\.1/);
  });

  it("refuses DNS lookups of public names, in every lookup form", async () => {
    await expect(dns.promises.lookup("cards.example.invalid")).rejects.toThrow(/network disabled in tests/);
    const err = await new Promise<Error | null>((resolve) => namedLookup("cards.example.invalid", (e) => resolve(e)));
    expect(err?.message).toMatch(/network disabled in tests/);
    expect((await dns.promises.lookup("localhost")).address).toMatch(/^(127\.|::1)/);
  });

  it("still allows loopback sockets", async () => {
    const server = net.createServer((sock) => sock.end("hi"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (server.address() as AddressInfo).port;
      const got = await new Promise<string>((resolve, reject) => {
        let data = "";
        const s = net.connect(port, "127.0.0.1");
        s.on("data", (d) => (data += d));
        s.on("end", () => resolve(data));
        s.on("error", reject);
      });
      expect(got).toBe("hi");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("keeps child git processes to local transports and turns off npm's update check", async () => {
    expect(process.env.npm_config_update_notifier).toBe("false");
    // A closed loopback port: without the guard git fails to connect instead.
    const stderr = await new Promise<string>((resolve) => {
      execFile("git", ["ls-remote", "https://127.0.0.1:9/x.git"], { timeout: 20_000 }, (_err, _out, errOut) =>
        resolve(String(errOut)),
      );
    });
    expect(stderr).toMatch(/transport 'https' not allowed/);
  });
});
