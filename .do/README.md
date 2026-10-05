# Deploying BE RELAX to DigitalOcean App Platform

Two specs, one worker image, one web image, one managed PostgreSQL. `app.staging.yaml` is safe to run.
`app.production.yaml` is complete and **the repository's own release check refuses it** — §1 says why, and
that refusal is the most important thing in this document.

Everything here is `doctl`. Nothing in this repository holds a DigitalOcean token and nothing should: the
token belongs in the operator's shell, or in this environment's secrets as `DIGITALOCEAN_ACCESS_TOKEN`,
never in a file and never in a commit.

---

## 1. Before anything: what `pnpm deploy:preflight` refuses, and what overriding it means

```
pnpm deploy:preflight --target staging      # passes today
pnpm deploy:preflight --target production   # refuses today
```

The production refusal has two parts. The first is `pnpm go-no-go`, which is the release check this
repository has had since H-MIG-11, and it returns **no-go on five counts**:

| Requirement | State | What it is waiting for |
| --- | --- | --- |
| `external-items-cleared` | UNMET | 51 of 52 items in [docs/OPEN-QUESTIONS.md](../docs/OPEN-QUESTIONS.md) are unanswered — the trading name, the licence, the TRN, the room inventory, the opening balances |
| `milestones-demonstrated` | UNMET | M3 is demonstrated by no unit in the manifest |
| `restore-drill-current` | UNKNOWN | No maximum drill age is configured (`Y13-rpo-rto`); "newer than the maximum age" is a comparison against nothing |
| `security-findings-clear` | UNMET | No penetration test has been performed (`Y13-pentest`). "No findings" and "nobody looked" are the same register |
| `provisional-settings-confirmed` | UNMET | 51 of 51 provisional settings still carry their provisional value |
| `three-clean-dry-runs` | MET | Three recorded dry runs, every one clean |

Its own closing line is the summary: *nothing here can be fixed by a deploy — every one of these is a fact
about the business.* A deployment does not make the licence number known or the penetration test happen.

The second part is **data residency**, and it is not a software question:

> DigitalOcean has no UAE region. [ADR 0010](../docs/adr/0010-clinical-boundary.md)
> records that UAE Federal Law 2 of 2019 may prohibit storing health data outside the country, and the
> licence classification that decides whether the rule applies to this business is `Y5-residency` — open.

The clinical schema is isolated so it can be moved to a UAE-hosted database in about a week. That is a
mitigation, not an answer, and nothing in this repository may pick a jurisdiction on the owner's behalf.

**Overriding this is a decision, and it looks like one.** There is no `--force`. Somebody who has read the
six rows above and the residency paragraph and decided to go anyway runs `doctl` directly; the preflight is
what makes that a deliberate act rather than a default. If the decision is "staging only for now", that is
§2 to §6 with `app.staging.yaml` and nothing further.

---

## 2. Create the cluster first, and the database with content in it

The web build **reads the database**. `/` and `/ar` are prerendered from the `premises` row, the catalogue
and the roster — measured, not assumed: a build against a migrated but unseeded database fails with *"The
home page has no facts to render: `premises` has no row"*. So the database exists and holds content
**before** the first deploy, or the first deploy fails at the prerender step.

**Staging** needs nothing here: `app.staging.yaml` declares a development database and App Platform creates
it with the app.

**Production** attaches an existing cluster, because a spec can only create a development database and a
development database has no standby, no point-in-time restore and no connection pool:

```sh
doctl databases create berelax-pg \
  --engine pg --version 16 \
  --region fra1 --size db-s-2vcpu-4gb --num-nodes 2      # 2 nodes = primary + standby (docs/02 §2)

doctl databases db create <cluster-id> berelax
doctl databases user create <cluster-id> berelax
```

Then migrate and load content, from a machine that can reach the cluster:

```sh
export DATABASE_URL="$(doctl databases connection <cluster-id> --format URI --no-header)"
export APP_ENV=production
pnpm db:apply            # from NOTHING: scripts/apply-migrations.mjs, hand-written, numbered
pnpm db:deploy --adopt   # then record what it just did, so the next deploy can resume
```

