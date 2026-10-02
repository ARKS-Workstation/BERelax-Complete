import type { AccountPosition, UnitOfWork } from '@berelax/db'
import {
  importOpeningBalances,
  openingBalanceIsAttested,
  readChartAccountCodes,
  readOpeningBalancePostings,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { ImporterDefinition, RowVerdict, StagedSourceRow } from '../../framework.ts'
import type { ImportedEntity } from '../../provenance.ts'
import { assertAccountsAreInTheChart } from './coa.ts'
import type { OpeningCell } from './workbook.ts'
import { ACCOUNT_CODE, isIsoDate, parseOpeningWorkbook } from './workbook.ts'

/**
 * The opening trial balance importer — H-MIG-07, and the one import that cannot be corrected by
 * re-running it.
 *
 * ## One staged ROW, not one per account
 *
 * Every other H-MIG importer stages one row per line of its file, because every other imported artefact
 * is one row per line: a contact, a visit, a therapist, a package balance. An opening position is not.
 * 0027 settled it — *"One entry, not one per account: the opening position is a single balanced document,
 * and a per-account entry would let half of it commit"* — and the staging has to agree with that or the
 * framework's per-row transaction would be exactly the per-account entry 0027 refused.
 *
 * So `parse` returns ONE {@link StagedSourceRow} whose payload carries every line of the file, and the
 * framework's guarantees land where they should: one transaction, one entry, one attestation, one
 * provenance row against each. Resumability is trivially satisfied because there is one row; idempotence
 * is decided on the content hash of the whole statement, which is the right granularity — a file with one
 * figure corrected is a different opening position and must not be skipped as a re-import.
 *
 * It also means the permanent copy the staging ledger keeps is the attested statement itself, figure for
 * figure. Here that is a feature rather than the hazard ADR 0072 is about: the payload holds account codes
 * and integer fils, no personal data of any kind, and keeping it for ever is how an opening figure
 * somebody disputes in two years can be traced to the bytes that were signed off.
 *
 * ## There is no quarantine in this importer at all
 *
 * A bad line refuses the WHOLE file. That is a deliberate departure from H-MIG-04, H-MIG-05 and
 * H-MIG-06, each of which quarantines a line whose own text is fine and which names something this
 * database does not hold — and the reason is that a trial balance with a line held back does not balance.
 * There is nothing to import, so there is nothing to record a quarantine against.
 *
 * ## The read that stops H-MIG-03 being counted twice
 *
 * H-MIG-03's reconstructed package liability posts on `journal_entry.source = 'opening_balance'`
 * (ADR 0069) and so does this. So the file states the FULL balance of every account — which is what a
 * person can check against the books they are copying from — and `apply` posts the REMAINDER after
 * reading what that source already holds at the boundary. `openingRemainder` in `@berelax/core` is the
 * arithmetic and it is injected, because `packages/migration` may import neither that package nor do any
 * calculation of its own; a stated figure smaller than what is already posted is REFUSED and never netted
 * the other way, which is ADR 0071's rule ("a named variance rather than one absorbed") at the opening.
 *
 * The reconciliation this leaves behind is per account and to the fils, and
 * `packages/fixtures/src/opening-boundary.itest.ts` asserts it — which is the fourth acceptance line's
 * own words.
 */

export const OPENING_IMPORTER_NAME = 'opening-balances'

/**
 * The importer's own version, recorded on every run.
 *
 * `1`: nothing has read an opening trial balance before. The version matters more here than anywhere
 * else in the workstream, because the figures this code POSTS are not the figures the file states — they
 * are the remainders it computed — so a balance somebody disputes has to be traceable to the code that
 * did the subtraction as well as to the statement it subtracted from.
 */
export const OPENING_IMPORTER_VERSION = '1'

/**
 * The tables this importer writes, schema-qualified and complete: ZY194 refuses provenance for anything
 * not in this list, and the report's before/after checksums are taken over exactly it.
 *
 * `journal_line` is absent and that is not an omission: its primary key is `(entry_id, line_no)`, and
 * `import_provenance` addresses a target by a SINGLE-column primary key — ZY199 refuses a coverage read
 * over a relation without one. The lines are provenanced through the `journal_entry` they belong to,
 * which is the document the statement actually is.
 */
export const OPENING_IMPORTER_TARGETS: readonly string[] = Object.freeze([
  'public.journal_entry',
  'public.opening_balance_import',
])

/**
 * Every reason an opening trial balance is refused. There are no quarantines — see the module note.
 *
 * Named values rather than message strings, for H-MIG-02's reason: a rejection is asserted by name in
 * this unit's tests, printed beside a line number for a person to act on, and branched on by nothing that
 * can read prose.
 */
export const OPENING_REJECTIONS = {
  payloadNotMinimised: 'staged-payload-must-carry-only-the-declared-keys',
  openingDateNotADate: 'opening-date-must-be-an-iso-date',
  openingDateNotTheSameOnEveryLine: 'opening-date-must-be-the-same-on-every-line',
  accountCodeNotFourDigits: 'account-code-must-be-four-digits',
  accountCodeRepeated: 'account-code-must-appear-once',
  amountNotWholeFils: 'debit-and-credit-must-be-whole-fils',
  notExactlyOneSide: 'exactly-one-of-debit-and-credit-must-be-non-zero',
  trialBalanceDoesNotBalance: 'opening-trial-balance-must-balance',
  noLines: 'opening-trial-balance-must-have-at-least-one-line',
} as const

export type OpeningRejection = (typeof OPENING_REJECTIONS)[keyof typeof OPENING_REJECTIONS]

/** Every reason, for a test that has to prove none was forgotten and none is unreachable. */
export const OPENING_REJECTION_REASONS: readonly OpeningRejection[] = Object.freeze(
  Object.values(OPENING_REJECTIONS),
)

export const DECLARED_OPENING_PAYLOAD_KEYS = ['openingDate', 'lines'] as const

export interface StagedOpeningLine {
  readonly accountCode: string
  readonly debitFils: number
  readonly creditFils: number
}

export interface StagedOpeningPayload {
  readonly openingDate: string
  readonly lines: readonly StagedOpeningLine[]
}

const DECLARED = new Set<string>(DECLARED_OPENING_PAYLOAD_KEYS)

const isLineArray = (value: unknown): value is readonly Record<string, unknown>[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'object' && entry !== null)

/** The shape of each line: a four-digit code and two whole-fils sides, exactly one of them non-zero. */
function validateOpeningLines(lines: readonly Record<string, unknown>[]): RowVerdict {
  if (lines.length === 0) return { ok: false, reason: OPENING_REJECTIONS.noLines }
  const seen = new Set<string>()
  for (const line of lines) {
    const code = line['accountCode']
    if (typeof code !== 'string' || !ACCOUNT_CODE.test(code)) {
      return { ok: false, reason: OPENING_REJECTIONS.accountCodeNotFourDigits }
    }
    if (seen.has(code)) return { ok: false, reason: OPENING_REJECTIONS.accountCodeRepeated }
    seen.add(code)
    const debit = line['debitFils']
    const credit = line['creditFils']
    for (const value of [debit, credit]) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return { ok: false, reason: OPENING_REJECTIONS.amountNotWholeFils }
      }
    }
    if ((debit === 0) === (credit === 0)) {
      return { ok: false, reason: OPENING_REJECTIONS.notExactlyOneSide }
    }
  }
  return { ok: true }
}

