/**
 * automaton-cli send <to-address> "message text"
 *
 * Send a signed message via the social relay with the automaton's wallet
 * (EVM or Solana), through the runtime social client: HTTPS relay only,
 * validated addresses and size, recipient case kept for Solana.
 */

import { loadConfig } from "@conway/automaton/config.js";
import { formatSendResult, resolveRelayUrl, sendOperatorMessage } from "@conway/automaton/operator/send.js";
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

  const relayUrl = resolveRelayUrl(loadConfig());
  const result = await sendOperatorMessage({ relayUrl, to: toAddress, content: messageText });
  // Relay-chosen text (error, id) is escaped for the terminal.
  const out = formatSendResult(result);
  for (const line of out.lines) (out.ok ? console.log : console.error)(line);
  if (!out.ok) process.exit(1);
} catch (err: any) {
  console.error(`Failed to send message: ${escapeForTerminal(err?.message || String(err), { keepNewlines: false })}`);
  process.exit(1);
}
