/**
 * The runtime's public edge: port exposure, DNS on the owner's zone, an
 * optional registrar and the published agent card, built from the
 * publicAccess block. With no block, createEdge returns an edge whose parts
 * are all null and withEdge leaves the client unchanged.
 */

import path from "node:path";
import type { AgentCard, AutomatonConfig, AutomatonDatabase, AutomatonIdentity, ConwayClient } from "../types.js";
import type { ResolvedRuntime } from "../providers/mode.js";
import { createLogger } from "../observability/logger.js";
import { generateAgentCard } from "../registry/agent-card.js";
import { parsePublicAccess, summarizeEdge, type EdgeSummary, type ResolvedPublicAccess } from "./config.js";
import {
  LocalExposer,
  ProxyExposer,
  TunnelExposer,
  createPortExposer,
  inferenceProviderLoopbackPorts,
  loopbackServicePorts,
  mcpLoopbackPorts,
  type Exposure,
  type PortExposer,
} from "./ports.js";
import { startCardServer, type CardServer } from "./card-server.js";
import { createDnsService } from "./dns/index.js";
import { createRegistrarClient } from "./registrar/index.js";
import type { DnsProvider, DnsService, RegistrarClient, ResolvedRegistrarConfig } from "./types.js";

import { withEdge } from "./facade.js";

export { withEdge };
export type { EdgeSummary } from "./config.js";

const logger = createLogger("edge");

export const AGENT_CARD_URL_KV = "edge.agent_card_url";
const DNS_VERIFY_BUDGET_MS = 10_000;
const MAX_STATUS_LINES = 10;
const CARD_PATH = "/.well-known/agent-card.json";

export interface Edge {
  readonly summary: EdgeSummary;
  /** null: today's behaviour. */
  readonly ports: PortExposer | null;
  readonly dns: DnsService | null;
  readonly registrar: RegistrarClient | null;
  registrarConfig(): ResolvedRegistrarConfig | null;
  /** Gateway listen, orphan cleanup, restore, DNS verify (background), card. */
  start(): Promise<void>;
  publishAgentCard(card: AgentCard): Promise<string | null>;
  agentCardUrl(): string | null;
  /** Prompt lines: URLs (from the validated parser) and states only, at most 10. */
  statusLines(): string[];
  close(ms: number): Promise<void>;
}

export interface CreateEdgeOptions {
  config: AutomatonConfig;
  runtime: Pick<ResolvedRuntime, "mode"> & { edge?: EdgeSummary; features?: Pick<ResolvedRuntime["features"], "domainPurchase"> };
  db: AutomatonDatabase;
  inner: ConwayClient;
  env?: NodeJS.ProcessEnv;
  identity?: AutomatonIdentity;
  /** Aborted when a runtime stop is requested, so a tunnel start in a tool call ends at once. */
  shutdownSignal?: AbortSignal;
  /** Test seams. */
  deps?: {
    dnsProvider?: DnsProvider;
    registrar?: RegistrarClient;
    backoffMs?: number[];
    probe?: (port: number) => Promise<boolean>;
    now?: () => number;
  };
}

/** Where the loop reads the Conway-mode provider file. */
function providersFile(env: NodeJS.ProcessEnv): string {
  return path.join(env.HOME || process.cwd(), ".automaton", "inference-providers.json");
}

