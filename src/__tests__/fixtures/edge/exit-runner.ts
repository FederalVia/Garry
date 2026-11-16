// Starts a fake tunnel (with a grandchild) and exits with process.exit(1),
// so a test can check the exit hook killed the whole group.
// Usage: node --import tsx exit-runner.ts <fake-tunnel.mjs> <pid-file> [wait]
// With "wait" it keeps running (handling only SIGTERM and SIGINT) until killed.
import { TunnelSupervisor } from "../../../edge/tunnel.js";

const [fixture, pidFile, mode] = process.argv.slice(2);

const sup = new TunnelSupervisor(4321, {
  command: process.execPath,
  args: [fixture, "--mode", "cloudflared", "--port", "{port}", "--grandchild", "--pid-file", pidFile],
  urlPattern: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
  env: { PATH: process.env.PATH ?? "" },
  startTimeoutMs: 15_000,
  restart: { maxRestarts: 0, windowMs: 60_000, backoffMs: [100] },
});

sup.start().then(
  (url) => {
    process.stdout.write(`URL ${url}\n`);
    if (mode !== "wait") process.exit(1);
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
    setInterval(() => {}, 1000);
  },
  (err) => {
    process.stderr.write(`start failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
