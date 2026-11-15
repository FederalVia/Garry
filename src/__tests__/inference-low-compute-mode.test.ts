/**
 * Low-compute mode of the inference client (the live code once in
 * low-compute.test.ts; the tests of the deleted src/survival/ module went
 * with it).
 */
import { describe, it, expect } from "vitest";
import { createInferenceClient } from "../conway/inference.js";

describe("createInferenceClient setLowComputeMode", () => {
  const baseOptions = {
    apiUrl: "https://api.conway.tech",
    apiKey: "test-key",
    defaultModel: "gpt-5.2",
    maxTokens: 4096,
  };

  it("uses lowComputeModel when provided", () => {
    const client = createInferenceClient({
      ...baseOptions,
      lowComputeModel: "gpt-5-mini",
    });
    client.setLowComputeMode(true);
    expect(client.getDefaultModel()).toBe("gpt-5-mini");
  });

  it("falls back to gpt-5-mini when no lowComputeModel is provided", () => {
    const client = createInferenceClient(baseOptions);
    client.setLowComputeMode(true);
    expect(client.getDefaultModel()).toBe("gpt-5-mini");
  });

  it("restores defaultModel when low compute mode is disabled", () => {
    const client = createInferenceClient({
      ...baseOptions,
      lowComputeModel: "gpt-5-mini",
    });
    client.setLowComputeMode(true);
    expect(client.getDefaultModel()).toBe("gpt-5-mini");
    client.setLowComputeMode(false);
    expect(client.getDefaultModel()).toBe("gpt-5.2");
  });
});
