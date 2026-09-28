import type { AppError } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'
import {
  canonicaliseVat201WorkingPapers,
  type Vat201Period,
  vat201ContentHash,
  vat201WorkingPapers,
} from '../queries/vat201-working-papers.ts'
import { postJournalEntry } from '../repositories/journal.ts'
import { withUnitOfWork } from '../tx.ts'
import { closeAccountingPeriod } from './period-close.ts'
import * as service from './vat-return-signoff.ts'
import {
  amendVatReturn,
  finaliseVatReturn,
  readVatReturn,
  signOffVatReturn,
  snapshotVatReturn,
  VAT_RETURN_CONSUMERS,
  VAT_RETURN_SQLSTATE,
  vatReturnBoxFigures,
  vatReturnForFiling,
  vatReturnNotFileableReasons,
  vatReturnSigningRoles,
  vatReturnSignOffState,
} from './vat-return-signoff.ts'

/**
 * M-VAT-08 — the sealed VAT return snapshot, its two signatures, and the door a filing comes through.
 *
 * ## Why every case needs real PostgreSQL
 *
 * Nothing this unit adds is enforced by TypeScript, and that is the design rather than an accident of it:
 * `SamePersonSignOff` is a BEFORE INSERT trigger (`ZY052`) with a UNIQUE index behind it, the role set is a
 * CHECK against `vat_return_signing_roles()` (`ZY053`), append-only is a trigger pair plus a REVOKE
 * (`ZY051`), an unsigned return is refused a finalisation and a filing read by `ZY055`, and
 * `content_hash = sha256(snapshot_json)` is a CHECK. A mock would prove none of it, and the service module
 * is deliberately thin over the database for exactly that reason.
 *
 * ## The two things only a real ledger can show, and the order they have to run in
 *
 *   1. **The snapshot stores the FIGURES.** Not a recipe: `vat_return_box_figure` is a view over
 *      `vat_return.snapshot_json` and reaches no ledger table. The only honest proof is to MOVE THE LEDGER
 *      and require the stored figures not to follow — with the control that the regenerated paper's hash
 *      DOES change, because "the figures did not move" is satisfied by a ledger that did not move either.
 *   2. **The hash is reproducible years later.** The papers contain no instant at all (M-VAT-07), so the
 *      clock is advanced five years and the hash is required back identical — with the control that a
 *      one-fils perturbation of the same paper changes it, because a hash function that returned a constant
 *      would pass the first assertion perfectly.
 *
 * Those two pull in opposite directions: once the ledger has moved, a regeneration no longer reproduces the
 * stored hash. So the file is ordered — the hash cases first, sign-off and filing next, then the ledger
 * moves, and the amendment last, where a changed ledger is what an amendment is FOR. `fileParallelism` is
 * off and vitest runs a file's `describe` blocks in source order, so the order is the file's own.
 *
 * ## Why this suite reopens a closed period, which production cannot
 *
 * The ledger under a CLOSED period cannot be moved by anything the application offers: `journal_entry`'s
 * guard refuses a posting into it (`ZL002`), and `postDatedCorrection` reverses into the first OPEN period
 * instead. ADR 0026 makes a reopen a migration. That is precisely why case group E deletes its own lock by
 * hand: the only way the ledger under a snapshot can move is the thing production refuses, and if the
 * snapshot re-derived, then the day somebody DID take that sanctioned migration, every return already filed
 * would silently restate itself. The locks removed are the ones this suite created, by `period_id` prefix.
 *
 * ## The window is picked, not fixed
 *
 * `journal_entry` and `journal_line` refuse DELETE for every role including the owner (`ZL001`), so the
 * entries this suite posts are permanent and a fixed month would double every figure on a second run
 * against the same database — M-TILL-10's recorded defect, which read 430,003 fils where 33,334 was
 * expected. So a virgin month is found inside {@link RESERVED_SPAN} (2120-01..2139-12, which M-VAT-07's own
 * span at 2150-2199 and every other suite's year — 2088, 2093, 2097, 2099 — stay clear of), and the figures
 * asserted are DELTAS over this suite's own writes, never totals.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** Two decades no other suite posts into. See the header on why it is not a fixed month. */
const RESERVED_SPAN = { from: '2120-01-01', to: '2139-12-31' } as const

const ACTOR = { kind: 'system', label: 'm-vat-08-itest' } as const
const PREFIX = 'MVAT08'
/** Unique per run: the entries this suite posts can never be deleted. */
const RUN = Date.now().toString(36)

const CASH = '1010'
const REVENUE = '4010'
const OUTPUT_VAT = '2030'

/**
 * A sale that splits exactly at 5%: 21,000 gross is 20,000 net and 1,000 tax.
 *
 * Every figure below is therefore checkable by eye, and a change to the rounding convention could not hide
 * inside a remainder — which matters because [UNVERIFIED] Y11-rounding is open and this unit stores the
 * figures a return is filed on.
 */
