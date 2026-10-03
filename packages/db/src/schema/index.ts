export * from './agents.ts'
/*
 * The `analytics` schema, as a NAMESPACE rather than flattened into this one (A-FIRST-01).
 *
 * Every other line in this file is a `export *` because every other mirror is of a table in `public`, and
 * `public` is one namespace in Postgres and one here. `analytics` is a second Postgres schema, and its
 * tables are called `session`, `event` and `visitor` — the names the migration gives them, which is what
 * every mirror in this directory does and what a reader comparing the two expects. Flattening those into
 * this namespace would put `session` next to `bookingSession` and `staffSession` with nothing saying which
 * schema it is in, and the day a migration adds `public.session` the `export *` would collide and the fix
 * would be somebody else's. `schema.analytics.session` reads the way the SQL does.
 */
export * as analytics from './analytics.ts'
/*
 * The dispatch queue's mirrors, which are PUBLIC tables about the analytics schema's subject.
 *
 * `export *` and not a namespace, unlike the line above, because `analytics_dispatch` and
 * `analytics_dispatch_destination` are in `public` — and their names already carry the word, so
 * `schema.analyticsDispatch` reads the way the SQL does. 0125's header is why the queue is in `public`.
 */
export * from './analytics-dispatch.ts'
export * from './attendance.ts'
export * from './attribution.ts'
export * from './bill.ts'
export * from './booking.ts'
export * from './booking-manage-grant.ts'
export * from './booking-session.ts'
export * from './campaign.ts'
export * from './cash-session.ts'
export * from './catalogue.ts'
export * from './checkout-idempotency.ts'
export * from './commission.ts'
export * from './consent.ts'
export * from './credit-note.ts'
export * from './crm.ts'
export * from './customer.ts'
export * from './document-series.ts'
export * from './flow.ts'
export * from './flow-run.ts'
export * from './frequency-ledger.ts'
export * from './google.ts'
export * from './gratuity.ts'
export * from './holiday-calendar.ts'
export * from './hr.ts'
export * from './identity.ts'
/*
 * The `import_staging` schema, as a NAMESPACE for the reason the `analytics` comment above gives
 * (H-MIG-01). Its tables are `import_run`, `import_row` and `import_provenance`, and `importRow` flattened
 * into this namespace would sit beside nothing that says which schema it is in — while `entityProvenance`
 * and `importProvenance` next to each other would read as two mirrors of one thing rather than a view this
 * file deliberately does not mirror. `schema.importStaging.importRow` reads the way the SQL does.
 */
export * as importStaging from './import-staging.ts'
export * from './imported-appointment.ts'
export * from './imported-contact.ts'
export * from './imported-staff-row.ts'
export * from './incident.ts'
export * from './invoice.ts'
export * from './leave-approval.ts'
export * from './ledger.ts'
export * from './merge-record.ts'
export * from './message.ts'
export * from './messaging.ts'
export * from './messaging-controls.ts'
export * from './obligation.ts'
export * from './opening-balances.ts'
export * from './package.ts'
export * from './parallel-run.ts'
export * from './payment.ts'
export * from './payments.ts'
export * from './payroll.ts'
export * from './pipeline.ts'
export * from './platform.ts'
export * from './price-list.ts'
export * from './price-on-request.ts'
export * from './private-document.ts'
export * from './publication.ts'
export * from './recurring-cost.ts'
export * from './redirect.ts'
export * from './reviews.ts'
export * from './rights.ts'
export * from './rooms.ts'
export * from './scheduled-step.ts'
export * from './seo.ts'
export * from './staff.ts'
export * from './staff-session.ts'
export * from './supplier.ts'
export * from './suppression.ts'
export * from './trading.ts'
export * from './vat-box-mapping.ts'
export * from './vat-return.ts'
export * from './waitlist.ts'
export * from './whatsapp-ref.ts'
