/**
 * The token-count cache never keeps copies of large texts and bounds the
 * total size of its keys.
 */

import { describe, it, expect } from "vitest";
import { createTokenCounter } from "../../memory/context-manager.js";

function bigText(seed: number): string {
  // Short words, so tokenizing stays fast.
  const words = Array.from({ length: 14_000 }, (_, i) => `w${(i * 7 + seed) % 97}`);
  return `${seed} ${words.join(" ")}`.slice(0, 50_000);
}

describe("token cache bounds", () => {
  it("a large text is cached under a short key", () => {
    const counter = createTokenCounter();
    const text = bigText(1);
    expect(text.length).toBe(50_000);
    const first = counter.countTokens(text);
    expect(counter.countTokens(text)).toBe(first);
    for (const key of counter.cache.keys()) expect(key.length).toBeLessThanOrEqual(300);
    // Short texts keep their readable key.
    counter.countTokens("hello");
    expect(counter.cache.has("default::hello")).toBe(true);
  });

  it("the total key length stays under the cap after many large texts", () => {
    const counter = createTokenCounter();
    for (let i = 0; i < 200; i++) counter.countTokens(bigText(i));
    let total = 0;
    for (const key of counter.cache.keys()) total += key.length;
    expect(total).toBeLessThan(2_000_000);
    expect(counter.cache.size).toBe(200);
  }, 120_000);
});
