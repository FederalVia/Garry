/**
 * Environment for child processes the agent's tools start. The runtime
 * copies its API keys into process.env, and a child inherits everything, so
 * `env` or `printenv` in a tool command would show them.
 */

const CREDENTIAL_NAME = /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIALS?)($|_)/i;

const RUNTIME_SECRET_NAMES = new Set([
  "CONWAY_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "TOGETHER_API_KEY",
  "OPENAI_BASE_URL",
]);

/** Copy of base without credentials. PATH, HOME, proxy and locale variables are kept. */
export function childProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (RUNTIME_SECRET_NAMES.has(name.toUpperCase())) continue;
    if (CREDENTIAL_NAME.test(name)) continue;
    out[name] = value;
  }
  return out;
}
