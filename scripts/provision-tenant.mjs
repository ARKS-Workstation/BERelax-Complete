#!/usr/bin/env node
/**
 * Stands up one tenant: its directory, its secrets, its database, its proxy block, its schema.
 *
 * ADR 0129's second rule: *provisioning is scripted from tenant one*. A manually-built instance is an
 * instance nobody can reproduce, and a fleet of those cannot be migrated to anything — which would make
 * the decision to run isolated instances irreversible, and the ADR is explicit that it must not be.
 *
 * So this exists before there is a second tenant, not after.
 *
 * ## What it writes, and what it refuses to
 *
 * It writes: `<root>/<slug>/.env` with generated secrets, a Caddy site block, and the schema (by running
 * the migrations). It can create the PostgreSQL database and its two required extensions when the
 * database is local.
 *
 * It refuses to: overwrite an existing tenant's `.env` (that file holds the only copy of secrets that
 * were generated once and are not recoverable), reload the proxy (see below), or start containers.
 *
 * ## Why it does not reload Caddy, and does not `docker compose up`
 *
 * Both are the actions that can disturb the live platform on a shared droplet, and neither is the kind of
 * thing a script should do on the operator's behalf while they are reading its output. It prints the two
 * commands instead, with `caddy validate` first, because `deploy/droplet/RUNBOOK.md` §4 states that a
 * reload with a broken Caddyfile is the one action in the whole deployment that can take the live
 * platform down.
 *
 * A script that did it anyway would be fine ninety-nine times. The hundredth is somebody's website.
 *
 * ## Secrets are generated HERE, on the machine, and printed nowhere
 *
 * `randomBytes` into the `.env`, which is then `chmod 600`. The values are never printed to stdout, never
 * passed as an argument (where `ps` would show them) and never returned. An operator who needs one reads
 * the file. A value that has been in a terminal's scrollback or a chat window has to be rotated, which is
 * a rule this repository has already had to apply to itself.
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function flag(name) {
  const at = process.argv.indexOf(`--${name}`)
  return at !== -1 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : null
}

const SLUG = flag('slug')
const SUBDOMAIN = flag('subdomain')
const DATABASE_URL = flag('database-url')
const PORT = flag('port') ?? '3000'
/*
 * The PostgreSQL port, because 5432 is a default and not a fact.
 *
 * Found by testing this script rather than by reading it: with the port written into the derived URL,
 * `--create-database` could only ever work against a cluster on 5432, and a droplet already running the
 * platform's own PostgreSQL is exactly the host where the second one is not there.
 */
const DB_PORT = flag('db-port') ?? '5432'
const ROOT = flag('root') ?? process.env['BERELAX_TENANT_ROOT'] ?? '/srv/berelax'
const CREATE_DB = process.argv.includes('--create-database')
const DRY_RUN = process.argv.includes('--dry-run')

const USAGE = `
provision-tenant — stand up one tenant instance (ADR 0129)

  node scripts/provision-tenant.mjs --slug <slug> --subdomain <fqdn> [options]

Required
  --slug <slug>           Directory name and compose project name. [a-z0-9-], 2-40 chars.
  --subdomain <fqdn>      The tenant's own hostname, e.g. crm.example.com. NEVER a hostname
                          another site on this host already serves.

Options
  --database-url <uri>    The tenant's database. Omitted with --create-database, a local one
                          is created and the URI derived from it.
  --create-database       Create the PostgreSQL database, role and extensions locally.
  --port <n>              Loopback port for this tenant's web container. Default 3000.
                          Every tenant on one host needs a DIFFERENT port.
  --db-port <n>           PostgreSQL port for --create-database. Default 5432.
  --root <path>           Tenant root. Default /srv/berelax (or BERELAX_TENANT_ROOT).
  --dry-run               Print what would happen and write nothing.

Exactly one of --database-url or --create-database is required.
`

