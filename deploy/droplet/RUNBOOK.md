# Deploying the CRM to a droplet

For putting this application on a plain Ubuntu droplet with Docker, rather than on App Platform.
`.do/README.md` remains the App Platform path and is not superseded by this one.

The droplet this was written for is `spamanagement-prod` (blr1, 2 vCPU / 4 GB, `134.209.145.162`), which
**already serves a live customer-facing website** — `berelaxmassage.com` resolves to it. Every step below
is arranged around not disturbing that. If a step's outcome is not what this document says, stop and find
out why rather than continuing: the failure mode here is not a broken deploy, it is a broken live site.

---

## 0. Discovery — run this first, and read it before anything else

Nothing below is safe to assume. These commands only read.

```bash
# What is already serving, and on which ports
ss -ltnp
systemctl list-units --type=service --state=running | grep -Ei 'nginx|caddy|apache|docker|postgres'

# Which reverse proxy, and how the live site is configured
ls -l /etc/nginx/sites-enabled/ 2>/dev/null
ls -l /etc/caddy/ 2>/dev/null
nginx -v 2>&1; caddy version 2>/dev/null

# Docker, and what is already running under it
docker --version; docker compose version
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'

# Headroom. This decides whether the box can take the app at all
free -m; df -h /; nproc

# Is there a PostgreSQL on here already
psql --version 2>/dev/null; systemctl is-active postgresql 2>/dev/null
```

Three answers decide the shape of the rest:

| Finding | Consequence |
|---|---|
| **No Docker** | Install it (§1). If the live site runs under Docker already, do not touch its daemon config. |
| **Available memory under ~2 GB** | Stop. The app plus the worker plus Chromium will not fit beside the existing site. Resize the droplet first, or use App Platform. §2 explains why this is not negotiable. |
| **Proxy is Caddy, not nginx** | `berelax-crm.nginx.conf` does not apply; §4 has the Caddy equivalent. |

---

## 1. Docker

Skip if `docker compose version` already answers.

```bash
curl -fsSL https://get.docker.com | sh
docker compose version    # must print v2.x — the v1 `docker-compose` binary cannot read this compose file
```

`docker-compose.production.yml` uses `depends_on.condition: service_completed_successfully`, which is
Compose v2 only. Under v1 it is ignored silently — the migration and the web container start together,
and the first request hits a schema that is not there yet.

---

## 2. The database

The compose file manages no PostgreSQL. `DATABASE_URL` points at one you choose, and the choice is a real
one.

**Managed cluster (recommended).** `.do/README.md` §2 has the `doctl databases create`: PostgreSQL 16,
2 vCPU / 4 GB with a standby. It costs money monthly and buys a standby, point-in-time restore and a
connection pool — the three things a development database does not have, and the three things you want the
day something is wrong with the books.

**On the droplet.** Free, and it puts the application and its data in one failure domain: one bad
`docker compose down -v`, one disk full, one OOM kill. On a 2 vCPU / 4 GB box already serving a live site,
PostgreSQL's shared buffers compete with that site's working set.

```bash
# If you go this way
apt-get install -y postgresql-16 postgresql-contrib-16
sudo -u postgres psql -c "create role berelax login password '$(openssl rand -hex 24)'"
sudo -u postgres createdb -O berelax berelax
sudo -u postgres psql -d berelax -c "create extension if not exists btree_gist; create extension if not exists pgcrypto"
```

`btree_gist` is not optional. The no-double-booking guarantee is an exclusion constraint on
`(therapist_id, period)` (migration 0024) and it cannot be created without that extension — migration 0024
fails, and so does the whole `db:deploy`.

**Either way, before the first deploy:** if the database was ever brought up with `pnpm db:apply` (which
takes an empty schema to the current one and refuses anything else), run `pnpm db:deploy --adopt` once.
It records every existing migration as applied. Without it, `db:deploy` refuses a populated schema with no
ledger — correctly, because it cannot tell a migrated database from a half-migrated one.

---

## 3. DNS and the origin

The CRM needs **its own subdomain**. `berelaxmassage.com` is the spa-management platform's; pointing the
CRM at it would have two applications claiming one name on one box.

1. Pick a subdomain — `crm.berelaxmassage.com` or `admin.berelaxmassage.com`.
2. Add an `A` record for it pointing at the droplet's IP. Wait for it to resolve:
   `getent hosts crm.berelaxmassage.com`.
3. Put the same value, with scheme and no trailing slash, in `SITE_ORIGIN`.

