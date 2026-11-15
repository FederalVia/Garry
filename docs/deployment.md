# Deploying the automaton

The automaton runs unattended, holds a wallet, spends money and runs shell
commands. Where you run it decides what it can reach.

**Recommended: a container on an always-on machine or a small VPS.** The
container keeps the agent's own config, budget and approvals out of its reach,
and an always-on host keeps its heartbeat (budget checks, revival, approved
transfers) running.

> **Warning.** In plain local mode (`automaton --run` as your own user) the
> agent can do anything your account can do: read your files and keys, use
> your SSH and cloud credentials, and edit its own config, budget and
> approvals. The path rules and the command tripwire are best-effort guards,
> not a security boundary. Use the container or a dedicated user for anything
> unattended.

In every layout, **set a spending limit on your AI provider's website** and
give the agent its own API key. The agent must read its key to use it, so no
layout can hide the key from it; the provider-side limit is the one limit it
cannot touch.

## 1. Container (recommended)

Needs Docker with Compose v2. Run everything from the `deploy/` folder of a
checkout.

```sh
git clone https://github.com/FederalVia/Garry && cd Garry/deploy
mkdir -p data/state data/config data/owner
sudo chown -R 10001:10001 data          # the image runs as uid 10001
../scripts/pin-base-image.sh            # pins the base image digest (needs the registry)
docker compose build
docker compose --profile owner run --rm setup      # the setup wizard
docker compose up -d agent
docker compose --profile owner run --rm cli budget add 10
docker compose --profile owner run --rm cli budget show
docker compose --profile owner run --rm cli approvals list
```

Later changes: `docker compose stop agent`, then
`docker compose --profile owner run --rm configure`, then
`docker compose start agent`. Logs: `docker compose logs -f agent`. Status:
`docker compose --profile owner run --rm cli status`.

The `Dockerfile` pins its base image (`node:22-bookworm-slim`) by digest, so a
rebuild cannot silently start from a different image. To move to a newer base
image, run `scripts/pin-base-image.sh`, which resolves the tag's current digest
and writes it in, and review the diff. Run it too if a build ever reports the
digest "not found". The container smoke test in `pnpm test` builds the image
when a Docker daemon is reachable and skips otherwise; CI requires it to run.
A digest of 64 zeros is treated as unpinned: the smoke test skips and CI pins
it before building.

### What is read-only, and why

| Inside the agent container | Mount | Agent can |
|---|---|---|
| `/app` (runtime code, guard code, CLI) | image, root-owned, read-only root filesystem | read only |
| `~/.automaton/automaton.json`, `wallet.json`, `config.json`, `heartbeat.yml`, `constitution.md`, `inference-providers.json`, `mcp-servers.json` | `data/config/*`, read-only binds | read only |
| `~/.automaton/owner/` (`owner.db`: budget grants, approval decisions) | `data/owner`, read-only bind | read only |
| `~/.automaton/` (state.db, logs, skills, workspace, SOUL.md, WORKLOG.md) | `data/state`, read-write | read and write |
| `/tmp` | tmpfs, 256 MB | read and write |

A read-only bind mount cannot be written, truncated, renamed over or unlinked
from inside the container, whatever the process does. The owner folder is
read-only as a folder, so no journal can be planted next to `owner.db`.
`inference-providers.json` is locked too: it sets the prices the inference gate
charges, so an agent that could edit it could make its spending look smaller.
So is `mcp-servers.json`: it names the MCP servers the runtime starts, with
your tokens, and approves the ones the agent installed. Setup writes it with
MCP off (`{ "version": 1, "enabled": false }`); edit `data/config/mcp-servers.json`
to add servers (see "MCP servers" in DOCUMENTATION.md) and restart the agent.

The agent service also runs with no Linux capabilities, `no-new-privileges`,
a process limit, 2 GB of memory and 2 CPUs. It publishes no ports and never
gets the Docker socket, so it cannot start the owner's `setup`, `configure` or
`cli` services, which are the only ones that mount the owner's files
read-write.