const SALE_GROSS = 21_000
const SALE_VAT = 1_000
/** The second entry, posted after the snapshot. A different figure, so a drift would be unmistakable. */
const LATER_GROSS = 6_300
const LATER_VAT = 300

const PREPARER = {
  userId: `${PREFIX}-${RUN}-preparer`,
  displayName: 'Accountant on duty',
  role: 'accountant',
} as const
const REVIEWER = {
  userId: `${PREFIX}-${RUN}-reviewer`,
  displayName: 'Proprietor',
  role: 'owner',
} as const

/** Instants, from constants. Nothing in this suite reads an ambient clock. */
const SNAPSHOTTED_AT = '2126-07-01T06:00:00.000Z'
const PREPARED_SIGNED_AT = '2126-07-01T07:00:00.000Z'
const REVIEWED_SIGNED_AT = '2126-07-02T07:00:00.000Z'
const FINALISED_AT = '2126-07-02T08:00:00.000Z'
const AMENDED_AT = '2126-08-01T06:00:00.000Z'

let sql: Sql
let period: Vat201Period
let returnId = ''
let snapshotContentHash = ''
let snapshotBoxTotals = ''

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

/**
 * The SQLSTATE and message of a rejected statement.
 *
 * Read from `err.code` for a raw statement and from `details.sqlState` for a service call, which translates
 * the driver's error and carries the code across. Either way the assertion is on the SQLSTATE: "an error was
 * raised" would pass just as happily for a typo in a column name, which is how a test for a trigger ends up
 * testing nothing.
 */
async function stateOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
    return { code: 'RESOLVED', message: 'the statement was accepted' }
  } catch (err) {
    const direct = (err as { code?: unknown }).code
    const translated = (err as { details?: { sqlState?: unknown } }).details?.sqlState
    const code = typeof direct === 'string' ? direct : translated
    return {
      code: typeof code === 'string' ? code : 'NO_CODE',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Runs `body` as `berelax_app` inside a transaction, so `set local role` cannot leak.
 *
 * One statement per query: postgres.js prepares each one and a prepared statement may not contain two
 * commands, so `set role …; delete …` in a single template comes back as `42601` — a syntax error that reads
 * exactly like the grant having been checked when nothing was.
 *
 * And no temporary view or table is used to name the return inside such a block. The first version of these
 * cases selected the id from a temp view created as the owner, and `berelax_app` was refused THAT — so the
 * case reported `42501` about the view while saying nothing at all about the grant it claimed to measure.
 */
async function asApplicationRole<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`set local role berelax_app`
    return body(tx as unknown as Sql)
  }) as Promise<T>
}

const removeOwnLocks = () => sql`delete from period_lock where period_id like ${`${PREFIX}-%`}`

const close = (from: string, to: string, periodId: string) =>
  withUnitOfWork(sql, ACTOR, (uow) =>
    closeAccountingPeriod(uow, {
      periodId,
      startsOn: from,
      endsOn: to,
      reason: 'M-VAT-08: the VAT return snapshot is taken from a closed period',
      closedByActorKind: 'system',
    }),
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
      `The M-VAT-08 suite needs a month with no journal entry in it, and ${RESERVED_SPAN.from}..` +
        `${RESERVED_SPAN.to} is used up to ${used}. The journal is append-only and refuses the owner, so ` +
        'the entries cannot be removed: run against a fresh database, or widen RESERVED_SPAN into a decade ' +
        'no other suite posts into. Wrapping round would land on a month that already holds a previous run ' +
        'and every figure asserted below would read double.',
    )
  }
  return { periodId: `${PREFIX}-${rolled.year}-${mm}`, startsOn, endsOn }
}

/** The box figures as one comparable string, so "nothing moved" is one assertion over every figure. */
const asFingerprint = (figures: readonly service.VatReturnBoxFigure[]) =>
  figures
    .map((box) => `${box.boxNo}:${box.netSuppliesFils}/${box.taxFils}/${box.lineCount}`)
    .join(' ')

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  // Defensive: a previous run killed between its cases leaves its locks behind, and
  // `period_lock_no_overlap` would then refuse this run's close for a reason unrelated to it.
  await removeOwnLocks()
  period = await virginMonth()

  const saleDay = `${period.startsOn.slice(0, 7)}-15`
  await withUnitOfWork(sql, ACTOR, (uow) =>
    postJournalEntry(uow, {
      entryId: `JE-${PREFIX}-${RUN}-SALE`,
      entryDate: saleDay,
      narrative: 'Aromatherapy 60 min, cash',
      source: 'sale',
      lines: saleLines(SALE_GROSS, SALE_VAT),
    }),
  )
  await close(period.startsOn, period.endsOn, period.periodId)

  const snapshot = await withUnitOfWork(sql, ACTOR, (uow) =>
    snapshotVatReturn(uow, {
      period,
      preparedBy: { kind: 'system', label: ACTOR.label },
      snapshottedAt: SNAPSHOTTED_AT,
    }),
  )
  returnId = snapshot.id
  snapshotContentHash = snapshot.contentHash
  snapshotBoxTotals = asFingerprint(await vatReturnBoxFigures(sql, returnId))
})

