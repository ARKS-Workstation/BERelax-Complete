/**
 * WHICH suite may empty WHICH table, and why. Data only — no imports, and nothing that reads a file.
 *
 * Separated from the scan in `./suite-table-ownership.ts` so that `@berelax/db` can export the declarations
 * without exporting a module that reaches for `node:fs`: the integration run's own invariant needs to know
 * which tables a suite is allowed to have emptied, and it runs inside `packages/fixtures`.
 *
 * The rule, the defect it is against and the two claims a static scan cannot make are all documented in
 * `./suite-table-ownership.ts`. ADR 0050 is the decision.
 */

/** Why a suite is allowed to issue a statement that names a table and no rows. */
export type DeclaredKind =
  /**
   * The suite owns the table outright for the length of its run: it creates every row in it, and the
   * statement is how it starts from nothing. `truncate` is always this — SQL gives it no predicate — which
   * is why truncating the invoice family as its owner becomes a declaration here rather than a convention
   * in a comment.
   */
  | 'owns'
  /**
   * The statement is a PROBE: the suite issues it to prove the database refuses it, and asserts the
   * refusal. Nothing is removed, so ownership does not come into it. Kept apart from `owns` because the two
   * are opposite claims about the same syntax, and a reader who cannot tell them apart cannot audit either.
   */
  | 'refused'
  /**
   * The statement runs inside a transaction the suite ABORTS on purpose, so the rows are still there when it
   * returns. Three suites need a probe against an empty table rather than a missing key — "the strict default
   * needs no row", "the reader throws rather than inventing rates" — and a rollback is the only way to have
   * one without damaging the database for everything that runs afterwards.
   *
   * Nothing static can confirm the rollback happened; the integration run's own invariant is what catches one
   * that did not, because the rows it expected to still be there would not be.
   */
  | 'rolled-back'

export interface DeclaredUnqualified {
  /** The test file, exactly as the scan reports it: repository-relative, forward slashes. */
  readonly file: string
  /** Lowercased, schema-qualified to match {@link UnqualifiedSite.tables}. */
  readonly tables: readonly string[]
  readonly kind: DeclaredKind
  /** Why this suite, this table. A sentence a reader can disagree with. */
  readonly why: string
  /**
   * The fixture loader that puts the seed's rows back, for the tables in this entry that the seed writes.
   *
   * Required by `seeded-tables.itest.ts` for any `kind: 'owns'` declaration naming a table the seed writes,
   * and refused on a `kind` that removes nothing. A suite may empty a seeded table and put it back; it may
   * not empty one and leave.
   *
   * It covers the SEEDED tables of the entry and says nothing about the others. An entry usually names both:
   * the package family is truncated in one statement because PostgreSQL requires every referencing table in
   * it, and of the seven tables in that statement the seed writes the three templates and none of the sales.
   * The sales are the suite's own and need no restoring; the claim is about the ones that are not.
   */
  readonly restoredBy?: string
}

/**
 * The tables no declaration may name, in any wording.
 *
 * `customer` is here because the loader CANNOT repair it in the way the package loader can. Measured: on a
 * database whose customers a suite had removed, re-running `pnpm seed` left the rows missing for every
 * table whose loader short-circuits on a non-empty table — and `package_sale.customer_id` is
 * `on delete restrict` with `package_sale` refusing DELETE, so one seeded sale pins its customer for the
 * life of the database. A suite that needs an empty `customer` table is a suite that needs its own rows
 * scoped, which both former offenders now do: one by the two `phone_match_key`s it creates, one by the two
 * number bands it creates in.
 */
export const NEVER_DECLARABLE: readonly string[] = Object.freeze(['customer'])

/**
 * Every unqualified `delete`/`truncate` this repository allows, and why.
 *
 * Ordered by file. One entry may name several tables when ONE reason covers them — the invoice family is
 * six tables in one statement because PostgreSQL refuses a truncate while a referencing table is missing
 * from it, and six entries repeating that sentence would be six places for it to drift.
 */
