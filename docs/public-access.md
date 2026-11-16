# Public addresses, DNS and domains

Everything on this page is optional and off by default. Without a `publicAccess` block in
`~/.automaton/automaton.json` the agent runs exactly as before: ports it exposes are served on this
machine only (`http://localhost:<port>`), DNS and domain tools are hidden in standalone mode, and
Conway mode keeps Conway's own ports, DNS and domain sales.

Shape errors in the block stop the agent at startup with the config path of the bad value. Problems
of the environment (a missing tunnel binary, a gateway port already in use, a DNS token that is
refused) only make that one capability unavailable; the reason is logged and shown to the agent.

```jsonc
"publicAccess": {
  "ports": { ... },      // how ports become public: "local" (default), "proxy" or "tunnel"
  "dns": { ... },        // records on a domain you already own
  "registrar": { ... },  // optional automated registration (off unless enabled)
  "agentCard": { "publish": false, "name": "agent" }
}
```

## What the agent can and cannot do

- It can make at most `maxExposed` (default 3) of its own ports public, only ports in
  `allowedPorts` (default 1024 to 65535), never a port in `deniedPorts`, never a well-known
  unauthenticated service port (Docker API 2375/2376, etcd, MySQL, Postgres, Redis, CouchDB, Consul,
  Elasticsearch, memcached, MongoDB, the Node inspector 9229, the ngrok agent API 4040,
  cloudflared's metrics ports 20241 to 20245) unless you list it in an explicit `allowedPorts`
  list, and never a port of the runtime's own loopback services (Ollama, from `ollamaBaseUrl`,
  `providers.ollama.baseUrl` or `OLLAMA_BASE_URL`; a loopback OpenAI-compatible server, in
  `providers.openai.baseUrl`, `OPENAI_BASE_URL` or any `providers.compatible` entry; in Conway
  mode, a loopback provider in `inference-providers.json`; a local Conway API or relay; a
  loopback MCP HTTP server in `mcp-servers.json`; the gateway; the agent card server). Loopback
  means any spelling that reaches this machine: `localhost`, a name ending in `.localhost`,
  `127.x.x.x`, `0.0.0.0`, `::1`, `::` and their IPv4-mapped forms. With ngrok, ports 4040 to 4050
  (where each ngrok agent serves an API that can open tunnels to any local port) are refused even
  if you list them. Exposes still
  starting count toward `maxExposed` and hold their name; `remove_port` on one stops it before it
  goes public, and `remove_port` on a port that is not public says so.
