// A stand-in for cloudflared / ngrok, run with process.execPath.
//
// Options:
//   --mode cloudflared|ngrok   output shape (cloudflared: stderr box, ngrok: stdout JSON)
//   --port N                   the port it would forward to (echoed)
//   --label L                  URL label (default: random)
//   --invalid                  print invalid URL candidates first
//   --no-url                   never print a valid URL
//   --delay MS                 wait before printing the URL
//   --ready                    print the cloudflared ready line after the URL
//   --crash-after MS           exit 1 that long after the URL, every start
//   --crash-once FILE          crash after 150 ms only when FILE does not exist (creates it)
//   --starts FILE              append one line per start
//   --ignore-term              ignore SIGTERM
//   --grandchild               start a grandchild that runs forever
//   --pid-file FILE            write {"pid","grandchild"} once running
//   --flood BYTES              after the URL write BYTES to stdout, then create --done FILE
//   --done FILE
//   --env-dump FILE            write process.env as JSON
//   --args-dump FILE           write argv as JSON
//   --secret-in-output S       print S before the URL (redaction checks)
//   --pad BYTES                after the secret line, print BYTES of filler (one line, newline included)
import fs from "node:fs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name) => argv.includes(name);

const mode = opt("--mode") ?? "cloudflared";
const label = opt("--label") ?? `t${crypto.randomBytes(5).toString("hex")}`;
const host = mode === "ngrok" ? `${label}.ngrok-free.app` : `${label}.trycloudflare.com`;
const url = `https://${host}`;

if (opt("--args-dump")) fs.writeFileSync(opt("--args-dump"), JSON.stringify(argv));
if (opt("--env-dump")) fs.writeFileSync(opt("--env-dump"), JSON.stringify(process.env));
if (opt("--starts")) fs.appendFileSync(opt("--starts"), `${process.pid}\n`);
if (flag("--ignore-term")) process.on("SIGTERM", () => {});

let grandchild = null;
if (flag("--grandchild")) {
  grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)"], {
    stdio: "ignore",
  });
}
if (opt("--pid-file")) {
  fs.writeFileSync(opt("--pid-file"), JSON.stringify({ pid: process.pid, grandchild: grandchild?.pid ?? null }));
}

const err = (s) => process.stderr.write(`${s}\n`);
const out = (s) => process.stdout.write(`${s}\n`);

err(`INF Starting tunnel for http://127.0.0.1:${opt("--port") ?? "?"}`);
if (opt("--secret-in-output")) err(`ERR auth failed for token ${opt("--secret-in-output")}`);
if (opt("--pad")) process.stderr.write("y".repeat(Number(opt("--pad")) - 1) + "\n");
if (flag("--invalid")) {
  err(`INF candidate http://${label}a.trycloudflare.com`);
  err(`INF candidate https://${label}b.evil-tunnel.com`);
  err(`INF candidate https://user:pw@${label}c.trycloudflare.com`);
  err(`INF candidate https://${label}d.trycloudflare.com/path`);
  err(`INF candidate https://${label}e.trycloudflare.com?x=1`);
  err(`INF candidate https://${label}f.trycloudflare.com:8443`);
}

function printUrl() {
  if (mode === "ngrok") {
    out(JSON.stringify({ lvl: "info", msg: "started tunnel", obj: "tunnels", name: "command_line", addr: `http://127.0.0.1:${opt("--port")}`, url }));
  } else {
    err("INF +--------------------------------------------------------------------------------------------+");
    err("INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |");
    err(`INF |  ${url}                                                    |`);
    err("INF +--------------------------------------------------------------------------------------------+");
    if (flag("--ready")) err("INF Registered tunnel connection connIndex=0 location=test");
  }
}

function afterUrl() {
  const crashAfter = opt("--crash-after");
  if (crashAfter) setTimeout(() => process.exit(1), Number(crashAfter));
  const once = opt("--crash-once");
  if (once && !fs.existsSync(once)) {
    fs.writeFileSync(once, "1");
    setTimeout(() => process.exit(1), 150);
  }
  const flood = Number(opt("--flood") ?? 0);
  if (flood > 0) {
    const chunk = "x".repeat(1023) + "\n";
    let written = 0;
    const writeMore = () => {
      while (written < flood) {
        written += chunk.length;
        if (!process.stdout.write(chunk)) {
          process.stdout.once("drain", writeMore);
          return;
        }
      }
      fs.writeFileSync(opt("--done"), "done");
    };
    writeMore();
  }
}

if (!flag("--no-url")) {
  setTimeout(() => {
    printUrl();
    afterUrl();
  }, Number(opt("--delay") ?? 0));
}
setInterval(() => {}, 1000);
