/**
 * The one transfer-status classifier the guarded client, the agent's tools
 * and the operator CLI share (review PAYMENTS-3).
 */

import { describe, expect, it } from "vitest";
import { classifyTransferStatus } from "../conway/transfer-status.js";
import { isRejectedTransferStatus } from "../treasury/guarded-conway.js";

describe("classifyTransferStatus", () => {
  it("rejects every refusal-style status", () => {
    for (const s of ["failed", "error", "rejected", "cancelled", "declined", "insufficient_funds", "denied", "invalid_recipient", "expired", "refused", "Reversed", "voided"]) {
      expect(classifyTransferStatus(s)).toBe("rejected");
      expect(isRejectedTransferStatus(s)).toBe(true);
    }
  });

  it("accepts only known success or in-progress statuses", () => {
    for (const s of ["completed", "Submitted", "pending", "processing", "succeeded", "success", "settled", " done ", "completed‮"]) {
      expect(classifyTransferStatus(s)).toBe("accepted");
    }
  });

  it("treats anything else as unknown", () => {
    for (const s of ["on_hold", "review", "", "???", 42, null, undefined]) {
      expect(classifyTransferStatus(s)).toBe("unknown");
      expect(isRejectedTransferStatus(s)).toBe(false);
    }
  });
});