afterAll(async () => {
  // By `period_id` prefix, so it can only ever remove locks this suite took. Not tidiness:
  // `period_lock_no_overlap` would refuse a second run against the same database, because the second run
  // wants the same dates under the same id.
  await removeOwnLocks()
  await sql.end()
})

// --- A. the snapshot, and the hash that has to survive five years -------------------------------

describe('the snapshot seals the figures with a hash over exactly the stored bytes', () => {
  it('stores the canonical bytes, and the stored hash is the sha256 of them', async () => {
    const stored = await readVatReturn(sql, returnId)
    expect(stored).not.toBeNull()
    // Computed here, in TypeScript, over the bytes read back out of the database — which is the assertion
    // 0095's CHECK cannot make on its own, because the CHECK compares the column with the column beside it.
    const { createHash } = await import('node:crypto')
    const recomputed = createHash('sha256')
      .update(stored?.snapshotJson ?? '')
      .digest('hex')
    expect(recomputed).toBe(snapshotContentHash)
    expect(stored?.contentHash).toBe(snapshotContentHash)
    // And the control: the same reader over one byte more must NOT produce it. Without this the case
    // passes for any hash of anything, including a constant.
    const perturbed = createHash('sha256')
      .update(`${stored?.snapshotJson ?? ''} `)
      .digest('hex')
    expect(perturbed).not.toBe(snapshotContentHash)
  })

  it('carries the period, the closed lock, the trial-balance hash and the engine signature', async () => {
    const stored = await readVatReturn(sql, returnId)
    expect(stored?.periodId).toBe(period.periodId)
    expect(stored?.startsOn).toBe(period.startsOn)
    expect(stored?.endsOn).toBe(period.endsOn)
    expect(stored?.version).toBe(1)
    expect(stored?.supersedesId).toBeNull()
    expect(stored?.closedPeriodId).toBe(period.periodId)
    expect(stored?.formatVersion).toBe('vat201-wp1')
    // The generating code version, and the two halves of it are checked differently: the format tag is a
    // value, the engine signature is a sha256 whose POINT is that it is not a constant anybody typed.
    expect(stored?.engineSignature).toMatch(/^[0-9a-f]{64}$/)
    expect(stored?.trialBalanceHash).toMatch(/^[0-9a-f]{64}$/)
    // The two hashes answer different questions and must not be the same value: "is this the return I
    // filed" against "is this the ledger it was filed from".
    expect(stored?.trialBalanceHash).not.toBe(stored?.contentHash)
    const [signature] = await sql<{ s: string }[]>`select vat201_engine_signature() as s`
    expect(stored?.engineSignature).toBe(signature?.s)
  })

  it('stores this sale, exact to the fils, in the boxes the mapping rows name', async () => {
    const figures = await vatReturnBoxFigures(sql, returnId)
    // Three boxes, always, even at zero — 0089's rule, carried into the snapshot because an absent row is
    // indistinguishable from a box nobody computed.
    expect(figures.length).toBeGreaterThanOrEqual(3)
    const [box] = await sql<{ box_no: number }[]>`
      select box_no from vat201_box_mapping m
      join account a on a.code = m.account_code
      where a.vat_box = 'standard_rated_supplies' and m.measure = 'net_supplies'
        and m.box_no is not null
      order by m.box_no limit 1
    `
    // Read from the ROWS. A test asserting the literal 1 would be asserting the answer to
    // Y11-vat201-boxes instead of reading it.
    const standardRated = figures.find((figure) => figure.boxNo === box?.box_no)
    expect(standardRated?.netSuppliesFils).toBe(BigInt(SALE_GROSS - SALE_VAT))
    expect(standardRated?.taxFils).toBe(BigInt(SALE_VAT))
    expect(standardRated?.lineCount).toBe(2)
  })

  it('is NOT fileable, says why, and the snapshot could not have claimed otherwise', async () => {
    const stored = await readVatReturn(sql, returnId)
    expect(stored?.fileable).toBe(false)
    const reasons = await vatReturnNotFileableReasons(sql, returnId)
    // The tax agent's review is recorded as not optional (Y11-tax-agent) and the box numbers are
    // placeholders (Y11-vat201-boxes). Both must be in the snapshot, by id, not by prose.
    expect(reasons.map((reason) => reason.reason)).toContain('tax_agent_review_outstanding')
    expect(reasons.map((reason) => reason.openQuestionId)).toContain('Y11-tax-agent')
    expect(reasons.length).toBeGreaterThanOrEqual(3)
    // Every box snapshotted carries the provisional marker, so the label a reviewer reads cannot look
    // settled. Both halves: the flag and the marker in the text.
    const figures = await vatReturnBoxFigures(sql, returnId)
    expect(figures.every((figure) => figure.isProvisional)).toBe(true)
    expect(figures.every((figure) => /to be confirmed/i.test(figure.label))).toBe(true)

    // And the refusal itself: a row claiming to be fileable over these very bytes cannot be stored. Not a
    // claim about the service — the same bytes, with `fileable` flipped in the column only, and then with
    // it flipped inside the snapshot as well so the columns-agree CHECK is not what answers.
    const flipped = await stateOf(sql`
      insert into vat_return (
        period_id, starts_on, ends_on, version, closed_period_id, format_version, engine_signature,
        trial_balance_hash, content_hash, snapshot_json, fileable,
        prepared_by_actor_kind, prepared_by_actor_label, snapshotted_at
      )
      select ${`${period.periodId}-FILEABLE`}, starts_on, ends_on, 1, closed_period_id, format_version,
             engine_signature, trial_balance_hash,
             encode(sha256(convert_to(replace(replace(snapshot_json, ${`"periodId":"${period.periodId}"`},
               ${`"periodId":"${period.periodId}-FILEABLE"`}), '"fileable":false', '"fileable":true'),
               'UTF8')), 'hex'),
             replace(replace(snapshot_json, ${`"periodId":"${period.periodId}"`},
               ${`"periodId":"${period.periodId}-FILEABLE"`}), '"fileable":false', '"fileable":true'),
             true, 'system', 'itest', now()
      from vat_return where id = ${returnId}::uuid
    `)
    expect(flipped.code).toBe('23514')
    expect(flipped.message).toContain('vat_return_fileable_only_when_nothing_in_it_refuses_filing')
  })

  it('reproduces the stored content hash when regenerated with the clock five years on', async () => {
    // The papers read no clock at all — not a frozen one, none (M-VAT-07) — so advancing it must change
    // nothing. Only `Date` is faked: postgres.js drives its timeouts off `setTimeout`, and faking those
    // makes the pool hang rather than fail, which presents as this file timing out for no stated reason.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2131-07-01T06:00:00.000Z'))
      const regenerated = await vat201WorkingPapers(sql, period)
      expect(regenerated.contentHash).toBe(snapshotContentHash)

      // The control, and it is the one that matters: a hash that ignored its input would pass the line
      // above perfectly. One fils on one box must change it.
      const { contentHash: _drop, ...body } = regenerated
      const tampered = {
        ...body,
        boxes: body.boxes.map((boxRow, index) =>
          index === 0 ? { ...boxRow, taxFils: boxRow.taxFils + 1n } : boxRow,
        ),
      }
      expect(vat201ContentHash(tampered)).not.toBe(snapshotContentHash)
      // And the bytes really are the bytes: what was stored is what the canonical form produces now.
      const stored = await readVatReturn(sql, returnId)
      expect(canonicaliseVat201WorkingPapers(body)).toBe(stored?.snapshotJson)
    } finally {
      // In a `finally`, because a failed expectation above would otherwise leave every later file in the
      // sequential integration run with a frozen Date.
      vi.useRealTimers()
    }
  })
})

