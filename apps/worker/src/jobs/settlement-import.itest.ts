import { ACCOUNTS, aedFrom, filsFrom, localDate, money, splitGross } from '@berelax/core'
import {
  type Actor,
  applyPaymentIntentMovement,
  createConnection,
  readSettlementTies,
  readSettlementVariances,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { FIXTURE_ISSUER, SUPPLIER_FIXTURE_PREFIX } from '@berelax/fixtures'
import { beforeAll, describe, expect, it } from 'vitest'
import { JOB_REGISTRY } from '../registry.ts'
import {
  importSettlementFile,
  SETTLEMENT_IMPORT_JOB,
  type SettlementImportData,
  type SettlementImportLine,
  settlementEntryId,
} from './settlement-import.ts'

/**
 * Y-PAY-09 — one gateway payout file imported against real PostgreSQL.
 *
 * The arithmetic is proved without a database by `packages/core/src/payments/settlement.test.ts` and its
 * property sibling, and the schema's seven refusals by `packages/fixtures/src/settlement.itest.ts`. This
 * file proves the five things that are properties of the IMPORT and of nothing else — each one an
 * acceptance line that cannot be made without a ledger behind it.
 *
 * ## The fixture, and the provenance of every figure in it
 *
 * **There is no real settlement file in this build and there cannot be one: no gateway has been chosen
 * (OPEN-QUESTIONS `Y7-gateway`), there is no merchant account and no MCC (`Y7-mcc`), and no acquirer fee
 * rate is on file (`Y7-card-fee`).** So this suite builds a ticket the way the till builds one, and then
 * writes the payout file an acquirer WOULD have sent for it:
 *
 * - **the capture and the tip** come from a real checkout-shaped fixture: an invoice of
 *   `TREATMENT_GROSS` fils, a `checkout_finalisation` entry crediting `2040 Tips payable` with
 *   `TIP_FILS`, and one `card_online` `payment` whose `reference` is the gateway intent id — which is
 *   what `TENDER_TYPES.card_online` says that column is for. So the file's capture line and tip line are
 *   checked against figures this build produced, not against figures this suite chose;
 * - **the refund** is a real `refunded` transaction on the intent, so the refund line is checked against
 *   the append-only rows;
 * - **the chargeback** is a real `chargeback` row of kind `received`, so the chargeback line is checked
 *   against Y-PAY-08's own record;
 * - **the fee is `FEE_FILS` and is NOT derived from any rate.** It is not a percentage of anything, it
 *   carries no interchange figure and no MCC. A fee computed from a rate would be a rate this build
 *   invented and the test it fed would be a test of the invention (brief rule 15);
 * - **the processor is a supplier row this suite creates, prefixed `FIXTURE (not a real supplier) —`**,
 *   with an offshore `supplier_tax_profile`. No vendor is named;
 * - **the settlement date is the capture's trading day plus two**, which is the D+2 acceptance line, and
 *   NOTHING anywhere derives one from the other: both are constants here and the importer never computes
 *   a delay.
 *
 * ## Isolation (brief rule 12)
 *
 * Nothing here can be deleted: `payment_intent_transaction` refuses DELETE for every role (`ZY161`),
 * `journal_entry` refuses it (`ZL001`), `invoice` refuses it, and `settlement_batch` refuses it
 * (`ZY441`). So every reference, idempotency key, invoice number and content hash carries a per-run
 * nonce, there is no truncate anywhere in this file, and every assertion is about rows this run created —
 * `readSettlementVariances` is read filtered to this run's batch ids rather than as a whole table.
 *
 * No customer or therapist is named (brief rule 10): the customer label is `Customer 0042`, which is
 * `packages/fixtures/src/synthetic.ts`' own spelling.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql
let nonce: string

/** The trading day the card was taken, and the day the acquirer paid. Two constants, never derived. */
const CAPTURE_DAY = '2099-12-01'
const SETTLED_ON = '2099-12-03'

const TREATMENT_GROSS = 21_000
const TIP_FILS = 2_000
/** The whole card tender: the document plus the gratuity, which is what `settleTenders` applies. */
const TENDER_FILS = TREATMENT_GROSS + TIP_FILS
const REFUND_FILS = 5_000
const CHARGEBACK_FILS = 3_000
/** The acquirer's charge for the batch. A figure this suite states; no rate exists to derive one. */
const FEE_FILS = 1_000

const ACTOR: Actor = { kind: 'staff', label: 'Y-PAY-09 settlement import itest' }

interface Ticket {
  readonly intentId: string
  readonly gatewayIntentId: string
  readonly invoiceId: string
}

const run = (suffix: string): string => `YPAY09-${nonce}-${suffix}`

/**
 * A document number unique to this run AND to this ticket.
 *
 * `invoice_series_period_number_unique` covers (series, period, number), and the first version of this
 * helper keyed only on the run — so the second ticket collided with the first. The suffix is folded in,
 * which is also why each ticket has one.
 */
const invoiceNumberFor = (suffix: string): number => {
  let hash = 0
  for (const character of `${nonce}-${suffix}`) hash = (hash * 31 + character.charCodeAt(0)) % 8_999
  return 900_000 + hash
}

/**
 * A whole till ticket: invoice, its line, its checkout entry crediting `2040`, one `card_online` tender,
 * and the gateway intent the tender's reference names.
 *
 * One transaction, because `assert_invoice_totals_match_lines` and `payment_within_the_document` are both
 * deferred: a bare INSERT autocommits, so the invoice would be judged with no lines and the payment with
 * no gratuity on the entry it is being measured against.
 */
async function ticket(suffix: string, tipFils: number): Promise<Ticket> {
  const gatewayIntentId = run(`${suffix}-GW`)
  const split = splitGross(money(filsFrom(TREATMENT_GROSS)))
  const entry = run(`${suffix}-CHK`)

  const [customer] = await sql<
    { id: string }[]
  >`select id from customer order by created_at limit 1`
  if (customer === undefined) throw new Error('the seed holds no customer — run `pnpm seed` first')

  const invoiceId = await sql.begin(async (tx) => {
    const [made] = await tx<{ id: string }[]>`
      insert into invoice (
        document_kind, series_code, period_key, number, display_number, issuer_legal_name,
        issuer_trading_name, issuer_trn, issuer_address_snapshot, issuer_emirate,
        customer_id, customer_name_snapshot, issue_date, issue_trading_date, tax_point_date,
        net_total, vat_total, gross_total
      ) values (
        'tax_invoice', 'TAX-INV', '2099', ${invoiceNumberFor(suffix)},
        ${run(`${suffix}-INV`)},
        ${FIXTURE_ISSUER.legalName}, ${FIXTURE_ISSUER.tradingName}, ${FIXTURE_ISSUER.trn},
        ${FIXTURE_ISSUER.addressLines.join('\n')}, ${FIXTURE_ISSUER.emirate},
        ${customer.id}::uuid, 'Customer 0042',
        ${CAPTURE_DAY}::date, ${CAPTURE_DAY}::date, ${CAPTURE_DAY}::date,
        ${split.net.fils}, ${split.vat.fils}, ${TREATMENT_GROSS}
      )
      returning id
    `
    if (made === undefined) throw new Error('inserting the fixture invoice returned no row')
    await tx`
      insert into invoice_line (
        invoice_id, line_no, description_en, quantity, unit_gross_fils, vat_rate_bp, line_net_fils,
        line_vat_fils
      ) values (
        ${made.id}::uuid, 1, 'Treatment (Y-PAY-09 fixture)', 1, ${TREATMENT_GROSS},
        ${split.rateBp}, ${split.net.fils}, ${split.vat.fils}
      )
    `
    // The checkout's own entry. The 2040 credit IS the figure a settlement tip line is checked against —
    // `invoice_payable_fils()` reads it, so this is the authority rather than a second copy of the tip.
    await tx`
      insert into journal_entry (entry_id, entry_date, narrative, source)
      values (${entry}, ${CAPTURE_DAY}::date, 'Y-PAY-09 fixture checkout', 'sale')
    `
    const lines: readonly [string, number, number][] = [
      [ACCOUNTS.gatewayClearing, TENDER_FILS, 0],
      [ACCOUNTS.treatmentRevenue, 0, split.net.fils],
      [ACCOUNTS.outputVatPayable, 0, split.vat.fils],
      ...(tipFils > 0
        ? ([[ACCOUNTS.tipsPayable, 0, tipFils]] as readonly [string, number, number][])
        : []),
    ]
    for (const [index, line] of lines.entries()) {
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils, memo)
        values (${entry}, ${index + 1}, ${line[0]}, ${line[1]}, ${line[2]}, 'Y-PAY-09 fixture')
      `
    }
    await tx`
      insert into checkout_finalisation (
        idempotency_key, request_fingerprint, basket_id, invoice_id, journal_entry_id, trading_date,
        tender_total_fils
      ) values (
        ${run(`${suffix}-CF`)}, ${run(`${suffix}-FP`)}, ${run(`${suffix}-BK`)}, ${made.id}::uuid,
        ${entry}, ${CAPTURE_DAY}::date, ${TREATMENT_GROSS + tipFils}
      )
    `
    await tx`
      insert into payment (
        invoice_id, tender_no, tender_kind, posting_account_code, amount_fils, reference, trading_date
      ) values (
        ${made.id}::uuid, 1, 'card_online', ${ACCOUNTS.gatewayClearing},
        ${TREATMENT_GROSS + tipFils}, ${gatewayIntentId}, ${CAPTURE_DAY}::date
      )
    `
    return made.id
  })

  // The intent, and its movements through the one path ADR 0056 permits.
  const [row] = await sql<{ id: string }[]>`
    insert into payment_intent (
      idempotency_key, gateway, gateway_intent_id, instrument, posting_account_code, requested_fils,
      reference
    ) values (
      ${run(`${suffix}-IK`)}, 'gateway-not-chosen', ${gatewayIntentId}, 'card_online',
      ${ACCOUNTS.gatewayClearing}, ${TREATMENT_GROSS + tipFils}, ${run(`${suffix}-REF`)}
    )
    returning id
  `
  if (row === undefined) throw new Error('inserting the fixture intent returned no row')
  const intentId = row.id
  const captured = TREATMENT_GROSS + tipFils
  for (const movement of [
    { event: 'authorised' as const, state: 'authorised', captured: 0, at: 'T19:00:00+04:00' },
    { event: 'captured' as const, state: 'captured', captured, at: 'T19:05:00+04:00' },
  ]) {
    await withUnitOfWork(sql, ACTOR, async (uow) => {
      await applyPaymentIntentMovement(uow, {
        paymentIntentId: intentId,
        gatewayEventId: run(`${suffix}-${movement.event}`),
        gatewayEventType: movement.event,
        amountFils: captured,
        occurredAt: new Date(`${CAPTURE_DAY}${movement.at}`),
        idempotencyKey: run(`${suffix}-IK-${movement.event}`),
        state: movement.state,
        authorisedFils: captured,
        capturedFils: movement.captured,
        refundedFils: 0,
      })
    })
  }

  return { intentId, gatewayIntentId, invoiceId }
}

/** A real refund movement, so the refund line is checked against the append-only rows. */
async function refundOn(ticketRow: Ticket, suffix: string, fils: number): Promise<void> {
  const captured = TREATMENT_GROSS + TIP_FILS
  await withUnitOfWork(sql, ACTOR, async (uow) => {
    await applyPaymentIntentMovement(uow, {
      paymentIntentId: ticketRow.intentId,
      gatewayEventId: run(`${suffix}-REFUND`),
      gatewayEventType: 'refunded',
      amountFils: fils,
      occurredAt: new Date(`${CAPTURE_DAY}T20:00:00+04:00`),
      idempotencyKey: run(`${suffix}-IK-REFUND`),
      state: 'captured',
      authorisedFils: captured,
      capturedFils: captured,
      refundedFils: fils,
    })
  })
}

/** A real `received` chargeback with its own entry, so the chargeback line is checked against the row. */
async function disputeOn(ticketRow: Ticket, suffix: string, fils: number): Promise<string> {
  const disputeRef = run(`${suffix}-DISPUTE`)
  const entry = run(`${suffix}-CB`)
  await sql.begin(async (tx) => {
    await tx`
      insert into journal_entry (entry_id, entry_date, narrative, source)
      values (${entry}, ${CAPTURE_DAY}::date, 'Y-PAY-09 fixture chargeback received', 'adjustment')
    `
    await tx`
      insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils, memo)
      values (${entry}, 1, ${ACCOUNTS.disputedCardReceipts}, ${fils}, 0, 'Y-PAY-09 fixture'),
             (${entry}, 2, ${ACCOUNTS.gatewayClearing}, 0, ${fils}, 'Y-PAY-09 fixture')
    `
    await tx`
      insert into chargeback (
        payment_intent_id, dispute_ref, kind, amount_fils, received_at, trading_date, journal_entry_id
      ) values (
        ${ticketRow.intentId}::uuid, ${disputeRef}, 'received', ${fils},
        ${`${CAPTURE_DAY}T21:00:00+04:00`}::timestamptz, ${CAPTURE_DAY}::date, ${entry}
      )
    `
  })
  return disputeRef
}

/**
 * The processor, as a supplier row nobody can mistake for a vendor, with an offshore profile.
 *
 * One transaction, because `supplier_has_tax_profile` is a DEFERRED constraint trigger: a supplier with
 * no profile cannot commit at all. That is 0039's answer to the same question this unit asks about the
 * fee - the treatment is not optional and its absence is not a default.
 *
 * The legal name carries `SUPPLIER_FIXTURE_PREFIX`, which is what that constant exists for: no card
 * processor has been chosen (`Y7-gateway`) and a plausible vendor name here would be indistinguishable
 * from a configured one (brief rule 15).
 */
async function offshoreProcessor(suffix: string): Promise<string> {
  return await sql.begin(async (tx) => {
    const [row] = await tx<{ supplier_id: string }[]>`
      insert into supplier (code, legal_name)
      values (
        ${`ypay09-${nonce}-${suffix}`.toLowerCase()},
        ${`${SUPPLIER_FIXTURE_PREFIX} card processor`}
      )
      returning supplier_id
    `
    if (row === undefined) throw new Error('inserting the fixture supplier returned no row')
    await tx`
      insert into supplier_tax_profile (supplier_id, residency, place_of_supply_rule)
      values (${row.supplier_id}::uuid, 'offshore', 'imported_services_reverse_charge')
    `
    return row.supplier_id
  })
}

const fileFor = (input: {
  readonly suffix: string
  readonly lines: readonly SettlementImportLine[]
  readonly declaredNetFils: number
  readonly feeSupplierId?: string
}): SettlementImportData => ({
  batchReference: run(`${input.suffix}-BATCH`),
  // A digest of the BYTES in production. Here a per-run, per-case constant of the right shape, and
  // HEX-ENCODED rather than sanitised: the first version lower-cased the label and replaced every
  // character outside `[0-9a-f]`, which collapsed suffixes `G` and `H` to the same string and made the
  // last case report `already_imported` about a file it had never seen. Hex of the bytes is injective.
  contentSha256: Buffer.from(`${nonce}-${input.suffix}`, 'utf8')
    .toString('hex')
    .padEnd(64, '0')
    .slice(0, 64),
  settledOn: SETTLED_ON,
  declaredNetFils: input.declaredNetFils,
  lines: input.lines,
  ...(input.feeSupplierId === undefined ? {} : { feeSupplierId: input.feeSupplierId }),
})

/**
 * One entry's lines, with the fils as NUMBERS.
 *
 * `Number(...)` and not a bare read: `createConnection` maps `bigint` to a string so nothing rounds a
 * money figure, so `toBe(14_000)` against a raw column fails with `expected '14000' to be 14000`. That is
 * exactly how the repository's own missing conversion was found on this suite's first run.
 */
const entryLines = async (
  entryId: string,
): Promise<readonly { account: string; debit: number; credit: number }[]> => {
  const rows = await sql<{ account: string; debit: string; credit: string }[]>`
    select account_code as account, debit_fils::bigint as debit, credit_fils::bigint as credit
      from journal_line where entry_id = ${entryId} order by line_no
  `
  return rows.map((row) => ({
    account: row.account,
    debit: Number(row.debit),
    credit: Number(row.credit),
  }))
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 6 })
  nonce = Math.random().toString(36).slice(2, 10)
  // `payment.trading_date` and `chargeback.trading_date` both reference `business_day`, and 0135's
  // `ZY432` resolves a dispute's day from the session containing its instant — so the session has to
  // exist and has to span 21:00 on the capture day.
  for (const [day, next] of [
    [CAPTURE_DAY, '2099-12-02'],
    [SETTLED_ON, '2099-12-04'],
  ] as const) {
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (
        ${day}::date, ${`${day} 11:00:00+04`}::timestamptz, ${`${next} 02:00:00+04`}::timestamptz,
        'weekly'
      )
      on conflict (trading_date) do nothing
    `
  }
}, 60_000)

