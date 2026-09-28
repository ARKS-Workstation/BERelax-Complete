import { AppError } from '@berelax/shared'
import type { AccountCode } from '../ledger/account.ts'

/**
 * The VAT201 return: the sign rule, the box summation and the exhaustive-partition measurement, pure.
 *
 * M-VAT-07. The authoritative summation lives in SQL (`vat201_box_total()` over `vat201_box_line()`,
 * migration 0089) for a reason the manifest states as "regenerable years later": a return that only this
 * codebase can reproduce is evidence about this codebase. What is here is the SECOND implementation —
 * `packages/db` may never import `packages/core`, so nothing compiles the two against each other, and
 * `packages/fixtures/src/vat201.itest.ts` is the one place that can assert they agree. That is the
 * arrangement `price_list`/`resolve-price.ts`, `payables_aging_bucket`/`payablesBucketFor` and
 * `package_release_through_fils`/`releaseThrough` already use, for the same reason.
 *
 * ## Every box number here is [UNVERIFIED]
 *
 * Nothing in this module names a box number. Y11-vat201-boxes is open — the numbers await an
 * FTA-registered tax agent (Y11-tax-agent, recorded as "not optional") — and its provisional answer is
 * that the mapping is HELD AS DATA. A constant `1` in this file would be the thing that answer exists to
 * forbid: a number nobody has confirmed, indistinguishable from one somebody had, and uncorrectable
 * without a deploy. The box numbers arrive as arguments, read from rows.
 *
 * ## Why bigint and not Money
 *
 * A box figure is a sum over a whole period's journal lines, and `Money` carries a `number`.
 * `queries/trial-balance.ts` records what that costs: a ledger holding 2^53 + 1 fils on each side
 * reported a difference of −4 fils out of nothing, because the two sides rounded independently. No real
 * balance reaches 2^53 fils (about 900 billion dirhams) — the argument is that these are the figures a
 * return is filed on, and a type that CAN report a wrong one is the wrong type for them.
 *
 * ## Nothing here divides, rounds or multiplies
 *
 * [UNVERIFIED] Y11-rounding is provisionally "half-up on net, VAT as the remainder", and ADR 0007 makes
 * integer fils with the VAT-inclusive gross authoritative. Every figure below is a SUM of fils as they
 * were posted. `NO_ARITHMETIC_BEYOND_ADDITION` states that as a checkable claim and gate block 116
 * enforces it over this file and over the migration, because the property that makes the answer to
 * Y11-rounding unable to move a box total is exactly "no rate is ever applied here".
 */

// --- the vocabulary the mapping rows use --------------------------------------------------------

/**
 * Which column of a box a line feeds.
 *
 * `net_supplies` is the value of the supply or the purchase; `tax` is the VAT on it. The distinction
 * M-VAT-03 measured the cost of not having: summing one grouping across both gave 2,006,706 fils where
 * the claim was 6,706, because every recoverable expense account carries the same grouping as 1080.
 */
export const VAT201_MEASURES = ['net_supplies', 'tax'] as const
export type Vat201Measure = (typeof VAT201_MEASURES)[number]

/**
 * Which direction is positive for an attribution.
 *
 * Stated per attribution rather than derived from the account's `normalBalance`, and 4095 Discounts and
 * allowances is why: it is a CONTRA revenue account sitting on the debit side, and its contribution is
 * `credit_less_debit` all the same, because it belongs to the output side of the return. A 500-fils
 * discount must REDUCE box 1 by 500. Deriving the direction from `normalBalance` gets that exactly
 * backwards, on the one account in the chart where the two differ — and the return still balances.
 */
export const VAT201_CONTRIBUTIONS = ['credit_less_debit', 'debit_less_credit'] as const
export type Vat201Contribution = (typeof VAT201_CONTRIBUTIONS)[number]

/**
 * What an account's attribution says about it.
 *
 * `unattributed` is not a state the database permits — ZY001 refuses an account with no mapping row — and
 * it is in the vocabulary because the exhaustive-partition acceptance line is a PROOF, and a proof whose
 * failing case cannot be represented is not one.
 */
export const VAT201_DISPOSITIONS = ['box', 'unallocated', 'out_of_scope', 'unattributed'] as const
export type Vat201Disposition = (typeof VAT201_DISPOSITIONS)[number]

/** One account's attribution: where its lines land, in which column, and in which direction. */
export interface Vat201Attribution {
  readonly accountCode: AccountCode
  readonly disposition: Vat201Disposition
  /** The box number from the ROW. `null` for every disposition but `box`. */
  readonly boxNo: number | null
  readonly measure: Vat201Measure | null
  readonly contribution: Vat201Contribution | null
}

