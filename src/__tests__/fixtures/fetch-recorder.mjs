// Preloaded (--import) into an entrypoint child: no real network, and every
// outbound request recorded. Each request is appended to RECORDER_LOG as one
// JSON line {method, host, path, jsonrpc}. Answers: OpenAI-compatible
// /chat/completions and Anthropic /v1/messages follow RECORDER_SCRIPT
// ({chat: [{text?, tools?}], credits?}); Ollama /api/tags lists
// RECORDER_SCRIPT.ollamaModels; Conway credit balance returns credits and the
// SIWE provisioning endpoints mint a stub key; JSON-RPC
// gets a zero result; anything else {}. http/https.request are recorded and
// refused, so no non-fetch egress goes unseen.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const LOG = process.env.RECORDER_LOG;
const SCRIPT = process.env.RECORDER_SCRIPT ? JSON.parse(fs.readFileSync(process.env.RECORDER_SCRIPT, "utf8")) : {};
const chatSteps = SCRIPT.chat ?? [];
let chatN = 0;

const record = (o) => {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + "\n");
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function nextStep() {
  const i = chatN++;
  return { i, step: chatSteps[i] ?? { text: "nothing to do" } };
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  const u = new URL(url);
  const method = (init.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
  let body = "";
  if (init.body) body = String(init.body);
  else if (typeof input === "object" && typeof input.text === "function" && method !== "GET") {
    try {
      body = await input.clone().text();
    } catch {
      body = "";
    }
  }
  const jsonrpc = body.includes('"jsonrpc"');
  const headers = new Headers(init.headers ?? (typeof input === "object" ? input.headers : undefined));
  const entry = { method, host: u.host, path: u.pathname, jsonrpc };
  // Strict automaton/1 relay polls carry a nonce; Conway-compatible ones do not.
  if (headers.has("x-auth-nonce")) entry.nonce = true;
  record(entry);

  if (u.pathname.endsWith("/v1/messages/poll")) return json({ messages: [], next_cursor: null });
  if (u.pathname.endsWith("/v1/messages/count")) return json({ unread: 0 });
  if (u.pathname.endsWith("/v1/credits/balance")) return json({ balance_cents: SCRIPT.credits ?? 50000 });
  if (u.pathname.endsWith("/v1/auth/nonce")) return json({ nonce: "abcdefgh12345678" });
  if (u.pathname.endsWith("/v1/auth/verify")) return json({ access_token: "stub-jwt" });
  if (u.pathname.endsWith("/v1/auth/api-keys")) return json({ key: "cnwy_k_stub_provisioned", key_prefix: "cnwy_k_st" });
  if (u.pathname.endsWith("/api/tags")) {
    return json({ models: (SCRIPT.ollamaModels ?? []).map((name) => ({ name, model: name, modified_at: "", size: 1 })) });
  }
  if (u.pathname.endsWith("/chat/completions")) {
    const { i, step } = nextStep();
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
      model: "stub",
      choices: [{ index: 0, message, finish_reason: step.tools ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
  }
  if (u.pathname.endsWith("/v1/messages")) {
    const { i, step } = nextStep();
    const content = [];
    if (step.text) content.push({ type: "text", text: step.text });
    for (const [j, t] of (step.tools ?? []).entries()) {
      content.push({ type: "tool_use", id: `toolu_${i}_${j}`, name: t.name, input: t.args });
    }
    if (content.length === 0) content.push({ type: "text", text: "nothing to do" });
    return json({
      id: `msg-${i}`,
      type: "message",
      role: "assistant",
      model: "stub",
      content,
      stop_reason: step.tools ? "tool_use" : "end_turn",
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  }
  if (jsonrpc) {
    let req;
    try {
      req = JSON.parse(body);
    } catch {
      req = {};
    }
    const one = (r) => ({ jsonrpc: "2.0", id: r.id, result: r.method === "eth_chainId" ? "0x2105" : "0x0" });
    return json(Array.isArray(req) ? req.map(one) : one(req));
  }
  return json({});
};

function refuse(kind) {
  return function patchedRequest(options, ...rest) {
    let host = "";
    let p = "";
    try {
      if (typeof options === "string" || options instanceof URL) {
        const u = new URL(String(options));
        host = u.host;
        p = u.pathname;
      } else if (options) {
        host = options.host || options.hostname || "";
        p = options.path || "";
      }
    } catch {
      // keep what we have
    }
    record({ method: "NODE", host, path: p, jsonrpc: false, via: kind });
    throw new Error(`fetch-recorder: ${kind}.request is not allowed in tests`);
  };
}
http.request = refuse("http");
https.request = refuse("https");
http.get = refuse("http");
https.get = refuse("https");
