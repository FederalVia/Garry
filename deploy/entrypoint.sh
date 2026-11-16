#!/bin/sh
# Container entrypoint for the automaton image.
#
#   run (default)   start the agent, after checking the owner files are locked
#   setup           first-time setup wizard; moves the owner files to /config
#   configure       edit automaton.json (bound read-write for that service only)
#   cli <args>      the owner CLI (automaton-cli)
#   healthcheck     exit 0 while the heartbeat is alive
#   version         print the version
#
# The owner files and the owner database are what the agent must not change.
# `run` refuses to start when any of them could be written, replaced or
# created by the agent user, so a missing or mistyped mount fails loudly
# instead of running unprotected.
set -eu

APP="${AUTOMATON_APP_DIR:-/app}"
STATE="${HOME:?HOME must be set}/.automaton"
CONFIG_OUT=/config
# Every file the agent reads but must never change. inference-providers.json
# sets the prices the inference gate charges, and mcp-servers.json holds the
# owner's MCP servers and approvals, so both are locked as well.
OWNER_FILES="automaton.json wallet.json config.json heartbeat.yml constitution.md inference-providers.json mcp-servers.json"
# Folders the agent reads but must never change, with everything in them:
# owner (owner.db) and public-access (credential files a tunnel command reads,
# such as a named tunnel's credentials; see docs/public-access.md).
OWNER_DIRS="owner public-access"

die() {
  code="$1"
  shift
  echo "automaton-entrypoint: $*" >&2
  exit "$code"
}

file_uid() {
  # ls -n prints the numeric owner in field 3 on GNU and busybox alike.
  ls -nd "$1" 2>/dev/null | awk '{print $3}'
}

# Options of the mount that holds $1 (the longest mount point that is a
# prefix of its real path). Prints nothing when /proc is unavailable.
mount_opts() {
  [ -r /proc/self/mountinfo ] || return 0
  awk -v p="$1" '
    function unesc(s) { gsub(/\\040/, " ", s); gsub(/\\011/, "\t", s); gsub(/\\012/, "\n", s); gsub(/\\134/, "\\", s); return s }
    {
      mp = unesc($5)
      if (p == mp || mp == "/" || index(p, mp "/") == 1) {
        if (length(mp) >= best) { best = length(mp); opts = $6 }
      }
    }
    END { print opts }
  ' /proc/self/mountinfo
}

on_readonly_mount() {
  case ",$(mount_opts "$1")," in
    *,ro,*) return 0 ;;
    *) return 1 ;;
  esac
}

# Why the agent user could change $1, or nothing when it cannot. A path is
# locked when it sits on a read-only mount, or when this user cannot write
# it, does not own it (so cannot chmod it), and cannot rename or unlink it
# in its folder (folder not writable, or sticky and owned by someone else).
unlocked_reason() {
  p="$1"
  if [ -L "$p" ]; then echo "is a symbolic link"; return; fi
  if [ ! -e "$p" ]; then echo "is missing (the agent could create it)"; return; fi
  real=$(readlink -f "$p" 2>/dev/null || echo "$p")
  if on_readonly_mount "$real"; then return; fi
  me=$(id -u)
  if [ -w "$p" ]; then echo "is writable"; return; fi
  if [ "$(file_uid "$p")" = "$me" ]; then echo "is owned by the agent user (it could chmod it)"; return; fi
  parent=$(dirname "$real")
  if [ -w "$parent" ]; then
    if [ -k "$parent" ] && [ "$(file_uid "$parent")" != "$me" ]; then
      return
    fi
    echo "sits in a folder the agent user can write (it could be renamed or replaced)"
    return
  fi
}

