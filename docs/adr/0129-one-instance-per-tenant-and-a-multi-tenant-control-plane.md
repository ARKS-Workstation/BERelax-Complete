# ADR 0129 — one instance per tenant, and the control plane is the only multi-tenant thing

- **Status:** accepted
- **Date:** 2026-11-09
- **Unit:** — a decision taken in operation, not from a brief unit
- **Covers:** docs/01 decision 33

## What changed, and why this record exists at all

`docs/01` said "one location, permanently" and listed multi-tenancy as excluded, with the whole
justification being **"Follows from the above"**. Four words, for the one decision in this system that is
expensive to reverse — while every other exclusion in that table gets a paragraph saying what it saved.

The premise has since turned out to be wrong about the business. `spamanagement.co` is the product: a
multi-tenant platform, live, already serving several spas' websites from one droplet. Be Relax is one
tenant of it, not the whole of it. So the brief this system was built to described one customer of the
product as though it were the product.

This record exists because that premise is load-bearing. 134 migrations, 222 tables and a 139-commit
history were built on it, and the next person to read `docs/01` would otherwise inherit the same mistake
the same way.

## The decision

**The product is multi-tenant. Each tenant's CRM is a single-tenant instance.**

- The **control plane** — tenant signup, billing, the tenant directory, provisioning — is multi-tenant, and
  already exists: it is the spamanagement platform.
- Each tenant's CRM is its own deployment: its own database, its own subdomain, its own secrets, its own
  `app_setting` rows, its own books. `docker-compose.production.yml` and `deploy/droplet/RUNBOOK.md` are
  what stands one up.
- **No tenant column is added to this schema.** `tenant_id` on 222 tables is the rejected alternative, not
  a later phase of this one.

## Why isolation, and not a tenant column

The usual argument for instance-per-tenant is operational simplicity, and that is not the argument here.

**Each spa is a separate taxable person.** It has its own TRN, files its own VAT 201, closes its own
months, carries its own opening balances and its own chart of accounts. A tenant column on `journal_line`
recreates, inside one database and enforced by predicates somebody has to remember, a boundary that a
separate database gives for free and cannot forget. The question "could one spa's revenue reach another
spa's VAT return" has one answer that is cheap to defend — *they are not in the same database* — and one
that requires row-level security to be correct on every table for ever.

The same argument holds twice over for the clinical estate. ADR 0010 draws a residency boundary around
treatment notes and contraindication flags and designs for relocation. Per-tenant instances make that
boundary per-tenant for free, which is what a customer in another jurisdiction will eventually need. A
shared database makes it one answer for everybody, and makes a cross-tenant read a single missing `where`
clause away.

And the audit trail's entire value is that it has one unambiguous subject. Adding a tenant dimension to
`audit_event` does not weaken it, but it does mean every reader of it is now also asserting a tenancy
claim, and a reader that forgets is a reader that over-reports.

## What this costs, stated now rather than discovered

Instance-per-tenant is not free, and the costs are operational and front-loaded:

- **N migrations.** Every release runs `pnpm deploy:migrate` once per tenant. A migration that succeeds on
  tenant 1 and fails on tenant 7 is a split estate, which is a worse state than a failed single deploy.
  The migration runner has to iterate the tenant directory and report per-tenant, from the first tenant —
  not from the tenth, when it is needed.
- **N of everything else.** Backups, restore drills, monitoring, secret rotation, the go/no-go evidence.
  Each of these is a script or it is a person remembering.
- **Onboarding is the real cost of tenant #2.** Each instance needs premises, catalogue, rooms, roster,
  genders, credentials, a rota and 52 settings before a single booking is possible — and
  `packages/db/src/seed/therapists.ts` deliberately refuses to invent most of those. Today that is hand
  entry into admin screens. For a product it is a guided setup, and that is product work, not infrastructure.
- **Memory, not CPU, is the limit.** Each instance is a web container and a worker, and documents render
  through Chromium (ADR 0011). Two instances will not fit on a 4 GB droplet beside anything else.

## When this decision stops being right

At roughly **30 to 50 tenants**, per-instance operations stops being tractable and the tenant column
becomes the cheaper risk. That threshold is a judgement, and the signal to watch is not the tenant count
itself but whether a release still goes out in one action.

Choosing this now is therefore also a bet that it can be undone. Three rules keep that true, and breaking
any of them is what would make the reversal a rewrite:

1. **No tenant's data or configuration in a shared table, ever.** Not a convenience lookup, not a cache,
   not a feature flag. The moment one row is shared, the clean boundary this decision buys is gone.
2. **Provisioning is scripted from tenant one.** A manually-built instance is an instance nobody can
   reproduce, and a fleet of those cannot be migrated to anything.
3. **The CRM never learns that other tenants exist.** No cross-tenant read, no shared identifier space, no
   "platform" API the application calls. The control plane knows about tenants; the instances do not.
