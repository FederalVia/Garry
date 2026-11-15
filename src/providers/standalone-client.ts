/**
 * The ConwayClient used when there is no Conway account. Commands, files and
 * ports run on this machine exactly as in today's local mode; every
 * Conway-only call throws FEATURE_DISABLED before any I/O, so nothing can
 * reach api.conway.tech by accident.
 *
 * With the owner's budget, getCreditsBalance reports what the budget has
 * left this period (never below 0), so the heartbeat, the loop, the tools
 * and the treasury see it through their existing balance reads.
 *
 * Not wrapped in the treasury guard: it cannot move value, and the guard
 * would record ledger rows and turn the clear error into a balance error.
 */

import type { ConwayClient } from "../types.js";
import { createConwayClient } from "../conway/client.js";
import { FeatureDisabledError } from "./features.js";

export { FeatureDisabledError } from "./features.js";

const CONWAY_KEY_SETTING = "providers.conway.apiKey";

export interface StandaloneClientOptions {
  /** The budget meter; without it the balance is FEATURE_DISABLED. */
  budget?: { snapshot(): { remainingCents: number } };
}

export function createStandaloneClient(opts: StandaloneClientOptions = {}): ConwayClient {
  // An empty sandbox id selects the local branches, which make no HTTP call.
  const local = createConwayClient({ apiUrl: "", apiKey: "", sandboxId: "" });
  const disabled = (feature: string) => async (): Promise<never> => {
    throw new FeatureDisabledError(feature, CONWAY_KEY_SETTING);
  };
  return {
    exec: (command, timeout) => local.exec(command, timeout),
    writeFile: (path, content) => local.writeFile(path, content),
    readFile: (path) => local.readFile(path),
    exposePort: (port) => local.exposePort(port),
    removePort: (port) => local.removePort(port),
    createSandbox: disabled("sandboxes"),
    deleteSandbox: disabled("sandboxes"),
    listSandboxes: disabled("sandboxes"),
    getCreditsBalance: opts.budget
      ? async () => Math.max(0, opts.budget!.snapshot().remainingCents)
      : disabled("Conway credits"),
    getCreditsPricing: disabled("Conway credits"),
    transferCredits: disabled("credit transfers"),
    registerAutomaton: disabled("Conway registration"),
    searchDomains: disabled("domains"),
    registerDomain: disabled("domains"),
    listDnsRecords: disabled("DNS"),
    addDnsRecord: disabled("DNS"),
    deleteDnsRecord: disabled("DNS"),
    listModels: disabled("Conway model discovery"),
    createScopedClient: () => {
      throw new FeatureDisabledError("child sandboxes", CONWAY_KEY_SETTING);
    },
  };
}
