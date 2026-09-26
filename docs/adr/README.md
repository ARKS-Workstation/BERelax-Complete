# Architecture decision records

One record per decision that would otherwise be re-litigated, or re-made wrongly by someone who was
not in the conversation. Each states the decision, the alternative rejected, and the consequence that
will be felt later.

`docs/01-scope-and-decisions.md` is the table: what was decided, at a glance. These are the arguments.
**`pnpm adr` fails the build if a locked decision has no record here**, or if a record claims to cover
a decision the table does not list.

| ADR | Decision | Covers |
|---|---|---|
| [0001](0001-monorepo-and-module-boundaries.md) | Monorepo shape and enforced module boundaries | 1 |
| [0002](0002-typescript-6-not-7.md) | TypeScript 6, not 7 — a gate that silently examined nothing | — |
| [0003](0003-every-gate-needs-a-known-bad-fixture.md) | Every gate needs a known-bad fixture | — |
| [0004](0004-postgres-driver-and-pooling.md) | Postgres driver, pooling, and managed-database sizing | 16 |
| [0005](0005-non-production-cannot-use-real-providers.md) | Non-production cannot reach a real provider | — |
| [0006](0006-sql-first-migrations.md) | SQL-first migrations; Drizzle is a mirror, not a generator | 3 |
| [0007](0007-money-and-business-day-primitives.md) | Integer fils, VAT as a remainder, business day first-class | 7, 8, 22 |
| [0008](0008-unit-of-work-and-exactly-once-per-handler.md) | Unit of work, transactional outbox, exactly-once per handler | 4 |
| [0009](0009-authorisation-matrix-and-mandatory-totp.md) | Authorisation matrix and mandatory TOTP for staff | 5 |
| [0010](0010-clinical-boundary.md) | The clinical boundary, designed for relocation | 10, 17 |
| [0011](0011-documents-render-in-chromium.md) | Documents render in Chromium; Latin runs in Arabic are isolated | 27, 28, 29 |
| [0012](0012-design-tokens.md) | The palette is derived, not chosen; generated artifacts are committed | 30, 31 |
| [0013](0013-server-rendered-not-a-spa.md) | Server-rendered, not a single-page application | 2 |
| [0014](0014-phone-first-customer-identity.md) | Phone-first customer identity, and no customer accounts | 6 |
| [0015](0015-double-booking-prevented-in-the-database.md) | Double-booking is prevented in the database | 9, 18 |
| [0016](0016-messaging-compliance-is-structural.md) | Messaging compliance is structural, not configurable | 11, 12 |
| [0017](0017-accounting-journal-and-no-auto-filing.md) | An internal journal, and no capability to file tax | 13 |
| [0018](0018-first-party-analytics-is-the-source-of-truth.md) | First-party analytics is the source of truth | 14, 24, 25 |
| [0019](0019-cms-embedded-in-the-app.md) | Payload CMS inside the same app and database | 15 |
| [0020](0020-regulatory-profile-drives-vocabulary-and-eligibility.md) | One regulatory profile, defaulting stricter | 19, 20, 23, 26 |
| [0021](0021-catalogue-shape-and-packages-only.md) | A service is (style × treatment); packages only | 19b, 21 |
| [0022](0022-provider-ports-and-fakes.md) | Every external service behind a port, with a fake that fails on demand | 32 |
| [0023](0023-gapless-numbering-row-locked-counter.md) | Gap-free document numbering from a row-locked counter, not a SEQUENCE | — |
| [0024](0024-deferred-room-capacity-trigger.md) | The room-capacity trigger is deferred to COMMIT; the therapist exclusion constraint is not | — |
| [0025](0025-staff-field-level-encryption.md) | Staff PII under a third KEK; the employment record is a closed field map | — |
| [0026](0026-period-reopen-requires-migration.md) | Reopening a closed accounting period requires a migration | — |
| [0031](0031-clinical-intake-consent-gate.md) | The intake consent gate is a refusal; the AAD binds the template version; residency is a setting | — |
| [0033](0033-contraindication-flag-crossing.md) | The crossing carries a flag and never an answer; `false` means "not affirmed"; an answer nobody can read escalates | — |

## Writing one

State the decision in a sentence. Then the thing that makes it a decision rather than a preference:
what the obvious alternative was, and the specific way it fails here. Then the consequence somebody
will have to live with — the deployment cost, the migration it forecloses, the thing that now has to
happen in two places.

A record that only says what was decided is the table. These exist for the rest.
