import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import type { InputVatRecoverability } from './post-bill.ts'

/**
 * Reclassifying an account's input VAT position — the audited write, and the only one.
 *
 * ## Why this exists at all, and why it cannot reach a posted line
 *
 * Y11-blocked-vat is open: whether staff accommodation and transport is a benefit the business is
 * obliged to provide (recoverable) or one it is not (blocked) needs a tax agent, and 0034 recorded the
 * conservative answer. So a reclassification is an expected event rather than a hypothetical one, and it
 * has to be possible **without restating a filed period**.
 *
 * That is exactly what this function cannot do, by construction rather than by care. What a bill claimed
 * is written on `bill_line` when it is posted — `tax_treatment`, `recoverable_input_vat_fils` and
 * `blocked_input_vat_fils` — and both tables refuse UPDATE and DELETE for every role (ADR 0017). The
 * VAT201 working papers sum those columns and never join `account` to decide what was recovered. So this
 * changes what the NEXT bill may record and nothing about the last one, which is the same argument 0026
 * makes for snapshotting the issuer onto an invoice.
 *
 * ## Why it is not a settings screen
 *
 * The application role holds SELECT on `account` and nothing else (0018, asserted by
 * `../repositories/journal.itest.ts`), so this runs as the owner — an accountant's action applied
 * deliberately, on the same footing as a migration. The manifest's "audited settings change" is
 * therefore the `audit_event` row written here, in the same transaction as the UPDATE: who, when, the
 * before and the after, and the reason in their words. Granting the web role UPDATE on the chart would
 * have made a tax position something an authenticated request can change, and the audit row is worth
 * more than the form.
 *
 * ## Both columns, stated
 *
 * The classification is the PAIR (`vat_box`, `input_vat_recoverable`), so the caller states both. A
 * three-valued argument would have to invent a `vat_box` for "recoverable", and 6075 Software and
 * imported services is recoverable under `reverse_charge` — inventing `recoverable_input_tax` there
 * would move it out of the reverse-charge grouping while claiming to have changed only its
 * recoverability. `account_blocked_input_vat_is_not_recoverable` refuses the contradictory pair.
 */

/** The `vat_box` values `account` accepts. Mirrors `VatBox` in `@berelax/core`. */
export const ACCOUNT_VAT_BOXES = [
  'standard_rated_supplies',
  'zero_rated_supplies',
  'exempt_supplies',
  'reverse_charge',
  'output_tax',
  'recoverable_input_tax',
  'blocked_input_tax',
] as const
export type AccountVatBox = (typeof ACCOUNT_VAT_BOXES)[number]

export interface AccountClassification {
  readonly code: string
  readonly name: string
  /** `null` means "feeds no VAT201 grouping", decided. It never means "not yet classified". */
  readonly vatBox: AccountVatBox | null
  readonly inputVatRecoverable: boolean
  /** The position the pair states. The same derivation as `recoverabilityOf` in `@berelax/core`. */
  readonly recoverability: InputVatRecoverability
}

export interface ReclassifyAccountInput {
  readonly code: string
  /** Stated, not derived: see the note on the pair. */
  readonly vatBox: AccountVatBox | null
  readonly inputVatRecoverable: boolean
  /**
   * Why, in the words of whoever decided it. Required, and it goes in the audit row: a reclassification
   * with no stated reason is indistinguishable from a mistake six months later, and the question a tax
   * agent asks about a category is always "on what basis".
   */
  readonly reason: string
  /** The open question this answers or stands in for, e.g. `Y11-blocked-vat`. */
  readonly openQuestionId?: string | null
}

/** The position the pair states, derived in one place so no caller re-implements the precedence. */
export function recoverabilityOfPair(
  vatBox: string | null,
  inputVatRecoverable: boolean,
): InputVatRecoverability {
  if (vatBox === 'blocked_input_tax') return 'blocked'
  if (inputVatRecoverable) return 'recoverable'
  return 'out_of_scope'
}

interface AccountRow {
  code: string
  name: string
  vat_box: string | null
  input_vat_recoverable: boolean
}

const shape = (row: AccountRow): AccountClassification => ({
  code: row.code,
  name: row.name,
  vatBox: row.vat_box as AccountVatBox | null,
  inputVatRecoverable: row.input_vat_recoverable,
  recoverability: recoverabilityOfPair(row.vat_box, row.input_vat_recoverable),
})

