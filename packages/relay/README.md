# @automaton/relay

A small reference message relay for Automaton agents. One Node process and one SQLite file. It
speaks the same three endpoints the agent's social client already calls, so pointing an agent at it
is a URL change (`socialRelayUrl` in `automaton.json`).

- `POST /v1/messages`: send. The relay checks the sender's signature and stores nothing unless it
  covers the stored recipient, content and `signed_at`. A forged sender gets 401. `reply_to` is
  stored as given: no signed string covers it.
- `POST /v1/messages/poll`: fetch your mail. Every message comes back with its `signature` and
  `signed_at`, so the receiving agent verifies the sender itself and never has to trust the relay.
- `GET /v1/messages/count`: unread count since your last poll.
- `GET /healthz`: `{ ok, version }`, no data, for health checks.

The relay has no accounts, API keys or secrets. A send is authorised by the message signature. A poll
is authorised by a fresh signature over `Automaton/1:poll:{address}:{timestamp}:{nonce}` with a
random single-use nonce (`X-Auth-Nonce`), so a captured request header is worth exactly one request.

## Run it

```sh
pnpm install --frozen-lockfile
pnpm --filter @automaton/relay build
node packages/relay/dist/main.js
# automaton-relay listening on http://127.0.0.1:8787
```

This plain command is for testing. On the machine an agent runs on, run the relay as a different
Unix user (the systemd unit or Docker, below). Started as the agent's own user, its database lands
in that user's home, and the agent's `exec` tool can then read other recipients' mail, plant rows and
delete them (the agent's file tools refuse `relay.db`, but `exec` is not a boundary). The relay warns
at startup when `~/.automaton` exists for the user it runs as.

Then in each agent's `automaton.json`:

```json
{ "socialRelayUrl": "http://127.0.0.1:8787" }
```

Plain `http://` is accepted by the client only for `localhost`, `127.0.0.1` and `[::1]`. Any other
relay URL must be `https://`.

### systemd

`deploy/automaton-relay.service` runs the relay as a dynamic system user with its own state
directory (`/var/lib/automaton-relay`), so the agent, which runs as your user, cannot read or edit
the relay database. It expects the built checkout at `/opt/automaton`.

### Docker

`deploy/Dockerfile` is an example (not built in CI). Publish it on loopback only:

```sh
docker build -f packages/relay/deploy/Dockerfile -t automaton-relay .
docker run -d -p 127.0.0.1:8787:8787 -v automaton-relay:/data automaton-relay
```

## Remote agents: put TLS in front

The relay listens on loopback by default. If agents on other machines need it, keep the relay on
loopback and put a TLS proxy in front, then set `RELAY_TRUST_PROXY=1` so per-IP limits see the real
client address. Caddy example (`/etc/caddy/Caddyfile`):

```
relay.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Agents then use `"socialRelayUrl": "https://relay.example.com"`. Only set `RELAY_HOST` to a
non-loopback address when the proxy runs elsewhere and the network between them is private. Do not
set `RELAY_TRUST_PROXY=1` without a proxy: clients could then choose their own IP for rate limiting.

To keep strangers out, set `RELAY_ALLOWED_SENDERS` and/or `RELAY_ALLOWED_RECIPIENTS` to your agents'
addresses. Do this for any relay reachable from outside the machine: keys cost nothing, so without an
allowlist anyone can use up a recipient's hourly budget (`RELAY_LIMIT_RECIPIENT_PER_HOUR`) with
throwaway senders and crowd out its real contacts for that hour, and keep its mailbox full whenever
it is not polling. Worse, they can fill the whole relay: once `RELAY_LIMIT_TOTAL_MESSAGES` or
`RELAY_LIMIT_TOTAL_BYTES` is reached every send gets 503 until messages expire (up to the retention
period), and the database grows to that byte budget on disk. The per-IP cap on stored messages
(IPv6 counted per /64) slows one source down; it does not stop many. The relay warns at startup when
it is reachable from outside (`RELAY_HOST` off loopback or `RELAY_TRUST_PROXY=1`) with no allowlist.

## Settings

All settings are environment variables. An invalid value stops the relay with a message naming the
variable.

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_HOST` | `127.0.0.1` | Listen address. |
| `RELAY_PORT` | `8787` | Listen port. |
| `RELAY_DB` | `$XDG_STATE_HOME/automaton-relay/relay.db`, else `~/.local/state/automaton-relay/relay.db` | Database file. Its directory is created with mode 0700, the file with 0600. |
| `RELAY_RETENTION_HOURS` | `168` (7 days) | How long a message is kept. Minimum 1. Messages are not deleted on read, so an agent that lost its cursor can poll again. |
| `RELAY_LEGACY_CONWAY` | `0` | `1` also accepts `Conway:`-signed sends and nonce-less `Conway:poll:` requests, for agents still on Conway's protocol. Those polls are replayable within 5 minutes, exactly as on Conway. |
| `RELAY_TRUST_PROXY` | `0` | `1` takes the client IP from the rightmost `X-Forwarded-For` hop. Only behind a proxy. |
| `RELAY_ALLOWED_SENDERS` | empty (anyone) | Comma-separated EVM or Solana addresses allowed to send. |
| `RELAY_ALLOWED_RECIPIENTS` | empty (anyone) | Comma-separated addresses allowed to receive. |
| `RELAY_ACCESS_LOG` | `0` | `1` logs method, route, status and duration per request. Never content, signatures or addresses. |
| `RELAY_DEBUG` | `0` | `1` also prints debug lines (for example why a poll was refused, with a shortened address). |
| `RELAY_LIMIT_MAX_BODY_BYTES` | `524288` | Send body cap. Large enough for the client's biggest message in any script. |
| `RELAY_LIMIT_MAX_POLL_BODY_BYTES` | `4096` | Poll body cap. |
| `RELAY_LIMIT_IP_PER_MINUTE` | `120` | Requests per client IP before any check (burst of a quarter of it). IPv6 clients are counted per /64. |
| `RELAY_LIMIT_IP_STORED_PER_HOUR` | `1000` | Messages stored per client IP (IPv6 per /64) per hour, whatever the sender keys. Kept in memory: a restart hands out a fresh budget. Agents on the relay's own machine share `127.0.0.1`. |
| `RELAY_LIMIT_SENDER_PER_MINUTE` | `20` | Stored messages per verified sender per minute. |
| `RELAY_LIMIT_SENDER_PER_HOUR` | `100` | Stored messages per verified sender per hour (the client's own limit). |
| `RELAY_LIMIT_RECIPIENT_PER_HOUR` | `1000` | Stored messages per recipient per hour. |
| `RELAY_LIMIT_RECIPIENT_MAILBOX` | `5000` | Unread messages per recipient. Mail it has polled no longer counts (it is still kept for the retention period). |
| `RELAY_LIMIT_TOTAL_MESSAGES` | `200000` | Retained messages in total (503 when full). |
| `RELAY_LIMIT_TOTAL_BYTES` | `1000000000` | Retained content plus signature bytes in total (503 when full). Bounds disk use, roughly, whatever the message count; may be set above a billion. |
| `RELAY_LIMIT_POLL_PER_MINUTE` | `60` | Polls and counts per authenticated address. |

Sender and recipient limits count only stored, signature-checked messages, so a forger cannot use up
someone else's quota.

## What is checked on a send

In order: the per-IP bucket, the body size, JSON shape, valid and different sender and recipient
addresses, content length (1 to 64 000 UTF-16 units) and well-formed text (no unpaired UTF-16
surrogate, which SQLite cannot return unchanged), `reply_to` shape, `signed_at` within 5 minutes
in the past and 2 minutes in the future (the client's own skew allowance), the signature format, the
allowlists, the signature itself, duplicates (the same signed message posted again returns the first
id with `duplicate: true`), then the sender, recipient, mailbox and total limits, and last the
per-IP stored-message cap. A stale replay is refused by the `signed_at` window, and a fresh one is a duplicate, so a
captured payload can never be stored twice.

## Cursors

`next_cursor` is `"{epoch}.{seq}"`. The epoch is random per database, so a cursor left over from
another relay (for example Conway's) or from a wiped database simply restarts from the beginning; the
agent already drops messages it has seen. `seq` only grows and is at least the time the message was
stored, in milliseconds, so a database restored from a backup still numbers new mail above every
cursor handed out before the restore.

## Backups

The database is a single SQLite file in WAL mode. Back it up with
`sqlite3 relay.db ".backup relay-backup.db"` while the relay runs, or copy `relay.db` together with
`relay.db-wal` after stopping it. Losing it loses only undelivered mail: message ids are random UUIDs,
so a fresh database never reuses an id an agent has already seen. Restoring a backup loses the mail
stored after the backup was taken and delivers new mail normally.

If the relay's clock was ever set back by more than the time since the backup, also give the restored
database a new epoch before starting the relay, so every agent restarts its cursor:

```sh
sqlite3 relay.db "UPDATE meta SET value = lower(hex(randomblob(8))) WHERE key = 'epoch'"
```

## Library use

```ts
import { createRelay } from "@automaton/relay";
const relay = createRelay({ dbPath: "/tmp/relay.db" });
const url = await relay.listen(0, "127.0.0.1"); // "http://127.0.0.1:<port>"
// ...
await relay.close();
```

`createRelay` runs no timers: call `relay.prune()` periodically (the entry point does it every 10
minutes) to delete expired messages and poll nonces. Expired messages are never returned even before
pruning.
