#!/usr/bin/env bash
# Nightly Postgres backup (D42): a compressed custom-format pg_dump of the bundled db, written atomically, with
# retention. Run from the systemd timer (ops/shareinference-backup.timer) or by hand. Exits non-zero on any failure.
#
# Environment (all optional):
#   BACKUP_DIR            target directory (default /var/backups/shareinference)
#   BACKUP_RETENTION_DAYS delete dumps older than this many days (default 14)
#   BACKUP_RCLONE_REMOTE  e.g. "s3:bucket/shareinference": also upload the new dump with rclone (off-VM copy; unset = skipped)
#   COMPOSE_DIR           directory holding compose.yaml (default: the parent of this script's directory)
#   COMPOSE_ARGS          docker compose arguments; default is the production set when .deploy.env exists in COMPOSE_DIR
#                         ("-f compose.yaml -f compose.prod.yaml --env-file .env --env-file .deploy.env"), else none
set -euo pipefail
umask 077

BACKUP_DIR=${BACKUP_DIR:-/var/backups/shareinference}
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}
COMPOSE_DIR=${COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}

[[ $RETENTION_DAYS =~ ^[0-9]+$ ]] || { echo "BACKUP_RETENTION_DAYS must be a whole number" >&2; exit 2; }
cd "$COMPOSE_DIR"
if [[ -z ${COMPOSE_ARGS:-} && -f .deploy.env ]]; then
  COMPOSE_ARGS="-f compose.yaml -f compose.prod.yaml --env-file .env --env-file .deploy.env"
fi
read -r -a compose <<<"docker compose ${COMPOSE_ARGS:-}"

mkdir -p "$BACKUP_DIR"
# Seconds plus the PID: two runs in the same second never share a file name.
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
final="$BACKUP_DIR/shareinference-$stamp.dump"
tmp="$final.tmp"
trap 'rm -f "$tmp"' EXIT

# Compressed custom format (restorable with pg_restore, selectively if needed); dumped over the container's local socket.
"${compose[@]}" exec -T db pg_dump -U shareinference -d shareinference -Fc >"$tmp"
[[ -s $tmp ]] || { echo "backup is empty" >&2; exit 1; }
# A dump that pg_restore cannot read is not a backup.
"${compose[@]}" exec -T db pg_restore -l <"$tmp" >/dev/null
mv "$tmp" "$final"
echo "backup written: $final ($(du -h "$final" | cut -f1))"

# Leftovers of runs that died mid-write, and old dumps (including restore.sh's pre-restore safety dumps).
find "$BACKUP_DIR" -maxdepth 1 -name 'shareinference-*.dump.tmp' -mtime +1 -print -delete | sed 's/^/pruned: /'
find "$BACKUP_DIR" -maxdepth 1 \( -name 'shareinference-*.dump' -o -name 'pre-restore-*.dump' \) -mtime +"$RETENTION_DAYS" -print -delete |
  sed 's/^/pruned: /'

# Off-VM copy, only when a remote is configured (later: object storage). The local dump stays either way.
if [[ -n ${BACKUP_RCLONE_REMOTE:-} ]]; then
  command -v rclone >/dev/null || { echo "BACKUP_RCLONE_REMOTE is set but rclone is not installed" >&2; exit 1; }
  rclone copy "$final" "$BACKUP_RCLONE_REMOTE"
  echo "uploaded to $BACKUP_RCLONE_REMOTE"
fi
