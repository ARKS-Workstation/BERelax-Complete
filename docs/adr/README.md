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
| [0034](0034-erasure-is-enumerated-and-bounded.md) | Erasure enumerates the catalogue and refuses an unclassified column; its four boundaries are stated in the row | — |
| [0039](0039-the-admin-session-is-an-opaque-token.md) | The admin session cookie carries 32 random bytes and no role; the role is reached by join on every request, and no deployment seeds an account | — |
| [0040](0040-flow-interpreter-idempotency-and-one-window.md) | The interpreter owns no window; its idempotency key is a unique constraint; its bounds live on the run | — |
| [0042](0042-publication-is-refused-at-the-permission-layer-and-in-the-database.md) | Publication is refused at the permission layer and in the database, never by a prompt | — |
| [0041](0041-leave-approval-never-cancels-an-appointment.md) | Approving leave never cancels an appointment; the coverage refusal is a difference; a leave period is stored over trading-session instants | — |
| [0045](0045-analytics-retention-is-a-policy-table-and-a-guarded-default-partition.md) | Analytics retention is a policy table the job reads; the missing partition is a guarded default that refuses every row | — |
| [0043](0043-a-private-sqlstate-is-five-characters-and-comes-from-a-registry.md) | A private SQLSTATE is all five characters and comes from a registry; two rules may share a class and never a code | — |
| [0046](0046-first-party-measurement-plan.md) | The measurement plan is code: one closed taxonomy, one funnel vocabulary derived from a single tuple, and a funnel bucketed on business_day | — |
| [0044](0044-a-filed-vat-return-is-a-snapshot-not-a-query.md) | A filed VAT return is a snapshot of bytes with a hash over exactly those bytes, signed by two different people; a correction is a new version | — |
| [0048](0048-the-marketing-kill-switch-cannot-reach-transactional-traffic.md) | The kill switch is read in a function whose parameter cannot be a transactional message; its state has one row; the non-production default is computed, not stored | — |
| [0047](0047-commission-is-reproducible-by-pinning-its-version-and-its-as-of.md) | A commission run pins the rule version that judged it and the instant it read the books at; nothing is seeded, because no structure is configured | — |
| [0049](0049-places-aggregate-only-while-the-caching-terms-are-unverified.md) | Places reads are aggregate only; review content is never cached while the terms are unverified | — |
| [0052](0052-no-autofile-is-structural.md) | The absence of a filing capability is enforced by checks that fail when it appears — a boundary rule for the import, a scan for the global, the name and the credential; the Zoho export is one-way bytes for a signed return | — |
| [0051](0051-a-private-document-is-fetched-through-one-route-against-a-detached-signature.md) | A private document is fetched through one route against a detached HMAC over the document, verified without the provider; a valid signature authorises a fetch and never a principal, and a clinical or salary document is single-use in the database | — |
| [0053](0053-a-report-over-a-closed-period-proves-it-read-as-of-the-lock-rather-than-filtering-silently.md) | A report over a closed period records the lock's own instant and carries a line counting the rows written after it, rather than filtering its reads on `created_at` — which would hide a reopened period behind figures that still look as filed | — |
| [0057](0057-a-gratuity-liability-is-cumulative-and-a-month-is-its-difference.md) | An end-of-service gratuity liability is computed WHOLE at a date with one rounding, and a month's accrual is the difference between that and what the books hold — so twelve months sum exactly to the year, idempotence is arithmetic, and a wage rise needs no completed payroll run rewritten. Every figure is a provisional row of `gratuity_rule` flagged against Y9-gratuity, and there is no cap column because the shape of a cap is as unknown as its number | — |
| [0055](0055-a-payment-adapter-is-what-the-conformance-suite-accepts.md) | A payment adapter is what the conformance suite accepts; every declared inability is a refusal the suite demands, never a case it skips | — |
| [0056](0056-only-a-gateway-transaction-row-may-move-a-payment-intent.md) | Only a gateway transaction row may move a payment intent: the database refuses a state or figure change that names no new append-only movement of its own | — |
| [0054](0054-a-payslip-pins-every-figure-it-prints.md) | A payslip stores no figure it could recompute: it names the commission run, the timesheet approval and the rule versions that produced each line, and a completed run is corrected by a new dated run. The WPS file's employer identifier is a placeholder that fails validation, and there is no code that could send the bytes | — |
| [0059](0059-an-opaque-category-code-is-a-property-of-the-whole-payload.md) | An opaque category code is a property of the whole payload, not of the code: the mapping is total by compilation and written out, the external payload is an allowlist projection whose drops are counted, and a figure travels only with the terminal funnel stage — because a price beside a code on a public price list is one row of the mapping | — |
| [0050](0050-a-suite-may-delete-only-what-it-created.md) | A suite may remove rows it created; anything wider is declared, with the loader that restores a seeded table named, and the run itself checks that the seeded rows survived | — |
| [0061](0061-an-import-is-resumable-per-row-and-provenance-is-a-reference.md) | An import commits one source row at a time — entity, provenance, audit row, outbox event and the staged row's state transition in one transaction, with nothing recorded outside it — and provenance is a reference to the staged row rather than a copy of the file, line and hash. A row that reaches `applied` with no provenance cannot be committed, and a dry run forces the deferred constraints before it rolls back, so the rehearsal is not weaker than the run | — |
| [0058](0058-origination-precedence-is-strict-and-a-click-id-outlives-the-tuple.md) | Origination is resolved in strict precedence — UTM, then click id, then referrer, then direct — and a click id is persisted verbatim whatever won, because the tuple and the ad-platform join key are different facts; an own-host referrer is no new origination rather than direct, and the registrable domain comes from a declared bounded suffix table whose worst case is a referral grouped one label too broadly | — |
| [0060](0060-the-reporting-schema-is-derived-and-keyed-on-business-day.md) | The reporting schema states no fact of its own — every relation is a materialised view, so a merge has nothing to re-point and an erasure is complete without a refresh, which is paid for by holding no contact detail, label or wage anywhere in it; `dim_date` is keyed on `business_day.trading_date` rather than on a calendar date it would be the first thing entitled to disagree with; and every refresh is CONCURRENT, so a materialised view with no plain unique index is refused before a refresh is attempted rather than after, because the obvious fix for that error is the keyword that blocks every reader | — |
| [0062](0062-the-ai-crawler-policy-is-one-table-and-a-user-agent-is-a-claim.md) | The AI crawler policy is ONE table that the robots.txt builder, the bot classifier and a repository-wide scan all read, so allowing a crawler and being able to recognise its traffic cannot drift apart; a user agent is a CLAIM and never evidence, so no verdict may refuse, gate or authorise anything; and a headless suspicion is either corroborated by two named signals or exact to the millisecond, with no tuned threshold and no tolerance | — |
| [0063](0063-the-reply-linter-is-a-send-path-chokepoint-the-database-enforces.md) | The reply linter is a send-path chokepoint: not injectable, identical in both delivery modes, and a delivery timestamp is impossible without a lint stamp the database can see; provenance is asked of a machine draft and content of every reply | — |
| [0064](0064-a-financial-statement-is-a-directed-sum-over-a-partition-of-the-chart.md) | Every statement line is a directed sum over a named set of account codes and the balance sheet's lines are a total, disjoint partition of the whole chart — so `assets - (liabilities + equity) = 0` is the trial-balance identity and, being true of ANY consistent partition, is a check on the partition and not on the sections: a liability filed under assets still balances, which is why the direction rule and a census taken with no reference to the layout are what tie the statements to `journal_line`. The earnings since the books opened are an equity LINE rather than a plug or an invented closing entry, the cash flow is indirect so that a banking run needs no pro-rata split, and nothing is materialised in `reporting`, whose every relation is keyed on a trading date the journal deliberately has no foreign key to | — |

## Writing one

State the decision in a sentence. Then the thing that makes it a decision rather than a preference:
what the obvious alternative was, and the specific way it fails here. Then the consequence somebody
will have to live with — the deployment cost, the migration it forecloses, the thing that now has to
happen in two places.

A record that only says what was decided is the table. These exist for the rest.