/**
 * Judges the whole staged statement.
 *
 * The trial-balance check is here and not only in `@berelax/db`'s `assertImportable`, deliberately: that
 * one throws, naming the difference in fils, which is the sentence a person corrects a spreadsheet from;
 * this one returns the NAMED reason, which is what the staging ledger records and what a test asserts by
 * name. Two directions on one claim, and `opening-boundary.itest.ts` drives both.
 */
export function validateStagedOpening(payload: Readonly<Record<string, unknown>>): RowVerdict {
  for (const key of Object.keys(payload)) {
    if (!DECLARED.has(key)) return { ok: false, reason: OPENING_REJECTIONS.payloadNotMinimised }
  }
  if (!isIsoDate(payload['openingDate'])) {
    return { ok: false, reason: OPENING_REJECTIONS.openingDateNotADate }
  }
  const lines = payload['lines']
  if (!isLineArray(lines)) return { ok: false, reason: OPENING_REJECTIONS.noLines }
  const shape = validateOpeningLines(lines)
  if (!shape.ok) return shape

  let debit = 0
  let credit = 0
  for (const line of lines) {
    debit += line['debitFils'] as number
    credit += line['creditFils'] as number
  }
  if (debit !== credit) {
    return { ok: false, reason: OPENING_REJECTIONS.trialBalanceDoesNotBalance }
  }
  return { ok: true }
}