if (SLUG === null || SUBDOMAIN === null) {
  console.error(USAGE)
  process.exit(1)
}
if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(SLUG)) {
  console.error(`--slug "${SLUG}" must be 2-40 characters of [a-z0-9-] and start with [a-z0-9].`)
  process.exit(1)
}
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(SUBDOMAIN)) {
  console.error(`--subdomain "${SUBDOMAIN}" does not look like a hostname.`)
  process.exit(1)
}
if ((DATABASE_URL === null) === !CREATE_DB) {
  // Both or neither. Both is ambiguous about which database wins; neither has no database at all, and
  // defaulting one would guess at where a tenant's books live.
  console.error('Pass exactly one of --database-url or --create-database.')
  process.exit(1)
}

const dir = join(ROOT, SLUG)
const envPath = join(dir, '.env')

if (existsSync(envPath)) {
  /*
   * Never overwritten, and this is not caution for its own sake.
   *
   * `.env` holds secrets generated once by `randomBytes` and stored nowhere else. Rewriting it rotates
   * PAYLOAD_SECRET and DOCUMENT_URL_SIGNING_SECRET under a running instance: every signed document link
   * already issued stops verifying, and the CMS admin refuses every existing session. Re-provisioning a
   * live tenant is not a thing to do by accident, so it is not a flag — delete the file deliberately if
   * that is really what you mean.
   */
  console.error(`${envPath} already exists. This tenant is provisioned.`)
  console.error(
    'Its secrets were generated once and are stored only there; rewriting them would invalidate ' +
      'every signed document link and every CMS session. Delete the file by hand if that is intended.',
  )
  process.exit(1)
}

const EXAMPLE = 'deploy/droplet/env.production.example'
if (!existsSync(EXAMPLE)) {
  console.error(`${EXAMPLE} is missing — it is the template this writes from.`)
  process.exit(1)
}

/** 32 bytes of hex. The same shape `openssl rand -hex 32` produces, so the runbook's advice matches. */
const secret = () => randomBytes(32).toString('hex')

const derivedUrl = DATABASE_URL ?? `postgres://${SLUG}@127.0.0.1:${DB_PORT}/${SLUG}`

/*
 * The `.env`, built by REPLACING values in the committed example rather than by writing a fresh file.
 *
 * The example carries the comments that say what each variable gates and why absent is refused — the
 * reasoning an operator needs when something will not start at 2am. A generated file with the comments
 * stripped is a file somebody has to go and look up, and `env.production.example` is the one place that
 * text is maintained.
 */
const lines = readFileSync(EXAMPLE, 'utf8').split('\n')
const set = {
  DATABASE_URL: derivedUrl,
  SITE_ORIGIN: `https://${SUBDOMAIN}`,
  PAYLOAD_SECRET: secret(),
  DOCUMENT_URL_SIGNING_SECRET: secret(),
  DOCUMENT_URL_SIGNING_SECRET_VERSION: '1',
  WEB_PORT: PORT,
}
const written = new Set()
const body = lines
  .map((line) => {
    const eq = line.indexOf('=')
    if (line.startsWith('#') || eq === -1) return line
    const key = line.slice(0, eq).trim()
    if (!(key in set)) return line
    written.add(key)
    return `${key}=${set[key]}`
  })
  .join('\n')

for (const key of Object.keys(set)) {
  if (!written.has(key)) {
    // The example is the template, so a key this script sets and the template does not carry means the
    // two have drifted. Refusing is the only way that gets noticed; a silent append would leave the
    // variable's documentation behind for ever.
    console.error(`${EXAMPLE} has no "${key}=" line, so this script and the template have drifted.`)
    process.exit(1)
  }
}

const caddy = readFileSync('deploy/droplet/berelax-crm.caddy', 'utf8')
  .replaceAll('REPLACE_SUBDOMAIN.berelaxmassage.com', SUBDOMAIN)
  .replaceAll('127.0.0.1:3000', `127.0.0.1:${PORT}`)
  .replaceAll('berelax-crm.log', `${SLUG}.log`)