/** A journal line as the return reads it: an account, and the two sides as posted. */
export interface Vat201Line {
  readonly entryId: string
  readonly lineNo: number
  readonly accountCode: AccountCode
  readonly debitFils: bigint
  readonly creditFils: bigint
}

// --- the sign rule ------------------------------------------------------------------------------

/**
 * A line's signed contribution to its box, in fils.
 *
 * The ONE statement of the rule in TypeScript, restated in SQL as the `case` inside `vat201_box_line()`
 * and held equal to it by `packages/fixtures/src/vat201.itest.ts` over a census.
 *
 * Direction is never folded into a sign on the line itself (0018: "a negative debit and a positive credit
 * both balance, and only one of them is what the poster meant"), so the direction has to be applied here,
 * from the attribution. An unattributed or out-of-scope line contributes zero rather than `null`: a null
 * in a sum swallows the whole bucket, and a bucket that reads as absent is the failure the partition
 * census exists to catch.
 */
export function vat201SignedFils(
  line: Vat201Line,
  contribution: Vat201Contribution | null,
): bigint {
  if (line.debitFils < 0n || line.creditFils < 0n) {
    throw new AppError(
      'validation',
      `Line ${line.entryId}/${line.lineNo} carries a negative side (${line.debitFils} debit, ` +
        `${line.creditFils} credit). The journal's fils domain is non-negative and direction is the ` +
        'side, never the sign; a negative here would be a second way to express a credit.',
    )
  }
  switch (contribution) {
    case 'credit_less_debit':
      return line.creditFils - line.debitFils
    case 'debit_less_credit':
      return line.debitFils - line.creditFils
    default:
      return 0n
  }
}

// --- the box summation --------------------------------------------------------------------------

export interface Vat201BoxFigure {
  readonly boxNo: number
  readonly netSuppliesFils: bigint
  readonly taxFils: bigint
  readonly lineCount: number
}

export interface Vat201UnboxedFigure {
  readonly disposition: Exclude<Vat201Disposition, 'box'>
  readonly accountCode: AccountCode
  readonly netSuppliesFils: bigint
  readonly taxFils: bigint
  /**
   * Debits PLUS credits, and never the net.
   *
   * M-TILL-09's `probePackageSalePosting` summed credit minus debit over the revenue accounts and read
   * the zero as "no revenue posted": 4010 credited against the contra 4095 by the same figure nets to
   * zero and HAS recognised revenue. An out-of-scope bucket measured as a net would report "nothing
   * happened here" about a period in which a great deal did.
   */
  readonly movementFils: bigint
  readonly lineCount: number
}

/**
 * The attributions by account code, refusing a second one for the same account.
 *
 * Its own function because `summariseVat201` crossed Biome's cognitive-complexity ceiling with it inline,
 * and because the refusal is a claim worth stating once: `vat201_box_mapping`'s primary key is the account
 * code precisely so two attributions cannot exist, and a caller that assembled them by hand has to meet
 * the same rule or every line on the account is counted in two boxes.
 */
function indexAttributions(
  attributions: readonly Vat201Attribution[],
): Map<string, Vat201Attribution> {
  const byAccount = new Map<string, Vat201Attribution>()
  for (const attribution of attributions) {
    if (byAccount.has(attribution.accountCode)) {
      throw new AppError(
        'invariant_violated',
        `Account ${attribution.accountCode} carries two VAT201 attributions. The mapping table's ` +
          'primary key is the account code precisely so this cannot happen: two attributions double ' +
          'every line on the account, in two different boxes.',
      )
    }
    byAccount.set(attribution.accountCode, attribution)
  }
  return byAccount
}

/** Adds one line to its non-box bucket, keyed by disposition AND account so neither is summed away. */
function accumulateUnboxed(
  unboxed: Map<string, Vat201UnboxedFigure>,
  line: Vat201Line,
  disposition: Vat201Disposition,
  measure: Vat201Measure | null,
  signed: bigint,
): void {
  const key = `${disposition}/${line.accountCode}`
  const previous = unboxed.get(key)
  unboxed.set(key, {
    disposition: disposition as Exclude<Vat201Disposition, 'box'>,
    accountCode: line.accountCode,
    netSuppliesFils: (previous?.netSuppliesFils ?? 0n) + (measure === 'tax' ? 0n : signed),
    taxFils: (previous?.taxFils ?? 0n) + (measure === 'tax' ? signed : 0n),
    movementFils: (previous?.movementFils ?? 0n) + line.debitFils + line.creditFils,
    lineCount: (previous?.lineCount ?? 0) + 1,
  })
}

