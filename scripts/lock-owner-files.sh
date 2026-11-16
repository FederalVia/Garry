#!/bin/sh
# Lock the owner's files for the dedicated-Unix-user layout.
#
#   sudo scripts/lock-owner-files.sh /var/lib/automaton/.automaton automaton
#
# After it runs, the agent user (a member of <group>) can read its config,
# wallet and owner database and create its own files in the state folder,
# but cannot modify, rename, delete or replace any owner file:
#   - owner files are root:<group> 0640 (constitution.md 0444),
#   - <state>/owner is root:<group> 0750, owner.db inside it root:<group> 0640,
#   - <state>/public-access (tunnel credential files, see docs/public-access.md)
#     is root:<group> 0750, each file in it root:<group> 0640,
#   - the state folder is root:<group> 1770 (sticky: a group member cannot
#     rename or unlink files it does not own).
# Every owner file is created when missing, since the agent could otherwise
# create it first (and systemd's ReadOnlyPaths= needs every path to exist).
# Idempotent. Prints what it changed.
set -eu

die() { echo "lock-owner-files: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "must run as root (sudo)"
[ $# -eq 2 ] || die "usage: $0 <state-dir> <group>"
STATE="$1"
GROUP="$2"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

[ -L "$STATE" ] && die "$STATE is a symbolic link; give the real folder"
[ -d "$STATE" ] || die "$STATE is not a folder"
getent group "$GROUP" >/dev/null 2>&1 || die "no such group: $GROUP"

changed=0
note() { echo "  $*"; changed=1; }

for f in automaton.json wallet.json; do
  p="$STATE/$f"
  [ -L "$p" ] && die "$p is a symbolic link"
  [ -f "$p" ] || die "$p is missing: run the setup wizard as the agent user first (docs/deployment.md)"
done

# Files the agent must not be able to create first.
ensure_file() {
  p="$STATE/$1"
  [ -L "$p" ] && die "$p is a symbolic link"
  if [ ! -e "$p" ]; then
    printf '%s\n' "$2" > "$p"
    note "created $p"
  fi
}
ensure_file config.json '{}'
ensure_file inference-providers.json '{}'
# MCP off, as with no file; the owner turns it on and adds servers here.
ensure_file mcp-servers.json '{ "version": 1, "enabled": false }'
ensure_file heartbeat.yml 'entries: []'
if [ ! -e "$STATE/constitution.md" ] && [ ! -L "$STATE/constitution.md" ]; then
  [ -f "$REPO/constitution.md" ] || die "$STATE/constitution.md is missing and $REPO/constitution.md was not found"
  cp "$REPO/constitution.md" "$STATE/constitution.md"
  note "copied constitution.md"
fi

lock_path() {
  p="$1"; mode="$2"
  [ -L "$p" ] && die "$p is a symbolic link"
  [ -f "$p" ] || die "$p is not a regular file"
  links=$(stat -c %h "$p")
  [ "$links" = "1" ] || die "$p has $links hard links; remove the others first (one may be the agent's)"
  owner=$(stat -c %U:%G "$p")
  cur=$(stat -c %a "$p")
  if [ "$owner" != "root:$GROUP" ]; then chown "root:$GROUP" "$p"; note "chown root:$GROUP $p (was $owner)"; fi
  if [ "$cur" != "$mode" ]; then chmod "$mode" "$p"; note "chmod $mode $p (was $cur)"; fi
}

for f in automaton.json wallet.json config.json heartbeat.yml inference-providers.json mcp-servers.json; do
  lock_path "$STATE/$f" 640
done
lock_path "$STATE/constitution.md" 444

# The owner database folder.
OWNER="$STATE/owner"
[ -L "$OWNER" ] && die "$OWNER is a symbolic link"
if [ ! -d "$OWNER" ]; then
  [ -e "$OWNER" ] && die "$OWNER exists and is not a folder"
  install -d -o root -g "$GROUP" -m 0750 "$OWNER"
  note "created $OWNER"
else
  owner=$(stat -c %U:%G "$OWNER"); cur=$(stat -c %a "$OWNER")
  if [ "$owner" != "root:$GROUP" ]; then chown "root:$GROUP" "$OWNER"; note "chown root:$GROUP $OWNER (was $owner)"; fi
  if [ "$cur" != "750" ]; then chmod 0750 "$OWNER"; note "chmod 750 $OWNER (was $cur)"; fi
fi
[ -e "$OWNER/owner.db-wal" ] && die "$OWNER/owner.db-wal exists: the owner database must use a rollback journal (run automaton-cli budget show once as root, with the agent stopped)"
for f in "$OWNER"/* "$OWNER"/.[!.]*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  case "$(basename "$f")" in
    owner.db|owner.db-journal) lock_path "$f" 640 ;;
    *) die "unexpected file in $OWNER: $f (only owner.db belongs there)" ;;
  esac
done

if [ ! -e "$OWNER/owner.db" ]; then
  CLI="$REPO/packages/cli/dist/index.js"
  if [ -f "$CLI" ] && [ "$(basename "$STATE")" = ".automaton" ]; then
    HOME="$(dirname "$STATE")" node "$CLI" budget show --init >/dev/null
    lock_path "$OWNER/owner.db" 640
    note "created $OWNER/owner.db"
  else
    echo "  $OWNER/owner.db not created ($CLI not built); 'automaton-cli budget add' run as root creates it."
  fi
fi

# Credential files a public-access tunnel reads. Only root places files here:
# a file the agent user owns may be one it planted, so it is refused, not adopted.
PA="$STATE/public-access"
[ -L "$PA" ] && die "$PA is a symbolic link"
if [ ! -d "$PA" ]; then
  [ -e "$PA" ] && die "$PA exists and is not a folder"
  install -d -o root -g "$GROUP" -m 0750 "$PA"
  note "created $PA"
else
  # The folder first, so nothing new can appear while its files are checked.
  owner=$(stat -c %U:%G "$PA"); cur=$(stat -c %a "$PA")
  if [ "$owner" != "root:$GROUP" ]; then chown "root:$GROUP" "$PA"; note "chown root:$GROUP $PA (was $owner)"; fi
  if [ "$cur" != "750" ]; then chmod 0750 "$PA"; note "chmod 750 $PA (was $cur)"; fi
  for f in "$PA"/* "$PA"/.[!.]*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    [ -L "$f" ] && die "$f is a symbolic link"
    [ -f "$f" ] || die "unexpected entry in $PA: $f (only regular files belong there)"
    [ "$(stat -c %u "$f")" = "0" ] || die "$f is not owned by root; check it was you who put it there, then chown it to root"
    lock_path "$f" 640
  done
fi

# Last: the state folder itself.
owner=$(stat -c %U:%G "$STATE"); cur=$(stat -c %a "$STATE")
if [ "$owner" != "root:$GROUP" ]; then chown "root:$GROUP" "$STATE"; note "chown root:$GROUP $STATE (was $owner)"; fi
if [ "$cur" != "1770" ]; then chmod 1770 "$STATE"; note "chmod 1770 $STATE (was $cur)"; fi

if [ "$changed" = "0" ]; then echo "Owner files already locked in $STATE."; else echo "Owner files locked in $STATE."; fi
