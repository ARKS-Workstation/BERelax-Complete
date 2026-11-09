#!/usr/bin/env bash
#
# One paste, run on the droplet, to bring up the CRM beside whatever the host already serves.
#
# It exists because the sequence in RUNBOOK.md is correct and long, and a long sequence typed at 2am by
# somebody reading a browser console is a sequence with a step missed in it. This does the same thing and
# refuses where the runbook says stop.
#
# ## What it will NOT do
#
# Two things, and they are the two that can disturb a live site on a shared host:
#
#   - it does not reload the proxy
#   - it does not start the containers
#
# It prints both commands at the end instead. `caddy validate` has to pass before a reload, and a script
# that reloaded anyway would be fine ninety-nine times out of a hundred; the hundredth is somebody's
# website. The same reasoning is in `scripts/provision-tenant.mjs`, which this calls.
#
# ## How to run it
#
#   curl -fsSL https://raw.githubusercontent.com/ARKS-Workstation/BERelax-Complete/claude/massage-crm-planning-c05j70/deploy/droplet/bootstrap.sh -o bootstrap.sh
#   less bootstrap.sh          # read it. it runs as root on a box serving live sites
#   bash bootstrap.sh --slug berelax --subdomain crm.berelaxmassage.com --port 3000
#
# Piping curl straight into bash is not offered on purpose. This runs as root on a host with live
# customer traffic, and the one defence against a compromised raw.githubusercontent URL is that a person
# read the file first.

set -euo pipefail

SLUG=""
SUBDOMAIN=""
PORT="3000"
DB_PORT="5432"
ROOT="/srv/berelax"
CHECKOUT="/srv/berelax-crm"
BRANCH="claude/massage-crm-planning-c05j70"
MIN_FREE_MB=1800
MIN_DISK_GB=12
CHECK_ONLY="no"

while [ $# -gt 0 ]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2 ;;
    --subdomain) SUBDOMAIN="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --db-port) DB_PORT="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    --checkout) CHECKOUT="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --check-only) CHECK_ONLY="yes"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$SLUG" ] || [ -z "$SUBDOMAIN" ]; then
  echo "usage: bash bootstrap.sh --slug <slug> --subdomain <fqdn> [--port 3000] [--check-only]" >&2
  exit 2
fi

say() { printf '\n== %s\n' "$1"; }
die() { printf '\nREFUSED: %s\n' "$1" >&2; exit 1; }

# --- preconditions -----------------------------------------------------------------------------------
#
# Every one of these is a refusal rather than a warning. A deployment that printed "memory is a bit tight"
# and carried on is a deployment whose failure mode is the kernel choosing which process to kill on a box
# that is also serving customers.

say "Preconditions"

[ "$(id -u)" -eq 0 ] || die "run as root: this installs packages and writes under $ROOT."

FREE_MB=$(free -m | awk '/^Mem:/ {print $7}')
echo "   available memory   ${FREE_MB} MB (need ${MIN_FREE_MB})"
[ "$FREE_MB" -ge "$MIN_FREE_MB" ] || die \
  "only ${FREE_MB} MB available. The web container and the worker together need headroom, and documents
  render through Chromium. Resize the droplet, or deploy elsewhere. Do not lower this threshold to get
  past it: the thing it protects is the site already running here."

DISK_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
echo "   free disk          ${DISK_GB} GB (need ${MIN_DISK_GB})"
[ "$DISK_GB" -ge "$MIN_DISK_GB" ] || die \
  "only ${DISK_GB} GB free on /. A pnpm store, two container images and a Next.js build need more than
  that, and a full disk on this host takes the live site with it."