check_locked() {
  bad=""
  for f in $OWNER_FILES; do
    p="$STATE/$f"
    why=$(unlocked_reason "$p")
    if [ -n "$why" ]; then bad="$bad
  $p $why"; continue; fi
    [ -f "$p" ] || bad="$bad
  $p is not a regular file"
  done
  for d in $OWNER_DIRS; do
    owner="$STATE/$d"
    why=$(unlocked_reason "$owner")
    if [ -n "$why" ]; then
      bad="$bad
  $owner $why"
    elif [ ! -d "$owner" ]; then
      bad="$bad
  $owner is not a folder"
    else
      for f in "$owner"/* "$owner"/.[!.]*; do
        [ -e "$f" ] || [ -L "$f" ] || continue
        why=$(unlocked_reason "$f")
        [ -n "$why" ] && bad="$bad
  $f $why"
      done
    fi
  done
  if [ -n "$bad" ]; then
    if [ "${AUTOMATON_ALLOW_WRITABLE_CONFIG:-}" = "1" ]; then
      echo "automaton-entrypoint: WARNING: AUTOMATON_ALLOW_WRITABLE_CONFIG=1, starting although:$bad" >&2
      return 0
    fi
    die 64 "refusing to start: the agent could change its owner files:$bad
Mount them read-only as in deploy/docker-compose.yml (see docs/deployment.md),
or set AUTOMATON_ALLOW_WRITABLE_CONFIG=1 to start anyway (not recommended)."
  fi
}

# The runtime writes providers.mode into automaton.json at startup when the
# file has neither a mode nor a Conway key. That write fails on a read-only
# file, so say how to fix it instead of letting the agent stop later.
check_mode_pinned() {
  node -e '
    const fs = require("fs");
    let raw;
    try { raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch (e) { console.error("automaton-entrypoint: cannot read " + process.argv[1] + ": " + e.message); process.exit(64); }
    const p = raw && typeof raw.providers === "object" && raw.providers ? raw.providers : {};
    const key = raw.conwayApiKey || (p.conway && p.conway.apiKey);
    if (p.mode !== "standalone" && p.mode !== "conway" && !key) {
      console.error("automaton-entrypoint: automaton.json sets no providers.mode; the agent would have to write it at startup, and the file is read-only.\n" +
        "Set \"providers\": { \"mode\": \"standalone\" } in data/config/automaton.json, or run: docker compose --profile owner run --rm configure");
      process.exit(64);
    }
  ' "$STATE/automaton.json"
}

cmd_run() {
  if [ "$(id -u)" = "0" ] && [ "${AUTOMATON_ALLOW_ROOT:-}" != "1" ]; then
    die 64 "refusing to run the agent as root. Run the image with its default user (10001), or set AUTOMATON_ALLOW_ROOT=1."
  fi
  check_locked
  [ -f "$STATE/automaton.json" ] && check_mode_pinned
  exec node "$APP/dist/index.js" --run
}

# setup and configure write the owner files with a temp file and a rename,
# which cannot replace a single-file bind mount. So they work in a private
# ~/.automaton (a tmpfs in deploy/docker-compose.yml) and move the results to
# /config (data/config). They never touch data/state, which they see at
# /state: the running agent's read-only binds sit on files there, and
# unlinking or replacing one from another container detaches that bind in
# the agent's container and hands it a writable copy.
SHARED_STATE="${AUTOMATON_SHARED_STATE:-/state}"
CONFIG_OUT="${AUTOMATON_CONFIG_OUT:-$CONFIG_OUT}"

require_owner_mounts() {
  { [ -d "$CONFIG_OUT" ] && [ -w "$CONFIG_OUT" ]; } ||
    die 64 "$1 needs data/config mounted read-write at $CONFIG_OUT (docker compose --profile owner run --rm $1)"
  { [ -d "$STATE/owner" ] && [ -w "$STATE/owner" ]; } ||
    die 64 "$1 needs data/owner mounted read-write at $STATE/owner"
  [ -d "$SHARED_STATE" ] ||
    die 64 "$1 needs data/state mounted at $SHARED_STATE (see deploy/docker-compose.yml)"
  # The old layout mounted data/state at ~/.automaton here: refuse it.
  if [ "$STATE" -ef "$SHARED_STATE" ]; then
    die 64 "$1 must not run in the agent's state folder ($STATE is $SHARED_STATE); update deploy/docker-compose.yml (~/.automaton is a tmpfs for this service)"
  fi
  for f in $OWNER_FILES; do
    if [ "$STATE/$f" -ef "$SHARED_STATE/$f" ]; then
      die 64 "$1: $STATE/$f is the agent's own file; update deploy/docker-compose.yml"
    fi
  done
}

# Best effort (data/state is the agent's to change): refuse while the agent
# holds its instance lock, before anything is staged.
refuse_if_agent_running() {
  lockf="$SHARED_STATE/state.db.lock"
  [ -f "$lockf" ] || return 0
  if ! node -e '
    const Database = require(process.argv[2] + "/node_modules/better-sqlite3");
    let db;
    try {
      db = new Database(process.argv[1], { readonly: true, fileMustExist: true, timeout: 0 });
      db.prepare("SELECT COUNT(*) FROM sqlite_master").get();
    } catch (e) {
      if (/SQLITE_BUSY|database is locked/i.test(String(e && (e.code || e.message)))) process.exit(3);
    } finally {
      try { db && db.close(); } catch {}
    }
  ' "$lockf" "$APP"; then
    die 64 "$1: the agent is running on data/state. Stop it first: docker compose stop agent"
  fi
}

stage_in() {
  mkdir -p "$STATE"
  for f in $OWNER_FILES; do
    if [ -f "$CONFIG_OUT/$f" ] && [ ! -L "$CONFIG_OUT/$f" ]; then
      cp -p "$CONFIG_OUT/$f" "$STATE/$f"
    fi
  done
}

stage_out() {
  for f in $OWNER_FILES; do
    if [ -f "$STATE/$f" ] && [ ! -L "$STATE/$f" ] && [ -s "$STATE/$f" ]; then
      # Copy, then rename inside /config.
      cp -p "$STATE/$f" "$CONFIG_OUT/.$f.tmp" && mv -f "$CONFIG_OUT/.$f.tmp" "$CONFIG_OUT/$f"
    fi
  done
  # Every bind source must exist, or Docker creates a folder in its place.
  [ -s "$CONFIG_OUT/config.json" ] || printf '{}\n' > "$CONFIG_OUT/config.json"
  [ -s "$CONFIG_OUT/inference-providers.json" ] || printf '{}\n' > "$CONFIG_OUT/inference-providers.json"
  # Off, as with no file; mode 0600 because it will hold the owner's tokens.
  [ -s "$CONFIG_OUT/mcp-servers.json" ] ||
    (umask 077 && printf '{ "version": 1, "enabled": false }\n' > "$CONFIG_OUT/mcp-servers.json")
  [ -s "$CONFIG_OUT/heartbeat.yml" ] || printf 'entries: []\n' > "$CONFIG_OUT/heartbeat.yml"
  [ -s "$CONFIG_OUT/constitution.md" ] || cp "$APP/constitution.md" "$CONFIG_OUT/constitution.md"
  # Bound read-only into the agent; empty unless you add tunnel credentials.
  [ -d "$CONFIG_OUT/public-access" ] || (umask 077 && mkdir "$CONFIG_OUT/public-access")
}

# The agent's own starting files (SOUL.md, default skills) go to data/state
# only where nothing is there yet: never replacing, never following a link.
seed_state() {
  for name in SOUL.md skills; do
    src="$STATE/$name"
    dst="$SHARED_STATE/$name"
    [ -e "$src" ] || continue
    if [ -e "$dst" ] || [ -L "$dst" ]; then continue; fi
    cp -R -P -n "$src" "$dst" 2>/dev/null || echo "automaton-entrypoint: could not copy $name to data/state" >&2
  done
}

cmd_setup() {
  require_owner_mounts setup
  refuse_if_agent_running setup
  stage_in
  node "$APP/dist/index.js" --setup
  stage_out
  seed_state
  node "$APP/packages/cli/dist/index.js" budget show --init
  echo "Owner files are in data/config and data/owner. Start the agent with: docker compose up -d agent"
}

cmd_configure() {
  require_owner_mounts configure
  [ -f "$CONFIG_OUT/automaton.json" ] || die 64 "no data/config/automaton.json: run setup first"
  refuse_if_agent_running configure
  stage_in
  status=0
  node "$APP/dist/index.js" --configure || status=$?
  stage_out
  exit "$status"
}

cmd="${1:-run}"
[ $# -gt 0 ] && shift
case "$cmd" in
  run) cmd_run ;;
  setup) cmd_setup ;;
  configure) cmd_configure ;;
  cli) exec node "$APP/packages/cli/dist/index.js" "$@" ;;
  healthcheck) exec node "$APP/dist/healthcheck.js" ;;
  version) exec node "$APP/dist/index.js" --version ;;
  *) die 64 "unknown command: $cmd (run, setup, configure, cli, healthcheck, version)" ;;
esac
