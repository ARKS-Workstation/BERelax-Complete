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
  // is why each of these statements is a list rather than one name. Each suite numbers its own documents
  // from the `TAX-INV` series and asserts on the series, so it has to start from none.
  {
    file: 'packages/db/src/adapters/manual-payment.itest.ts',
    tables: [
      'credit_note_line',
      'credit_note',
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
    ],
    kind: 'owns',
    why: 'the adapter suite issues and refunds its own invoices and asserts on the series numbers, so it starts from none; no loader writes an invoice',
  },
  {
    file: 'packages/db/src/repositories/invoice.itest.ts',
    tables: [
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
    ],
    kind: 'owns',
    why: 'the repository suite owns every invoice it reads, and the same file probes `delete from invoice` as the application role to prove ZI003 refuses it',
  },
  {
    file: 'packages/db/src/services/checkout-finalise.itest.ts',
    tables: [
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
    ],
    kind: 'owns',
    why: 'finalisation is asserted against the documents this file issues; no loader writes an invoice',
  },
  {
    file: 'packages/db/src/services/issue-credit-note.itest.ts',
    tables: [
      'credit_note_line',
      'credit_note',
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
    ],
    kind: 'owns',
    why: 'a credit note is asserted against the invoice this file issued for it, and both series restart from 1 here',
  },
  {
    file: 'packages/fixtures/src/checkout-finalisation.itest.ts',
    tables: [
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
    ],
    kind: 'owns',
    why: 'the finalisation walkthrough issues its own invoice per case and asserts the series number it got',
  },
  {
    file: 'packages/fixtures/src/credit-note.itest.ts',
    tables: [
      'credit_note_line',
      'credit_note',
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
    ],
    kind: 'owns',
    why: 'the credit-note walkthrough owns both documents it asserts on, and both series restart from 1 here',
  },
  {
    file: 'packages/fixtures/src/invoice-document.itest.ts',
    tables: [
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
    ],
    kind: 'owns',
    why: 'the rendered document is compared against the invoice this file issued, down to its number',
  },
  {
    file: 'packages/fixtures/src/payment.itest.ts',
    tables: [
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
    ],
    kind: 'owns',
    why: 'the payment pair is asserted against this file’s own invoice and its own `TAX-INV` numbering',
  },
  {
    file: 'packages/fixtures/src/tax-document.itest.ts',
    tables: [
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
    ],
    kind: 'owns',
    why: 'the statutory document set is this file’s own, numbered from a series it resets',
  },
  {
    file: 'packages/fixtures/src/rights.itest.ts',
    tables: [
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
    ],
    kind: 'owns',
    why: 'the erasure probe has to know every invoice in the database is its own subject’s, or a retained document elsewhere would read as a failure to erase',
  },

  // ## The cash session family
  {
    file: 'packages/db/src/services/cash-session.itest.ts',
    tables: ['cash_session_adjustment', 'cash_drop', 'cash_session'],
    kind: 'owns',
    why: 'a till session is opened and closed by this file per case, and the close asserts on the only open session there is; no loader opens one',
  },
  {
    file: 'packages/db/src/services/cash-session.itest.ts',
    tables: [
      'credit_note_line',
      'credit_note',
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
    ],
    kind: 'owns',
    why: 'the takings a session counts are the payments this file recorded, so the invoice family is its own too',
  },
  {
    file: 'packages/fixtures/src/cash-up.itest.ts',
    tables: ['cash_session_adjustment', 'cash_drop', 'cash_session'],
    kind: 'owns',
    why: 'the cash-up walkthrough opens the session it reconciles and asserts on the only one open',
  },
  {
    file: 'packages/fixtures/src/cash-up.itest.ts',
    tables: [
      'credit_note_line',
      'credit_note',
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
    ],
    kind: 'owns',
    why: 'the declared float is reconciled against the payments this file recorded and nothing else',
  },
  {
    file: 'apps/web/src/till.itest.ts',
    tables: ['cash_session_adjustment', 'cash_drop', 'cash_session'],
    kind: 'owns',
    why: 'the till screen is rendered against the session this suite opens, and a session another suite left open would be the one it displayed',
  },
  {
    file: 'apps/web/src/till.itest.ts',
    tables: [
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
    ],
    kind: 'owns',
    why: 'the receipt and the day’s takings on the screen are this suite’s own documents',
  },

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

  // ## The package family
  {
    file: 'packages/db/src/services/sell-package.itest.ts',
    tables: ['commission_line'],
    kind: 'owns',
    why: 'named only because PostgreSQL refuses a TRUNCATE while a table referencing one of the others is left out of the statement, and migration 0097 gave `commission_line` a `package_redemption_id`. This suite owns no commission line and the table is empty unless `hr-commission.itest.ts` has run, which truncates its own rows itself. It refuses on the CONSTRAINT and not on the rows, so leaving it out failed these statements for every row count \u2014 measured at 8716718, before this unit: 44 cases across five files, red on a list nobody had touched',
  },
  {
    file: 'packages/fixtures/src/package.itest.ts',
    tables: ['commission_line'],
    kind: 'owns',
    why: 'named only because PostgreSQL refuses a TRUNCATE while a table referencing one of the others is left out of the statement, and migration 0097 gave `commission_line` a `package_redemption_id`. This suite owns no commission line and the table is empty unless `hr-commission.itest.ts` has run, which truncates its own rows itself. It refuses on the CONSTRAINT and not on the rows, so leaving it out failed these statements for every row count \u2014 measured at 8716718, before this unit: 44 cases across five files, red on a list nobody had touched',
  },
  {
    file: 'packages/fixtures/src/package-redemption.itest.ts',
    tables: ['commission_line'],
    kind: 'owns',
    why: 'named only because PostgreSQL refuses a TRUNCATE while a table referencing one of the others is left out of the statement, and migration 0097 gave `commission_line` a `package_redemption_id`. This suite owns no commission line and the table is empty unless `hr-commission.itest.ts` has run, which truncates its own rows itself. It refuses on the CONSTRAINT and not on the rows, so leaving it out failed these statements for every row count \u2014 measured at 8716718, before this unit: 44 cases across five files, red on a list nobody had touched',
  },
  {
    file: 'packages/fixtures/src/till-receipt.itest.ts',
    tables: ['commission_line'],
    kind: 'owns',
    why: 'named only because PostgreSQL refuses a TRUNCATE while a table referencing one of the others is left out of the statement, and migration 0097 gave `commission_line` a `package_redemption_id`. This suite owns no commission line and the table is empty unless `hr-commission.itest.ts` has run, which truncates its own rows itself. It refuses on the CONSTRAINT and not on the rows, so leaving it out failed these statements for every row count \u2014 measured at 8716718, before this unit: 44 cases across five files, red on a list nobody had touched',
  },
  {
    file: 'apps/web/src/till.itest.ts',
    tables: ['commission_line'],
    kind: 'owns',
    why: 'named only because PostgreSQL refuses a TRUNCATE while a table referencing one of the others is left out of the statement, and migration 0097 gave `commission_line` a `package_redemption_id`. This suite owns no commission line and the table is empty unless `hr-commission.itest.ts` has run, which truncates its own rows itself. It refuses on the CONSTRAINT and not on the rows, so leaving it out failed these statements for every row count \u2014 measured at 8716718, before this unit: 44 cases across five files, red on a list nobody had touched',
  },
  {
    file: 'apps/worker/src/jobs/package-expiry.itest.ts',
    tables: ['commission_line'],
    kind: 'owns',
    why: 'named only because PostgreSQL refuses a TRUNCATE while a table referencing one of the others is left out of the statement, and migration 0097 gave `commission_line` a `package_redemption_id`. This suite owns no commission line and the table is empty unless `hr-commission.itest.ts` has run, which truncates its own rows itself. It refuses on the CONSTRAINT and not on the rows, so leaving it out failed these statements for every row count \u2014 measured at 8716718, before this unit: 44 cases across five files, red on a list nobody had touched',
  },
  //
  // M-TILL-13's decision, kept: the seed writes the four fixture TEMPLATES and no sales, because
  // `package_sale.customer_id` is `on delete restrict` and `package_sale` refuses DELETE, so one seeded
  // sale would pin its customer for the life of the database. The suites truncate the family to start from
  // none, and `seedPackageTemplates` is what puts the templates back — which is why that loader had to stop
  // short-circuiting on a non-empty table (see `packages/fixtures/src/package-seed.ts`).
  {
    file: 'packages/db/src/services/sell-package.itest.ts',
    tables: [
      'package_redemption',
      'payment',
      'package_balance',
      'package_sale',
      'package_template_line',
      'package_template_version',
      'package_template',
    ],
    kind: 'owns',
    restoredBy: 'packages',
    why: 'a sale is asserted against the template version this file saved, and the version numbers restart from 1 here',
  },
  {
    file: 'packages/fixtures/src/package.itest.ts',
    tables: [
      'package_redemption',
      'payment',
      'package_balance',
      'package_sale',
      'package_template_line',
      'package_template_version',
      'package_template',
    ],
    kind: 'owns',
    restoredBy: 'packages',
    why: 'the template mapping is asserted as the whole list of templates, so a seeded one is an extra row in the answer',
  },
  {
    file: 'packages/fixtures/src/seeded-tables.itest.ts',
    tables: ['package_template', 'package_template_version', 'package_template_line'],
    kind: 'rolled-back',
    why: 'this unit\u2019s own suite, and the rule caught it on its first run \u2014 which is the best evidence the scan reads every file. It empties the package family to prove the loader can put it back, which is what every `restoredBy: "packages"` declaration rests on, and both probes throw to roll their transaction back. `cascade` rather than a hand-written list of referencing tables, because this probe runs against whatever the rest of the run has left behind',
  },
  {
    file: 'packages/fixtures/src/package-redemption.itest.ts',
    tables: [
      'package_redemption',
      'payment',
      'package_balance',
      'package_sale',
      'package_template_line',
      'package_template_version',
      'package_template',
    ],
    kind: 'owns',
    restoredBy: 'packages',
    why: 'the drawdown is asserted against the balance this file sold, and a seeded balance would be drawn down instead; the same file also issues a bare `delete from package_redemption` as the application role to show ZG007 refuses it',
  },
  {
    file: 'packages/fixtures/src/till-receipt.itest.ts',
    tables: [
      'package_redemption',
      'package_balance',
      'package_sale',
      'package_template_line',
      'package_template_version',
      'package_template',
    ],
    kind: 'owns',
    restoredBy: 'packages',
    why: 'the receipt lines for a package are asserted against the sale this file made. `payment` is named by this statement too and is declared with the invoice family below, because one (file, table) pair carries one reason',
  },
  {
    file: 'packages/fixtures/src/till-receipt.itest.ts',
    tables: [
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
    ],
    kind: 'owns',
    why: 'the receipt is rendered from this file’s own invoice and its own series number',
  },
  {
    file: 'apps/web/src/till.itest.ts',
    tables: [
      'package_redemption',
      'package_balance',
      'package_sale',
      'package_template_line',
      'package_template_version',
      'package_template',
    ],
    kind: 'owns',
    restoredBy: 'packages',
    why: 'this suite calls `seedPackageDrawdownStates` to put the four drawdown states on the screen and truncates them away afterwards, which is the arrangement M-TILL-13 chose so that no seeded sale pins a customer',
  },
  {
    file: 'apps/worker/src/jobs/package-expiry.itest.ts',
    tables: [
      'package_redemption',
      'payment',
      'package_balance',
      'package_sale',
      'package_template_line',
      'package_template_version',
      'package_template',
    ],
    kind: 'owns',
    restoredBy: 'packages',
    why: 'expiry is asserted as the set of balances the job touched, so every balance has to be one this file aged',
  },
  {
    file: 'packages/fixtures/src/hr-commission.itest.ts',
    tables: [
      'commission_line',
      'commission_run',
      'commission_rule_band',
      'commission_rule',
      'package_redemption',
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
      'package_balance',
      'package_sale',
      'package_template_line',
      'package_template_version',
      'package_template',
    ],
    kind: 'owns',
    restoredBy: 'packages',
    why: 'a commission run is asserted as a total over every line it produced, so every invoice, redemption and rule band in the database has to be one this file created',
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
