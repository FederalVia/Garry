/**
 * automaton-cli send <to-address> "message text"
 *
 * Send a signed message via the configured social relay with the automaton's
 * wallet (EVM or Solana), through the runtime social client: HTTPS relay (or
 * loopback HTTP), validated addresses and size, recipient case kept for
 * Solana. The relay is socialRelayUrl from automaton.json, else
 * SOCIAL_RELAY_URL, else the agent's own default (Conway's relay until
 * standalone mode makes it off). An empty socialRelayUrl means off.
 */

import { formatSendResult, loadRelayTarget, sendOperatorMessage } from "@conway/automaton/operator/send.js";
import { escapeForTerminal } from "@conway/automaton/observability/terminal-safe.js";

const args = process.argv.slice(3);
const toAddress = args[0];
const messageText = args.slice(1).join(" ");

try {
  if (!toAddress || !messageText) {
    console.log("Usage: automaton-cli send <to-address> <message>");
    console.log("  <to-address>  EVM (0x...) or Solana (base58, case-sensitive) address");
    console.log("Examples:");
    console.log('  automaton-cli send 0xabc...def "Hello, fellow automaton!"');
    process.exit(1);
  }

  // Resolved before any wallet is loaded.
  const target = loadRelayTarget();
  if (!target.ok) {
    console.error(`Failed to send message: ${escapeForTerminal(target.error, { keepNewlines: false })}`);
    process.exit(1);
  }
  const result = await sendOperatorMessage({
    relayUrl: target.relayUrl,
    to: toAddress,
    content: messageText,
    options: target.options,
  });
  // Relay-chosen text (error, id) is escaped for the terminal.
  const out = formatSendResult(result);
  for (const line of out.lines) (out.ok ? console.log : console.error)(line);
  if (!out.ok) process.exit(1);
} catch (err: any) {
  console.error(`Failed to send message: ${escapeForTerminal(err?.message || String(err), { keepNewlines: false })}`);
  process.exit(1);
}
