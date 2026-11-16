/**
 * Environment for child processes the agent's tools start. The runtime
 * copies its API keys into process.env, and a child inherits everything, so
 * `env` or `printenv` in a tool command would show them.
 */

const CREDENTIAL_NAME = /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIALS?)($|_)/i;
// Run-together names the rule above misses (NGROK_AUTHTOKEN, PORKBUN_SECRETAPIKEY).
const CREDENTIAL_SUFFIX = /(?:APIKEY|AUTHTOKEN|SECRETKEY|SECRETAPIKEY|ACCESSTOKEN)$/i;

const RUNTIME_SECRET_NAMES = new Set([
  "CONWAY_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "TOGETHER_API_KEY",
  "OPENAI_BASE_URL",
]);

// Variables the owner named for one child only (a tunnel's passEnv). Their
// names need not look like credentials, so they are listed, not guessed.
const WITHHELD_NAMES = new Set<string>();

// Proxy, certificate and locale settings every child is meant to share.
const SHARED_NAME =
  /^(?:HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|TMPDIR)$/i;

/** True for a setting children keep by design; it is not a credential to hold back or mask. */
export function isSharedEnvName(name: string): boolean {
  return SHARED_NAME.test(name);
}

/**
 * Keep these variables out of every child built by childProcessEnv. Shared
 * settings are skipped: naming HTTPS_PROXY for a tunnel must not take the
 * proxy away from the agent's commands.
 */
export function withholdFromChildren(names: Iterable<string>): void {
  for (const n of names) {
    if (typeof n === "string" && n && !isSharedEnvName(n)) WITHHELD_NAMES.add(n.toUpperCase());
  }
}

/** Copy of base without credentials. PATH, HOME, proxy and locale variables are kept. */
export function childProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (RUNTIME_SECRET_NAMES.has(name.toUpperCase())) continue;
    if (WITHHELD_NAMES.has(name.toUpperCase())) continue;
    if (CREDENTIAL_NAME.test(name) || CREDENTIAL_SUFFIX.test(name)) continue;
    out[name] = value;
  }
  return out;
}