/** The staged payload, read back from `jsonb` with its keys typed. */
function readStaged(payload: Readonly<Record<string, unknown>>): StagedOpeningPayload {
  const verdict = validateStagedOpening(payload)
  if (!verdict.ok) {
    throw new AppError(
      'invariant_violated',
      `A staged opening statement reached apply that staging should have refused (${verdict.reason}). ` +
        'Validation happens over the statement before anything is applied, so reaching here means a ' +
        'payload was written into the ledger by something other than this importer.',
      { details: { reason: verdict.reason } },
    )
  }
  return {
    openingDate: payload['openingDate'] as string,
    lines: payload['lines'] as readonly StagedOpeningLine[],
  }
}

/**
 * The remainder arithmetic, injected: `openingRemainder` from `@berelax/core`.
 *
 * `packages/migration` may import `@berelax/db` and `@berelax/shared` and nothing else first-party, and
 * H-MIG-01 gives the reason: there is no calculation in this package, and the importer that needs one
 * takes the answer as an argument. There is no default and there must not be one — an identity remainder
 * would post the stated figure on top of what H-MIG-03 already attested, which is the double count this
 * whole unit is arranged against, and the books would still balance afterwards.
 */
export type RemainderCalculator = (args: {
  readonly accountCode: string
  readonly statedDebitFils: number
  readonly statedCreditFils: number
  readonly postedNetFils: number
}) =>
  | { readonly ok: true; readonly debitFils: number; readonly creditFils: number }
  | { readonly ok: false; readonly message: string }

export interface OpeningImporterOptions {
  readonly remainder: RemainderCalculator
  /** A label recorded on the attestation. Never a uuid; the audit row carries the actor. */
  readonly importedBy: string
  /**
   * Y8-opening-balances. True while the figures are the build's assumption rather than the owner's
   * answer, which is what the Unconfirmed Assumptions panel reads. 0027 refuses a provisional row that
   * names no open question, so the two are supplied together or not at all.
   */
  readonly provisional?: { readonly note: string; readonly openQuestionId: string }
}

/**
 * Applies the one staged statement: reads what is already posted, posts the remainder, attests the whole.
 *
 * The order is the only one that works and it is worth stating. The entry is posted FIRST and the
 * attestation second, because 0027's guard reads the attestation — so an attestation written first would
 * refuse the entry it is about. ZY383 then closes the boundary on the way out, which is why a second run
 * of a corrected file is a dated reversal and a new boundary rather than a re-import.
 */
async function applyOpeningStatement(
  uow: UnitOfWork,
  payload: Readonly<Record<string, unknown>>,
  options: OpeningImporterOptions,
): Promise<readonly ImportedEntity[]> {
  const staged = readStaged(payload)

  if (await openingBalanceIsAttested(uow.sql, staged.openingDate)) {
    throw new AppError(
      'conflict',
      `An opening balance has already been attested for ${staged.openingDate}. A second import at the ` +
        'same boundary is refused by the unique key on (legal_entity_id, opening_date) rather than ' +
        'doubling every balance — which is undetectable afterwards, because the books still balance ' +
        '(0027). A correction is a dated reversal plus a fresh import at a NEW boundary.',
      { details: { openingDate: staged.openingDate } },
    )
  }

  assertAccountsAreInTheChart(
    await readChartAccountCodes(uow.sql),
    staged.lines.map((line) => line.accountCode),
  )

  const posted = new Map(
    (await readOpeningBalancePostings(uow.sql, staged.openingDate)).map((row) => [
      row.accountCode,
      row.netFils,
    ]),
  )

  const lines: { accountCode: string; debitFils: number; creditFils: number }[] = []
  let totalDebitFils = 0
  let totalCreditFils = 0
  for (const line of staged.lines) {
    // The attested totals are the WHOLE position's — the statement's own figures — and not the
    // remainder's. That is what makes the file the thing a person checks against their own books, and it
    // is the number ZY382 holds to the entry... which is why the remainder is what the entry carries and
    // the totals are summed from the statement. The two agree exactly when nothing was already posted.
    totalDebitFils += line.debitFils
    totalCreditFils += line.creditFils

    const verdict = options.remainder({
      accountCode: line.accountCode,
      statedDebitFils: line.debitFils,
      statedCreditFils: line.creditFils,
      postedNetFils: posted.get(line.accountCode) ?? 0,
    })
    if (!verdict.ok) throw new AppError('validation', verdict.message)
    if (verdict.debitFils === 0 && verdict.creditFils === 0) continue
    lines.push({
      accountCode: line.accountCode,
      debitFils: verdict.debitFils,
      creditFils: verdict.creditFils,
    })
  }

  if (lines.length === 0) {
    throw new AppError(
      'validation',
      `Every account in the opening trial balance for ${staged.openingDate} is already fully posted by ` +
        'an earlier opening_balance entry, so this import has nothing to post. Refused rather than ' +
        'recorded as an import of nothing: the attestation would claim the position was established ' +
        'here, and the entry it names would have no lines at all.',
    )
  }

  const imported = await importOpeningBalances(uow, {
    openingDate: staged.openingDate,
    entryId: `OPEN-${staged.openingDate}`,
    importedBy: options.importedBy,
    lines,
    ...(options.provisional === undefined
      ? {}
      : {
          isProvisional: true,
          provisionalNote: options.provisional.note,
          openQuestionId: options.provisional.openQuestionId,
        }),
  })

  return [
    { table: 'journal_entry', id: imported.entryId },
    { table: 'opening_balance_import', id: imported.importId },
  ]
}