/**
 * The boxes and the other buckets, summed from lines and attributions.
 *
 * `boxNumbers` is passed in rather than discovered from the attributions, so a box with nothing in it is
 * a row at zero instead of an absent one — the argument `PAYABLES_AGING_BUCKETS` and
 * `INPUT_VAT_NON_RECOVERY_REASONS` both make. A box nobody posted to and a box nobody computed look
 * identical once the row is missing.
 */
export function summariseVat201(
  lines: readonly Vat201Line[],
  attributions: readonly Vat201Attribution[],
  boxNumbers: readonly number[],
): {
  readonly boxes: readonly Vat201BoxFigure[]
  readonly unboxed: readonly Vat201UnboxedFigure[]
} {
  const byAccount = indexAttributions(attributions)
  const boxes = new Map<number, { net: bigint; tax: bigint; count: number }>(
    boxNumbers.map((boxNo) => [boxNo, { net: 0n, tax: 0n, count: 0 }]),
  )
  const unboxed = new Map<string, Vat201UnboxedFigure>()

  for (const line of lines) {
    const attribution = byAccount.get(line.accountCode)
    const disposition = attribution?.disposition ?? 'unattributed'
    const signed = vat201SignedFils(line, attribution?.contribution ?? null)

    if (disposition === 'box' && attribution?.boxNo !== null && attribution?.boxNo !== undefined) {
      const bucket = boxes.get(attribution.boxNo)
      if (bucket === undefined) {
        throw new AppError(
          'invariant_violated',
          `Account ${line.accountCode} is attributed to box ${attribution.boxNo}, which is not one of ` +
            `the boxes the return was asked for (${boxNumbers.join(', ')}). A figure attributed to a ` +
            'box nobody is reporting disappears from the return without reducing any total, so it ' +
            'cannot be dropped quietly.',
        )
      }
      if (attribution.measure === 'tax') bucket.tax += signed
      else bucket.net += signed
      bucket.count += 1
      continue
    }

    accumulateUnboxed(unboxed, line, disposition, attribution?.measure ?? null, signed)
  }

  return {
    boxes: [...boxes.entries()]
      .map(([boxNo, bucket]) => ({
        boxNo,
        netSuppliesFils: bucket.net,
        taxFils: bucket.tax,
        lineCount: bucket.count,
      }))
      .sort((a, b) => a.boxNo - b.boxNo),
    unboxed: [...unboxed.values()].sort(
      (a, b) =>
        a.disposition.localeCompare(b.disposition) || a.accountCode.localeCompare(b.accountCode),
    ),
  }
}

// --- the exhaustive partition -------------------------------------------------------------------

export interface Vat201PartitionCensus {
  readonly linesInPeriod: number
  readonly linesEnumerated: number
  readonly linesDistinct: number
  /** Lines whose account carries no attribution. ZY001 makes this unreachable; it is COUNTED anyway. */
  readonly unattributed: readonly string[]
  /** `entryId/lineNo` seen more than once. A line counted twice is a box total silently too large. */
  readonly duplicated: readonly string[]
  readonly boxed: number
  readonly unallocated: number
  readonly outOfScope: number
}

/**
 * The partition, as a measurement rather than as an assertion.
 *
 * The acceptance line is "the union of journal lines behind every box plus the out-of-scope bucket equals
 * every journal line in the period, with no line counted twice and none unattributed". All three halves
 * are separate failures and each is reported separately, because a single boolean cannot tell a dropped
 * line from a duplicated one and the two are fixed in different places.
 */