/** One account's recovery classification, or `null` if the code is not in the chart. */
export async function readAccountClassification(
  sql: Sql,
  code: string,
): Promise<AccountClassification | null> {
  const [row] = await sql<AccountRow[]>`
    select code, name, vat_box, input_vat_recoverable from account where code = ${code}
  `
  return row === undefined ? null : shape(row)
}

/** Every account whose category blocks input VAT recovery, in code order. */
export async function blockedInputVatAccountCodes(sql: Sql): Promise<readonly string[]> {
  const rows = await sql<{ code: string }[]>`
    select code from account where vat_box = 'blocked_input_tax' order by code
  `
  return rows.map((row) => row.code)
}

/**
 * Reclassifies one account, and records the change.
 *
 * Returns the classification as it now stands. Refuses a no-op: an audit trail whose rows include
 * "changed nothing" is an audit trail somebody stops reading, and a reclassification that did not change
 * anything is a caller who has the account confused with another.
 */
export async function reclassifyAccountRecoverability(
  uow: UnitOfWork,
  input: ReclassifyAccountInput,
): Promise<AccountClassification> {
  if (input.vatBox !== null && !ACCOUNT_VAT_BOXES.includes(input.vatBox)) {
    throw new AppError(
      'validation',
      `Unknown vat_box "${input.vatBox}". It is one of ${ACCOUNT_VAT_BOXES.join(', ')}, or null for ` +
        '"feeds no VAT201 grouping" — which is a decision, not an omission.',
    )
  }
  if (input.reason.trim().length === 0) {
    throw new AppError(
      'validation',
      `Reclassifying account "${input.code}" needs a stated reason. It is the basis a tax agent will ` +
        'ask about, and an audit row that records the change without it answers nothing.',
    )
  }
  if (input.vatBox === 'blocked_input_tax' && input.inputVatRecoverable) {
    // account_blocked_input_vat_is_not_recoverable would refuse this at the UPDATE. Refusing here says
    // what the contradiction IS, which a constraint name does not.
    throw new AppError(
      'validation',
      `Account "${input.code}" cannot be blocked_input_tax and recoverable at once: blocked means the ` +
        'VAT was charged and may not be reclaimed.',
    )
  }

  const before = await readAccountClassification(uow.sql, input.code)
  if (before === null) {
    throw new AppError(
      'not_found',
      `No account "${input.code}" in the chart. Adding one is a migration (0018): a code is never ` +
        'renumbered, because the journal references it and the journal cannot be edited.',
    )
  }
  if (before.vatBox === input.vatBox && before.inputVatRecoverable === input.inputVatRecoverable) {
    throw new AppError(
      'conflict',
      `Account "${input.code}" (${before.name}) is already ${before.recoverability} with vat_box ` +
        `${before.vatBox ?? 'null'}. Nothing to reclassify.`,
    )
  }

  const [updated] = await uow.sql<AccountRow[]>`
    update account
       set vat_box = ${input.vatBox}, input_vat_recoverable = ${input.inputVatRecoverable}
     where code = ${input.code}
    returning code, name, vat_box, input_vat_recoverable
  `
  if (updated === undefined) {
    throw new AppError(
      'invariant_violated',
      `The reclassification of account "${input.code}" returned no row`,
    )
  }
  const after = shape(updated)

  await uow.audit.record({
    action: 'ledger.account.recoverability_reclassified',
    entityType: 'account',
    entityId: input.code,
    operation: 'update',
    before: {
      vatBox: before.vatBox,
      inputVatRecoverable: before.inputVatRecoverable,
      recoverability: before.recoverability,
    },
    after: {
      vatBox: after.vatBox,
      inputVatRecoverable: after.inputVatRecoverable,
      recoverability: after.recoverability,
      reason: input.reason,
      openQuestionId: input.openQuestionId ?? null,
      // Said out loud in the audit row, because it is the question anybody reading this row later is
      // actually asking: does this restate what we filed? It does not — every posted line carries its own
      // treatment and both purchase tables refuse UPDATE.
      appliesTo:
        'bills posted after this change; posted lines keep the treatment they were recorded with',
    },
  })

  return after
}
