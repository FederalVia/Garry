/**
 * security: docs/public-access.md says what the runtime really does with the
 * owner's DNS, registrar and tunnel credentials. The agent's commands run as
 * the runtime's user, so the page must not claim the agent cannot read them,
 * and must name the provider-side limits that do hold.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const doc = fs.readFileSync(path.join(ROOT, "docs", "public-access.md"), "utf8");
const flat = doc.replace(/\s+/g, " ");
const section = (title: string): string => {
  const start = doc.indexOf(`## ${title}`);
  expect(start, title).toBeGreaterThanOrEqual(0);
  const next = doc.indexOf("\n## ", start + 1);
  return doc.slice(start, next < 0 ? undefined : next).replace(/\s+/g, " ");
};

describe("docs/public-access.md", () => {
  it("does not claim the agent cannot read the credentials", () => {
    for (const claim of [
      /never enters the process environment, a child process/,
      /a file on the host the agent never sees/,
      /tool children never get them/,
      /so the agent never sees it/,
      /Real isolation is the container/,
    ]) {
      expect(flat, String(claim)).not.toMatch(claim);
    }
  });

  it("says a command can read them and act outside the policy and the treasury, and names the limits that hold", () => {
    const s = section("What these limits do not stop");
    expect(s).toMatch(/can read anything the runtime can read/);
    expect(s).toContain("`automaton.json`");
    expect(s).toContain("`/proc/<pid>/environ`");
    expect(s).toContain("`~/.automaton/public-access/`");
    expect(s).toMatch(/outside the zone policy, the change caps, the infrastructure caps and the budget, and with no ledger row/);
    expect(s).toMatch(/a token limited to this one zone/);
    expect(s).toMatch(/API access enabled on this one domain only/);
    expect(s).toMatch(/a small account balance/);
    expect(s).toMatch(/process under another user.*future work/);
    // Every place that describes what the runtime withholds points here.
    expect(flat.match(/\(#what-these-limits-do-not-stop\)/g)!.length).toBeGreaterThanOrEqual(5);
  });

  it("says which variables tool children lose", () => {
    expect(flat).toMatch(/A variable named in `passEnv` is for the tunnel only: the runtime leaves it out of the environment of every other child/);
  });

  it("says approvals do not cover a domain purchase and which turns can buy", () => {
    const s = section("Domain registration (off unless enabled)");
    expect(s).toMatch(/`treasuryPolicy\.requireConfirmationAboveCents` and the approvals the owner CLI lists cover credit transfers only/);
    expect(s).toMatch(/never held for approval/);
    expect(s).toMatch(/including a scheduled \(heartbeat\) wake-up/);
    expect(s).toMatch(/a turn that handles an inbox message can only reply/);
  });

  it("lists every loopback endpoint the runtime reserves, the wildcard rule and the CNAME limit", () => {
    expect(flat).toContain("`OPENAI_BASE_URL`");
    expect(flat).toMatch(/in Conway mode, a loopback provider in `inference-providers\.json`/);
    expect(flat).toMatch(/refused `DNS_NAME_HELD_BY_OWNER`/);
    expect(flat).toMatch(/CNAME targets are checked by name only .* they are not resolved/);
    expect(flat).toMatch(/A stop request .* ends a tunnel start that is still waiting for its URL at once/);
  });
});
