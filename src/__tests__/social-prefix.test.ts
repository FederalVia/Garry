/**
 * The versioned signed prefix: "Automaton/1" by default, the legacy
 * "Conway" form only when local configuration accepts it. Keys are generated
 * per run and fetch is stubbed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes, verifyMessage } from "viem";
import {
  PREFIX_CONWAY,
  PREFIX_V1,
  canonicalPollMessage,
  canonicalSendMessage,
  signSendPayload,
} from "../social/signing.js";
import { matchSignedPrefix, verifyMessageSignature } from "../social/protocol.js";
import { classifyInbound } from "../social/inbound.js";
import { createSocialClient } from "../social/client.js";
import { describeRelay, relayProtocol, resolveRelayClientOptions } from "../social/settings.js";
import { SolanaChainIdentity } from "../identity/chain.js";

const self = privateKeyToAccount(generatePrivateKey());
const peer = privateKeyToAccount(generatePrivateKey());

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signedMessage(prefix?: typeof PREFIX_V1 | typeof PREFIX_CONWAY, id = "m1") {
  const p = await signSendPayload(peer, self.address, "hello there", undefined, prefix ? { prefix } : {});
  return { id, from: p.from, to: p.to, content: p.content, signature: p.signature, signed_at: p.signed_at };
}

describe("signing", () => {
  it("signSendPayload signs Automaton/1 by default", async () => {
    const p = await signSendPayload(peer, self.address, "hi");
    const v1 = `Automaton/1:send:${self.address.toLowerCase()}:${keccak256(toBytes("hi"))}:${p.signed_at}`;
    expect(await verifyMessage({ address: peer.address, message: v1, signature: p.signature as `0x${string}` })).toBe(true);
    const old = `Conway:send:${self.address.toLowerCase()}:${keccak256(toBytes("hi"))}:${p.signed_at}`;
    expect(await verifyMessage({ address: peer.address, message: old, signature: p.signature as `0x${string}` })).toBe(false);
  });

  it("signSendPayload signs the Conway form when asked", async () => {
    const p = await signSendPayload(peer, self.address, "hi", undefined, { prefix: "Conway" });
    const old = `Conway:send:${self.address.toLowerCase()}:${keccak256(toBytes("hi"))}:${p.signed_at}`;
    expect(await verifyMessage({ address: peer.address, message: old, signature: p.signature as `0x${string}` })).toBe(true);
  });

  it("canonical strings for both prefixes", () => {
    const h = keccak256(toBytes("x"));
    expect(canonicalSendMessage("0xABCDEF0000000000000000000000000000000001", "x", "T")).toBe(
      `Automaton/1:send:0xabcdef0000000000000000000000000000000001:${h}:T`,
    );
    expect(canonicalSendMessage("0xABCDEF0000000000000000000000000000000001", "x", "T", "Conway")).toBe(
      `Conway:send:0xabcdef0000000000000000000000000000000001:${h}:T`,
    );
    expect(canonicalPollMessage("0xabc", "2026-01-01T00:00:00.000Z", "Automaton/1", "ff00")).toBe(
      "Automaton/1:poll:0xabc:2026-01-01T00:00:00.000Z:ff00",
    );
    expect(canonicalPollMessage("0xabc", "2026-01-01T00:00:00.000Z", "Conway")).toBe(
      "Conway:poll:0xabc:2026-01-01T00:00:00.000Z",
    );
    expect(() => canonicalPollMessage("0xabc", "T", "Automaton/1")).toThrow(/nonce/);
  });

  it("Solana base58 recipients keep their case under both prefixes", async () => {
    const sol = new SolanaChainIdentity(nacl.sign.keyPair().secretKey);
    const p = await signSendPayload(peer, sol.address, "hi");
    expect(p.to).toBe(sol.address);
    expect(canonicalSendMessage(sol.address, "hi", "T", "Conway")).toContain(`:send:${sol.address}:`);
  });
});

describe("matchSignedPrefix", () => {
  it("returns the prefix that verifies, within the accepted set only", async () => {
    const v1 = await signedMessage();
    const conway = await signedMessage("Conway");
    const msg = (m: typeof v1) => ({ to: self.address, content: m.content, signed_at: m.signed_at, signature: m.signature });
    expect(await matchSignedPrefix(msg(v1), peer.address)).toBe("Automaton/1");
    expect(await matchSignedPrefix(msg(conway), peer.address)).toBeNull();
    expect(await matchSignedPrefix(msg(conway), peer.address, [PREFIX_V1, PREFIX_CONWAY])).toBe("Conway");
    expect(await matchSignedPrefix(msg(v1), peer.address, [PREFIX_CONWAY])).toBeNull();
    expect(await verifyMessageSignature(msg(conway), peer.address)).toBe(false);
    expect(await verifyMessageSignature(msg(conway), peer.address, [PREFIX_CONWAY])).toBe(true);
    // The wrong sender never matches.
    expect(await matchSignedPrefix(msg(v1), self.address, [PREFIX_V1, PREFIX_CONWAY])).toBeNull();
  });
});

describe("classifyInbound with accepted prefixes", () => {
  it("an Automaton/1 message is verified by default", async () => {
    const v = await classifyInbound(await signedMessage(), self.address);
    expect(v.verdict).toBe("verified");
  });

  it("a Conway-signed message with compat off is rejected as a bad signature", async () => {
    const v = await classifyInbound(await signedMessage("Conway"), self.address);
    expect(v).toEqual({ verdict: "rejected", reason: "bad_signature" });
  });

  it("with acceptPrefixes [Automaton/1, Conway] a Conway-signed message is verified", async () => {
    const v = await classifyInbound(await signedMessage("Conway"), self.address, Date.now(), {
      acceptPrefixes: [PREFIX_V1, PREFIX_CONWAY],
    });
    expect(v.verdict).toBe("verified");
  });

  it("sigHash covers the prefix that verified: different across prefixes, stable for a replay", async () => {
    const accept = { acceptPrefixes: [PREFIX_V1, PREFIX_CONWAY] as const };
    const v1 = await signedMessage();
    // The same content and time under the other prefix.
    const conwaySig = await peer.signMessage({ message: canonicalSendMessage(self.address, v1.content, v1.signed_at, "Conway") });
    const conway = { ...v1, id: "m2", signature: conwaySig };
    const a = await classifyInbound(v1, self.address, Date.now(), accept);
    const b = await classifyInbound(conway, self.address, Date.now(), accept);
    const replay = await classifyInbound({ ...v1, id: "replayed" }, self.address, Date.now(), accept);
    expect(a.verdict).toBe("verified");
    expect(b.verdict).toBe("verified");
    if (a.verdict !== "verified" || b.verdict !== "verified" || replay.verdict !== "verified") throw new Error("unreachable");
    expect(a.sigHash).not.toBe(b.sigHash);
    expect(replay.sigHash).toBe(a.sigHash);
  });

  it("the client's poll drops a Conway-signed message when compat is off, and keeps it when on", async () => {
    const conway = await signedMessage("Conway", "c1");
    const v1 = await signedMessage(undefined, "v1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ messages: [conway, v1] }), { status: 200 })),
    );
    const strict = await createSocialClient("https://relay.example.com", self).poll();
    expect(strict.messages.map((m) => [m.id, m.verified])).toEqual([["v1", true]]);
    const compat = await createSocialClient("https://relay.example.com", self, { conwayCompat: true }).poll();
    expect(compat.messages.map((m) => [m.id, m.verified])).toEqual([
      ["c1", true],
      ["v1", true],
    ]);
  });
});

describe("resolveRelayClientOptions", () => {
  it("social.conway.tech (and other conway.tech hosts) gives compat", () => {
    expect(resolveRelayClientOptions({ socialRelayUrl: "https://social.conway.tech" })).toEqual({ conwayCompat: true });
    expect(resolveRelayClientOptions({ socialRelayUrl: "https://conway.tech/" })).toEqual({ conwayCompat: true });
    expect(resolveRelayClientOptions({ socialRelayUrl: "https://SOCIAL.CONWAY.TECH." })).toEqual({ conwayCompat: true });
  });

  it("an own relay gives strict Automaton/1", () => {
    expect(resolveRelayClientOptions({ socialRelayUrl: "http://127.0.0.1:8787" })).toEqual({ conwayCompat: false });
    expect(resolveRelayClientOptions({ socialRelayUrl: "https://relay.example.com" })).toEqual({ conwayCompat: false });
    expect(resolveRelayClientOptions({})).toEqual({ conwayCompat: false });
  });

  it("an explicit boolean wins either way", () => {
    expect(resolveRelayClientOptions({ socialRelayUrl: "http://127.0.0.1:8787", relay: { conwayCompat: true } })).toEqual({ conwayCompat: true });
    expect(resolveRelayClientOptions({ socialRelayUrl: "https://social.conway.tech", relay: { conwayCompat: false } })).toEqual({ conwayCompat: false });
  });

  it("look-alike hosts are not Conway's", () => {
    for (const url of [
      "https://social.conway.tech.evil.example",
      "https://evilconway.tech",
      "https://conway.tech@evil.example",
      "not a url",
    ]) {
      expect(resolveRelayClientOptions({ socialRelayUrl: url }), url).toEqual({ conwayCompat: false });
    }
  });

  it("a non-boolean conwayCompat counts as unset", () => {
    for (const v of ["true", 1, null, {}]) {
      expect(resolveRelayClientOptions({ socialRelayUrl: "http://127.0.0.1:8787", relay: { conwayCompat: v } })).toEqual({ conwayCompat: false });
      expect(resolveRelayClientOptions({ socialRelayUrl: "https://social.conway.tech", relay: { conwayCompat: v } })).toEqual({ conwayCompat: true });
    }
  });

  it("relayProtocol and describeRelay", () => {
    expect(relayProtocol({ conwayCompat: false })).toEqual({ sendPrefix: "Automaton/1", pollPrefix: "Automaton/1", acceptPrefixes: ["Automaton/1"], requireSignature: true });
    expect(relayProtocol({ conwayCompat: true })).toEqual({ sendPrefix: "Conway", pollPrefix: "Conway", acceptPrefixes: ["Automaton/1", "Conway"], requireSignature: false });
    expect(describeRelay({ socialRelayUrl: "http://127.0.0.1:8787" })).toBe("http://127.0.0.1:8787 (automaton/1)");
    expect(describeRelay({ socialRelayUrl: "https://social.conway.tech" })).toMatch(/\(conway, accepts automaton\/1 and conway\)$/);
    expect(describeRelay({ socialRelayUrl: "" })).toBe("off");
  });
});