### Two migration tools, and which one a deploy uses

`pnpm db:apply` takes an **empty** schema to the current one and refuses anything else. That contract is
deliberate (its header explains why: the migrations are not idempotent, and an early attempt to tolerate a
second run half-applied `0011` and reported it as a skip) and it is exactly right for CI, which creates the
database in a service container.

It is useless for a deployment, and that was measured rather than argued: the `migrate` job ran
`pnpm db:apply` against the staging cluster, applied 134 migrations, and failed on the next deploy with
*"berelax already holds 222 table(s)"*. A deployment that cannot apply migration 135 is not a deployment.

So the job runs **`pnpm deploy:migrate`**, which is two things, because there are two migration estates:

- **`pnpm db:deploy`** for this repository's 134 hand-written SQL migrations, described below.
- **`pnpm cms:migrate`** (`payload migrate`) for Payload's own tables. `payload.config.ts` sets
  `push: false` in production on purpose — drizzle-kit syncing a schema nobody reviewed is right for
  development and not for a live database — and its comment has always said "Production runs
  `payload migrate` as a deploy step". Until the first real deployment nothing did: there were no
  migration files and no step, so `/admin` answered 500 with `relation "payload.cms_user" does not
  exist`. `apps/web/src/migrations/` now holds the initial one.

  Regenerating it (`pnpm --filter @berelax/web exec payload migrate:create <name>`) reintroduces one
  defect every time: Payload's generator imports `MigrateUpArgs` and `MigrateDownArgs` as VALUES, and
  `@payloadcms/db-postgres` exports them as types, so ESM refuses the file at run time. Make that
  `import type` and the file works; the committed one carries a comment saying so.

`db:deploy` keeps a `schema_migration(filename, checksum, applied_at)` ledger and:

- applies only the files that are not yet rows, in order, in one psql session behind an advisory lock —
  one session because a lock taken in a session that exits is a lock nobody holds;
- is a no-op when there is nothing pending, which is what makes it safe as a step on every deploy;
- **refuses a migration edited after it was applied**, by checksum. That failure is the quiet one: every
  database that already ran it has the old shape, every new one gets the new shape, and nothing in a schema
  dump says which;
- refuses a database that is ahead of the checkout, which would be a downgrade;
- refuses to run against a populated schema with no ledger, and names `--adopt`, which records every
  migration on disk as applied **without running any of them**. That is the one-off step for a database
  brought up by `db:apply`, and it refuses an empty schema because adopting one would skip every migration
  for ever.

It does not wrap the migrations: 109 of the 134 carry their own `BEGIN;`/`COMMIT;`, and nesting would turn
each one's COMMIT into a warning.

What loads the content is **not** `pnpm seed`. Seeding is a fixture estate for tests. The real path is the
migration workstream: `docs/runbooks/cutover.md` and `scripts/cutover.mjs` are the eleven declared steps,
and they are blocked on the same open questions as §1 — the opening balances, the staff, the rooms, the
packages. Until those are answered there is no real content to load, which is another way of reading the
go/no-go verdict.

---

## 3. Create the app

```sh
doctl apps create --spec .do/app.staging.yaml
# or, having read §1:
doctl apps create --spec .do/app.production.yaml
```

### Two steps the first deploy needs, and neither is optional

Both were measured on the first live deploy of this app rather than predicted, and both come from one
platform fact: **App Platform does not interpolate a binding at build time.** A `${db.DATABASE_URL}` or
`${APP_URL}` scoped to build time arrives as the literal `${...}` text, or as nothing.

**1. A build-time `DATABASE_URL`.** `/` and `/ar` prerender from the database, so `next build` needs a real
connection string. With the binding it got the nine characters `${db.DATABASE_URL}` and died with *"Failed
to collect page data for /ar/treatments/[slug]"*. The committed spec therefore scopes the binding to
`RUN_TIME` and the build gets a secret set on the app:

```sh
doctl databases connection <cluster-id> --format URI --no-header     # swap /defaultdb for /berelax
# then add to the app, on the `web` component:
#   key: DATABASE_URL  scope: RUN_AND_BUILD_TIME  type: SECRET  value: <that URI>
```

**2. A build-time `SITE_ORIGIN`, before the hostname is given to anybody.** This is the one that matters.
`SITE_ORIGIN` is read at render time and therefore baked into every prerendered canonical URL. With
`${APP_URL}` the build saw nothing, fell back to `SITE_ORIGIN_FALLBACK` in `@berelax/shared`, and the
staging site served `rel="canonical" href="https://berelaxmassage.com/"` — a preview asking Google to index
production copies of unreviewed pages, which is exactly the harm that fallback's own comment names. So
immediately after creating a non-production app:

```sh
doctl apps get <app-id> --format DefaultIngress --no-header
# set SITE_ORIGIN (scope RUN_AND_BUILD_TIME) to that URL, then redeploy ONCE before linking it anywhere
```

`pnpm deploy:preflight` refuses a spec that scopes a binding to build time, because that failure is silent
until a site is already serving the wrong canonical.

**3. Trusted sources.** The build container must be able to reach the cluster. If trusted sources are
enabled and the build container is not among them, the build fails at the prerender step with the "no facts
to render" error from §2 — which looks like a content problem and is a firewall problem.

**4. `DATABASE_CA_CERT`, if you want verified TLS.** `doctl databases ca <cluster-id>` prints the cluster's
CA certificate. Set it as a plain (non-secret) env var on `worker` and `web` and the pg-boss connection
verifies the chain instead of merely encrypting — the "verify-full" half of docs/02 §2. Without it the
worker still boots: `jobQueueSsl` falls back to what the connection string asked for. It is NOT optional in
the other direction, though — pg-boss's driver verifies by default where postgres.js does not, and the
worker died at boot with `SELF_SIGNED_CERT_IN_CHAIN` against the same cluster the web app was serving
from.

The database credential is passed into the build as a Docker build argument (`ARG DATABASE_URL`) in the
**discarded** `deps` stage. The shipped image is the `runtime` stage, whose history contains only its own
instructions and which never declares it; the `container` job in CI asserts exactly that by reading
`docker history` and `Config.Env` of the built image.

---

## 4. Set the secrets, and read this before `doctl apps update --spec`

**An app spec is declarative. Applying a spec that omits an env var REMOVES it from the app.** No secret is
in these specs — a placeholder in a committed file is indistinguishable from a configured value (brief rule
15), and for `PAYLOAD_SECRET` it would be worse than useless: the application refuses the placeholder by
name, because signing admin session tokens with a value that is in a public repository is the same hole as
signing them with a guessed one.

So secrets are set on the app and the committed spec is the shape, not the state. After the first
`doctl apps create`, keep the two in step by fetching what the platform holds before editing:

```sh
doctl apps spec get <app-id> > /tmp/live.yaml      # secrets come back as EV[1:…] ciphertext
# edit /tmp/live.yaml, or re-apply the committed spec and re-set the secrets below
doctl apps update <app-id> --spec /tmp/live.yaml
```

What to set, from [`build/secret-inventory.json`](../build/secret-inventory.json) — the inventory is the
authority and `docs/runbooks/key-rotation.md` is how each one rotates:

| Env var | Needed for | If unset |
| --- | --- | --- |
| `PAYLOAD_SECRET` | The CMS admin and its REST API | The public site serves; the admin refuses by name |
| `CLINICAL_KEK` (+ `_VERSION`) | Clinical records | The clinical store refuses to read or write |
| `GOOGLE_TOKEN_KEK` (+ `_VERSION`) | Google refresh tokens | The consent callback refuses by name |
| `STAFF_PII_KEK` (+ `_VERSION`) | Staff bank and identity-document columns | Those reads refuse by name |
| `SUPPRESSION_PEPPER` (+ `_VERSION`) | The opt-out list's HMAC | `loadSuppressionPepper` refuses by name |
| `DOCUMENT_URL_SIGNING_SECRET` (+ `_VERSION`) | Signed private-document links | No document is served, rather than one served unsigned |
| `PAYMENT_WEBHOOK_SIGNING_SECRET` | A card gateway's webhook deliveries | The endpoint answers 503 `[payment-webhook-not-configured]` and writes no row |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Only when `GOOGLE_PROVIDER=real` | Refused by `parseConfig` if the provider is real without them |
| `SENTRY_DSN` | Error reporting | No error reporting |

