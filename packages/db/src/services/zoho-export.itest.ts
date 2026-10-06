import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import type { AppError } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'
import type { Vat201Period } from '../queries/vat201-working-papers.ts'
import { postJournalEntry } from '../repositories/journal.ts'
import { withUnitOfWork } from '../tx.ts'
import { closeAccountingPeriod } from './period-close.ts'
import {
  finaliseVatReturn,
  signOffVatReturn,
  snapshotVatReturn,
  VAT_RETURN_SQLSTATE,
  vatReturnBoxFigures,
} from './vat-return-signoff.ts'
import {
  exportVatReturnForZoho,
  renderZohoVatReturn,
  ZOHO_EXPORT_FORMAT_VERSION,
  ZOHO_EXPORT_SURFACE,
} from './zoho-export.ts'

/**
 * M-VAT-09 — the one-way Zoho Books export: the door it comes through, the figures it states, and the
 * absence of everything else.
 *
 * ## What only real PostgreSQL can show here
 *
 * The export checks nothing. `ZY055` is raised inside `vat_return_for_filing()` — on a READ, which is the
 * only layer that can refuse an operation whose whole content is reading — and `exportVatReturnForZoho`
 * translates it. So a mock would prove the opposite of the claim: it would prove that a function this unit
 * deliberately did not write does not exist. The refusal has to be taken from the database.
 *
 * The reconciliation is the second thing. `zoho-export.test.ts` owns the BYTES against a committed fixture,
 * because a snapshot's hash and engine signature are whatever the database it was taken in held and no
 * byte-exact fixture can be taken against that. What this file owns is the other direction: that the
 * figures in those bytes are the figures of `vat_return_box_figure`, the view over the hashed snapshot, to
 * the fils. Neither claim is provable where the other lives.
 *
 * ## The order is the file's own
 *
 * Group A runs while the return is UNSIGNED, then signs it one signature at a time, then marks it final.
 * There is no way to make a signed return unsigned again — `vat_return_sign_off` is append-only for every
 * role including the owner (`ZY051`) — so the refusals can only be taken before the signatures, and a
 * second return per case would be four snapshots of one period and three amendments to set up. `vitest`
 * runs a file's `describe` blocks in source order and `fileParallelism` is off.
 *
 * ## The window is picked, not fixed
 *
 * `journal_entry` refuses DELETE for every role (`ZL001`), so the entry this suite posts is permanent and a
 * fixed month would double every figure on a second run against the same database — M-TILL-10's recorded
 * defect, which read 430,003 fils where 33,334 was expected. So a virgin month is found inside
 * {@link RESERVED_SPAN}, which is a decade no other suite posts into: M-VAT-08 holds 2120-2139 and
 * `packages/fixtures/src/vat201.ts` holds 2150-2199.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** A decade no other suite posts into. See the header on why it is not a fixed month. */
const RESERVED_SPAN = { from: '2140-01-01', to: '2149-12-31' } as const

const ACTOR = { kind: 'system', label: 'm-vat-09-itest' } as const
const PREFIX = 'MVAT09'
/** Unique per run: the entries this suite posts can never be deleted. */
const RUN = Date.now().toString(36)

const CASH = '1010'
const REVENUE = '4010'
const OUTPUT_VAT = '2030'

/** 21,000 gross is 20,000 net and 1,000 tax — an exact 5% split, so every figure is checkable by eye. */
const SALE_GROSS = 21_000
const SALE_VAT = 1_000

const PREPARER = {
  userId: `${PREFIX}-${RUN}-preparer`,
  displayName: 'Accountant on duty',
  role: 'accountant',
} as const
const REVIEWER = {
  userId: `${PREFIX}-${RUN}-reviewer`,
  displayName: 'Proprietor',
  role: 'owner' as const,
} as const
/**
 * Whoever performs the export. A third person, and deliberately not one of the signatories.
 *
 * The acceptance line asks the audit row to carry "the exporting user", which is a different question from
 * who signed — the person who carries the file to the accountant is usually neither — and a fixture that
 * reused the preparer could not tell the two apart.
 */