if (DRY_RUN) {
  console.log(`--dry-run: tenant "${SLUG}"`)
  console.log(`  directory     ${dir}`)
  console.log(`  origin        https://${SUBDOMAIN}`)
  console.log(`  web port      127.0.0.1:${PORT}`)
  console.log(
    `  database      ${CREATE_DB ? `created locally as ${SLUG} on port ${DB_PORT}` : 'supplied'}`,
  )
  console.log(`  .env          ${envPath} (3 secrets generated, printed nowhere)`)
  console.log(`  caddy block   /etc/caddy/sites.d/${SLUG}.caddy`)
  console.log('  migrations    pnpm deploy:migrate against this tenant')
  console.log('\nNothing was written.')
  process.exit(0)
}

mkdirSync(dir, { recursive: true })
writeFileSync(envPath, body, { mode: 0o600 })
chmodSync(envPath, 0o600)
console.log(`  wrote ${envPath} (0600, 3 secret(s) generated)`)

if (CREATE_DB) {
  /*
   * `btree_gist` is not optional and this is the place to fail if it cannot be created.
   *
   * The no-double-booking guarantee is an exclusion constraint on `(therapist_id, period)` in migration
   * 0024, and it cannot be created without that extension — so without it `db:deploy` fails midway and
   * leaves a partially migrated database, which is a worse thing to debug than a refusal here.
   */
  const password = randomBytes(24).toString('hex')
  /*
   * The SQL goes in on STDIN, never as `-c <sql>`.
   *
   * `-c` puts the statement in argv, and argv is readable by every user on the box through `ps` for as
   * long as the process lives. The role's password is in that statement. psql reads stdin when given no
   * `-c` and no `-f`, so this costs nothing and closes it.
   */
  const psql = (sql, database) =>
    execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', ...(database ? ['-d', database] : [])], {
      env: { ...process.env, PGUSER: 'postgres', PGPORT: DB_PORT, PGHOST: '127.0.0.1' },
      input: sql,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
  try {
    /*
     * CREATEROLE, and it is not optional. Found by running this script, not by reading the migrations.
     *
     * Migrations 0009 and 0096 `create role` — `berelax_app`, `berelax_clinical`, `berelax_readonly` and
     * `berelax_retention`, all `nologin` and all reached by `set role`. Without CREATEROLE the run dies
     * at 0096 with "The current user must have the CREATEROLE attribute", after 95 migrations have
     * applied and been recorded: a half-migrated database, which is the state the ledger exists to make
     * recoverable but still the one nobody wants to meet.
     *
     * It is more privilege than an application role should keep for ever, and `.do/app.production.yaml`
     * concedes the same thing about `doadmin`: "pg-boss and Payload both CREATE their own schemas on
     * first boot, so the role that runs them needs more than an application role should keep". The better
     * answer is two roles — one that migrates, one that serves — and it is a separate decision, not
     * something to invent silently here.
     */
    psql(`create role "${SLUG}" login createrole password '${password}';`)

    /*
     * The SHARED roles, and this is the sharpest thing testing found.
     *
     * PostgreSQL roles are CLUSTER-wide, not per-database. Migrations 0009 and 0096 create four — all
     * `nologin`, each guarded by `if not exists` — and then `grant` and `comment on` them. The guard is
     * what makes tenant 2 fail: the role already exists from tenant 1, so tenant 2 skips creating it and
     * then cannot comment on a role it does not own:
     *
     *   ERROR:  permission denied
     *   DETAIL: The current user must have the ADMIN option on role "berelax_retention".
     *
     * That was measured, not predicted — the first run of this script against a cluster that already had
     * one tenant on it. So the SUPERUSER creates them, once per cluster, and grants each tenant's role
     * ADMIN option. Every tenant then finds them and may grant and comment; the `if not exists` guards
     * no-op; and no tenant owns a role another tenant depends on.
     *
     * The names are read from the migrations rather than written here, so a fifth role added later is
     * picked up instead of failing the fifth tenant to be provisioned after it.
     *
     * The GRANTS on these roles stay per-database, which is what keeps the tenants apart: a session that
     * can `set role berelax_app` in this database still has no privilege in another tenant's. The role
     * OBJECT is shared and the authority it carries is not. ADR 0129 records what that does and does not
     * buy.
     */
    const sharedRoles = [
      ...new Set(
        readdirSync('packages/db/migrations')
          .filter((f) => f.endsWith('.sql'))
          .flatMap((f) => [
            ...readFileSync(join('packages/db/migrations', f), 'utf8').matchAll(
              /create role ([a-z_][a-z0-9_]*) nologin/gi,
            ),
          ])
          .map((m) => m[1]),
      ),
    ]
    if (sharedRoles.length === 0) {
      // ADR 0002: a provisioning step that granted nothing and said it had. The migrations DO create
      // roles, so finding none means this pattern stopped matching and tenant 2 would fail instead.
      console.error('  no shared roles found in packages/db/migrations — the pattern has drifted.')
      process.exit(1)
    }
    for (const role of sharedRoles) {
      psql(
        `do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') ` +
          `then create role ${role} nologin; end if; end $$;`,
      )
      psql(`grant ${role} to "${SLUG}" with admin option;`)
    }
    console.log(`  ensured ${sharedRoles.length} shared role(s): ${sharedRoles.join(', ')}`)

    psql(`create database "${SLUG}" owner "${SLUG}";`)
    psql(
      'create extension if not exists btree_gist; create extension if not exists pgcrypto;',
      SLUG,
    )
    console.log(`  created database "${SLUG}" with btree_gist and pgcrypto`)
  } catch (error) {
    console.error(`  database creation FAILED: ${error.message}`)
    console.error(`  ${envPath} was written and is now stale — delete it before retrying.`)
    process.exit(1)
  }
  // Rewritten with the real password now that the role exists. Same file, same mode.
  writeFileSync(
    envPath,
    body.replace(
      `DATABASE_URL=${derivedUrl}`,
      `DATABASE_URL=postgres://${SLUG}:${password}@127.0.0.1:${DB_PORT}/${SLUG}`,
    ),
    { mode: 0o600 },
  )
}

