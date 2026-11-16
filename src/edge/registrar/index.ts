/** Optional automated domain registration (Porkbun). The fake is in ./fake.ts. */

import type { RegistrarClient, ResolvedRegistrarConfig } from "../types.js";
import { PorkbunRegistrar, type PorkbunRegistrarDeps } from "./porkbun.js";

export { parseRegistrarSection, REGISTRAR_DEFAULT_API_URL, REGISTRAR_DEFAULTS, REGISTRAR_ENV_NAMES } from "./config.js";
export { MAX_SEARCH_NAMES, PorkbunRegistrar, QUOTE_CACHE_MS, RegistrarRefusedError } from "./porkbun.js";
export { parsePriceCents, PorkbunRegistrarApi } from "./raw-client.js";

export function createRegistrarClient(cfg: ResolvedRegistrarConfig, deps: PorkbunRegistrarDeps = {}): RegistrarClient {
  return new PorkbunRegistrar(cfg, deps);
}