// --- B. two different people, in a role that may sign -------------------------------------------

describe('sign-off needs two different people, and only an accountant or an owner', () => {
  it('permits exactly the roles core grants vat_return:prepare, read from the database', async () => {
    expect(await vatReturnSigningRoles(sql)).toEqual(['accountant', 'owner'])
  })

  it('records the preparer with their display name and role snapshotted', async () => {
    const signed = await withUnitOfWork(sql, ACTOR, (uow) =>
      signOffVatReturn(uow, {
        returnId,
        capacity: 'preparer',
        signatory: PREPARER,
        signedAt: PREPARED_SIGNED_AT,
      }),
    )
    expect(signed.signatory.displayName).toBe(PREPARER.displayName)
    expect(signed.signatory.role).toBe('accountant')

    const state = await vatReturnSignOffState(sql, returnId)
    expect(state.preparer?.userId).toBe(PREPARER.userId)
    expect(state.reviewer).toBeNull()
    expect(state.signed).toBe(false)

    // The snapshot half, which is what a rename would break. The row carries the NAME and not a join, so
    // a later rename of the person cannot reach it — asserted by changing nothing and reading the column,
    // because there is no staff row here to rename: the absence of a foreign key IS the mechanism.
    const [row] = await sql<{ signatory_display_name: string }[]>`
      select signatory_display_name from vat_return_sign_off
      where return_id = ${returnId}::uuid and capacity = 'preparer'
    `
    expect(row?.signatory_display_name).toBe(PREPARER.displayName)
  })

  it('refuses the same person as reviewer, with SamePersonSignOff', async () => {
    const refusal = await refusalOf(
      withUnitOfWork(sql, ACTOR, (uow) =>
        signOffVatReturn(uow, {
          returnId,
          capacity: 'reviewer',
          // The same id, a different display name: a caller who signed twice under two spellings of one
          // name would be the realistic version of this, and the id is what the rule is about.
          signatory: { ...PREPARER, displayName: 'A. Accountant' },
          signedAt: REVIEWED_SIGNED_AT,
        }),
      ),
    )
    expect(refusal.name).toBe('SamePersonSignOff')
    expect((refusal.details as { sqlState?: string }).sqlState).toBe(
      VAT_RETURN_SQLSTATE.samePersonSignOff,
    )
    expect(refusal.message).toContain('preparer')
  })

  it('refuses every role core does not grant, and names the permitted set', async () => {
    // All six denied roles, one at a time, each in its own transaction so a refusal cannot leave a row.
    // Deny-by-default means the list of who is refused is the complement of the list of who may, so the
    // cases are driven from F07's whole role set rather than from the two the acceptance line names.
    const denied = [
      'manager',
      'receptionist',
      'therapist',
      'marketer',
      'auditor',
      'system',
    ] as const
    for (const role of denied) {
      const refusal = await stateOf(
        withUnitOfWork(sql, ACTOR, (uow) =>
          signOffVatReturn(uow, {
            returnId,
            capacity: 'reviewer',
            signatory: {
              userId: `${PREFIX}-${RUN}-${role}`,
              displayName: `Somebody in ${role}`,
              role,
            },
            signedAt: REVIEWED_SIGNED_AT,
          }),
        ),
      )
      expect(refusal.code, `${role} must not be able to sign`).toBe(
        VAT_RETURN_SQLSTATE.roleNotPermitted,
      )
      expect(refusal.message).toContain('accountant, owner')
    }
  })

  it('accepts a second person in the owner role, and the return is then signed', async () => {
    // The control for the six refusals above: the same statement with a permitted role is ACCEPTED, so
    // those cases are not passing because every sign-off is refused.
    const signed = await withUnitOfWork(sql, ACTOR, (uow) =>
      signOffVatReturn(uow, {
        returnId,
        capacity: 'reviewer',
        signatory: REVIEWER,
        signedAt: REVIEWED_SIGNED_AT,
      }),
    )
    expect(signed.signatory.role).toBe('owner')
    const state = await vatReturnSignOffState(sql, returnId)
    expect(state.preparer?.userId).toBe(PREPARER.userId)
    expect(state.reviewer?.userId).toBe(REVIEWER.userId)
    expect(state.signed).toBe(true)
    expect(state.finalisedAt).toBeNull()
  })

  it('writes an audit row for each signature, in the transaction that signed', async () => {
    // A delta and never a total: `audit_event` is append-only (ADR 0008).
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
      where action = 'vat_return.sign_off'
        and entity_id in (select id::text from vat_return_sign_off where return_id = ${returnId}::uuid)
    `
    expect(Number(row?.n ?? '-1')).toBe(2)
  })
})

// --- C. an unsigned return cannot be marked final or exported -----------------------------------

describe('nothing consumes a return for filing until it is signed and final', () => {
  it('enumerates every export of this module, so a new consumer must be classified', async () => {
    // The acceptance line asks for the enumeration to come FROM the export surface. Taken from the real
    // module namespace rather than from a hand-written list, so M-VAT-09's export cannot arrive without
    // somebody deciding in writing whether it needs a signature.
    //
    // Lower-case names only: the classes (`SamePersonSignOff`) and the constant objects
    // (`VAT_RETURN_SQLSTATE`) are not paths that consume a return.
    const exported = Object.entries(service)
      .filter(([name, value]) => typeof value === 'function' && /^[a-z]/.test(name))
      .map(([name]) => name)
      .sort()
    expect(exported.length).toBeGreaterThan(6)
    expect(VAT_RETURN_CONSUMERS.map((entry) => entry.export).sort()).toEqual(exported)
    // Every entry says WHY, because a classification with no reason is one nobody can review.
    expect(VAT_RETURN_CONSUMERS.every((entry) => entry.why.length > 30)).toBe(true)
    // And the two that require sign-off are exactly these two. A third arriving without its own
    // behavioural case below fails here rather than passing silently.
    expect(
      VAT_RETURN_CONSUMERS.filter((entry) => entry.requiresSignOff)
        .map((entry) => entry.export)
        .sort(),
    ).toEqual(['finaliseVatReturn', 'vatReturnForFiling'])
  })

  it('refuses to mark a return final while only one person has signed', async () => {
    // Against a SECOND return, because the one above is signed by now. A snapshot of the same period is
    // refused as a duplicate version, so this is the period's next version — which is also the shape a
    // real "amend and re-sign" takes.
    const draft = await withUnitOfWork(sql, ACTOR, (uow) =>
      amendVatReturn(uow, {
        period,
        preparedBy: { kind: 'system', label: ACTOR.label },
        snapshottedAt: AMENDED_AT,
        supersedesId: returnId,
        amendmentReason:
          'M-VAT-08 itest: an unfinalised version, to prove a finalisation is refused without both ' +
          'signatures',
      }),
    )
    const unsigned = await refusalOf(
      withUnitOfWork(sql, ACTOR, (uow) =>
        finaliseVatReturn(uow, {
          returnId: draft.id,
          finalisedAt: FINALISED_AT,
          actor: { kind: 'system', label: ACTOR.label },
        }),
      ),
    )
    expect(unsigned.name).toBe('VatReturnNotSignedOff')
    expect((unsigned.details as { sqlState?: string }).sqlState).toBe(
      VAT_RETURN_SQLSTATE.notSignedOff,
    )

    await withUnitOfWork(sql, ACTOR, (uow) =>
      signOffVatReturn(uow, {
        returnId: draft.id,
        capacity: 'preparer',
        signatory: PREPARER,
        signedAt: PREPARED_SIGNED_AT,
      }),
    )
    // ONE signature is still not signed off, which is the half a check written as "any sign-off exists"
    // would get wrong.
    const halfSigned = await refusalOf(
      withUnitOfWork(sql, ACTOR, (uow) =>
        finaliseVatReturn(uow, {
          returnId: draft.id,
          finalisedAt: FINALISED_AT,
          actor: { kind: 'system', label: ACTOR.label },
        }),
      ),
    )
    expect(halfSigned.name).toBe('VatReturnNotSignedOff')
    expect(halfSigned.message).toContain(PREPARER.displayName)

    // And the reading door, refused by the same code from the database rather than by a guard here.
    const read = await refusalOf(vatReturnForFiling(sql, draft.id))
    expect(read.name).toBe('VatReturnNotSignedOff')

    // The figures, however, ARE readable — which is the half that has to be true for a reviewer to be
    // able to review anything.
    expect((await vatReturnBoxFigures(sql, draft.id)).length).toBeGreaterThanOrEqual(3)

    await withUnitOfWork(sql, ACTOR, (uow) =>
      signOffVatReturn(uow, {
        returnId: draft.id,
        capacity: 'reviewer',
        signatory: REVIEWER,
        signedAt: REVIEWED_SIGNED_AT,
      }),
    )
    const finalised = await withUnitOfWork(sql, ACTOR, (uow) =>
      finaliseVatReturn(uow, {
        returnId: draft.id,
        finalisedAt: FINALISED_AT,
        actor: { kind: 'system', label: ACTOR.label },
      }),
    )
    expect(finalised.returnId).toBe(draft.id)

    // The control for all four refusals above: with both signatures and the finalisation, the same reads
    // succeed and hand back the same bytes the snapshot holds.
    const forFiling = await vatReturnForFiling(sql, draft.id)
    expect(forFiling.contentHash).toBe(draft.contentHash)
    expect(forFiling.snapshotJson).toBe(draft.snapshotJson)
    expect(forFiling.finalisedAt).toBeInstanceOf(Date)
  })
})

// --- D. immutable: revoked AND refused ----------------------------------------------------------

describe('a snapshot, a signature and a finalisation cannot be changed by anybody', () => {
  it('grants the application role INSERT and SELECT and nothing else, from information_schema', async () => {
    const rows = await sql<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where grantee = 'berelax_app'
        and table_name in ('vat_return', 'vat_return_sign_off', 'vat_return_finalisation')
      order by table_name, privilege_type
    `
    const held = new Map<string, string[]>()
    for (const row of rows) {
      held.set(row.table_name, [...(held.get(row.table_name) ?? []), row.privilege_type])
    }
    for (const table of ['vat_return', 'vat_return_sign_off', 'vat_return_finalisation']) {
      // The control first: a table with NO grants at all would satisfy "holds no UPDATE" perfectly, and
      // the application has to be able to append and read or the unit does not work.
      expect(held.get(table)?.sort(), `${table} must be insertable and readable`).toEqual([
        'INSERT',
        'SELECT',
      ])
      expect(held.get(table), `${table} must not be updatable`).not.toContain('UPDATE')
      expect(held.get(table), `${table} must not be deletable`).not.toContain('DELETE')
      expect(held.get(table), `${table} must not be truncatable`).not.toContain('TRUNCATE')
    }
  })

  it('raises ZY051 on an UPDATE and on a DELETE, for the owner as well', async () => {
    // The precondition, stated rather than assumed: a BEFORE trigger fires per ROW, so a statement that
    // matches nothing succeeds. Without this the cases below would report "RESOLVED, expected ZY051" and
    // send somebody looking for a missing trigger when what was missing was the row — which is exactly what
    // happened when gate mutant 122z(iv) removed the audit row and the signatures stopped being written.
    const [present] = await sql<{ signatures: string; finalisations: string }[]>`
      select (select count(*) from vat_return_sign_off where return_id = ${returnId}::uuid)::text
               as signatures,
             (select count(*) from vat_return_finalisation f
               join vat_return r on r.id = f.return_id
              where r.period_id = ${period.periodId})::text as finalisations
    `
    expect(
      Number(present?.signatures ?? '-1'),
      'the two signatures this case needs to have something to refuse',
    ).toBe(2)
    expect(
      Number(present?.finalisations ?? '-1'),
      'the finalisation this case needs to have something to refuse',
    ).toBeGreaterThanOrEqual(1)

    // The test pool connects as OWNER, so these cases are the only ones in this file that can see the
    // trigger layer at all — the privilege layer in the case above refuses `berelax_app` before a trigger
    // runs, so the two layers can only ever be observed separately.
    for (const [what, statement] of [
      [
        'update a snapshot',
        sql`update vat_return set fileable = true where id = ${returnId}::uuid`,
      ],
      ['delete a snapshot', sql`delete from vat_return where id = ${returnId}::uuid`],
      [
        'update a signature',
        sql`update vat_return_sign_off set signatory_display_name = 'Somebody else'
            where return_id = ${returnId}::uuid`,
      ],
      [
        'delete a signature',
        sql`delete from vat_return_sign_off where return_id = ${returnId}::uuid`,
      ],
      [
        'delete a finalisation',
        sql`delete from vat_return_finalisation
            where return_id in (select id from vat_return where period_id = ${period.periodId})`,
      ],
    ] as const) {
      const refusal = await stateOf(statement)
      expect(refusal.code, what).toBe(VAT_RETURN_SQLSTATE.immutable)
      expect(refusal.message).toContain('append-only')
    }
  })

  it('refuses the application role an UPDATE and a DELETE by privilege, before any trigger', async () => {
    for (const what of ['vat_return', 'vat_return_sign_off', 'vat_return_finalisation'] as const) {
      const updated = await stateOf(
        asApplicationRole((tx) => tx`update ${tx(what)} set created_at = created_at`),
      )
      expect(updated.code, `${what} update as berelax_app`).toBe('42501')
      const deleted = await stateOf(asApplicationRole((tx) => tx`delete from ${tx(what)}`))
      expect(deleted.code, `${what} delete as berelax_app`).toBe('42501')
    }
    // The control: the same role CAN read the snapshot and its figures. Without it the six cases above
    // would pass for a role that had been granted nothing and could not run the unit at all.
    const readable = await asApplicationRole(
      (tx) => tx<{ n: string }[]>`
        select count(*)::text as n from vat_return_box_figure where return_id = ${returnId}::uuid
      `,
    )
    expect(Number(readable[0]?.n ?? '-1')).toBeGreaterThanOrEqual(3)
  })
})