The owner CLI (`budget`, `approvals`) does not take the agent's instance lock:
you can add budget and decide approvals while the agent runs. `setup` and
`configure` refuse while the agent runs, and they never work in `data/state`:
they edit the owner files in a private, in-memory `~/.automaton` and move the
results to `data/config`. (The agent's read-only binds sit on files in
`data/state`; replacing one of those from another container would detach the
bind inside the agent's container.) `setup` also copies the agent's starting
`SOUL.md` and default skills into `data/state` when they are not there yet.

### What the agent can still do

- Read and write its own state folder, including its own ledgers in
  `state.db` (it must write them). A tamper-proof meter outside the container
  is future work; the provider-side limit is the backstop.
- Read its provider keys (to use them).
- Reach the network: its AI providers, and anything else it can reach from
  your host. Put the host behind a firewall if that matters to you.
- Use its skills and `workspace/`.

### Self-modification is off in the container

`/app` is read-only, so `edit_own_file`, `pull_upstream`, `pnpm` rebuilds and
global installs fail inside the container. This is deliberate: writable code
would let the agent rewrite its own treasury and inference gate. Update by
pulling the checkout and rebuilding the image.

### Entrypoint checks

`run` (the default command) refuses to start, with exit code 64, when:

- it runs as root (override: `AUTOMATON_ALLOW_ROOT=1`);
- any owner file or the owner folder could be changed by the agent user:
  missing (the agent could create it), writable, owned by the agent user, or
  in a folder the agent user can write without the sticky protection (so it
  could be renamed and replaced). A read-only mount always passes (override:
  `AUTOMATON_ALLOW_WRITABLE_CONFIG=1`, not recommended);
- `automaton.json` sets no `providers.mode` and has no Conway key. The runtime
  would then have to write the mode into the read-only file at startup; set
  `"providers": { "mode": "standalone" }` (the wizard writes it).

Other commands: `setup`, `configure`, `cli <args>`, `healthcheck`, `version`.

The image's healthcheck (`node /app/dist/healthcheck.js`) passes while the
heartbeat has recorded a task in the last 45 minutes
(`AUTOMATON_HEALTH_MAX_AGE_MIN` changes it). A dead agent (out of budget) is
healthy: its heartbeat keeps running, and a restart would not help it.

### Updating

```sh
git pull && docker compose build && docker compose up -d agent
```

## 2. Dedicated Unix user (Linux, systemd)

The same layout without Docker: the agent runs as its own user, the owner
files belong to root, and systemd mounts them read-only.

```sh
sudo useradd --system --home-dir /var/lib/automaton --shell /usr/sbin/nologin automaton
sudo install -d -o root -g automaton -m 0750 /var/lib/automaton
sudo install -d -o root -g automaton -m 1770 /var/lib/automaton/.automaton
sudo git clone https://github.com/FederalVia/Garry /opt/automaton
cd /opt/automaton && sudo corepack enable && sudo pnpm install --frozen-lockfile && sudo pnpm run build
# First-time setup as the agent user (writes automaton.json and wallet.json):
cd /opt/automaton && sudo -u automaton -H env HOME=/var/lib/automaton node /opt/automaton/dist/index.js --setup
# Lock the owner files (root-owned, group-readable, sticky state folder):
sudo /opt/automaton/scripts/lock-owner-files.sh /var/lib/automaton/.automaton automaton
sudo install -m 0644 /opt/automaton/deploy/automaton.service /etc/systemd/system/automaton.service
sudo systemctl daemon-reload && sudo systemctl enable --now automaton
# Owner commands, as root, pointing HOME at the agent's home:
sudo env HOME=/var/lib/automaton node /opt/automaton/packages/cli/dist/index.js budget add 10
sudo env HOME=/var/lib/automaton node /opt/automaton/packages/cli/dist/index.js budget show
sudo env HOME=/var/lib/automaton node /opt/automaton/packages/cli/dist/index.js approvals list
```

`scripts/lock-owner-files.sh <state-dir> <group>`:

- creates every owner file that is missing (`config.json`,
  `inference-providers.json`, `mcp-servers.json` with MCP off, `heartbeat.yml`,
  `constitution.md`), so the
  agent cannot create one first, and so every path the unit lists exists;
- makes the owner files `root:<group> 0640` (`constitution.md` 0444);
- makes `<state>/owner` `root:<group> 0750` and `owner.db` in it
  `root:<group> 0640` (it creates `owner.db` when the CLI is built);
- makes the state folder `root:<group> 1770`: the agent can create its own
  files there, but the sticky bit stops it renaming or deleting root's;
- refuses to run as non-root, a symbolic link as the state folder or an owner
  file, an owner file with extra hard links, and a WAL-mode `owner.db`.

It is idempotent and prints what it changed.

To change the configuration later, run `--configure` as **root** with `HOME`
pointing at the agent's home, with the service stopped, then lock again. The
agent user cannot do it once the files are locked: saving replaces
`automaton.json` by renaming a new file over it, and the sticky, root-owned
state folder refuses that for a file the agent does not own (which is the
point of the layout).

```sh
sudo systemctl stop automaton
cd /opt/automaton && sudo env HOME=/var/lib/automaton node /opt/automaton/dist/index.js --configure
sudo /opt/automaton/scripts/lock-owner-files.sh /var/lib/automaton/.automaton automaton
sudo systemctl start automaton
```

Saved as root, the file is `root:root 0600` until the lock script makes it
`root:automaton 0640` again, so the agent cannot start before it has run.

`deploy/automaton.service` runs `node dist/index.js --run` as `automaton`
with `NoNewPrivileges`, `ProtectSystem=strict` (the whole file system
read-only except the state folder), `ProtectHome`, `PrivateTmp`, and
`ReadOnlyPaths=` for each owner file and the owner folder. systemd refuses
to start the unit when one of those paths is missing; the lock script creates
them.

Self-modification works in this layout only if you make `/opt/automaton`
writable by the agent user, which gives it its guard code. The default
(root-owned checkout) keeps it off, as in the container.

## 3. Plain local mode

`node dist/index.js --run` as your own user. Fine for trying the agent out
while you watch it. Read the warning at the top of this page before leaving
it alone: the protections against changing its own config, budget and
approvals are guards, not a boundary, when it runs as you.