export function createEdge(o: CreateEdgeOptions): Edge {
  const env = o.env ?? process.env;
  const mode = o.runtime.mode;
  const summary = o.runtime.edge ?? summarizeEdge(o.config, mode, env);
  let parsed: ResolvedPublicAccess | null = null;
  try {
    parsed = parsePublicAccess((o.config as { publicAccess?: unknown }).publicAccess, env);
  } catch (err) {
    logger.warn(`publicAccess is ignored: ${err instanceof Error ? err.message : String(err)}`);
  }

  let providerPorts: number[] | null = null;
  let ports: PortExposer | null = null;
  if (parsed?.ports && (summary.ports === "proxy" || summary.ports === "tunnel")) {
    ports = createPortExposer(parsed.ports, {
      reservedPorts: () => [
        ...loopbackServicePorts(o.config, env),
        ...mcpLoopbackPorts(),
        // Read once, like the loop does at its start.
        ...(mode === "conway" ? (providerPorts ??= inferenceProviderLoopbackPorts(providersFile(env))) : []),
      ],
      kv: o.db,
      env,
      backoffMs: o.deps?.backoffMs,
      probe: o.deps?.probe,
      now: o.deps?.now,
      shutdownSignal: o.shutdownSignal,
    });
  } else if (parsed?.ports?.mode === "local" && summary.ports === "local" && summary.configured) {
    ports = new LocalExposer();
  }

  let dns: DnsService | null = null;
  if (parsed?.dns && summary.dns) {
    dns = createDnsService(parsed.dns, {
      db: o.db.raw,
      provider: o.deps?.dnsProvider,
      now: o.deps?.now,
      // Names under the gateway's suffix belong to the gateway: an explicit
      // record there would shadow the owner's wildcard and bypass it.
      reservedSubtrees: parsed.ports?.mode === "proxy" && parsed.ports.suffix ? [parsed.ports.suffix] : [],
    });
  }
  let registrar: RegistrarClient | null = null;
  const registrarCfg = parsed?.registrar && summary.registrar ? parsed.registrar : null;
  if (registrarCfg) registrar = o.deps?.registrar ?? createRegistrarClient(registrarCfg, { kv: o.db });

  const cardCfg = parsed?.agentCard ?? { publish: false, name: "agent" };
  let cardServer: CardServer | null = null;
  let cardServerStarting: Promise<CardServer> | null = null;
  let cardUrl: string | null = null;
  let cardWarned = false;
  let unsubscribe: (() => void) | null = null;

  // Read when asked: the runtime normalises config.treasuryPolicy after the edge is built.
  const infraCapsUnset = (): boolean => {
    const tp = o.config.treasuryPolicy;
    return !!tp && (tp.maxInfraSingleCents === 0 || tp.maxInfraDailyCents === 0);
  };

  const setCardUrl = (url: string | null): void => {
    cardUrl = url;
    try {
      if (url) o.db.setKV(AGENT_CARD_URL_KV, url);
      else o.db.deleteKV(AGENT_CARD_URL_KV);
    } catch {
      // the prompt still shows it
    }
  };

  if (ports instanceof ProxyExposer || ports instanceof TunnelExposer) {
    // The card's name is the runtime's, never the agent's.
    if (cardCfg.publish) ports.reserveName(cardCfg.name);
  }

  const edge: Edge = {
    summary,
    ports,
    dns,
    registrar,
    registrarConfig: () => registrarCfg,

    async start(): Promise<void> {
      for (const w of parsed?.warnings ?? []) logger.warn(w);
      for (const why of summary.ignored) logger.warn(`publicAccess.${why}`);
      if (registrarCfg && mode === "standalone" && o.runtime.features?.domainPurchase !== true) {
        logger.warn(
          "publicAccess.registrar is enabled; search_domains and register_domain stay hidden until a budget gives the treasury a readable balance.",
        );
      } else if (registrarCfg && infraCapsUnset()) {
        logger.warn(
          "publicAccess.registrar is enabled but treasuryPolicy.maxInfraSingleCents and maxInfraDailyCents are not both set " +
            "(standalone reads them as 0 unless automaton.json sets them, and does not count Conway's defaults 2500 and 5000 as set): " +
            "every purchase will be refused until you set both.",
        );
      }
      if (registrarCfg) {
        // The treasury gate is in this process; the keys are readable by it.
        logger.warn(
          "publicAccess.registrar: the registrar keys are readable by this runtime, so a command the agent runs can read them too. " +
            "The treasury limits prevent mistakes, not misuse of the keys; keep the registrar account balance as small as what you would let the agent spend.",
        );
      }
      if (ports) {
        unsubscribe = ports.onChange((e) => {
          if (cardServer && e.port === cardServer.port) setCardUrl(e.url ? `${e.url}${CARD_PATH}` : null);
        });
        await ports.start();
      }
      if (dns) {
        const d = dns;
        // In the background with a budget: a slow provider never delays startup.
        void Promise.race([
          d.verify(),
          new Promise((_, reject) => {
            const t = setTimeout(() => reject(new Error("verification took longer than 10 s")), DNS_VERIFY_BUDGET_MS);
            t.unref?.();
          }),
        ]).catch((err) => logger.warn(`DNS for ${d.zone} is not available yet: ${err instanceof Error ? err.message : String(err)}`));
      }
      if (summary.agentCard && o.identity) {
        try {
          await edge.publishAgentCard(generateAgentCard(o.identity, o.config, o.db));
        } catch (err) {
          logger.warn(`The agent card was not published: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },

    async publishAgentCard(card: AgentCard): Promise<string | null> {
      if (!cardCfg.publish) return null;
      if (!summary.agentCard || !(ports instanceof ProxyExposer || ports instanceof TunnelExposer)) {
        if (!cardWarned) {
          cardWarned = true;
          logger.warn("agentCard.publish is set but ports are not public (proxy or tunnel mode); the card is not published.");
        }
        return null;
      }
      if (cardServer) {
        cardServer.setCard(card);
        return cardUrl;
      }
      if (!cardServerStarting) {
        cardServerStarting = startCardServer({ host: "127.0.0.1", port: 0, card });
      }
      let server: CardServer;
      try {
        server = await cardServerStarting;
      } catch (err) {
        cardServerStarting = null;
        throw err;
      }
      server.setCard(card);
      if (cardServer) return cardUrl;
      ports.reservePort(server.port);
      cardServer = server;
      try {
        const e: Exposure = await ports.expose(server.port, { name: cardCfg.name, managedBy: "runtime" });
        setCardUrl(e.url ? `${e.url}${CARD_PATH}` : null);
      } catch (err) {
        cardServer = null;
        cardServerStarting = null;
        await server.close().catch(() => {});
        throw err;
      }
      return cardUrl;
    },

    agentCardUrl: () => cardUrl,

    statusLines(): string[] {
      if (!summary.configured) return [];
      const lines: string[] = [];
      if (ports && (summary.ports === "proxy" || summary.ports === "tunnel")) {
        const a = ports.available();
        if (!a.ok) lines.push(`Public ports unavailable: ${a.reason}`);
        for (const e of ports.list()) {
          if (e.managedBy !== "agent") continue;
          const label = e.name ? ` (${e.name})` : "";
          if (e.state === "up" && e.url) lines.push(`port ${e.port}${label}: ${e.url} up`);
          else lines.push(`port ${e.port}${label}: ${e.state}${e.detail ? ` (${e.detail})` : ""}`);
        }
        const before = ports.previous();
        if (before.length > 0) {
          lines.push(
            `Exposed before the restart, not public now: ${before.map((p) => `${p.port}${p.name ? ` (${p.name})` : ""}`).join(", ")}`,
          );
        }
      }
      if (summary.agentCard) {
        lines.push(
          cardUrl
            ? `Agent card: ${cardUrl} (usable as agent_uri for register_erc8004)`
            : "Agent card: not reachable right now",
        );
      }
      if (dns) {
        const av = dns.availability();
        const state =
          av.state === "ok" ? "available" : av.state === "unavailable" ? `unavailable (${av.reason})` : "not verified yet";
        lines.push(`DNS: records under ${dns.zone} via ${dns.provider}, ${state}`);
      }
      if (registrar && mode === "standalone" && o.runtime.features?.domainPurchase !== true) {
        lines.push(`Registrar: ${registrar.provider}, not usable until your owner sets a budget`);
      } else if (registrar && infraCapsUnset()) {
        lines.push(`Registrar: ${registrar.provider}, not usable until your owner sets the infrastructure spending caps`);
      } else if (registrar) {
        lines.push(`Registrar: ${registrar.provider} (purchases go through your budget and treasury limits)`);
        try {
          lines.push(...(registrar.statusLines?.() ?? []));
        } catch {
          // the prompt goes on without it
        }
      }
      return lines.slice(0, MAX_STATUS_LINES);
    },

    async close(ms: number): Promise<void> {
      unsubscribe?.();
      const server = cardServer;
      cardServer = null;
      await Promise.allSettled([ports?.close(ms), server?.close()]);
    },
  };
  return edge;
}

export interface EdgeBoot {
  edge: Edge;
  /** The client the runtime hands to tools: the inner one routed through the edge. */
  conway: ConwayClient;
  /** Starts the edge in the background when publicAccess is set. */
  start(): void;
  /** The shutdown step: stops tunnels, the gateway and the card server. */
  closeEdge(ms: number): Promise<void>;
}

/** What the runtime does with the edge at boot and shutdown, in one tested place. */
export function bootEdge(o: CreateEdgeOptions): EdgeBoot {
  const edge = createEdge(o);
  installEdge(edge);
  return {
    edge,
    conway: withEdge(o.inner, edge, o.runtime.mode),
    start(): void {
      if (!edge.summary.configured && edge.summary.ignored.length === 0) return;
      void edge.start().catch((err) => logger.warn(`Public access did not start: ${err instanceof Error ? err.message : String(err)}`));
    },
    closeEdge: (ms) => edge.close(ms),
  };
}

// ─── Process-wide edge (read by tools and the prompt) ───────────

const EDGE_KEY = Symbol.for("automaton.edge");

export function installEdge(e: Edge | null): void {
  (globalThis as Record<symbol, unknown>)[EDGE_KEY] = e ?? undefined;
}

export function currentEdge(): Edge | null {
  return ((globalThis as Record<symbol, unknown>)[EDGE_KEY] as Edge | undefined) ?? null;
}
