/**
 * automaton-cli send <to-address> "message text"
 *
 * Send a signed message via the social relay with the automaton's wallet
 * (EVM or Solana), through the runtime social client: HTTPS relay only,
 * validated addresses and size, recipient case kept for Solana.
 */

import { loadConfig } from "@conway/automaton/config.js";
import { resolveRelayUrl, sendOperatorMessage } from "@conway/automaton/operator/send.js";

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
  if (!result.ok) {
    console.error(`Failed to send message: ${result.error}`);
    process.exit(1);
  }

  console.log(`Message sent (signed).`);
  console.log(`  ID:    ${result.id}`);
  console.log(`  From:  ${result.from}`);
  console.log(`  To:    ${result.to}`);
  console.log(`  Relay: ${result.relayUrl}`);
} catch (err: any) {
  console.error(`Failed to send message: ${err?.message || String(err)}`);
  process.exit(1);
}
