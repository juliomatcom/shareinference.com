#!/usr/bin/env bash
# Deploy to the production VM without building there (D41): build both images here, stream them over ssh, copy the
# compose files and Caddy config, start the stack, check health. Runbook: docs/deploy.md.
#
#   DEPLOY_HOST=root@host ops/deploy.sh [--dry-run]
#   IMAGE_TAG=<tag on the VM> DEPLOY_HOST=root@host ops/deploy.sh      # redeploy / roll back: no build, no upload
#
# Environment:
#   DEPLOY_HOST      ssh target, root@host (required; never committed). The VM is operated as root, key-only ssh.
#   DEPLOY_DIR       directory on the VM (default /opt/shareinference); holds the hand-made .env (secrets)
#   DEPLOY_DOMAIN    public host[:port] used for the health check (default shareinference.com)
#   DEPLOY_API_DOMAIN api host[:port] for the health check (default api.<DEPLOY_DOMAIN>)
#   DEPLOY_CURL_OPTS extra curl options for the health check (e.g. "-k" against a local test certificate)
#   DEPLOY_PLATFORM  image platform of the VM (default linux/amd64; building it on an ARM machine needs qemu emulation,
#                    which is slow: build on an amd64 machine or in CI when you can)
#   DEPLOY_SSH_OPTS  extra ssh options (e.g. "-i ~/.ssh/key")
#   IMAGE_TAG        default: short git commit, plus -dirty-<time> for an uncommitted tree. Setting it means the images
#                    already exist on the VM (a rollback): nothing is built or sent.
# --dry-run builds the images (unless IMAGE_TAG is set) but only prints what it would run on the VM.
#
# .deploy.env on the VM (the live tag) is replaced only after the new stack is up and healthy; the old one is kept as
# .deploy.env.prev. On any failure the exact rollback command is printed.
set -euo pipefail

dry=0
case ${1:-} in
  "") ;;
  --dry-run) dry=1 ;;
  -h | --help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown argument: $1 (try --dry-run)" >&2; exit 2 ;;
esac

if ((dry)); then
  DEPLOY_HOST=${DEPLOY_HOST:-root@host}
else
  : "${DEPLOY_HOST:?set DEPLOY_HOST (root@host of the VM)}"
fi
DEPLOY_DIR=${DEPLOY_DIR:-/opt/shareinference}
DEPLOY_DOMAIN=${DEPLOY_DOMAIN:-shareinference.com}
DEPLOY_API_DOMAIN=${DEPLOY_API_DOMAIN:-api.$DEPLOY_DOMAIN}
DEPLOY_PLATFORM=${DEPLOY_PLATFORM:-linux/amd64}
[[ $DEPLOY_DIR =~ ^/[A-Za-z0-9_./-]+$ ]] || { echo "DEPLOY_DIR must be an absolute path of plain characters" >&2; exit 2; }
[[ $DEPLOY_DOMAIN =~ ^[A-Za-z0-9.:-]+$ && $DEPLOY_API_DOMAIN =~ ^[A-Za-z0-9.:-]+$ ]] ||
  { echo "DEPLOY_DOMAIN and DEPLOY_API_DOMAIN must be host names" >&2; exit 2; }
read -r -a curl_opts <<<"${DEPLOY_CURL_OPTS:-}"
read -r -a ssh_opts <<<"${DEPLOY_SSH_OPTS:-}"
# The ${arr[@]+...} form keeps an empty array legal under `set -u` on older bash (macOS).
ssh_cmd=(ssh ${ssh_opts[@]+"${ssh_opts[@]}"} "$DEPLOY_HOST")

cd "$(dirname "${BASH_SOURCE[0]}")/.."
redeploy=0
if [[ -n ${IMAGE_TAG:-} ]]; then
  redeploy=1
else
  IMAGE_TAG=$(git rev-parse --short HEAD)
  [[ -z $(git status --porcelain) ]] || IMAGE_TAG="$IMAGE_TAG-dirty-$(date -u +%Y%m%d%H%M)"