export function vat201PartitionCensus(
  lines: readonly Vat201Line[],
  attributions: readonly Vat201Attribution[],
): Vat201PartitionCensus {
  const byAccount = new Map(attributions.map((a) => [a.accountCode as string, a]))
  const seen = new Map<string, number>()
  const unattributed: string[] = []
  let boxed = 0
  let unallocated = 0
  let outOfScope = 0

  for (const line of lines) {
    const key = `${line.entryId}/${line.lineNo}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
    switch (byAccount.get(line.accountCode)?.disposition) {
      case 'box':
        boxed += 1
        break
      case 'unallocated':
        unallocated += 1
        break
      case 'out_of_scope':
        outOfScope += 1
        break
      default:
        unattributed.push(key)
    }
  }

  return {
    linesInPeriod: lines.length,
    linesEnumerated: lines.length,
    linesDistinct: seen.size,
    unattributed,
    duplicated: [...seen.entries()].filter(([, n]) => n > 1).map(([key]) => key),
    boxed,
    unallocated,
    outOfScope,
  }
}

// --- what is not settled, and what each answer changes ------------------------------------------

/**
 * Why a reason belongs on the return rather than only in `docs/OPEN-QUESTIONS.md`.
 *
 * `blocked_on_owner` is not a gate — the working papers an agent reviews have to exist before the agent
 * can review them — but a working paper that did not SAY it was provisional would be filed. So the
 * reasons are rows on the return, each naming its question id and what changes when it is answered, and
 * `vat201WorkingPapers()` refuses to report a return as fileable while any of them stands.
 */
export interface Vat201OpenQuestion {
  readonly questionId: string
  readonly provisionalAnswer: string
  /** What moves in this system when the owner answers. Stated per answer, not as "revisit this". */
  readonly whatChanges: string
}

/**
 * The four questions this return stands on, and exactly what each answer moves.
 *
 * Data rather than prose so that the Unconfirmed Assumptions panel, the working paper and the unit's
 * report are one list. If an answer arrives and this list is not what changes, the list was wrong.
 */
export const VAT201_OPEN_QUESTIONS: readonly Vat201OpenQuestion[] = [
  {
    questionId: 'Y11-vat201-boxes',
    provisionalAnswer:
      'Box 1 (standard-rated supplies), Box 3 (reverse charge) and Box 10 (recoverable input tax) as ' +
      'placeholders, held as rows in vat201_box and vat201_box_mapping.',
    whatChanges:
      'An UPDATE of vat201_box (the numbers, the labels, is_provisional) and of the box_no on the ' +
      'mapping rows. No TypeScript and no SQL function changes, which is what the test that moves a ' +
      'figure between boxes by changing a row proves. If the answer adds a box for zero-rated or exempt ' +
      'supplies, that is an INSERT plus a mapping row for whichever revenue account Y8-coa adds for it; ' +
      "if it allocates blocked input tax, 6090's and 5060's rows go from unallocated to box.",
  },
  {
    questionId: 'Y11-tax-agent',
    provisionalAnswer:
      'The working papers are produced FOR the agent to review and are never asserted correct. Every ' +
      'box is is_provisional and the return reports fileable = false.',
    whatChanges:
      'Nothing computed. The agent either confirms the mapping — in which case is_provisional is ' +
      'cleared, the placeholder markers come out of the labels, and fileable stops being refused for ' +
      'that reason — or supplies different numbers, which is Y11-vat201-boxes. The review itself is ' +
      "recorded by M-VAT-08's sign-off, not here.",
  },
  {
    questionId: 'Y11-vat-package',
    provisionalAnswer:
      'Date of supply at REDEMPTION. A package sale credits 2050 with the whole consideration and ' +
      'touches no VAT account; a redemption credits 4020 the net and 2030 the tax.',
    whatChanges:
      "Which PERIOD the tax falls in, and nothing about this unit's mapping. Under the provisional " +
      "answer a sale period's box 1 holds nothing from packages and the redemption period's box 1 holds " +
      'the tax on what was delivered. If the owner answers supply at SALE, the sale posts the VAT and a ' +
      'redemption only moves the balance — the accounts and therefore the box attributions are the ' +
      'same, the figures move between periods, and a period already filed under the other reading has ' +
      'to be amended. That is a repost in M-TILL-09/10, not a remapping here.',
  },
  {
    questionId: 'Y11-rounding',
    provisionalAnswer: 'Half-up on the net, VAT as the remainder, so net + vat = gross exactly.',
    whatChanges:
      'No box total, by construction. The return sums fils as they were POSTED and applies no rate, so ' +
      'the convention decides only how an invoice split its gross at the moment it was issued, which is ' +
      "M-TILL's. A filed period cannot be restated by re-reading it. What a different convention would " +
      "change is the split between a box's value column and its tax column on invoices issued AFTER " +
      'the change, never the sum of the two.',
  },
] as const

/**
 * The claim gate block 116 enforces over this file and over `0089_vat201_mapping.sql`.
 *
 * Exported as a constant rather than written in a comment so that the gate asserts against a stated
 * claim, and so that deleting the claim is a visible edit rather than the check quietly measuring
 * nothing.
 */
export const NO_ARITHMETIC_BEYOND_ADDITION =
  'The VAT201 return engine adds and subtracts integer fils and does nothing else. No division, no ' +
  'rounding and no VAT rate appears in vat201_box_line, vat201_box_total or vat201SignedFils, which is ' +
  'why the answer to Y11-rounding cannot move a box total by one fils.'
