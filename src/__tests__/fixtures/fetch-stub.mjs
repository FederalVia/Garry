// Preloaded (--import) into an entrypoint child: no real network. Chat
// completions follow the script in STUB_SCRIPT ({chat: [{text?, tools?}]});
// each chat request is appended to STUB_LOG as one JSON line.
import fs from "node:fs";

const LOG = process.env.STUB_LOG;
const SCRIPT = process.env.STUB_SCRIPT ? JSON.parse(fs.readFileSync(process.env.STUB_SCRIPT, "utf8")) : { chat: [] };
let chatN = 0;
const log = (o) => {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + "\n");
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  const u = new URL(url);
  const body = init.body ? String(init.body) : "";
  if (u.pathname.endsWith("/v1/credits/balance")) return json({ balance_cents: SCRIPT.credits ?? 50000 });
  if (u.pathname.endsWith("/chat/completions")) {
    const i = chatN++;
    const step = SCRIPT.chat[i] ?? { text: "nothing to do" };
    log({ chat: i, at: Date.now() });
    const message = { role: "assistant", content: step.text ?? "" };
    if (step.tools) {
      message.tool_calls = step.tools.map((t, j) => ({
        id: `call_${i}_${j}`,
        type: "function",
        function: { name: t.name, arguments: JSON.stringify(t.args) },
      }));
    }
    return json({
      id: `chat-${i}`,
      model: "gpt-5.2",
      choices: [{ index: 0, message, finish_reason: step.tools ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
  }
  if (body.includes('"jsonrpc"')) {
    let req;
    try {
      req = JSON.parse(body);
    } catch {
      req = {};
    }
    const one = (r) => ({ jsonrpc: "2.0", id: r.id, result: r.method === "eth_chainId" ? "0x2105" : "0x0" });
    return json(Array.isArray(req) ? req.map(one) : one(req));
  }
  log({ other: `${init.method || "GET"} ${u.host}${u.pathname}` });
  return json({});
};