// --- E. the ledger moves; the snapshot does not --------------------------------------------------

describe('the snapshot holds the figures, not a recipe for recomputing them', () => {
  it('does not move when the journal under the period changes', async () => {
    // Before: the regenerated paper agrees with the snapshot. Establishing that FIRST is what makes the
    // comparison afterwards mean something — without it, "the regenerated hash differs" would also be
    // true of a snapshot that had never agreed with the ledger at all.
    expect((await vat201WorkingPapers(sql, period)).contentHash).toBe(snapshotContentHash)

    // Reopen — by hand, because production cannot: see the header. Only this suite's own locks.
    await removeOwnLocks()
    await withUnitOfWork(sql, ACTOR, (uow) =>
      postJournalEntry(uow, {
        entryId: `JE-${PREFIX}-${RUN}-LATER`,
        entryDate: `${period.startsOn.slice(0, 7)}-20`,
        narrative: 'A second sale, posted after the return was snapshotted',
        source: 'sale',
        lines: saleLines(LATER_GROSS, LATER_VAT),
      }),
    )
    await close(period.startsOn, period.endsOn, period.periodId)

    // The control, and the half that stops this case being vacuous: the LEDGER really did move, so a
    // freshly generated paper is a different paper — and by exactly the second sale, named as a figure
    // rather than as "different", because "the hash changed" is also what a changed key order looks like.
    const regenerated = await vat201WorkingPapers(sql, period)
    expect(regenerated.contentHash).not.toBe(snapshotContentHash)
    const [box] = await sql<{ box_no: number }[]>`
      select box_no from vat201_box_mapping m
      join account a on a.code = m.account_code
      where a.vat_box = 'standard_rated_supplies' and m.measure = 'net_supplies' and m.box_no is not null
      order by m.box_no limit 1
    `
    const regeneratedBox = regenerated.boxes.find((row) => row.boxNo === box?.box_no)
    expect(regeneratedBox?.taxFils).toBe(BigInt(SALE_VAT + LATER_VAT))

    // And the claim: nothing the snapshot holds followed it. The stored hash, the stored bytes and every
    // stored figure — including the one box whose live value has just been shown to have moved.
    const stored = await readVatReturn(sql, returnId)
    expect(stored?.contentHash).toBe(snapshotContentHash)
    expect(asFingerprint(await vatReturnBoxFigures(sql, returnId))).toBe(snapshotBoxTotals)
    const storedBox = (await vatReturnBoxFigures(sql, returnId)).find(
      (row) => row.boxNo === box?.box_no,
    )
    expect(storedBox?.taxFils).toBe(BigInt(SALE_VAT))
  })
})