`SITE_ORIGIN` is not cosmetic. Canonical URLs, sitemap entries and signed document links all derive from
it, and a wrong value publishes wrong canonicals that a crawler then keeps serving. App Platform taught
this: `SITE_ORIGIN` falling back to its default made staging emit production canonical URLs, and nothing
failed — it just quietly claimed the wrong origin.

---

## 4. The reverse proxy

**nginx:**

```bash
cp deploy/droplet/berelax-crm.nginx.conf /etc/nginx/sites-available/berelax-crm
sed -i 's/REPLACE_SUBDOMAIN/crm/' /etc/nginx/sites-available/berelax-crm   # your subdomain
grep -r connection_upgrade /etc/nginx/    # if absent, add the map to nginx.conf's http block (see the file's footer)
ln -s /etc/nginx/sites-available/berelax-crm /etc/nginx/sites-enabled/
nginx -t                                   # MUST pass before the reload
systemctl reload nginx
certbot --nginx -d crm.berelaxmassage.com  # writes the certificate paths the vhost already names
```

`nginx -t` before every reload, without exception. A reload with a broken config is the one action in this
runbook that can take the live site down, and `-t` is what makes it impossible.

**Caddy:** add to the `Caddyfile` — Caddy gets the certificate itself, so there is no certbot step:

```
crm.berelaxmassage.com {
    reverse_proxy 127.0.0.1:3000
    request_body { max_size 32MB }
}
```

Then `caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`. Do not add security
headers in either proxy: `apps/web/proxy.ts` emits the whole set including a per-response CSP nonce, and a
static CSP added here breaks every inline script in the admin estate.

---

## 5. The application

```bash
git clone https://github.com/ARKS-Workstation/BERelax-Complete /srv/berelax-crm
cd /srv/berelax-crm
git checkout claude/massage-crm-planning-c05j70   # the repository's default branch

cp deploy/droplet/env.production.example .env
chmod 600 .env
$EDITOR .env        # every REPLACE_ value, and generate each secret with `openssl rand -hex 32`

docker compose -f docker-compose.production.yml config >/dev/null   # refuses on a missing required var
docker compose -f docker-compose.production.yml build               # 10–20 minutes on 2 vCPU
docker compose -f docker-compose.production.yml up -d
```

Watch the migration specifically — `web` does not start until it exits 0:

```bash
docker compose -f docker-compose.production.yml logs -f migrate
```

The build reads the database, because `/` and `/ar` are prerendered from it. So `DATABASE_URL` has to be
reachable and migrated **at build time**, not only at run time, and a schema change that the build's own
code depends on cannot arrive in the same deploy as that code. `.do/README.md` §5 has the two-phase
sequence for that case; it is the normal case here, not an edge one.

---

## 6. Verify

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/            # 200, from the box
curl -sS -o /dev/null -w '%{http_code}\n' https://crm.berelaxmassage.com/   # 200, from outside
curl -sS -o /dev/null -w '%{http_code}\n' https://berelaxmassage.com/       # 200 — the LIVE SITE, unchanged
docker compose -f docker-compose.production.yml ps                          # web and worker up, migrate exited 0
free -m                                                                     # headroom left over
```

That third line is the one that matters most. Run it before you call the deploy done.

Then sign in at `https://crm.berelaxmassage.com/login` and open `/record-visit` — it is the newest screen
and it exercises the whole stack: a session, the admin shell, a database read, the settings table and the
lifecycle machine.

**Expect an empty therapist list, and do not treat it as a bug.** `pnpm seed` deliberately leaves the
roster with no gender, no credentials and no rota, and `packages/db/src/seed/therapists.ts` sets out why
each is NULL — inventing nineteen real people's genders would make the booking engine decide who may treat
whom from a fact the build made up. Until a human enters the roster and publishes a rota, availability
correctly offers nobody, and `/quick-book` cannot book either.

---

## 7. Rollback

```bash
cd /srv/berelax-crm
git checkout <previous-commit>
docker compose -f docker-compose.production.yml up -d --build
```

**Migrations do not roll back.** `db:deploy` applies forward only and refuses a database ahead of the
checkout, which it reads as a downgrade. So a bad release is rolled back in the code; a bad migration is
corrected by a new migration. That is why §2 recommends the managed cluster — point-in-time restore is the
only real undo, and it has to exist before you need it.

To remove the CRM entirely and leave the live site untouched:

```bash
docker compose -f docker-compose.production.yml down      # NOT -v: that destroys volumes
rm /etc/nginx/sites-enabled/berelax-crm && nginx -t && systemctl reload nginx
```

`down` without `-v`, always. The `name: berelax-crm` project in the compose file is what stops any of this
reaching the other stack on the same host.
