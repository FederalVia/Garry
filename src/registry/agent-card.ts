/**
 * Agent Card
 *
 * Generates and manages the agent's self-description card.
 * This is the JSON document pointed to by the ERC-8004 agentURI.
 * Can be hosted on IPFS or served at /.well-known/agent-card.json
 *
 * Phase 3.2: Fixed code injection in hostAgentCard (S-P0-3),
 * removed internal details from card (S-P1-10),
 * added CORS headers and Content-Type.
 */

import crypto from "crypto";
import path from "path";
import { writeFileSafe } from "../security/secure-fs.js";
import { stateDir } from "../security/protected-paths.js";
import { resolveRuntime } from "../providers/mode.js";
import type {
  AgentCard,
  AgentService,
  AutomatonConfig,
  AutomatonIdentity,
  AutomatonDatabase,
  ConwayClient,
} from "../types.js";

const AGENT_CARD_TYPE =
  "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

/**
 * Generate an agent card from the automaton's current state.
 *
 * Phase 3.2: Only expose agentWallet service, name, generic description,
 * x402Support, and active status. Do NOT include:
 * - Conway API URL (internal infrastructure)
 * - Sandbox ID (internal identifier)
 * - Creator address (privacy)
 */
export function generateAgentCard(
  identity: AutomatonIdentity,
  config: AutomatonConfig,
  _db: AutomatonDatabase,
): AgentCard {
  // Chain-aware endpoint: EVM uses CAIP-2 eip155:8453, Solana uses solana:mainnet
  const chainType = config.chainType || identity.chainType || "evm";
  const walletEndpoint = chainType === "solana"
    ? `solana:mainnet:${identity.address}`
    : `eip155:8453:${identity.address}`;

  const services: AgentService[] = [
    {
      name: "agentWallet",
      endpoint: walletEndpoint,
    },
  ];

  // Phase 3.2: Generic description, no internal details
  const description = `Autonomous agent: ${config.name}`;

  return {
    type: AGENT_CARD_TYPE,
    name: config.name,
    description,
    services,
    // Standalone with payments off pays and accepts nothing over x402.
    x402Support: chainType !== "solana" && resolveRuntime(config).payments,
    active: true,
  };
}

/**
 * Serialize agent card to JSON string.
 */
export function serializeAgentCard(card: AgentCard): string {
  return JSON.stringify(card, null, 2);
}

/**
 * Host the agent card at /.well-known/agent-card.json
 * by exposing a simple HTTP server on a port.
 *
 * Phase 3.2: CRITICAL FIX (S-P0-3) — Write card as a SEPARATE JSON file.
 * Server script reads the file at request time, NOT interpolated into JS.
 * Added CORS headers and X-Content-Type-Options: nosniff.
 */
export async function hostAgentCard(
  card: AgentCard,
  conway: ConwayClient,
  port: number = 8004,
): Promise<string> {
  const cardJson = serializeAgentCard(card);

  // Fresh, unpredictable directory: mkdir fails if anything is already
  // there, so no planted link can redirect the writes or the served file.
  const dir = `/tmp/agent-card-${crypto.randomBytes(8).toString("hex")}`;
  const mk = await conway.exec(`mkdir -m 700 '${dir}'`, 5000);
  if (mk.exitCode !== 0) {
    throw new Error(`Could not create agent card directory: ${mk.stderr || mk.stdout}`);
  }
  const cardPath = `${dir}/agent-card.json`;
  const serverPath = `${dir}/agent-card-server.js`;

  // Phase 3.2: Write card as a separate JSON file (not interpolated into JS)
  await conway.writeFile(cardPath, cardJson);

  // The server reads the card once at startup, without following links,
  // and serves that copy; later changes on disk are never published.
  const serverScript = `
const http = require('http');
const fs = require('fs');
const cardPath = ${JSON.stringify(cardPath)};

function loadCard() {
  const fd = fs.openSync(cardPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > 65536) throw new Error('unsafe card file');
    return fs.readFileSync(fd, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
}
const data = loadCard();

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/.well-known/agent-card.json' || req.url === '/agent-card.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(data);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(${port}, () => console.log('Agent card server on port ' + ${port}));
`;

  await conway.writeFile(serverPath, serverScript);

  // Start server in background
  await conway.exec(
    `node '${serverPath}' &`,
    5000,
  );

  // Expose port
  const portInfo = await conway.exposePort(port);

  return `${portInfo.publicUrl}/.well-known/agent-card.json`;
}

/**
 * Write agent card to the state directory for git versioning.
 */
export async function saveAgentCard(
  card: AgentCard,
  _conway: ConwayClient,
): Promise<void> {
  const cardJson = serializeAgentCard(card);
  // The state dir is local; temp + rename so a link at this name is refused.
  writeFileSafe(path.join(stateDir(), "agent-card.json"), cardJson, { trustedWriter: true, mode: 0o644 });
}