// --- F. an amendment is a new version carrying a reason -----------------------------------------

describe('a correction is a new version naming the one it supersedes', () => {
  it('adds a version whose figures are the NEW ledger, leaving the prior hash untouched', async () => {
    const prior = await readVatReturn(sql, returnId)
    // Version 2 was taken in case group C, before the ledger moved. Version 3 is the amendment that
    // restates the period, so the figures it carries are the corrected ones.
    const [current] = await sql<{ id: string; version: number }[]>`
      select id, version from vat_return where period_id = ${period.periodId}
      order by version desc limit 1
    `
    const amended = await withUnitOfWork(sql, ACTOR, (uow) =>
      amendVatReturn(uow, {
        period,
        preparedBy: { kind: 'system', label: ACTOR.label },
        snapshottedAt: AMENDED_AT,
        supersedesId: current?.id ?? '',
        amendmentReason:
          'A second cash sale dated in the period was posted after the return was sealed',
      }),
    )
    expect(amended.version).toBe((current?.version ?? 0) + 1)
    expect(amended.supersedesId).toBe(current?.id)
    expect(amended.amendmentReason).toContain('after the return was sealed')

    // The acceptance line, in both directions. The amendment carries the CORRECTED figures…
    const amendedFigures = await vatReturnBoxFigures(sql, amended.id)
    expect(asFingerprint(amendedFigures)).not.toBe(snapshotBoxTotals)
    // …and the prior version's content hash is unchanged afterwards, which is the sentence the trap is
    // about: an amendment that edited the row it corrects would leave nothing to compare.
    const reread = await readVatReturn(sql, returnId)
    expect(reread?.contentHash).toBe(prior?.contentHash)
    expect(reread?.contentHash).toBe(snapshotContentHash)
    expect(reread?.snapshotJson).toBe(prior?.snapshotJson)
  })

  it('refuses an amendment with no reason, a forked chain, and another period', async () => {
    const [v1] = await sql<{ id: string }[]>`
      select id from vat_return where period_id = ${period.periodId} and version = 1
    `
    const [latest] = await sql<{ id: string; version: number }[]>`
      select id, version from vat_return where period_id = ${period.periodId}
      order by version desc limit 1
    `

    // A blank reason. Refused by a CHECK rather than by a trigger, which is the layer that also holds
    // when a restore has triggers off.
    const blank = await stateOf(
      withUnitOfWork(sql, ACTOR, (uow) =>
        amendVatReturn(uow, {
          period,
          preparedBy: { kind: 'system', label: ACTOR.label },
          snapshottedAt: AMENDED_AT,
          supersedesId: latest?.id ?? '',
          amendmentReason: '   ',
        }),
      ),
    )
    expect(blank.code).toBe('23514')
    expect(blank.message).toContain('vat_return_amendment_carries_a_reason')

    // A fork: superseding version 1, which is no longer in force. 0093's ZZ003 rule, for its reason —
    // superseding an older version leaves the current one unaccounted for, and the ledger then reads as
    // two returns in force at once.
    const forked = await stateOf(
      withUnitOfWork(sql, ACTOR, (uow) =>
        amendVatReturn(uow, {
          period,
          preparedBy: { kind: 'system', label: ACTOR.label },
          snapshottedAt: AMENDED_AT,
          supersedesId: v1?.id ?? '',
          amendmentReason: 'A fork of a superseded version',
        }),
      ),
    )
    expect(forked.code).toBe(VAT_RETURN_SQLSTATE.amendmentNotWellFormed)
    expect(forked.message).toContain('has already been superseded')

    // And an amendment claiming to restate a DIFFERENT period from the one it supersedes. The period is
    // read from the papers, so this is driven by asking for papers over a different range — which needs
    // that range closed too, so the case uses the one lock this suite already holds and shifts the label
    // rather than the dates. `period_id` is what the refusal compares first.
    const crossed = await stateOf(sql`
      insert into vat_return (
        period_id, starts_on, ends_on, version, supersedes_id, amendment_reason, closed_period_id,
        format_version, engine_signature, trial_balance_hash, content_hash, snapshot_json, fileable,
        prepared_by_actor_kind, prepared_by_actor_label, snapshotted_at
      )
      select ${`${period.periodId}-OTHER`}, starts_on, ends_on, ${(latest?.version ?? 0) + 1},
             ${latest?.id ?? ''}::uuid, 'a cross-period amendment', closed_period_id, format_version,
             engine_signature, trial_balance_hash, content_hash, snapshot_json, fileable,
             'system', 'itest', now()
      from vat_return where id = ${latest?.id ?? ''}::uuid
    `)
    expect(crossed.code).toBe(VAT_RETURN_SQLSTATE.amendmentNotWellFormed)
    expect(crossed.message).toContain('An amendment restates ONE period')

    // The control for all three: the amendment taken in the case above WAS accepted, so these are not
    // passing because every amendment is refused.
    const [versions] = await sql<{ n: string }[]>`
      select count(*)::text as n from vat_return where period_id = ${period.periodId}
    `
    expect(Number(versions?.n ?? '-1')).toBeGreaterThanOrEqual(3)
  })
})
