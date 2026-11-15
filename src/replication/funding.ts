/**
 * Child bookkeeping after a committed funding transfer. Shared by fund_child
 * and the heartbeat step that executes an owner-approved fund_child, so a
 * child funded either way is recorded once and the agent does not ask again.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { ChildLifecycle } from "./lifecycle.js";

export function recordChildFunded(db: DatabaseType, childId: string, amountCents: number): boolean {
  const row = db.prepare("SELECT status FROM children WHERE id = ?").get(childId) as { status: string } | undefined;
  if (!row) return false;
  db.prepare("UPDATE children SET funded_amount_cents = funded_amount_cents + ? WHERE id = ?").run(amountCents, childId);
  if (row.status === "wallet_verified") {
    try {
      new ChildLifecycle(db).transition(childId, "funded", `funded with ${amountCents} cents`);
    } catch {
      // Non-critical: may already be in funded state
    }
  }
  return true;
}
