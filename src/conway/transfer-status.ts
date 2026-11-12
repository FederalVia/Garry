/**
 * Credit transfer status: the one classifier the guarded client, the agent's
 * tools and the operator CLI share for a 2xx answer's `status` field.
 *
 * - "rejected": the status says the transfer did not happen.
 * - "accepted": a status known to mean it was taken (done or in progress).
 * - "unknown": anything else. Nothing proves credits did or did not move, so
 *   callers hold the amount as spent but do not report success.
 */

export type TransferStatusClass = "accepted" | "rejected" | "unknown";

const REJECTED_RE = /fail|error|reject|cancel|declin|insufficient|denied|deny|refus|invalid|expired|revers|void/i;

const ACCEPTED = new Set([
  "submitted",
  "pending",
  "processing",
  "queued",
  "accepted",
  "completed",
  "complete",
  "succeeded",
  "success",
  "successful",
  "settled",
  "confirmed",
  "transferred",
  "sent",
  "done",
  "ok",
]);

export function classifyTransferStatus(status: unknown): TransferStatusClass {
  if (typeof status !== "string") return "unknown";
  // Case, separators and stray invisible characters do not change the meaning.
  const s = status
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z_]/g, "")
    .replace(/^_+|_+$/g, "");
  if (REJECTED_RE.test(s)) return "rejected";
  if (ACCEPTED.has(s)) return "accepted";
  return "unknown";
}