- Through `manage_dns` it can create A, AAAA, CNAME and TXT records under your zone, and delete
  only records it created. It cannot touch names that hold your records (nor underscore names such
  as `_acme-challenge.<host>` attached to a host that holds them, nor a name one of your wildcard
  records serves; see [DNS](#dns-on-a-domain-you-own)), the apex, `www`, `mail`, `_dmarc`,
  `*._domainkey`, `*._bimi`, MTA-STS, autoconfig/autodiscover or wildcards, cannot point A/AAAA
  records at private addresses or a CNAME at a private-network name, and is limited to 20 changes
  per hour, 100 per day and 25 records.
- Through `register_domain` it can buy a domain only if you enable the registrar and set a budget,
  and only as a treasury purchase: one year, an exact quoted price, at most `maxPriceCents`,
  within your budget and the infrastructure spending caps you set.
- These rules prevent accidents, not a determined agent. They bind the agent's tools, and the
  agent also has `exec`. See [What these limits do not stop](#what-these-limits-do-not-stop)
  before you give it a DNS token or registrar keys.

## What these limits do not stop

The port rules, the zone policy and the treasury gate run inside the runtime, and the runtime
holds the credentials they use. As with the AI provider keys (see
[deployment.md](deployment.md)), an agent that can run commands can read anything the runtime
can read:

- `automaton.json`, where the `publicAccess` block and its tokens are. Both deployments make the
  file read-only for the agent, not unreadable: the runtime must read it.
- The runtime's own start environment (`/proc/<pid>/environ`), where tokens given through
  `AUTOMATON_DNS_*`, `AUTOMATON_REGISTRAR_*` or a tunnel's `passEnv` are. The agent's commands
  run as the same user, in the container too.
- The files in `~/.automaton/public-access/`.

The exec tripwire refuses commands that name these places, including through globs and
variables it can recognise, but it is a tripwire: a command can build the path another way. With
a token in hand, a command can call the DNS provider or the registrar directly, outside the zone
policy, the change caps, the infrastructure caps and the budget, and with no ledger row. The
runtime does keep the credentials out of what it hands on: tool children's environment, log
lines, the prompt and tool results, where the values are also redacted. With `exec` it can also
run its own forwarder or tunnel, whatever the port rules say.

So the limits on this page stop mistakes. What stops a deliberately evasive agent is what you set
at the provider, which the agent cannot change:

- **Cloudflare:** a token limited to this one zone with only "Edit zone DNS". Such a token can
  still change any record in that zone, including the ones the policy protects, so use a zone
  (or a delegated subzone) you can afford to have rewritten.
- **Porkbun DNS:** API access enabled on this one domain only.
- **Porkbun registrar:** a small account balance, and no saved payment method that tops it up.
  The balance is the most a misused key can spend. A startup warning repeats this while the
  registrar is enabled.
- **Tunnels:** a tunnel account or token that can do nothing but open tunnels.

A real boundary needs the DNS and registrar calls made by a process under another user, which the
agent cannot read: a sidecar or an owner-side broker. That is future work. Proxy mode with a
sidecar tunnel ([below](#proxy-mode-in-the-container)) already keeps the tunnel's token away from
the agent.

## Ports

### Local (default)

`"ports": { "mode": "local" }` or no `ports` section. `expose_port` returns `http://localhost:<port>`.

### Behind your reverse proxy (`proxy`)

The runtime runs a small gateway on `127.0.0.1:8480`. You point one wildcard name at it once; the
gateway serves only the names the agent exposed, each to `127.0.0.1:<port>`, and answers 404 to
everything else without contacting any local service.

```jsonc
"ports": {
  "mode": "proxy",
  "urlTemplate": "https://{name}.agents.example.com",   // {name} is the whole leftmost label
  "gateway": { "host": "127.0.0.1", "port": 8480 },
  "maxExposed": 3,
  "allowedPorts": { "min": 1024, "max": 65535 },          // or a list: [3000, 8080]
  "deniedPorts": [],
  "restoreOnStart": false
}
```

The agent calls `expose_port` with an optional `name` (lowercase letters, digits, hyphens; default
`p<port>`) and gets `https://<name>.agents.example.com`. Its service must listen on `127.0.0.1` or
`0.0.0.0` (one bound only to `::1` is not reached).

Caddy (wildcard certificate through the DNS challenge, needs a Caddy build with your DNS plugin):

```
*.agents.example.com {
    tls { dns cloudflare {env.CF_TOKEN} }
    reverse_proxy 127.0.0.1:8480
}
```

nginx (with a wildcard certificate you obtain separately):

```
server {
    listen 443 ssl;
    server_name *.agents.example.com;
    ssl_certificate     /etc/ssl/agents.example.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/agents.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8480;
        proxy_set_header Host $host;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
```

A named Cloudflare Tunnel you run yourself works the same way: route `*.agents.example.com` to
`http://127.0.0.1:8480` in its ingress rules. This gives fixed names, unlike quick tunnels.

`gateway.host` is the address the gateway listens on (default `127.0.0.1`; an IP address or
`localhost`). Inside the container it must be `0.0.0.0`; see
[In a container or as a dedicated user](#in-a-container-or-as-a-dedicated-user).

Do not let the DNS zone the agent manages cover your proxy suffix with records of its own: the
runtime refuses agent records under the proxy suffix, because an explicit record would shadow your
wildcard and bypass the gateway.

### A tunnel the runtime supervises (`tunnel`)

The runtime starts one tunnel process per exposed port, reads the public URL from its output,
restarts it after a crash (backoff 1, 2, 4, 8, 16, 30 s; at most 5 restarts in 10 minutes, then it
stays failed until the agent exposes the port again) and stops it on shutdown. A forced exit kills
every tunnel process group, and SIGHUP takes the clean stop path; a runtime killed with SIGKILL
leaves them running until the next start, which stops them (Linux only: it checks `/proc`). Each
tunnel's process id, full command line and start time are recorded as soon as it is spawned, so
this holds during a start or restart too; a group is stopped only when all three still match, and
never the runtime's own. Once the runtime begins shutting down no tunnel starts, including one a
background restore was about to start.

```jsonc
"ports": {
  "mode": "tunnel",
  "tunnel": { "preset": "cloudflared", "command": "/usr/local/bin/cloudflared" }
}
```

- `command` must be an absolute path; it is not looked up in PATH. Keep it root-owned: a startup
  warning says when the runtime's user can write it.
- `cloudflared` quick tunnels (`https://<random>.trycloudflare.com`) need no account. The name
  changes on every start, so the agent is told the new address in its next turn. For a fixed name,
  run a named tunnel yourself and use `proxy` mode.
- `ngrok`: `{ "preset": "ngrok", "command": "/usr/local/bin/ngrok", "passEnv": ["NGROK_AUTHTOKEN"] }`.
  The free plan limits concurrent agent sessions; set `"maxExposed": 1`.
- `custom`: your own command with `args` (one must contain `{port}`) and a `urlPattern` regular
  expression for the public URL, optionally `readyPattern`.
- `env` sets variables for the tunnel only (its own token); `passEnv` hands over named variables of
  the runtime's environment. The tunnel gets nothing else of the runtime's credentials: no AI keys,
  no DNS token. Values are registered for redaction. A variable named in `passEnv` is for the
  tunnel only: the runtime leaves it out of the environment of every other child it starts (tool
  commands, MCP servers), whatever its name. The exceptions are proxy, certificate and locale
  settings (`HTTPS_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`, `LANG` and the like): every child shares
  those, so listing one changes nothing for other children and its value is not masked. Holding a
  variable back does not hide it from a command that reads the runtime's own environment; see
  [What these limits do not stop](#what-these-limits-do-not-stop).
- `startTimeoutMs` (default 30000, at most 120000) and `restart: { maxRestarts, windowMs }` tune
  supervision. A stop request (SIGTERM, SIGINT, SIGHUP) ends a tunnel start that is still waiting
  for its URL at once, so a long start timeout does not delay shutdown.

Tunnel output is never shown to the agent: only the validated https origin is. A tunnel that fails
to start gives the agent a fixed reason (no URL within the start timeout, or the exit code); the
redacted last 1 KB of its output goes to the log.

### After a restart

With `restoreOnStart: false` (default) the agent's ports are not public after a restart; its prompt
lists them as "exposed before the restart, not public now". With `true` they are exposed again in
the background.

## DNS on a domain you own

```jsonc
"dns": {
  "provider": "cloudflare",          // or "porkbun"
  "zone": "example.com",
  "apiToken": "...",                 // or the AUTOMATON_DNS_API_TOKEN environment variable
  "allowedTypes": ["A", "AAAA", "CNAME", "TXT"],
  "allowedSubtree": "agent",         // optional: only agent.example.com and below (also for list)
  "maxChangesPerHour": 20, "maxChangesPerDay": 100, "maxRecords": 25
}
```

- Cloudflare: create an API token with the "Edit zone DNS" template, limited to this one zone
  (Zone Resources: Include, Specific zone, example.com). A token that can see other zones is refused
  unless you set `"allowBroadToken": true`.
- Porkbun: API keys are account-wide, so `"allowBroadToken": true` is required. Enable API access
  only on this domain (Domain Management, the domain's details, API Access). Keys go in `apiKey` and
  `secretApiKey` or `AUTOMATON_DNS_API_KEY` and `AUTOMATON_DNS_SECRET_API_KEY`.
- The token is registered for redaction when the config loads. The runtime never copies it into
  its process environment and never hands it to a child process, a log line, the prompt or a tool
  result; tool children also lose run-together credential names such as `NGROK_AUTHTOKEN` and
  `PORKBUN_SECRETAPIKEY`. A command the agent runs can still read the token where the runtime
  reads it; see [What these limits do not stop](#what-these-limits-do-not-stop).
- **Wildcards.** A name with no records of its own is answered by your wildcard record above it,
  if you have one (`*.example.com` answers for `shop.example.com`). The agent may not create a
  record at such a name, because it would take the name from your wildcard: it is refused
  `DNS_NAME_HELD_BY_OWNER`. With a zone-wide wildcard that is every new name, so give the agent
  its own subtree with `allowedSubtree`: names at or under it are the agent's, whatever wildcard
  sits above. A wildcard you keep inside the subtree still holds its names.
- CNAME targets are checked by name only (no IP addresses, no `localhost`, `.local`, `.internal`,
  `.lan`, `.corp`, `.home`, `.intranet`, `.private` and similar names); they are not resolved, so
  a public name that resolves to a private address is not caught.
- A create whose answer was lost is adopted when the record shows up in the zone later. On
  Cloudflare only a record carrying the runtime's own comment (`automaton`) is adopted, so an
  identical record you make yourself stays yours; Porkbun has no such marker.
- With `allowedSubtree`, `list` shows only records at or under it plus the agent's own, so your
  other records (and the origin addresses behind proxied ones) stay out of the agent's view.
- `defaultTtl` (default 300) applies when the agent gives no TTL, raised to the provider's minimum
  (600 on Porkbun); the tool's description says which.
- In Conway mode, names under your zone go to your provider and other domains still go to Conway.
- Every change is recorded in `state.db` (`edge_dns_changes`), which the agent's tools cannot write.

## Domain registration (off unless enabled)

Registration stays manual by default. An optional Porkbun registrar makes `register_domain` a
treasury purchase:

```jsonc
"registrar": {
  "provider": "porkbun",
  "enabled": true,
  "allowedTlds": ["com", "net", "org", "dev"],
  "maxPriceCents": 2000
  // keys: "apiKey"/"secretApiKey" or AUTOMATON_REGISTRAR_API_KEY / AUTOMATON_REGISTRAR_SECRET_API_KEY
}
```

- Only standalone mode uses it (Conway sells its own domains).
- `search_domains` and `register_domain` appear only when the registrar is enabled **and**
  `automaton.json` has a `budget` block. Without a budget the treasury has no balance to check the
  reserve against and would refuse every purchase (`BALANCE_UNAVAILABLE`), so the tools stay hidden
  and the runtime logs that the registrar is configured but hidden.
- Each purchase needs an exact quote: one year, not premium, an allowed TLD, at most
  `maxPriceCents`. The treasury reserves exactly that price and the registrar is sent that price as
  Porkbun's `cost`, so Porkbun refuses if its price moved and nothing is charged.
- **No owner approval step.** `treasuryPolicy.requireConfirmationAboveCents` and the approvals
  the owner CLI lists cover credit transfers only. A domain purchase is never held for approval,
  whatever it costs: your consent to its size is `maxPriceCents` and the infrastructure caps
  below. Any turn of the agent's own can buy, including a scheduled (heartbeat) wake-up; a turn
  that handles an inbox message can only reply and cannot.
- It is a treasury infrastructure spend (`domain_register`, budget `infra`), refused like any other
  outflow:
  - **Infrastructure caps.** `treasuryPolicy.maxInfraSingleCents` and `maxInfraDailyCents` apply.
    In standalone both are 0 unless `automaton.json` sets them, so no domain is bought until you
    set both (for example 2000 and 4000). Conway's defaults (2500 and 5000), which a Conway-mode
    save writes into the file, count as not set in standalone: an install that moved from Conway
    mode buys nothing on caps you never chose, and saving the config drops them. Any other values
    are kept. The setup wizard never writes these caps. While either cap is 0 the runtime logs a
    warning at startup and the agent's prompt says the registrar is not usable yet.
  - **Budget.** The ledger row counts against the budget when it counts treasury spending
    (`budget.countTreasury`, default true); a purchase larger than what the budget has left this
    period is refused `BUDGET_EXHAUSTED`. With `countTreasury: false` purchases are not deducted
    from the budget, and only the caps and the reserve floor below limit them.
  - **Reserve floor.** The remaining budget is the balance: a purchase that would leave less than
    `treasuryPolicy.minimumReserveCents` is refused `RESERVE_VIOLATION`.
- You fund the Porkbun account balance. It is the one limit that holds even against a misused
  key (see [What these limits do not stop](#what-these-limits-do-not-stop)), so keep it small.
- **Auto-renewal:** Porkbun renews new registrations automatically a year later and charges your
  account directly, outside the treasury. Right after a purchase the runtime turns auto-renew off
  and records the date the registration runs out (`edge.registrar.renewals` in `state.db`); the
  tool result says so. If Porkbun does not confirm the change, the purchase stands, the tool result
  says auto-renew may still be on, and the prompt's PUBLIC ACCESS section keeps saying so; turn it
  off in Porkbun yourself. Turn it back on in Porkbun for a domain you want to keep.

## The agent card

`"agentCard": { "publish": true }` serves the agent card from memory on a loopback port and
publishes it through the same port mode under the reserved name (`agent` by default):
`https://agent.agents.example.com/.well-known/agent-card.json` in proxy mode, its own tunnel in
tunnel mode. `update_agent_card` republishes it. The card carries the wallet address, which is why
publishing is off by default. In local mode nothing is published.

## In a container or as a dedicated user

Everything in `publicAccess` lives in `automaton.json`, which both deployments in
[deployment.md](deployment.md) make an owner file: read-only for the agent, so it cannot change
the limits or the credentials. It can still read them. Tokens can also come from the environment
(`AUTOMATON_DNS_*`, `AUTOMATON_REGISTRAR_*`, a tunnel's `passEnv`): in the container that is the
agent service's `env_file`. The file itself stays on the host, and the runtime does not pass these
variables to the children it starts, but they are in the runtime's own environment, which a
command running as the same user can read. Neither deployment hides a credential the runtime
uses from the agent; see [What these limits do not stop](#what-these-limits-do-not-stop).

A tunnel that reads a credential **file** (a named tunnel's credentials, an ngrok config named by
`NGROK_CONFIG` in the tunnel's `env`) must read it from the owner folder `~/.automaton/public-access/`,
never from a place the agent can write:

- Container: put the files in `deploy/data/config/public-access/`; it is bound read-only at
  `/home/automaton/.automaton/public-access`, and the entrypoint refuses to start if that folder
  or anything in it could be changed by the agent. `setup` creates the folder empty.
- Dedicated user: put the files in `/var/lib/automaton/.automaton/public-access/` as root, then run
  `scripts/lock-owner-files.sh` again; it makes them `root:automaton 0640` and refuses a file there
  that root does not own (the agent may have planted it). The systemd unit mounts the folder
  read-only.

The agent's file tools cannot read that folder, and the exec tripwire refuses commands that name
it; a command that builds the path another way can still read the files (they must be readable by
the tunnel, which runs as the same user).

### Proxy mode in the container

The gateway runs inside the agent container and must be reachable by your reverse proxy on the
host, but not from anywhere else:

1. In `automaton.json`: `"gateway": { "host": "0.0.0.0", "port": 8480 }`. A startup warning says
   the address is not loopback; inside the container that is expected.
2. In `deploy/docker-compose.yml`, uncomment the agent service's `ports` entry, which publishes the
   gateway on the host's loopback only:

   ```yaml
   ports:
     - "127.0.0.1:8480:8480"
   ```

   Never `"8480:8480"`: Docker would publish it on every interface, past most host firewalls.
3. Point Caddy, nginx or `cloudflared` on the host at `http://127.0.0.1:8480` as above.

Alternatively run your reverse proxy or a named Cloudflare Tunnel as a sidecar container in the same
compose project and point it at `http://agent:8480`, with no `ports` entry at all. The sidecar holds
its own token in its own container, which the agent cannot read.

### Tunnel mode in the container

The official image ships no tunnel binary and downloads nothing. Add one in a derived image, owned
by root on the read-only image file system, and point `command` at it:

```dockerfile
# Dockerfile.tunnel, in a folder of your own next to the binary:
#   docker build -f Dockerfile.tunnel -t automaton:tunnel .
FROM automaton:local
USER root
# A cloudflared release you downloaded and verified; or ADD --checksum=sha256:<digest> <url>
COPY --chown=root:root --chmod=0755 cloudflared /usr/local/bin/cloudflared
USER 10001:10001
```

Then set `image: automaton:tunnel` for the agent service and
`"tunnel": { "preset": "cloudflared", "command": "/usr/local/bin/cloudflared" }`. The container's
file system is read-only apart from the state folder and `/tmp`, so the tunnel cannot keep files in
its home folder; give it what it needs through `env`, `passEnv` or `public-access/`. For fixed
names, prefer proxy mode with a sidecar tunnel (above): the agent then never runs the tunnel
process at all.