fi
[[ $IMAGE_TAG =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "invalid IMAGE_TAG: $IMAGE_TAG" >&2; exit 2; }
export IMAGE_TAG
echo "deploying $IMAGE_TAG ($DEPLOY_PLATFORM) to $DEPLOY_HOST:$DEPLOY_DIR"

compose_base="docker compose -f compose.yaml -f compose.prod.yaml --env-file .env"
# The new tag goes through a temp env file; .deploy.env changes only once the stack is healthy.
remote_compose="$compose_base --env-file .deploy.env.new"
reload_caddy="ok=0; for i in 1 2 3 4 5 6; do if $remote_compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then ok=1; break; fi; sleep 2; done; [ \$ok = 1 ]"
show() { printf '+ %s\n' "$*"; }

previous=""
if ((! dry)); then
  # Before anything changes: what is live now (the rollback target).
  previous=$("${ssh_cmd[@]}" "sed -n 's/^IMAGE_TAG=//p' '$DEPLOY_DIR/.deploy.env' 2>/dev/null || true")
fi
started=0
on_exit() {
  local status=$?
  ((status == 0 || dry)) && return 0
  echo >&2
  echo "DEPLOY FAILED (exit $status)." >&2
  if ((started)) && [[ -n $previous ]]; then
    echo "The stack may be running $IMAGE_TAG. Roll back to the previous release with either:" >&2
    echo "  IMAGE_TAG=$previous DEPLOY_HOST=$DEPLOY_HOST ops/deploy.sh" >&2
    echo "  (on the VM, in $DEPLOY_DIR)  echo IMAGE_TAG=$previous > .deploy.env.new && $remote_compose up -d" >&2
  elif ((started)); then
    echo "No previous release is recorded; inspect with '$remote_compose logs --tail 100' in $DEPLOY_DIR." >&2
  else
    echo "Nothing was started; the running release${previous:+ ($previous)} is unchanged." >&2
  fi
}
trap on_exit EXIT

if ((! redeploy)); then
  # 1. Build here. Only the base compose file knows the build contexts; the build needs no secrets (a placeholder
  #    DATABASE_URL satisfies compose's required-variable check on a machine without a .env).
  echo "== build"
  DATABASE_URL=${DATABASE_URL:-unused} DOCKER_DEFAULT_PLATFORM=$DEPLOY_PLATFORM docker compose -f compose.yaml build api web
fi

echo "== commands"
((redeploy)) || show "docker save shareinference-api:$IMAGE_TAG shareinference-web:$IMAGE_TAG | gzip | ssh $DEPLOY_HOST 'gunzip | docker load'"
show "tar -cf - compose.yaml compose.prod.yaml ops | ssh $DEPLOY_HOST 'mkdir -p $DEPLOY_DIR && tar -xf - -C $DEPLOY_DIR'"
show "ssh $DEPLOY_HOST 'cd $DEPLOY_DIR && echo IMAGE_TAG=$IMAGE_TAG > .deploy.env.new && $remote_compose up -d --remove-orphans && <caddy reload> && $remote_compose ps'"
show "curl --fail https://$DEPLOY_DOMAIN/api/healthz && curl --fail https://$DEPLOY_API_DOMAIN/healthz"
show "ssh $DEPLOY_HOST 'cd $DEPLOY_DIR && cp .deploy.env .deploy.env.prev; mv .deploy.env.new .deploy.env'"
if ((dry)); then
  echo "dry run: nothing was sent"
  exit 0
fi

# 2. The VM needs its secrets file first (written by hand, never by this script).
"${ssh_cmd[@]}" "test -f '$DEPLOY_DIR/.env'" ||
  { echo "$DEPLOY_DIR/.env is missing on the VM: create it first (docs/deploy.md, step 'Production .env')" >&2; exit 1; }

if ((redeploy)); then
  for image in api web; do
    "${ssh_cmd[@]}" "docker image inspect shareinference-$image:$IMAGE_TAG >/dev/null" ||
      { echo "shareinference-$image:$IMAGE_TAG is not on the VM; deploy it without IMAGE_TAG to build and send it" >&2; exit 1; }
  done
else
  echo "== ship images"
  docker save "shareinference-api:$IMAGE_TAG" "shareinference-web:$IMAGE_TAG" | gzip | "${ssh_cmd[@]}" 'gunzip | docker load'
fi

echo "== ship compose files"
tar -cf - compose.yaml compose.prod.yaml ops | "${ssh_cmd[@]}" "mkdir -p '$DEPLOY_DIR' && tar -xf - -C '$DEPLOY_DIR'"

echo "== start"
started=1
# `exec caddy reload` applies a changed Caddyfile (the ops/caddy directory is mounted; a recreated container reads it anyway).
"${ssh_cmd[@]}" "cd '$DEPLOY_DIR' && echo 'IMAGE_TAG=$IMAGE_TAG' > .deploy.env.new && $remote_compose up -d --remove-orphans && $reload_caddy && $remote_compose ps"

echo "== health"
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 10 ${curl_opts[@]+"${curl_opts[@]}"} "https://$DEPLOY_DOMAIN/api/healthz" >/dev/null 2>&1 &&
    curl -fsS --max-time 10 ${curl_opts[@]+"${curl_opts[@]}"} "https://$DEPLOY_API_DOMAIN/healthz" 2>/dev/null; then
    healthy=1
    break
  fi
  sleep 3
done
if ((! healthy)); then
  echo "health check failed: run '$remote_compose logs --tail 100' in $DEPLOY_DIR on the VM" >&2
  exit 1
fi
echo

# Healthy: this tag is now the live one; keep the old one for rollback.
"${ssh_cmd[@]}" "cd '$DEPLOY_DIR' && { [ ! -f .deploy.env ] || cp .deploy.env .deploy.env.prev; } && mv .deploy.env.new .deploy.env"
echo "deployed $IMAGE_TAG${previous:+ (previous: $previous; roll back with IMAGE_TAG=$previous ops/deploy.sh)}"