/**
 * The statement a file states, per account and signed, for the reconciliation read.
 *
 * Exported because the reconciliation is `@berelax/db`'s (`reconcileOpeningPosition`) and takes the
 * stated side as an argument — this package does not read the ledger and that one does not parse a file.
 */
export function statedPositions(cells: readonly OpeningCell[]): readonly AccountPosition[] {
  return cells.map((cell) => ({
    accountCode: cell.accountCode,
    netFils: cell.debitFils - cell.creditFils,
  }))
}

/**
 * Builds the opening-balance importer.
 *
 * Stateless across `parse` and `apply`, unlike every other H-MIG importer, and the reason is the one-row
 * staging: there is nothing a plan would have to carry between the two, because the whole statement is in
 * the payload. The file-scoped claims — one opening date, each account once, the two sides equal — are
 * claims about that single payload and are therefore `validate`'s, not a plan's.
 */
export function openingBalancesImporter(options: OpeningImporterOptions): ImporterDefinition {
  if (typeof options.remainder !== 'function') {
    throw new AppError(
      'invariant_violated',
      'No remainder calculator was injected, so nothing could subtract what is already posted from what ' +
        'the statement attests. Wire `openingRemainder` from @berelax/core. There is no fallback on ' +
        'purpose: posting the stated figure on top of H-MIG-03’s reconstructed package liability is ' +
        'the double count this unit is arranged against, and the books would still balance afterwards.',
    )
  }
  return {
    name: OPENING_IMPORTER_NAME,
    version: OPENING_IMPORTER_VERSION,
    targetTables: OPENING_IMPORTER_TARGETS,
    parse: (sourceText: string): readonly StagedSourceRow[] => {
      const cells = parseOpeningWorkbook(sourceText)
      if (cells.length === 0) {
        throw new AppError(
          'validation',
          'The opening trial balance has a header and no lines. Refused rather than imported as an ' +
            'import of nothing: a run that applied zero lines and completed would make the next run of ' +
            'the filled file look like a re-import (H-MIG-01).',
        )
      }
      const dates = [...new Set(cells.map((cell) => cell.openingDate))]
      if (dates.length > 1) {
        throw new AppError(
          'validation',
          `The opening trial balance names ${dates.length} different opening dates: ${dates.join(', ')}. ` +
            'The boundary is one fact about the whole file and it is the most consequential value in it, ' +
            'so a disagreement is refused rather than resolved to whichever line came first.',
          { details: { dates } },
        )
      }
      return [
        {
          // The FIRST data line, which is the line a person opens the spreadsheet at to find the
          // statement. One staged row, so there is one line number and it has to be a real one — the
          // framework refuses a line number below 1 by name.
          lineNumber: cells[0]?.lineNumber ?? 1,
          payload: {
            openingDate: dates[0] as string,
            lines: cells.map((cell) => ({
              accountCode: cell.accountCode,
              debitFils: cell.debitFils,
              creditFils: cell.creditFils,
            })),
          },
        },
      ]
    },
    validate: validateStagedOpening,
    apply: (uow: UnitOfWork, payload: Readonly<Record<string, unknown>>) =>
      applyOpeningStatement(uow, payload, options),
  }
}
