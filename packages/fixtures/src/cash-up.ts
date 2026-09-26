import type { AccountCode, EntryId, JournalEntry, LocalDate } from '@berelax/core'
import {
  cashDropPosting,
  cashSessionCorrection,
  cashUpPosting,
  type DrawerReconciliation,
  type DrawerTakings,
  filsFrom,
  money,
  reconcileDrawer,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import type {
  CloseCashSessionInput,
  DrawerTakingsRow,
  JournalEntryInput,
  PostCashSessionAdjustmentInput,
  RecordCashDropInput,
} from '@berelax/db'

/**
 * The mapping between `@berelax/core`'s cash-up rule and `@berelax/db`'s writer.
 *
 * `packages/db` may never import `packages/core` — the dependency runs the other way — so something has
 * to turn a drawer's takings and its count into the two structural mirrors `closeCashSession` takes: the
 * snapshot figures, and the `JournalEntryInput` for the discrepancy. `packages/fixtures` is the package
 * allowed to depend on both, which is what `checkout.ts` is for the checkout side and `credit-note.ts`
 * for the correction side, and the till route will call this.
 *
 * Nothing here decides an account, rounds anything or derives a date. The accounts come from
 * `cashUpPosting`, the arithmetic from `expectedFloat`, and the business day is the session's own — which
 * is the one the caller resolved with `resolveTradingDate`, because trading runs 11:00–02:00 and a shift
 * that ends at 02:00 belongs to the date it opened on.
 *
 * ## Why the posting is OPTIONAL in the result
 *
 * Because a balanced drawer must post nothing. `journal_line_exactly_one_side` (0018) refuses a
 * zero-value line, so the only entry a balanced cash-up could produce is an entry about some other
 * figure, and `ZU004` refuses a closed session that names one. `cashUpPosting` throws `DrawerBalances`
 * rather than returning an empty entry, so the `undefined` here is caught once, in one place, instead of
 * at every call site.
 */

/** `DrawerTakingsRow` from `@berelax/db` in core's spelling. Field for field; nothing is derived. */
export function toCoreTakings(row: DrawerTakingsRow): DrawerTakings {
  return Object.freeze({
    openingFloatFils: row.openingFloatFils,
    cashReceivedFils: row.cashReceivedFils,
    changeGivenFils: row.changeGivenFils,
    cashRefundedFils: row.cashRefundedFils,
    dropsFils: row.dropsFils,
  })
}

export interface CashUpMappingInput {
  /** The session being counted, as the database holds its identity. */
  readonly cashSessionId: string
  readonly drawerCode: string
  /** From `cash_drawer.posting_account_code`. Read, never assumed to be `1010`. */
  readonly drawerAccount: AccountCode
  /** The session's BUSINESS DAY, as `readCashSession` returned it. */
  readonly businessDay: LocalDate
  /** The five figures, as `readDrawerTakings` returned them. */
  readonly takings: DrawerTakingsRow
  /** What was physically counted, in fils. `undefined` is the `CountRequired` case. */
  readonly countedFloatFils: number | undefined
  /** Allocated by the caller. Core never invents an id, and neither does this. */
  readonly entryId: EntryId
  /** Why the drawer is out. Required by `cash_session_variance_needs_a_reason` when it is. */
  readonly countNote?: string
}

export interface CashUpMapping {
  /** What core decided, including the signed discrepancy. */
  readonly reconciliation: DrawerReconciliation
  /** The cash-up entry, or `undefined` when the drawer balanced exactly. */
  readonly posting: JournalEntry | undefined
  /** Ready for `closeCashSession`. */
  readonly input: CloseCashSessionInput
}

/** Maps a drawer's takings and its count onto `closeCashSession`'s input. */
export function cashUpMapping(options: CashUpMappingInput): CashUpMapping {
  const takings = toCoreTakings(options.takings)
  const reconciliation = reconcileDrawer(
    takings,
    options.countedFloatFils === undefined ? undefined : money(filsFrom(options.countedFloatFils)),
    { drawerCode: options.drawerCode, businessDay: options.businessDay },
  )

  const posting =
    reconciliation.discrepancyFils === 0
      ? undefined
      : cashUpPosting(
          {
            entryId: options.entryId,
            businessDay: options.businessDay,
            drawerCode: options.drawerCode,
            drawerAccount: options.drawerAccount,
            reconciliation,
            countNote: options.countNote ?? '',
          },
          STANDARD_SPA_CHART,
        )

  return {
    reconciliation,
    posting,
    input: {
      cashSessionId: options.cashSessionId,
      countedFloatFils: reconciliation.countedFils,
      takings: options.takings,
      ...(options.countNote === undefined ? {} : { countNote: options.countNote }),
      ...(posting === undefined ? {} : { posting: toEntryInput(posting) }),
    },
  }
}

export interface CashDropMappingInput {
  readonly cashSessionId: string
  readonly drawerCode: string
  readonly drawerAccount: AccountCode
  readonly businessDay: LocalDate
  /** `1020 Bank current` for a banking, `1015 Petty cash float` for the safe. */
  readonly destinationAccount: AccountCode
  readonly amountFils: number
  readonly reason: string
  readonly reference?: string
  readonly entryId: EntryId
}

/** Maps a mid-shift drop onto `recordCashDrop`'s input. */
export function cashDropMapping(options: CashDropMappingInput): {
  readonly posting: JournalEntry
  readonly input: RecordCashDropInput
} {
  const posting = cashDropPosting(
    {
      entryId: options.entryId,
      businessDay: options.businessDay,
      drawerCode: options.drawerCode,
      drawerAccount: options.drawerAccount,
      destinationAccount: options.destinationAccount,
      amount: money(filsFrom(options.amountFils)),
      reason: options.reason,
    },
    STANDARD_SPA_CHART,
  )
  return {
    posting,
    input: {
      cashSessionId: options.cashSessionId,
      amountFils: options.amountFils,
      destinationAccountCode: options.destinationAccount,
      reason: options.reason,
      ...(options.reference === undefined ? {} : { reference: options.reference }),
      posting: toEntryInput(posting),
    },
  }
}

export interface CashSessionCorrectionMappingInput {
  readonly cashSessionId: string
  readonly drawerCode: string
  readonly drawerAccount: AccountCode
  /** The business day the CORRECTION posts on, which the caller got from `earliestOpenDateFrom`. */
  readonly businessDay: LocalDate
  /** The business day of the session being corrected. */
  readonly correctsBusinessDay: LocalDate
  /** Signed: positive means the drawer held MORE than the close recorded. */
  readonly amountFils: number
  readonly reason: string
  readonly entryId: EntryId
}

/** Maps a correction to a closed session onto `postCashSessionAdjustment`'s input. */
export function cashSessionCorrectionMapping(options: CashSessionCorrectionMappingInput): {
  readonly posting: JournalEntry
  readonly input: PostCashSessionAdjustmentInput
} {
  const posting = cashSessionCorrection(
    {
      entryId: options.entryId,
      businessDay: options.businessDay,
      drawerCode: options.drawerCode,
      drawerAccount: options.drawerAccount,
      correctsBusinessDay: options.correctsBusinessDay,
      amountFils: options.amountFils,
      reason: options.reason,
    },
    STANDARD_SPA_CHART,
  )
  return {
    posting,
    input: {
      cashSessionId: options.cashSessionId,
      tradingDate: options.businessDay,
      amountFils: options.amountFils,
      reason: options.reason,
      posting: toEntryInput(posting),
    },
  }
}

/**
 * A core `JournalEntry` in `@berelax/db`'s spelling.
 *
 * The structural mirror, field for field: `Money` becomes integer `debitFils`/`creditFils`, `LocalDate`
 * becomes an ISO string, and the branded `EntryId` becomes a string. Nothing is recomputed, because a
 * mapping that recomputed a figure would be a second opinion about the posting core already decided.
 */
export function toEntryInput(entry: JournalEntry): JournalEntryInput {
  return {
    entryId: entry.entryId as string,
    entryDate: entry.entryDate as string,
    narrative: entry.narrative,
    source: entry.source,
    lines: entry.lines.map((line) => ({
      accountCode: line.account as string,
      debitFils: line.debitFils,
      creditFils: line.creditFils,
      memo: line.memo,
    })),
  }
}
