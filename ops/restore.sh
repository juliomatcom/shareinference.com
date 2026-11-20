#!/usr/bin/env bash
# Restore a dump made by ops/backup.sh into the bundled Postgres.
#
#   ops/restore.sh [--yes] [--db NAME] <dump file>
#
# Default target is the live database `shareinference`: the api is stopped first, the database is DROPPED and recreated
# from the dump, then the api is started again (it runs pending migrations). `--db NAME` restores into another database
# (created fresh; an existing one is dropped) and leaves the api alone: use it to test a backup (e.g. --db restore_test).
# Before dropping the live database it takes a safety dump (BACKUP_DIR/pre-restore-<time>.dump, default
# /var/backups/shareinference) and aborts if that fails. Without --yes it asks you to type the database name.
# Same COMPOSE_DIR / COMPOSE_ARGS variables as backup.sh.
set -euo pipefail

assume_yes=0
target=shareinference
dump=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --yes) assume_yes=1 ;;
    --db) target=${2:?--db needs a name}; shift ;;
    -h | --help) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) dump=$1 ;;
  esac
  shift
done
[[ -n $dump ]] || { echo "usage: ops/restore.sh [--yes] [--db NAME] <dump file>" >&2; exit 2; }
[[ -f $dump ]] || { echo "no such file: $dump" >&2; exit 2; }
[[ $target =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "invalid database name: $target" >&2; exit 2; }
[[ $target != postgres && $target != template0 && $target != template1 ]] || { echo "refusing to touch $target" >&2; exit 2; }

COMPOSE_DIR=${COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
cd "$COMPOSE_DIR"
if [[ -z ${COMPOSE_ARGS:-} && -f .deploy.env ]]; then
  COMPOSE_ARGS="-f compose.yaml -f compose.prod.yaml --env-file .env --env-file .deploy.env"
fi
read -r -a compose <<<"docker compose ${COMPOSE_ARGS:-}"
psql=("${compose[@]}" exec -T db psql -U shareinference -d postgres -v ON_ERROR_STOP=1 -q)

live=0
[[ $target == shareinference ]] && live=1

if ((assume_yes == 0)); then
  echo "This will DROP database '$target' and replace it with the contents of $dump."
  ((live)) && echo "The api will be stopped while it runs and started again afterwards."
  [[ -t 0 ]] || { echo "not a terminal: pass --yes to confirm" >&2; exit 2; }
  read -r -p "Type the database name ($target) to continue: " answer
  [[ $answer == "$target" ]] || { echo "aborted" >&2; exit 1; }
fi

"${compose[@]}" exec -T db pg_restore -l <"$dump" >/dev/null || { echo "not a readable pg_dump custom-format file" >&2; exit 1; }

if ((live)); then
  "${compose[@]}" stop api
  # What is in the live database right now, in case the dump being restored turns out to be the wrong one.
  BACKUP_DIR=${BACKUP_DIR:-/var/backups/shareinference}
  safety="$BACKUP_DIR/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
  if ! (umask 077 && mkdir -p "$BACKUP_DIR" && "${compose[@]}" exec -T db pg_dump -U shareinference -d shareinference -Fc >"$safety" &&
    [[ -s $safety ]] && "${compose[@]}" exec -T db pg_restore -l <"$safety" >/dev/null); then
    rm -f "$safety"
    echo "safety dump failed: nothing was changed; starting the api again" >&2
    "${compose[@]}" start api
    exit 1
  fi
  echo "safety dump of the current database: $safety"
fi
"${psql[@]}" -c "DROP DATABASE IF EXISTS $target WITH (FORCE)" -c "CREATE DATABASE $target"
# --no-owner: objects belong to the connecting role (shareinference), as in the original.
"${compose[@]}" exec -T db pg_restore -U shareinference -d "$target" --no-owner --exit-on-error <"$dump"
echo "restored $dump into $target"

if ((live)); then
  "${compose[@]}" start api
  echo "api started; check: docker compose ps, then ledger:check"
fi