export const DECLARED_UNQUALIFIED: readonly DeclaredUnqualified[] = Object.freeze([
  // ## The invoice family
  //
  // `invoice` refuses DELETE for every role (ZI003), so TRUNCATE as the owner is the only legal removal —
  // and PostgreSQL refuses a truncate while a table referencing one of the named tables is left out, which
  // is why the statement is a list rather than one name. Each suite numbers its own documents from the
  // `TAX-INV` series and asserts on the series, so it has to start from none.
  //
  // Only the REFUSED probe is declared per suite now. Every suite that empties the family calls the shared
  // statement below instead, so there is one entry for it and none here: eight entries that named the same
  // eight tables with eight different reasons were removed when the statements moved, because a declaration
  // that matches no statement is standing permission to write one back.
  {
    file: 'packages/db/src/repositories/invoice.itest.ts',
    tables: ['invoice'],
    kind: 'refused',
    why: 'issued as the application role to prove ZI003 refuses it. This file used to own the invoice family here too; the statement moved to `truncateInvoiceFamily` and this entry shrank to the probe, which is the direction the stale-declaration rule exists to allow',
  },

  // ## The shared family teardowns
  //
  // ONE entry for the module that holds all five statements, and it replaced TWENTY-EIGHT — one per suite
  // that used to restate a table list. That is the same argument this whole rule makes, turned on the rule's own
  // subject: sixteen suites each spelled the invoice and package lists, migration 0097 gave `commission_line`
  // a foreign key to both `invoice` and `package_redemption`, every list went stale at once and four suites
  // failed in their own teardowns. The lists live once now.
  //
  // One entry rather than one per helper because a (file, table) pair carries one reason, and `payment` and
  // `commission_line` are in more than one list deliberately — `payment` references `invoice` and `package_sale`, so
  // whichever family is emptied first has to name it.
  //
  // `packages/fixtures/src/invoice-family.itest.ts` is what stops this declaration drifting: it derives all
  // five closures from `pg_constraint` and fails when a written list and the schema disagree. So the claim here is
  // about ONE statement whose scope another check proves, which is the arrangement this rule wants everywhere.
  {
    file: 'packages/fixtures/src/invoice-family.ts',
    tables: [
      'refund',
      'checkout_finalisation',
      'payment',
      'commission_line',
      'invoice_appointment',
      'invoice_line',
      'invoice',
      'package_redemption',
      'imported_package_sale',
      'package_balance',
      'package_sale',
      'package_template_line',
      'package_template_version',
      'package_template',
      'credit_note_line',
      'credit_note',
      'cash_session_adjustment',
      'cash_drop',
      'employee_tip',
      'cash_session',
      'payslip',
      'commission_run',
      'commission_rule_band',
      'commission_rule',
    ],
    kind: 'owns',
    restoredBy: 'packages',
    why: 'the shared teardown for all five families — invoice, credit note, package, cash and commission — called by the suites that issue their own documents, sell their own packages and open their own drawers. `invoice` refuses DELETE for every role (ZI003) and a closed `cash_session` refuses it for every role including the owner, so truncate by the owner is the only legal removal, and PostgreSQL requires every referencing table in the statement. Of the twenty-three the seed writes only the three package templates, and `seedPackageTemplates` restores those',
  },

  // ## The payroll run (P-HR-12)
  //
  // Five tables migration 0104 creates and the seed does not write — checked against the derived seeded set
  // rather than assumed. The suite builds a run, its payslips, the tips it discharges and the deductions it
  // records, then empties them: every row in all five is its own by construction, so there is nothing to
  // restore. `payroll_run` refuses UPDATE once completed and DELETE always (ZY141), which puts it in the same
  // position as `invoice` — a truncate by the owner is the only legal removal, and the append-only guarantee
  // is about what the application may do, not about what a fixture may clear between runs
  // (`packages/fixtures/src/invoice-family.ts` states that once, at length).
  {
    file: 'packages/fixtures/src/hr-payroll.itest.ts',
    tables: ['wps_export', 'payslip', 'payroll_run', 'employee_tip', 'payroll_deduction'],
    kind: 'owns',
    why: 'the payroll suite builds every row in all five tables and the seed writes none of them; PostgreSQL requires every referencing table in one statement, which is why the five are named together',
  },

  // ## The review intake (G-REV-02)
  //
  // Four tables the seed does not write — checked against the derivation rather than assumed, because a
  // declaration that guessed would be the defect this rule is about. The intake is asserted as the whole
  // contents of each table, which is production behaviour: a fallback email is matched against every place
  // aggregate there is, so a row another suite left behind is a different answer rather than extra noise.
  {
    file: 'packages/google/src/reviews/inbound-email.itest.ts',
    tables: [
      'review_intake_email',
      'google_place_aggregate',
      'google_reviews',
      'google_connections',
    ],
    kind: 'owns',
    why: 'the intake is asserted as the whole contents of these four tables, and a connection or aggregate left by another suite would be resolved against instead of this file\u2019s; no loader writes any of them, because a connection carries a real OAuth refresh token',
  },
  {
    file: 'apps/web/src/reviews-paste.itest.ts',
    tables: ['review_intake_email', 'google_place_aggregate'],
    kind: 'owns',
    why: 'the paste route is asserted by the intake row it creates and the aggregate it matched, both counted as totals; the same file scopes its `google_reviews` and `google_connections` deletes to its own place id and sub, which is why they are absent here',
  },
  {
    file: 'apps/worker/src/jobs/review-fallback-intake.itest.ts',
    tables: [
      'review_intake_email',
      'google_place_aggregate',
      'google_reviews',
      'google_connections',
    ],
    kind: 'owns',
    why: 'the job is asserted by which intake rows it promoted to reviews, over the whole table, so every row in all four has to be one this file put there',
  },

  // ## The cash session family, the credit-note family and the commission family
  //
  // Nothing is declared per suite for any of the three. Each had its own hand-written table list — four
  // copies of the cash one, five of the credit-note one — and each list went stale on one migration: 0104
  // pointed `employee_tip` at `cash_session` and `payslip` at `commission_run`. The statements are in
  // `packages/fixtures/src/invoice-family.ts` and declared there, once, with the derivation that keeps them
  // honest in `invoice-family.itest.ts`.

  // ## The booking family
  //
  // Nothing in `pnpm seed` writes an appointment: the fixture salon's 250 appointments are generated but no
  // loader is registered for them (see `packages/fixtures/src/load.ts`), so these tables hold only what a
  // suite put there.
  {
    file: 'packages/db/src/repositories/catalogue.itest.ts',
    tables: [
      'booking_idempotency',
      'appointment_status_history',
      'scheduled_step',
      'appointment',
      'booking',
    ],
    kind: 'owns',
    why: 'archiving a service is asserted against the bookings this file made against it; no loader writes an appointment',
  },
  {
    file: 'packages/db/src/schema/booking-constraints.itest.ts',
    tables: [
      'booking_idempotency',
      'appointment_status_history',
      'scheduled_step',
      'appointment',
      'booking',
    ],
    kind: 'owns',
    why: 'every exclusion constraint is proved by a pair of appointments this file inserts, and the file also truncates `appointment_status_history` alone as the application role to prove the grant is absent',
  },
  {
    file: 'packages/fixtures/src/catalogue-compliance.itest.ts',
    tables: [
      'booking_idempotency',
      'appointment_status_history',
      'scheduled_step',
      'appointment',
      'booking',
    ],
    kind: 'owns',
    why: 'the compliance walkthrough books against the service it publishes and removes both again',
  },

  // ## The ledger
  {
    file: 'packages/db/src/repositories/journal.itest.ts',
    tables: ['journal_line', 'journal_entry'],
    kind: 'owns',
    why: 'the trial balance is asserted as a total over the entries this file posts, so a foreign entry is a wrong answer; the file also truncates `journal_line` as the application role to prove 42501',
  },
  {
    file: 'packages/db/src/repositories/journal.itest.ts',
    tables: ['period_lock'],
    kind: 'owns',
    why: 'the lock under test is the one this file takes, and a lock left by another suite would refuse its posts',
  },
  {
    file: 'packages/db/src/services/opening-balances.itest.ts',
    tables: ['opening_balance_import'],
    kind: 'owns',
    why: 'the import is idempotent on its own marker row, so the second-run assertion needs the table to hold this file’s import and no other',
  },

  // ## Google
  //
  // `resolveTarget` scans every connection serving a capability and orders by id, which is production
  // behaviour (brief rule 12). Six suites each start from no connection for that reason. No loader writes
  // one — a connection carries a real OAuth refresh token.
  {
    file: 'packages/db/src/schema/google.itest.ts',
    tables: ['google_connections'],
    kind: 'owns',
    why: 'the schema probe asserts on the columns of the connection it inserts, and `resolveTarget` would otherwise answer with another suite’s',
  },
  {
    file: 'packages/db/src/schema/reviews.itest.ts',
    tables: ['google_reviews', 'google_connections'],
    kind: 'owns',
    why: 'a review hangs off a connection with `on delete restrict`, so both are this file’s own and both go together',
  },
  {
    file: 'packages/google/src/google-connection.itest.ts',
    tables: ['google_connections'],
    kind: 'owns',
    why: 'the re-wrap is asserted over every connection in the table, so every connection has to be this file’s',
  },
  {
    file: 'packages/google/src/google-disconnect.itest.ts',
    tables: ['google_reviews', 'google_connections'],
    kind: 'owns',
    why: 'disconnection is asserted by the connection being gone, which only means something if the file put every connection there',
  },
  {
    file: 'packages/google/src/google-oauth.itest.ts',
    tables: ['google_connections'],
    kind: 'owns',
    why: 'the consent callback is asserted by the connection it creates being the one `resolveTarget` returns',
  },
  {
    file: 'packages/google/src/review-queue.itest.ts',
    tables: ['google_reviews', 'google_connections'],
    kind: 'owns',
    why: 'the queue is asserted as an ordered list, so a review another suite left behind changes the answer',
  },
  {
    file: 'packages/google/src/review-routing.itest.ts',
    tables: ['google_reviews', 'google_connections'],
    kind: 'owns',
    why: 'routing is asserted per review over the whole table, so the table has to hold this file’s reviews only',
  },
  {
    file: 'packages/google/src/reviews/review-draft.itest.ts',
    tables: ['google_reviews', 'google_connections'],
    kind: 'owns',
    why: 'the draft is asserted against the one review awaiting a reply, so a foreign review would be drafted against instead',
  },

  // ## OTP
  {
    file: 'packages/db/src/repositories/otp.itest.ts',
    tables: ['otp_challenge', 'otp_phone_lock'],
    kind: 'owns',
    why: 'the attempt counter and the lock are asserted as totals for the number this file challenges; no loader issues a challenge',
  },
  {
    file: 'apps/web/src/otp-route.itest.ts',
    tables: ['otp_challenge', 'otp_phone_lock'],
    kind: 'owns',
    why: 'the route is asserted by the challenge it created and the lock it earned; the customers this file used to clear with it are now scoped to the two number bands it creates in',
  },

  // ## Agents
  {
    file: 'packages/fixtures/src/agents.itest.ts',
    tables: ['agent_alert', 'agent_run'],
    kind: 'owns',
    why: 'the watchdog is asserted by the alert count for the runs this file records; no loader records a run',
  },
  {
    file: 'apps/worker/src/jobs/agent-watchdog.itest.ts',
    tables: ['agent_alert', 'agent_run'],
    kind: 'owns',
    why: 'the job is asserted by the alerts it raises over the runs this file inserts',
  },

  // ## Statements whose scope the scan cannot read
  //
  // Each takes its table from an interpolation, so there is no list to resolve and the reason has to be
  // written down instead. Kept apart from every other kind because the claim is different: not "this suite
  // owns the table" but "the scan cannot see which table this is, and here is why that is safe".
  {
    file: 'packages/db/src/repositories/numbering.itest.ts',
    tables: ['<unresolved-list>'],
    kind: 'owns',
    why: 'truncates the `issued_document` table of TEST_SCHEMA \u2014 a table in the per-run schema this file creates and drops, so it owns every row in it by construction. The name is a template literal over the schema, which is why no list can be resolved; a suite whose tables are its own schema is the strongest form of this rule rather than an exception to it',
  },
  {
    file: 'packages/db/src/analytics.itest.ts',
    tables: ['<unresolved-list>'],
    kind: 'refused',
    why: 'deletes from a PARTITION whose name the probe has just read out of `tableoid`, to prove the append-only rule reaches a partition and not merely the parent. The name cannot be known before the query runs, and the case asserts the refusal rather than the removal',
  },
  {
    file: 'packages/db/src/services/vat-return-signoff.itest.ts',
    tables: ['<unresolved-list>'],
    kind: 'refused',
    why: 'loops the three sealed return tables as the application role and asserts 42501 on each, so the table name is the loop variable. Nothing is removed \u2014 that is the whole assertion',
  },

  // ## Append-only probes
  //
  // Each of these is issued to prove the database REFUSES it. Nothing is removed, so ownership does not
  // arise — and the integration run's own invariant is what proves the refusal held, because a probe that
  // silently succeeded would show up as rows that stopped existing.
  {
    file: 'packages/db/src/analytics.itest.ts',
    tables: ['analytics.event', 'analytics.funnel_step'],
    kind: 'refused',
    why: 'the append-only guarantee of ADR 0008 is asserted by issuing the delete as each role and requiring the refusal',
  },
  {
    file: 'packages/fixtures/src/rights.itest.ts',
    tables: ['rights_request', 'rights_resolution_class'],
    kind: 'refused',
    why: 'a rights record is immutable evidence, and the probe is the only way to show the refusal fires rather than being asserted in prose',
  },

  // ## Rolled back
  //
  // The statement runs inside a transaction the suite aborts on purpose, so the rows are still there when
  // it returns. Declared rather than trusted: the run invariant is what catches a rollback that did not
  // happen, and each of these files states the rollback in its own comment beside the throw.
  {
    file: 'packages/db/src/settings/availability.itest.ts',
    tables: ['app_setting'],
    kind: 'rolled-back',
    why: 'the strict default has to be proved against an EMPTY table rather than a missing key, and the probe throws to roll back so every later suite sees the settings it expects',
  },
  {
    file: 'packages/fixtures/src/therapist-eligibility.itest.ts',
    tables: ['app_setting'],
    kind: 'rolled-back',
    why: 'the same empty-table probe for gender matching, rolled back, with the key list read before and compared after',
  },
  {
    file: 'packages/fixtures/src/hr-working-hours.itest.ts',
    tables: ['working_hours_rule'],
    kind: 'rolled-back',
    why: 'the reader must throw rather than invent rates when no version exists, and the probe helper rolls back; the file asserts the row is back afterwards',
  },

  // ## Seeded tables a suite empties and the seed puts back
  //
  // Every one of these names the loader that repairs it, and the integration run re-runs the loaders before
  // it checks — so a `restoredBy` that is not true fails the run that relied on it.
  {
    file: 'packages/db/src/settings-store.itest.ts',
    tables: ['app_setting'],
    kind: 'owns',
    restoredBy: 'settings',
    why: 'the store’s own suite: `seedSettingDefaults` is the thing under test and it has to be proved from an empty table. It re-seeds the DEFAULTS itself, which is not the same as the fixture values — `packages/db` may not import `packages/fixtures`, so the three values the settings loader updates are restored by that loader and not here',
  },
  {
    file: 'packages/db/src/spine.itest.ts',
    tables: ['premises_hours'],
    kind: 'owns',
    restoredBy: 'premises',
    why: '`crosses_midnight` is generated by the database from the times, and proving it needs rows with chosen times and no others. The file now calls `seedPremises` in its own `afterAll` so the real 11:00–02:00 hours are back before any later suite reads them',
  },
  {
    file: 'packages/fixtures/src/load.itest.ts',
    tables: ['premises_hours', 'premises'],
    kind: 'owns',
    restoredBy: 'premises',
    why: 'the idempotence criterion is "identical rows when run twice FROM CLEAN", which cannot be shown without emptying the two tables first; the same test re-runs `loadSalon` twice, so the rows are back before it returns',
  },
  {
    file: 'packages/fixtures/src/business-days.itest.ts',
    tables: ['business_day'],
    kind: 'owns',
    restoredBy: 'business-days',
    why: 'the trading calendar is asserted row by row over the window this file generates, and the fixture horizon overlaps it, so the seeded days would be indistinguishable from the ones under test',
  },
  {
    file: 'packages/fixtures/src/seeded-tables.itest.ts',
    tables: ['package_template', 'package_template_version', 'package_template_line'],
    kind: 'rolled-back',
    why: 'this unit\u2019s own suite, and the rule caught it on its first run \u2014 which is the best evidence the scan reads every file. It empties the package family to prove the loader can put it back, which is what every `restoredBy: "packages"` declaration rests on, and both probes throw to roll their transaction back. `cascade` rather than a hand-written list of referencing tables, because this probe runs against whatever the rest of the run has left behind',
  },
  {
    file: 'packages/fixtures/src/package-redemption.itest.ts',
    tables: ['package_redemption'],
    kind: 'refused',
    why: 'issued as the application role to show ZG007 refuses it. The truncate that used to stand beside it moved to `truncatePackageFamily`, so this entry is the probe alone',
  },
])

/**
 * Tables a suite is allowed to have emptied because the seed puts them back.
 *
 * Read by the integration run's own invariant, which re-runs the fixture loaders before it checks: a table
 * named here may come back with NEW row ids, and one not named here must hold the rows it held before.
 */
export function restorableTables(
  declarations: readonly DeclaredUnqualified[] = DECLARED_UNQUALIFIED,
): Set<string> {
  // Every table of a restoring entry, including the ones the seed does not write. That over-inclusion is
  // harmless and deliberate: the caller compares over the SEEDED tables it read before the run, so a table
  // the seed does not write is never looked up here. Intersecting first would need the derived set, which
  // would make this data module need a database.
  const out = new Set<string>()
  for (const entry of declarations) {
    if (entry.restoredBy === undefined) continue
    for (const table of entry.tables) out.add(table)
  }
  return out
}