# The port is probed by CONNECTING, not by parsing `ss`.
#
# The first version of this ran `ss -ltn 2>/dev/null | grep ...`, and testing it here found the defect:
# `ss` was not installed, the pipeline produced nothing, grep matched nothing, and the check PASSED with a
# listener sitting on the port. A check that silently succeeds when its tool is missing is ADR 0002's
# subject, in the one script whose entire job is to refuse rather than guess — and on this host it would
# have passed for the wrong reason while looking right.
#
# bash's /dev/tcp needs nothing installed and tests the thing that actually matters: whether something
# accepts a connection there. A listener on 0.0.0.0 accepts on 127.0.0.1 too, so this sees both.
# The descriptor is opened and closed inside the SUBSHELL, which is why there is no `exec 3>&-` here.
# The first attempt had one, and it exited the script with status 1 and no message at all: `exec` with a
# failing redirection terminates a non-interactive shell, and `|| true` does not catch that — the parent
# never opened fd 3, so closing it was both an error and unnecessary.
if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
  WHAT=$(ss -ltnp 2>/dev/null | grep -E "[:.]${PORT}\b" || true)
  [ -n "$WHAT" ] && echo "   $WHAT"
  die "something is already listening on port ${PORT}. Every instance on this host needs its own.
  Pass a different --port; \`ss -ltnp\` shows what has this one."
fi
echo "   port ${PORT}          free"

if [ -e "$ROOT/$SLUG/.env" ]; then
  die "$ROOT/$SLUG/.env exists, so this tenant is already provisioned. Its secrets are stored only
  there and rewriting them would invalidate every signed document link and CMS session."
fi
echo "   tenant slug        ${SLUG} not yet provisioned"

PROXY="none"
if systemctl is-active --quiet caddy 2>/dev/null; then PROXY="caddy"
elif systemctl is-active --quiet nginx 2>/dev/null; then PROXY="nginx"; fi
echo "   reverse proxy      ${PROXY}"
[ "$PROXY" != "none" ] || die "no running Caddy or nginx found. The CRM binds to loopback only and is
  unreachable without one; set the proxy up first, or this deploys something nobody can open."

if getent hosts "$SUBDOMAIN" >/dev/null 2>&1; then
  echo "   DNS                ${SUBDOMAIN} resolves"
else
  echo "   DNS                ${SUBDOMAIN} does NOT resolve yet — add the A record before the proxy step,"
  echo "                      or the certificate cannot be issued. Not fatal here."
fi

if [ "$CHECK_ONLY" = "yes" ]; then
  say "Checks only. Nothing was changed."
  exit 0
fi

# --- dependencies ------------------------------------------------------------------------------------

say "Dependencies"

if ! command -v docker >/dev/null 2>&1; then
  echo "   installing docker"
  curl -fsSL https://get.docker.com | sh
else
  echo "   docker             $(docker --version | awk '{print $3}' | tr -d ,)"
fi

# Compose v2 specifically. `docker-compose.production.yml` orders the migration before the web container
# with `depends_on.condition: service_completed_successfully`, which v1 ignores SILENTLY — the migration
# and the app start together and the first request hits a schema that is not there.
docker compose version >/dev/null 2>&1 || die "\`docker compose\` (v2) is not available. The v1
  \`docker-compose\` binary ignores the ordering this deployment depends on, without saying so."
echo "   compose            $(docker compose version --short)"

for tool in git node psql; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "   installing ${tool}"
    case "$tool" in
      git) apt-get install -y git >/dev/null ;;
      node) curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null && apt-get install -y nodejs >/dev/null ;;
      psql) apt-get install -y postgresql-client >/dev/null ;;
    esac
  }
done
command -v corepack >/dev/null 2>&1 && corepack enable >/dev/null 2>&1 || true
echo "   node               $(node --version)"

# --- the checkout ------------------------------------------------------------------------------------

say "Checkout"

if [ -d "$CHECKOUT/.git" ]; then
  git -C "$CHECKOUT" fetch origin "$BRANCH"
  git -C "$CHECKOUT" checkout "$BRANCH"
  git -C "$CHECKOUT" reset --hard "origin/$BRANCH"
  echo "   updated $CHECKOUT to $(git -C "$CHECKOUT" rev-parse --short HEAD)"
else
  git clone --branch "$BRANCH" https://github.com/ARKS-Workstation/BERelax-Complete "$CHECKOUT"
  echo "   cloned $CHECKOUT at $(git -C "$CHECKOUT" rev-parse --short HEAD)"
fi

cd "$CHECKOUT"
corepack prepare --activate >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

# --- the tenant --------------------------------------------------------------------------------------
#
# Delegated rather than reimplemented. `provision-tenant.mjs` owns the secrets, the shared cluster roles
# that migrations 0009 and 0096 need, the database, and the migration run — and it is the thing that gets
# exercised when a SECOND tenant is added, so a copy of its logic here would be the copy that drifts.

say "Tenant"

node scripts/provision-tenant.mjs \
  --slug "$SLUG" \
  --subdomain "$SUBDOMAIN" \
  --create-database \
  --db-port "$DB_PORT" \
  --port "$PORT" \
  --root "$ROOT"

say "Done, except the two steps that touch the live host"

cat <<EOF
Those are printed and not run on purpose — a proxy reload and a container start are what can affect the
sites already on this box.

  1. Proxy  (validate FIRST; a reload with a broken config is the one action that can take the live site down)
       cp $ROOT/$SLUG/$SLUG.caddy /etc/caddy/sites.d/$SLUG.caddy
       grep -q 'import sites.d' /etc/caddy/Caddyfile || echo 'import sites.d/*.caddy' >> /etc/caddy/Caddyfile
       caddy validate --config /etc/caddy/Caddyfile
       systemctl reload caddy

  2. Containers  (the first build takes 10-20 minutes on 2 vCPU)
       cd $CHECKOUT
       docker compose --project-name $SLUG --env-file $ROOT/$SLUG/.env \\
         -f docker-compose.production.yml up -d --build

  3. Verify — including that the OTHER sites here are untouched
       curl -sS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:$PORT/
       curl -sS -o /dev/null -w '%{http_code}\\n' https://$SUBDOMAIN/
       curl -sS -o /dev/null -w '%{http_code}\\n' https://berelaxmassage.com/
       curl -sS -o /dev/null -w '%{http_code}\\n' https://spamanagement.co/
       free -m

Expect an empty therapist list on first use. The roster carries no gender, no credentials and no rota by
design (packages/db/src/seed/therapists.ts says why), so availability correctly offers nobody until a
human enters it. That is not a failed deploy.
EOF