describe('the job registration', () => {
  it('is a queue with no cron and therefore no agent', () => {
    const job = JOB_REGISTRY.find((candidate) => candidate.name === SETTLEMENT_IMPORT_JOB)
    expect(job, 'the settlement importer is not in the registry').toBeDefined()
    // Both halves: a cron would demand an agent row, and claiming an agent without a cron would be an
    // agent the watchdog expects to hear from on no schedule.
    expect(job?.cron).toBeUndefined()
    expect(job?.agent).toBeUndefined()
    expect(job?.purpose.length).toBeGreaterThan(40)
  })
})

describe('importing a reconciled payout', () => {
  it('reconciles a capture, a partial refund, a chargeback, a card tip and a fee to the fils, and posts', async () => {
    const row = await ticket('A', TIP_FILS)
    await refundOn(row, 'A', REFUND_FILS)
    const disputeRef = await disputeOn(row, 'A', CHARGEBACK_FILS)
    const supplier = await offshoreProcessor('A')

    const lines: SettlementImportLine[] = [
      { lineNo: 1, kind: 'capture', reference: row.gatewayIntentId, amountFils: TREATMENT_GROSS },
      { lineNo: 2, kind: 'tip', reference: row.gatewayIntentId, amountFils: TIP_FILS },
      { lineNo: 3, kind: 'refund', reference: row.gatewayIntentId, amountFils: REFUND_FILS },
      { lineNo: 4, kind: 'chargeback', reference: disputeRef, amountFils: CHARGEBACK_FILS },
      { lineNo: 5, kind: 'fee', reference: run('A-BATCH'), amountFils: FEE_FILS },
    ]
    const declaredNetFils = TREATMENT_GROSS + TIP_FILS - REFUND_FILS - CHARGEBACK_FILS - FEE_FILS

    // The ties first, asserted on their own: this is the half the fixture's provenance rests on, and
    // without it a reconciliation could be passing because every local figure came back null.
    const ties = await readSettlementTies(
      sql,
      lines.map((line) => ({ kind: line.kind, reference: line.reference })),
    )
    const tieFor = (kind: string): number | null | undefined =>
      ties.find((tie) => tie.kind === kind)?.localFils
    expect(tieFor('capture')).toBe(TREATMENT_GROSS)
    expect(tieFor('tip')).toBe(TIP_FILS)
    expect(tieFor('refund')).toBe(REFUND_FILS)
    expect(tieFor('chargeback')).toBe(CHARGEBACK_FILS)
    // A fee ties to nothing, and ZY444 requires it to.
    expect(tieFor('fee')).toBeNull()

    const outcome = await importSettlementFile(
      { sql, now: () => `${SETTLED_ON}T09:00:00+04:00` },
      fileFor({ suffix: 'A', lines, declaredNetFils, feeSupplierId: supplier }),
    )
    expect(outcome.kind).toBe('posted')
    if (outcome.kind !== 'posted') return

    const [batch] = await sql<{ state: string; variances: number }[]>`
        select b.state,
               (select count(*)::int from settlement_variance v where v.batch_id = b.id) as variances
          from settlement_batch b where b.id = ${outcome.batchId}::uuid
      `
    expect(batch?.state).toBe('posted')
    expect(batch?.variances).toBe(0)

    const posted = await entryLines(outcome.journalEntryId)
    const bank = posted.find((line) => line.account === ACCOUNTS.bankCurrent)
    expect(bank?.debit).toBe(declaredNetFils)
    const clearing = posted.find((line) => line.account === ACCOUNTS.gatewayClearing)
    expect(clearing?.credit).toBe(TREATMENT_GROSS + TIP_FILS - REFUND_FILS - CHARGEBACK_FILS)
    expect(
      posted.reduce((total, line) => total + line.debit - line.credit, 0),
      'the settlement entry does not balance',
    ).toBe(0)
  }, 30_000)

  it('posts the fee as an expense with the reverse-charge pair, and nothing to revenue or tips payable', async () => {
    const row = await ticket('B', TIP_FILS)
    const supplier = await offshoreProcessor('B')
    const lines: SettlementImportLine[] = [
      { lineNo: 1, kind: 'capture', reference: row.gatewayIntentId, amountFils: TREATMENT_GROSS },
      { lineNo: 2, kind: 'tip', reference: row.gatewayIntentId, amountFils: TIP_FILS },
      { lineNo: 3, kind: 'fee', reference: run('B-BATCH'), amountFils: FEE_FILS },
    ]
    const outcome = await importSettlementFile(
      { sql, now: () => `${SETTLED_ON}T09:00:00+04:00` },
      fileFor({
        suffix: 'B',
        lines,
        declaredNetFils: TREATMENT_GROSS + TIP_FILS - FEE_FILS,
        feeSupplierId: supplier,
      }),
    )
    expect(outcome.kind).toBe('posted')
    if (outcome.kind !== 'posted') return

    const posted = await entryLines(outcome.journalEntryId)
    expect(posted.find((line) => line.account === ACCOUNTS.paymentProcessingFees)?.debit).toBe(
      FEE_FILS,
    )
    // 5% of 1,000 fils, stated independently of `reverseChargeOn`'s own arithmetic.
    expect(posted.find((line) => line.account === ACCOUNTS.reverseChargeVatPayable)?.credit).toBe(
      50,
    )
    expect(posted.find((line) => line.account === ACCOUNTS.recoverableInputVat)?.debit).toBe(50)

    // The two accounts a settlement may never reach. Read from the chart rather than listed, so an
    // account added to the revenue group is covered the day it is added.
    const revenue = await sql<{ code: string }[]>`
        select code from account where type = 'revenue'
      `
    expect(revenue.length).toBeGreaterThan(0)
    for (const line of posted) {
      expect(revenue.map((account) => account.code)).not.toContain(line.account)
      expect(line.account).not.toBe(ACCOUNTS.tipsPayable)
    }
    // And the control that makes the claim mean something: the TILL's entry for the same ticket DOES
    // credit 2040 and 4010, so a settlement reaching them would not be a quirk of an empty chart.
    const checkout = await entryLines(run('B-CHK'))
    expect(checkout.find((line) => line.account === ACCOUNTS.tipsPayable)?.credit).toBe(TIP_FILS)
    expect(
      checkout.find((line) => line.account === ACCOUNTS.treatmentRevenue)?.credit,
    ).toBeGreaterThan(0)
  }, 30_000)

  it('settles two days after the capture without moving revenue between business days', async () => {
    const row = await ticket('C', TIP_FILS)
    const supplier = await offshoreProcessor('C')
    const before = await sql<{ net: string }[]>`
        select coalesce(sum(l.credit_fils - l.debit_fils), 0)::text as net
          from journal_line l join journal_entry e on e.entry_id = l.entry_id
          join account a on a.code = l.account_code
         where a.type = 'revenue' and e.entry_date = ${CAPTURE_DAY}::date
      `
    const outcome = await importSettlementFile(
      { sql, now: () => `${SETTLED_ON}T09:00:00+04:00` },
      fileFor({
        suffix: 'C',
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: row.gatewayIntentId,
            amountFils: TREATMENT_GROSS,
          },
          { lineNo: 2, kind: 'tip', reference: row.gatewayIntentId, amountFils: TIP_FILS },
          { lineNo: 3, kind: 'fee', reference: run('C-BATCH'), amountFils: FEE_FILS },
        ],
        declaredNetFils: TREATMENT_GROSS + TIP_FILS - FEE_FILS,
        feeSupplierId: supplier,
      }),
    )
    expect(outcome.kind).toBe('posted')
    if (outcome.kind !== 'posted') return

    const [entry] = await sql<{ entryDate: string }[]>`
        select entry_date::text as "entryDate" from journal_entry
         where entry_id = ${outcome.journalEntryId}
      `
    // The payout's own day, two days after the capture, and the two are independent constants here:
    // nothing in the importer derives a settlement delay.
    expect(entry?.entryDate).toBe(SETTLED_ON)
    expect(SETTLED_ON).not.toBe(CAPTURE_DAY)

    const after = await sql<{ net: string }[]>`
        select coalesce(sum(l.credit_fils - l.debit_fils), 0)::text as net
          from journal_line l join journal_entry e on e.entry_id = l.entry_id
          join account a on a.code = l.account_code
         where a.type = 'revenue' and e.entry_date = ${CAPTURE_DAY}::date
      `
    // A DELTA on the capture day's revenue, because `journal_line` cannot be emptied and other suites
    // have written into it (brief rule 9). The delta is nought: the payout moved no revenue at all.
    expect(Number(after[0]?.net ?? '0') - Number(before[0]?.net ?? '0')).toBe(0)
  }, 30_000)
})