const EXPORTER = {
  userId: `${PREFIX}-${RUN}-exporter`,
  displayName: 'Accounts assistant on duty',
} as const

/** Instants, from constants. Nothing in this suite reads an ambient clock. */
const SNAPSHOTTED_AT = '2146-04-01T06:00:00.000Z'
const PREPARED_SIGNED_AT = '2146-04-01T07:00:00.000Z'
const REVIEWED_SIGNED_AT = '2146-04-02T07:00:00.000Z'
const FINALISED_AT = '2146-04-02T08:00:00.000Z'

let sql: Sql
let period: Vat201Period
let returnId = ''

const saleLines = (grossFils: number, vatFils: number) => [
  { accountCode: CASH, debitFils: grossFils, creditFils: 0, memo: 'cash taken' },
  { accountCode: REVENUE, debitFils: 0, creditFils: grossFils - vatFils },
  { accountCode: OUTPUT_VAT, debitFils: 0, creditFils: vatFils },
]

/** The `AppError` a promise rejected with, so `details` can be asserted rather than message text. */
async function refusalOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
    throw new Error('expected a refusal; the call resolved')
  } catch (err) {
    return err as AppError
  }
}

const removeOwnLocks = () => sql`delete from period_lock where period_id like ${`${PREFIX}-%`}`

