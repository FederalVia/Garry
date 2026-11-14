/**
 * finishShutdown closes the MCP servers after the workers drain and before
 * the state, lock and database are handled; a hung close cannot stall it.
 */

import { describe, expect, it } from "vitest";
import { finishShutdown } from "../../runtime/shutdown.js";

describe("finishShutdown and MCP", () => {
  it("runs closeMcp after drainWorkers and before leaveState", async () => {
    const order: string[] = [];
    let mcpMs = -1;
    await finishShutdown({
      remainingMs: () => 1_000,
      stopHeartbeat: () => order.push("stopHeartbeat"),
      drainHeartbeat: async () => order.push("drainHeartbeat"),
      drainWorkers: async () => order.push("drainWorkers"),
      closeMcp: async (ms) => {
        mcpMs = ms;
        order.push("closeMcp");
      },
      leaveState: () => order.push("leaveState"),
      releaseLock: () => order.push("releaseLock"),
      closeDb: () => order.push("closeDb"),
    });
    expect(order).toEqual(["stopHeartbeat", "drainHeartbeat", "drainWorkers", "closeMcp", "leaveState", "releaseLock", "closeDb"]);
    expect(mcpMs).toBe(1_000);
  });

  it("a close that never settles is cut off at the deadline", async () => {
    const order: string[] = [];
    const started = Date.now();
    await finishShutdown({
      remainingMs: () => Math.max(0, 300 - (Date.now() - started)),
      stopHeartbeat: () => undefined,
      drainHeartbeat: async () => undefined,
      drainWorkers: async () => undefined,
      closeMcp: () => new Promise(() => undefined),
      leaveState: () => order.push("leaveState"),
      releaseLock: () => order.push("releaseLock"),
      closeDb: () => order.push("closeDb"),
    });
    expect(order).toEqual(["leaveState", "releaseLock", "closeDb"]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