describe('refusing to post', () => {
  it('quarantines a batch whose capture line is one fils out, names the line, and posts nothing', async () => {
    const row = await ticket('D', TIP_FILS)
    const supplier = await offshoreProcessor('D')
    const lines: SettlementImportLine[] = [
      {
        lineNo: 1,
        kind: 'capture',
        reference: row.gatewayIntentId,
        // ONE fils. The whole acceptance line: there is no tolerance this can fall inside.
        amountFils: TREATMENT_GROSS + 1,
      },
      { lineNo: 2, kind: 'tip', reference: row.gatewayIntentId, amountFils: TIP_FILS },
      { lineNo: 3, kind: 'fee', reference: run('D-BATCH'), amountFils: FEE_FILS },
    ]
    const outcome = await importSettlementFile(
      { sql, now: () => `${SETTLED_ON}T09:00:00+04:00` },
      fileFor({
        suffix: 'D',
        lines,
        declaredNetFils: TREATMENT_GROSS + 1 + TIP_FILS - FEE_FILS,
        feeSupplierId: supplier,
      }),
    )
    expect(outcome.kind).toBe('quarantined')
    if (outcome.kind !== 'quarantined') return

    const [batch] = await sql<{ state: string; journalEntryId: string | null }[]>`
        select state, journal_entry_id as "journalEntryId"
          from settlement_batch where id = ${outcome.batchId}::uuid
      `
    expect(batch?.state).toBe('quarantined')
    expect(batch?.journalEntryId).toBeNull()

    const variances = (await readSettlementVariances(sql)).filter(
      (variance) => variance.batchId === outcome.batchId,
    )
    const named = variances.find((variance) => variance.kind === 'amount_disagrees')
    expect(named, 'no variance named the offending line').toBeDefined()
    expect(named?.lineNo).toBe(1)
    expect(named?.differenceFils).toBe(1)
    expect(named?.explanation).toContain(row.gatewayIntentId)

    // Nothing was posted: the deterministic entry id this batch WOULD have used does not exist.
    const [entry] = await sql<{ n: string }[]>`
        select count(*)::text as n from journal_entry
         where entry_id = ${
           settlementEntryId(
             fileFor({ suffix: 'D', lines, declaredNetFils: 0 }).contentSha256,
           ) as string
         }
      `
    expect(entry?.n).toBe('0')

    // And the alert, in the same transaction — ZY446 would have refused the commit otherwise, so this
    // asserts that the row the rule demands is the row that is there.
    const [audit] = await sql<{ n: string }[]>`
        select count(*)::text as n from audit_event
         where entity_type = 'settlement_batch' and entity_id = ${outcome.batchId}
           and action = 'settlement.quarantined'
      `
    expect(audit?.n).toBe('1')
  }, 30_000)

  it('quarantines a line nothing local answers to rather than force-matching it', async () => {
    const supplier = await offshoreProcessor('F2')
    const orphan = run('E-ORPHAN')
    const outcome = await importSettlementFile(
      { sql, now: () => `${SETTLED_ON}T09:00:00+04:00` },
      fileFor({
        suffix: 'E',
        lines: [
          { lineNo: 1, kind: 'capture', reference: orphan, amountFils: TREATMENT_GROSS },
          { lineNo: 2, kind: 'fee', reference: run('E-BATCH'), amountFils: FEE_FILS },
        ],
        declaredNetFils: TREATMENT_GROSS - FEE_FILS,
        feeSupplierId: supplier,
      }),
    )
    expect(outcome.kind).toBe('quarantined')
    if (outcome.kind !== 'quarantined') return
    const variances = (await readSettlementVariances(sql)).filter(
      (variance) => variance.batchId === outcome.batchId,
    )
    expect(variances.map((variance) => variance.kind)).toContain('no_local_record')
    expect(variances.find((variance) => variance.kind === 'no_local_record')?.localFils).toBeNull()
  }, 30_000)

  it('quarantines a fee the import names no supplier for, rather than guessing domestic', async () => {
    const row = await ticket('F', TIP_FILS)
    const outcome = await importSettlementFile(
      { sql, now: () => `${SETTLED_ON}T09:00:00+04:00` },
      fileFor({
        suffix: 'F',
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: row.gatewayIntentId,
            amountFils: TREATMENT_GROSS,
          },
          { lineNo: 2, kind: 'tip', reference: row.gatewayIntentId, amountFils: TIP_FILS },
          { lineNo: 3, kind: 'fee', reference: run('F-BATCH'), amountFils: FEE_FILS },
        ],
        declaredNetFils: TREATMENT_GROSS + TIP_FILS - FEE_FILS,
        // No `feeSupplierId`. A supplier row with NO tax profile cannot exist at all - 0039's
        // `supplier_has_tax_profile` is a deferred constraint trigger - so the reachable absence is this
        // one: the import does not say whose fee it is.
      }),
    )
    // Every LINE ties. The only thing wrong is that nobody has said whether the fee self-accounts, and
    // defaulting to domestic drops the reverse charge on every offshore batch while the return balances.
    expect(outcome.kind).toBe('quarantined')
    if (outcome.kind !== 'quarantined') return
    const variances = (await readSettlementVariances(sql)).filter(
      (variance) => variance.batchId === outcome.batchId,
    )
    expect(variances).toHaveLength(1)
    expect(variances[0]?.kind).toBe('unattributable')
    expect(variances[0]?.lineNo).toBeNull()
    expect(variances[0]?.explanation).toContain('names no supplier')
  }, 30_000)
})

