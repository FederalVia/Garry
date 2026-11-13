import { describe, it, expect } from "vitest";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  PREFIX_CONWAY,
  PREFIX_V1,
  canonicalPoll,
  canonicalSend,
  chainOf,
  normalize,
  parseIsoUtc,
  signatureFormatOk,
  verify,
} from "../src/protocol.js";

const EVM_LOWER = "0x" + "ab".repeat(20);
const EVM_MIXED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

describe("canonical strings", () => {
  it("send: exact text for both prefixes", () => {
    const hash = keccak256(toBytes("hello"));
    const at = "2026-03-01T12:00:00.000Z";
    expect(canonicalSend(PREFIX_V1, EVM_LOWER, "hello", at)).toBe(`Automaton/1:send:${EVM_LOWER}:${hash}:${at}`);
    expect(canonicalSend(PREFIX_CONWAY, EVM_LOWER, "hello", at)).toBe(`Conway:send:${EVM_LOWER}:${hash}:${at}`);
  });

  it("poll: v1 binds the nonce, Conway has none", () => {
    const at = "2026-03-01T12:00:00.000Z";
    const nonce = "0123456789abcdef0123456789abcdef";
    expect(canonicalPoll(PREFIX_V1, EVM_LOWER, at, nonce)).toBe(`Automaton/1:poll:${EVM_LOWER}:${at}:${nonce}`);
    expect(canonicalPoll(PREFIX_CONWAY, EVM_LOWER, at, nonce)).toBe(`Conway:poll:${EVM_LOWER}:${at}`);
    expect(canonicalPoll(PREFIX_CONWAY, EVM_LOWER, at)).toBe(`Conway:poll:${EVM_LOWER}:${at}`);
  });
});

describe("addresses", () => {
  it("EVM: lowercase and mixed case are EVM; wrong length or characters are not", () => {
    expect(chainOf(EVM_LOWER)).toBe("evm");
    expect(chainOf(EVM_MIXED)).toBe("evm");
    expect(chainOf("0x" + "ab".repeat(19))).toBeNull();
    expect(chainOf("0x" + "ab".repeat(21))).toBeNull();
    expect(chainOf("0x" + "zz".repeat(20))).toBeNull();
    expect(chainOf("")).toBeNull();
  });

  it("Solana: exactly 32 decoded bytes; 31 and 33 bytes are refused", () => {
    const key = bs58.encode(nacl.sign.keyPair().publicKey);
    expect(chainOf(key)).toBe("solana");
    expect(chainOf(bs58.encode(new Uint8Array(31).fill(7)))).toBeNull();
    expect(chainOf(bs58.encode(new Uint8Array(33).fill(7)))).toBeNull();
    expect(chainOf("0OIl" + key.slice(4))).toBeNull(); // not base58
    expect(chainOf("1".repeat(5000))).toBeNull(); // oversized input never reaches the decoder
  });

  it("normalize lowercases EVM and keeps Solana case", () => {
    expect(normalize(EVM_MIXED)).toBe(EVM_MIXED.toLowerCase());
    const key = bs58.encode(nacl.sign.keyPair().publicKey);
    expect(normalize(key)).toBe(key);
    expect(normalize("not-an-address")).toBeNull();
  });
});

describe("verify", () => {
  it("EVM: a good signature is true; tampered text, the wrong key and malformed hex are false", async () => {
    const alice = privateKeyToAccount(generatePrivateKey());
    const mallory = privateKeyToAccount(generatePrivateKey());
    const msg = canonicalSend(PREFIX_V1, EVM_LOWER, "hi", "2026-03-01T12:00:00.000Z");
    const sig = await alice.signMessage({ message: msg });
    expect(await verify(alice.address.toLowerCase(), msg, sig)).toBe(true);
    expect(await verify(alice.address, msg, sig)).toBe(true);
    expect(await verify(alice.address, msg + "x", sig)).toBe(false);
    expect(await verify(mallory.address, msg, sig)).toBe(false);
    expect(await verify(alice.address, msg, sig.slice(0, -2))).toBe(false);
    expect(await verify(alice.address, msg, "0x" + "zz".repeat(65))).toBe(false);
    expect(await verify(alice.address, msg, "")).toBe(false);
  });

  it("Solana: a good signature is true; tampered text, the wrong key and a 63-byte signature are false", async () => {
    const kp = nacl.sign.keyPair();
    const other = nacl.sign.keyPair();
    const addr = bs58.encode(kp.publicKey);
    const msg = "Automaton/1:send:x";
    const raw = nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey);
    const sig = bs58.encode(raw);
    expect(await verify(addr, msg, sig)).toBe(true);
    expect(await verify(addr, msg + "x", sig)).toBe(false);
    expect(await verify(bs58.encode(other.publicKey), msg, sig)).toBe(false);
    expect(await verify(addr, msg, bs58.encode(raw.slice(0, 63)))).toBe(false);
    expect(await verify(addr, msg, "0OIl")).toBe(false);
  });

  it("anything that throws or is not an address is false", async () => {
    expect(await verify("nope", "m", "0x" + "00".repeat(65))).toBe(false);
    expect(await verify(EVM_LOWER, "m", undefined as unknown as string)).toBe(false);
    expect(await verify(EVM_LOWER, "m", "0x" + "00".repeat(65))).toBe(false);
  });

  it("signature format check per chain", () => {
    expect(signatureFormatOk("evm", "0x" + "ab".repeat(65))).toBe(true);
    expect(signatureFormatOk("evm", "0x" + "ab".repeat(64))).toBe(false);
    expect(signatureFormatOk("solana", bs58.encode(new Uint8Array(64).fill(1)))).toBe(true);
    expect(signatureFormatOk("solana", bs58.encode(new Uint8Array(63).fill(1)))).toBe(false);
    expect(signatureFormatOk("solana", "0x" + "ab".repeat(65))).toBe(false);
  });
});

describe("timestamps", () => {
  it("accepts the client's ISO UTC form only", () => {
    expect(parseIsoUtc("2026-03-01T12:00:00.000Z")).toBe(Date.parse("2026-03-01T12:00:00.000Z"));
    expect(parseIsoUtc("2026-03-01T12:00:00Z")).not.toBeNull();
    expect(parseIsoUtc("2026-03-01T12:00:00+00:00")).toBeNull();
    expect(parseIsoUtc("2026-03-01 12:00:00Z")).toBeNull();
    expect(parseIsoUtc("1772366400000")).toBeNull();
    expect(parseIsoUtc(17)).toBeNull();
  });
});