const caddyOut = join(dir, `${SLUG}.caddy`)
writeFileSync(caddyOut, caddy)
console.log(`  wrote ${caddyOut}`)

console.log('\nMigrating this tenant only:')
try {
  execFileSync('node', ['scripts/migrate-tenants.mjs', '--root', ROOT, '--only', SLUG], {
    stdio: 'inherit',
  })
} catch {
  console.error('\nMigration failed. The tenant directory exists and its schema does not.')
  console.error(
    `Fix the cause and re-run: node scripts/migrate-tenants.mjs --root ${ROOT} --only ${SLUG}`,
  )
  process.exit(1)
}

/*
 * The last two steps are PRINTED and not run. See the header: a proxy reload and a container start are
 * the two actions that can disturb a live site on a shared host, and `caddy validate` has to pass first.
 */
console.log(`
Two steps left, deliberately not taken by this script — both can affect the live site on a shared host:

  1. The proxy
       cp ${caddyOut} /etc/caddy/sites.d/${SLUG}.caddy
       caddy validate --config /etc/caddy/Caddyfile     # MUST pass
       systemctl reload caddy

  2. The containers
       cd ${process.cwd()}
       docker compose --project-name ${SLUG} --env-file ${envPath} \\
         -f docker-compose.production.yml up -d

Then verify, including that the OTHER sites on this host are untouched —
deploy/droplet/RUNBOOK.md §6 has the four curls.

DNS for ${SUBDOMAIN} must already resolve to this host, or Caddy cannot get a certificate.
`)