describe('re-importing', () => {
  it('is a no-op by content hash: the same batch id, no second entry and no second audit row', async () => {
    const row = await ticket('G', TIP_FILS)
    const supplier = await offshoreProcessor('G')
    const data = fileFor({
      suffix: 'G',
      lines: [
        { lineNo: 1, kind: 'capture', reference: row.gatewayIntentId, amountFils: TREATMENT_GROSS },
        { lineNo: 2, kind: 'tip', reference: row.gatewayIntentId, amountFils: TIP_FILS },
        { lineNo: 3, kind: 'fee', reference: run('G-BATCH'), amountFils: FEE_FILS },
      ],
      declaredNetFils: TREATMENT_GROSS + TIP_FILS - FEE_FILS,
      feeSupplierId: supplier,
    })
    const first = await importSettlementFile(
      { sql, now: () => `${SETTLED_ON}T09:00:00+04:00` },
      data,
    )
    expect(first.kind).toBe('posted')
    const second = await importSettlementFile(
      { sql, now: () => `${SETTLED_ON}T10:00:00+04:00` },
      data,
    )
    expect(second.kind).toBe('already_imported')
    expect(second.batchId).toBe(first.batchId)

    const [counts] = await sql<{ batches: number; lines: number; audits: number }[]>`
        select (select count(*)::int from settlement_batch
                 where content_sha256 = ${data.contentSha256})                      as batches,
               (select count(*)::int from settlement_line
                 where batch_id = ${first.batchId}::uuid)                           as lines,
               (select count(*)::int from audit_event
                 where entity_type = 'settlement_batch' and entity_id = ${first.batchId}) as audits
      `
    expect(counts?.batches).toBe(1)
    expect(counts?.lines).toBe(3)
    expect(counts?.audits).toBe(1)
  }, 30_000)

  it('treats a file that differs by one fils as a DIFFERENT batch, because the bytes differ', async () => {
    // The control for the case above. A no-op keyed on the batch REFERENCE would make a corrected file
    // under the same reference invisible; keyed on the content, it is a new batch — which here means a
    // new quarantine naming the disagreement rather than silence.
    const row = await ticket('H', TIP_FILS)
    const supplier = await offshoreProcessor('H')
    const lines: SettlementImportLine[] = [
      { lineNo: 1, kind: 'capture', reference: row.gatewayIntentId, amountFils: TREATMENT_GROSS },
      { lineNo: 2, kind: 'tip', reference: row.gatewayIntentId, amountFils: TIP_FILS },
      { lineNo: 3, kind: 'fee', reference: run('H-BATCH'), amountFils: FEE_FILS },
    ]
    const good = fileFor({
      suffix: 'H',
      lines,
      declaredNetFils: TREATMENT_GROSS + TIP_FILS - FEE_FILS,
      feeSupplierId: supplier,
    })
    const first = await importSettlementFile(
      { sql, now: () => `${SETTLED_ON}T09:00:00+04:00` },
      good,
    )
    expect(first.kind).toBe('posted')

    const corrected: SettlementImportData = {
      ...good,
      contentSha256: fileFor({ suffix: 'H2', lines, declaredNetFils: 0 }).contentSha256,
      declaredNetFils: good.declaredNetFils + 1,
    }
    const second = await importSettlementFile(
      { sql, now: () => `${SETTLED_ON}T11:00:00+04:00` },
      corrected,
    )
    expect(second.kind).toBe('quarantined')
    if (second.kind !== 'quarantined') return
    expect(second.batchId).not.toBe(first.batchId)
    const variances = (await readSettlementVariances(sql)).filter(
      (variance) => variance.batchId === second.batchId,
    )
    expect(variances.map((variance) => variance.kind)).toContain('unattributable')
    expect(variances.find((variance) => variance.kind === 'unattributable')?.differenceFils).toBe(1)
  }, 30_000)
})

describe('the figures this build cannot supply', () => {
  it('holds no fee rate, so a fee is never predicted and never checked against one', async () => {
    // The acceptance's negative half, as a structural claim rather than a comment: nothing in the
    // importer or the settlement module mentions a rate, an MCC or a settlement delay. `aedFrom` is
    // referenced so this file's import of it is not dead — the suite's own figures are fils, and a major
    // unit here would be the hundred-times mistake the property suite found in the sibling file.
    expect(aedFrom(1).fils).toBe(100)
    expect(localDate(SETTLED_ON)).toBe(SETTLED_ON)
    const [stored] = await sql<{ n: string }[]>`
      select count(*)::text as n from settlement_line where kind = 'fee' and local_fils is not null
    `
    // ZY444 refuses one, so this is a whole-table assertion that is safe: no row of that shape can exist
    // in any database, written by any suite.
    expect(stored?.n).toBe('0')
  })
})