Every one of these is `optional()` in [`packages/config/src/env.ts`](../packages/config/src/env.ts) **on
purpose**: the schema's job is to declare the names, and each runtime reader refuses loudly and by name when
its key is absent. An app that boots with none of them serves the public site and refuses the features that
need them, which is the intended shape and is not the same thing as a configured deployment.

Generate them with `openssl rand -base64 48` and set them as secrets:

```sh
doctl apps update <app-id> --spec /tmp/live.yaml   # with `type: SECRET` entries added
```

### The connection pool

[ADR 0004](../docs/adr/0004-postgres-driver-and-pooling.md) is written against **PgBouncer in transaction
pooling mode** — it is why the driver runs with `prepare: false`, and that decision is already in
`packages/db/src/connection.ts`. A spec cannot bind a pool, so create one and override `DATABASE_URL` on
`web` and `worker` with its URI:

```sh
doctl databases pool create <cluster-id> berelax-tx --mode transaction --size 20 --db berelax --user berelax
```

**The `migrate` job keeps the direct credential.** A migration run that is ambiguous about what it holds is
the one thing worse than a slow one.

### TLS

docs/02 §2 says "VPC, TLS verify-full". The URI App Platform injects carries `sslmode=require`, which is
encryption **without** certificate-chain verification. Closing that gap is the cluster's CA certificate in
the image and `sslmode=verify-full&sslrootcert=…` on the URL — `createConnection` passes the URL straight
through to postgres.js, so it is a file and a URL and not a code change. Recorded here rather than claimed.

---

## 5. Deploying a change, and the ordering that will catch somebody

App Platform's order is **build → `PRE_DEPLOY` job → new containers take traffic**. The migration job runs
after the image is built. For this application that is not a detail:

> A migration that changes what the **build** reads cannot arrive in the same deploy as the code that reads
> it, because the build ran against the old schema.

That is the normal case here, not an edge one — `/` and `/ar` are prerendered from the database. The
sequence for such a change is two deploys:

1. Deploy the migration alone, in a release whose build does not depend on it (or run `pnpm db:apply`
   against the cluster from a machine that can reach it, which is what §2 does).
2. Deploy the code that reads the new shape.

`deploy_on_push` is `false` in both specs, deliberately: a git push is not a decision to release.

---

## 6. Afterwards

- **`/` is the health check.** An instance that answers 200 there has the premises row, the catalogue and the
  roster baked into its build, which is the thing most likely to have gone wrong.
- **The ISR cache is per instance.** App Platform gives no shared disk, so with `instance_count: 2` a
  revalidation served by one instance is not seen by the other until it revalidates too. For a catalogue
  edited a few times a month that is minutes of skew; it is not the same as correct, and it is a known gap.
- **Every provider is `fake`, in production too.** There is no real adapter for any of them (ADR 0005, ADR
  0022): `real` resolves to `notImplemented` and the process would refuse to start. A production environment
  that takes bookings and sends nothing is the current state of this build, and the health panel says so.
- **Cloudflare is in front of this app** in docs/02 §2's topology — the WAF, the DNS and the custom domain
  live there, and neither spec declares a `domains:` block because the hostname is not in this repository and
  must not be guessed (`Y1-nap`).
- **Rollback** is `doctl apps list-deployments <app-id>` and a redeploy of a previous one. What a redeploy
  cannot undo is a migration, and `docs/runbooks/cutover-rollback.md` is the honest statement of which parts
  are irreversible.