/** Counted in SQL, never through a capped reader — brief rule 12's third recorded defect. */
async function exportAuditCount(): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event
    where action = 'vat_return.zoho_export' and entity_id = ${returnId}
  `
  return Number(row?.n ?? '-1')
}

const doExport = () =>
  withUnitOfWork(sql, ACTOR, (uow) =>
    exportVatReturnForZoho(uow, { returnId, exportedBy: EXPORTER }),
  )

/** A month inside the reserved span that no journal entry has ever been dated in. */
async function virginMonth(): Promise<Vat201Period> {
  const [row] = await sql<{ used: string | null }[]>`
    select max(entry_date)::text as used
    from journal_entry
    where entry_date between ${RESERVED_SPAN.from}::date and ${RESERVED_SPAN.to}::date
  `
  const used = row?.used ?? null
  const year = used === null ? Number(RESERVED_SPAN.from.slice(0, 4)) : Number(used.slice(0, 4))
  const month = used === null ? 1 : Number(used.slice(5, 7)) + 1
  const rolled = month > 12 ? { year: year + 1, month: 1 } : { year, month }
  const mm = String(rolled.month).padStart(2, '0')
  const lastDay = new Date(Date.UTC(rolled.year, rolled.month, 0)).getUTCDate()
  const startsOn = `${rolled.year}-${mm}-01`
  const endsOn = `${rolled.year}-${mm}-${String(lastDay).padStart(2, '0')}`
  if (endsOn > RESERVED_SPAN.to) {
    throw new Error(
      `The M-VAT-09 suite needs a month with no journal entry in it, and ${RESERVED_SPAN.from}..` +
        `${RESERVED_SPAN.to} is used up to ${used}. The journal is append-only and refuses the owner, so ` +
        'the entries cannot be removed: run against a fresh database, or widen RESERVED_SPAN into a ' +
        'decade no other suite posts into. Wrapping round would land on a month that already holds a ' +
        'previous run and every figure asserted below would read double.',
    )
  }
  return { periodId: `${PREFIX}-${rolled.year}-${mm}`, startsOn, endsOn }
}

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  // Defensive: a previous run killed between its cases leaves its locks behind, and
  // `period_lock_no_overlap` would then refuse this run's close for a reason unrelated to it.
  await removeOwnLocks()
  period = await virginMonth()

  await withUnitOfWork(sql, ACTOR, (uow) =>
    postJournalEntry(uow, {
      entryId: `JE-${PREFIX}-${RUN}-SALE`,
      entryDate: `${period.startsOn.slice(0, 7)}-15`,
      narrative: 'Aromatherapy 60 min, cash',
      source: 'sale',
      lines: saleLines(SALE_GROSS, SALE_VAT),
    }),
  )
  await withUnitOfWork(sql, ACTOR, (uow) =>
    closeAccountingPeriod(uow, {
      periodId: period.periodId,
      startsOn: period.startsOn,
      endsOn: period.endsOn,
      reason: 'M-VAT-09: the export is taken from a signed snapshot of a closed period',
      closedByActorKind: 'system',
    }),
  )
  const snapshot = await withUnitOfWork(sql, ACTOR, (uow) =>
    snapshotVatReturn(uow, {
      period,
      preparedBy: { kind: 'system', label: ACTOR.label },
      snapshottedAt: SNAPSHOTTED_AT,
    }),
  )
  returnId = snapshot.id
})

afterAll(async () => {
  // By `period_id` prefix, so it can only ever remove locks this suite took. Not tidiness:
  // `period_lock_no_overlap` would refuse a second run against the same database.
  await removeOwnLocks()
  await sql.end()
})

// --- A. an unsigned return produces a refusal and no file ---------------------------------------

describe('the export is refused until two different people have signed and it is final', () => {
  it('refuses an unsigned return by name and by SQLSTATE, and writes nothing', async () => {
    const before = await exportAuditCount()
    expect(before).toBe(0)
    const refusal = await refusalOf(doExport())
    // The name the acceptance line calls ReturnNotSigned. M-VAT-08 shipped this refusal as
    // VatReturnNotSignedOff and this unit does not add a second class for one rule — see the manifest NOTE.
    expect(refusal.name).toBe('VatReturnNotSignedOff')
    // And the SQLSTATE, because "an error was raised" would pass just as happily for a typo in a column
    // name, which is how a test for a trigger ends up testing nothing.
    expect(refusal.details['sqlState']).toBe(VAT_RETURN_SQLSTATE.notSignedOff)
    // "and no file": nothing produced, and nothing recorded. A refusal that still wrote the audit row
    // would make the trail say an export happened that nobody received.
    expect(await exportAuditCount()).toBe(0)
  })

  it('still refuses when only the preparer has signed', async () => {
    await withUnitOfWork(sql, ACTOR, (uow) =>
      signOffVatReturn(uow, {
        returnId,
        capacity: 'preparer',
        signatory: PREPARER,
        signedAt: PREPARED_SIGNED_AT,
      }),
    )
    const refusal = await refusalOf(doExport())
    expect(refusal.name).toBe('VatReturnNotSignedOff')
    expect(refusal.details['sqlState']).toBe(VAT_RETURN_SQLSTATE.notSignedOff)
    expect(await exportAuditCount()).toBe(0)
  })

  it('still refuses when both have signed and nobody has marked it final', async () => {
    await withUnitOfWork(sql, ACTOR, (uow) =>
      signOffVatReturn(uow, {
        returnId,
        capacity: 'reviewer',
        signatory: REVIEWER,
        signedAt: REVIEWED_SIGNED_AT,
      }),
    )
    // Two signatures is not the whole condition, and this is the case that says so. `ZY055` covers both
    // halves, so without this the suite could not tell "signed" from "signed and final".
    const refusal = await refusalOf(doExport())
    expect(refusal.name).toBe('VatReturnNotSignedOff')
    expect(refusal.message).toContain('Marked final: no')
    expect(await exportAuditCount()).toBe(0)
  })

  it('enumerates the paths that require a signed return, and each one was refused above', async () => {
    // The acceptance criterion's enumeration, made behavioural: every entry classified as requiring a
    // signature has a case above that took the refusal from the database. A second entry arriving without
    // one fails here rather than passing silently — the device M-VAT-08's gate case 122q uses.
    const gated = ZOHO_EXPORT_SURFACE.filter((entry) => entry.requiresSignedReturn).map(
      (entry) => entry.export,
    )
    expect(gated).toEqual(['exportVatReturnForZoho'])
    // The control: the unsigned refusals above are real, so the same call must now SUCCEED once the return
    // is final. Without it the three cases above are satisfied by an export that never works at all.
    await withUnitOfWork(sql, ACTOR, (uow) =>
      finaliseVatReturn(uow, {
        returnId,
        finalisedAt: FINALISED_AT,
        actor: { kind: 'system', label: ACTOR.label },
      }),
    )
    const exported = await doExport()
    expect(exported.byteLength).toBeGreaterThan(200)
  })
})

// --- B. the bytes, the hash and the audit row ----------------------------------------------------

describe('every export produces bytes and an audit row that identifies them', () => {
  it('hashes exactly the bytes it hands back', async () => {
    const exported = await doExport()
    const recomputed = createHash('sha256').update(exported.bytes).digest('hex')
    expect(exported.fileHash).toBe(recomputed)
    expect(exported.byteLength).toBe(exported.bytes.byteLength)
    expect(exported.mediaType).toBe('text/csv')
    // The control: a hash of one byte more must NOT be it. Without this the case passes for a constant.
    const perturbed = createHash('sha256')
      .update(new Uint8Array([...exported.bytes, 0x20]))
      .digest('hex')
    expect(perturbed).not.toBe(exported.fileHash)
  })

  it('exports the same signed return to the same bytes every time', async () => {
    const first = await doExport()
    const second = await doExport()
    // The property the recorded file hash depends on: nothing in the file is an instant or a person, so
    // "is this the file we handed over" has an answer. An `exported_at` column would make every export a
    // different artefact and the hash an identifier for nothing.
    expect(second.fileHash).toBe(first.fileHash)
    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true)
    expect(second.filename).toBe(first.filename)
  })

  it('writes one audit row per export, carrying the user, the version and the file hash', async () => {
    const before = await exportAuditCount()
    const exported = await doExport()
    // A DELTA, never a total: `audit_event` is append-only (ADR 0008) and earlier cases in this file have
    // already written rows.
    expect(await exportAuditCount()).toBe(before + 1)

    const [row] = await sql<
      { operation: string; actor_label: string | null; after_state: Record<string, unknown> }[]
    >`
      select operation, actor_label, after_state
      from audit_event
      where action = 'vat_return.zoho_export' and entity_id = ${returnId}
      order by occurred_at desc, id desc
      limit 1
    `
    expect(row?.operation).toBe('export')
    expect(row?.actor_label).toBe(ACTOR.label)
    // The three things the acceptance line names, out of the row rather than out of the return value.
    expect(row?.after_state['exportedByUserId']).toBe(EXPORTER.userId)
    expect(row?.after_state['exportedByDisplayName']).toBe(EXPORTER.displayName)
    expect(row?.after_state['returnVersion']).toBe(exported.version)
    expect(row?.after_state['fileHash']).toBe(exported.fileHash)
    // And the snapshot's hash beside the file's, which is what ties the bytes to the signed figures.
    expect(row?.after_state['contentHash']).toBe(exported.contentHash)
    expect(row?.after_state['exportFormatVersion']).toBe(ZOHO_EXPORT_FORMAT_VERSION)
    // The control: the two hashes answer different questions and must not be the same value.
    expect(row?.after_state['fileHash']).not.toBe(row?.after_state['contentHash'])
  })
})

// --- C. the figures in the file are the figures of the signed snapshot ---------------------------

describe('the totals reconcile to the snapshot box figures, to the fils', () => {
  it('agrees with vat_return_box_figure row for row', async () => {
    const exported = await doExport()
    const csv = new TextDecoder().decode(exported.bytes)
    const figures = await vatReturnBoxFigures(sql, returnId)
    expect(figures.length).toBeGreaterThanOrEqual(3)
    for (const figure of figures) {
      // The exact row the file states for this box, assembled from the view. A comparison of totals alone
      // would pass for a file that had two boxes' figures swapped.
      const expected =
        `${figure.boxNo},${figure.label},${figure.side},${figure.netSuppliesFils},` +
        `${figure.taxFils},${figure.lineCount},${figure.isProvisional},`
      expect(csv).toContain(expected)
    }
    // The control: a figure ONE FILS out is not in the file. Without it this case passes for any file
    // containing the digits by coincidence.
    const first = figures[0]
    if (first === undefined) throw new Error('the snapshot has no boxes to reconcile')
    expect(csv).not.toContain(
      `${first.boxNo},${first.label},${first.side},${first.netSuppliesFils},${first.taxFils + 1n},`,
    )
  })

  it('states side totals equal to the view summed in SQL', async () => {
    const exported = await doExport()
    const csv = new TextDecoder().decode(exported.bytes)
    const rows = await sql<{ side: string; net: string; tax: string }[]>`
      select side, sum(net_supplies_fils)::text as net, sum(tax_fils)::text as tax
      from vat_return_box_figure
      where return_id = ${returnId}::uuid
      group by side
    `
    const bySide = new Map(rows.map((row) => [row.side, row]))
    const output = bySide.get('output')
    const input = bySide.get('input')
    // Summed in SQL over the view, which reaches no ledger table (0095) — so this compares the file with
    // the hashed snapshot and not with the journal. Two independent paths to one figure.
    const line = (key: string) => {
      const found = csv.split('\n').find((entry) => entry.startsWith(`${key},`))
      if (found === undefined) throw new Error(`the export has no "${key}" line`)
      return found.slice(key.length + 1)
    }
    expect(line('output_net_supplies_fils')).toBe(output?.net ?? 'no output rows')
    expect(line('output_tax_fils')).toBe(output?.tax ?? 'no output rows')
    expect(line('input_net_supplies_fils')).toBe(input?.net ?? 'no input rows')
    expect(line('input_tax_fils')).toBe(input?.tax ?? 'no input rows')
    expect(line('net_tax_due_fils')).toBe(
      String(BigInt(output?.tax ?? '0') - BigInt(input?.tax ?? '0')),
    )
    // And the figures are this suite's own sale, exact to the fils, so the reconciliation is not two
    // zeroes agreeing. The sale is the only entry in a virgin month.
    expect(BigInt(output?.tax ?? '0')).toBe(BigInt(SALE_VAT))
    expect(BigInt(output?.net ?? '0')).toBe(BigInt(SALE_GROSS - SALE_VAT))
  })

  it('states the snapshot content hash the database holds, not a recomputed one', async () => {
    const exported = await doExport()
    const csv = new TextDecoder().decode(exported.bytes)
    const [row] = await sql<{ content_hash: string; engine_signature: string }[]>`
      select content_hash, engine_signature from vat_return where id = ${returnId}::uuid
    `
    expect(csv).toContain(`snapshot_content_hash,${row?.content_hash}`)
    expect(csv).toContain(`engine_signature,${row?.engine_signature}`)
    expect(exported.contentHash).toBe(row?.content_hash)
    // The control: the two hashes are different values, so the case is not satisfied by one column being
    // read twice.
    expect(row?.content_hash).not.toBe(row?.engine_signature)
  })

  it('carries the snapshot own reasons against filing, so nobody reads it as fileable', async () => {
    const exported = await doExport()
    const csv = new TextDecoder().decode(exported.bytes)
    const rows = await sql<{ reason: string; open_question_id: string }[]>`
      select reason, open_question_id from vat_return_not_fileable_reason
      where return_id = ${returnId}::uuid order by reason
    `
    // Every box is provisional while Y11-vat201-boxes stands, so there is always at least one reason and
    // an export that dropped them would be handing over figures that look ready to file.
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(csv).toContain(`${row.reason},${row.open_question_id},`)
    expect(csv).toContain('nothing_here_has_been_filed,')
  })
})

// --- D. one-way: no network, no environment, no credentials --------------------------------------

describe('the export is one-way and needs nothing configured', () => {
  it('succeeds with the environment emptied and every network call throwing', async () => {
    const reference = await doExport()

    const savedEnv = { ...process.env }
    const savedFetch = globalThis.fetch
    const savedHttp = http.request
    const savedHttps = https.request
    const refuse = (what: string) => () => {
      throw new Error(`M-VAT-09: the export reached ${what}, which it must never do`)
    }
    try {
      // The environment EMPTIED, not merely a variable unset. The acceptance line is that the export
      // "succeeds with no environment variables or credentials set", and the connection is already open —
      // postgres.js resolves its options when the pool is constructed, so nothing below needs one.
      for (const key of Object.keys(process.env)) delete process.env[key]
      // And the network made to throw. `tax-and-filing-must-not-reach-the-network` refuses the IMPORT and
      // a module graph is blind to `fetch`, which is a global: this is the half of the claim that rule
      // cannot hold, and it is why this file is exempt from it (it imports node:http to break it).
      globalThis.fetch = refuse('fetch') as unknown as typeof globalThis.fetch
      http.request = refuse('http.request') as unknown as typeof http.request
      https.request = refuse('https.request') as unknown as typeof https.request

      const exported = await doExport()
      // Identical bytes, which is the strong form: "it did not throw" would also be true of an export that
      // silently produced a different, degraded file when it could not reach anything.
      expect(exported.fileHash).toBe(reference.fileHash)
      expect(Buffer.from(exported.bytes).equals(Buffer.from(reference.bytes))).toBe(true)
    } finally {
      globalThis.fetch = savedFetch
      http.request = savedHttp
      https.request = savedHttps
      Object.assign(process.env, savedEnv)
    }
    // The control for the stubs themselves: they have to be capable of failing, or the case above proves
    // only that an unused variable was reassigned.
    expect(() => refuse('fetch')()).toThrow('which it must never do')
    // And the environment is back, or every suite after this one in the sequential run would fail on a
    // missing DATABASE_URL with no hint of where it went.
    expect(process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']).toBeDefined()
  })

  it('renders from the row the gated read returned, and from nothing else', async () => {
    // `renderZohoVatReturn` is the pure half. Driving it with the row the DATABASE produced, rather than
    // with a hand-built one, is what shows the two halves compose: the bytes the service wrote and the
    // bytes the renderer produces from the same filing row are the same bytes.
    const [row] = await sql<
      {
        return_id: string
        period_id: string
        starts_on: string
        ends_on: string
        version: number
        content_hash: string
        engine_signature: string
        format_version: string
        snapshot_json: string
        finalised_at: Date
      }[]
    >`
      select return_id, period_id, starts_on::text as starts_on, ends_on::text as ends_on, version,
             content_hash, engine_signature, format_version, snapshot_json, finalised_at
      from vat_return_for_filing(${returnId}::uuid)
    `
    if (row === undefined)
      throw new Error('vat_return_for_filing returned no row for a final return')
    const rendered = renderZohoVatReturn({
      returnId: row.return_id,
      periodId: row.period_id,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      version: row.version,
      contentHash: row.content_hash,
      engineSignature: row.engine_signature,
      formatVersion: row.format_version,
      snapshotJson: row.snapshot_json,
      finalisedAt: row.finalised_at,
    })
    const exported = await doExport()
    expect(rendered.csv).toBe(new TextDecoder().decode(exported.bytes))
    // The control: the totals came out of the snapshot bytes and are not zero, so the equality above is
    // not two empty files matching.
    expect(rendered.totals.outputTaxFils).toBe(BigInt(SALE_VAT))
  })
})
