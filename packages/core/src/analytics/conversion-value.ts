/**
 * The conversion value an ad platform is told, in the one unit both platforms accept.
 *
 * ## Why this is in `packages/core` and not beside the adapters
 *
 * Money arithmetic is `packages/core`'s and this is money arithmetic: integer fils in, a figure in the
 * currency's major unit out. Putting it beside the GA4 and Meta adapters would be two conversions — one
 * per adapter — and two conversions is how two platforms come to be told two different figures for one
 * conversion. That variance is exactly what A-MEAS-07 reports and exactly what nobody could attribute,
 * because both sides would look internally consistent.
 *
 * ## The round trip is the claim, not the formatting
 *
 * Both platforms take `value` as a decimal in the major unit, and this build stores integer fils,
 * VAT-inclusive gross authoritative (ADR 0007). The dangerous half is not the division: it is that
 * `fils / 100` is a binary float, so `32010 / 100` is `320.1` and `fils * 100` on the way back can land a
 * fils either side. A figure that is one fils out is not an error anywhere — it is a conversion value the
 * platform reports and the journal does not, and the difference shows up as an unattributable variance in
 * a reconciliation months later.
 *
 * So the conversion goes through `toDecimalString`, which is integer arithmetic (`floor(abs / 100)` and
 * `abs % 100`) and cannot be a fils out, and {@link filsFromConversionValue} parses the two parts back as
 * integers rather than multiplying a float. The round trip is then exact by construction over every
 * integer, and `conversion-value.test.ts` asserts it as a property across the whole range the catalogue
 * uses rather than over a handful of examples.
 *
 * ## Negative values are first-class
 *
 * A credit note pushes a negative value equal to the credit, and a no-show pushes a compensating void
 * (A-MEAS-05), so the sign is part of the figure and not an error to be clamped. `toDecimalString` already
 * handles it, and the property test covers the negative range for the reason the positive one is covered:
 * `-1` fils is `-0.01`, and an implementation that formatted the magnitude and lost the sign would turn a
 * refund into a second sale.
 */

import { AppError } from '@berelax/shared'
import { type Fils, filsFrom, money, toDecimalString } from '../money.ts'

/** The currency every figure here is in. AED is the legal entity's, not a payload's (ADR 0007). */
export const CONVERSION_VALUE_CURRENCY = 'AED'

/**
 * The exact two-decimal representation of an integer fils amount.
 *
 * A STRING, deliberately, and the `number` form is {@link conversionValueNumber} one function down. The
 * string is what the round trip is stated over, because a string has no representation question — and a
 * caller that wants the number gets it from a function whose name says a float is being produced.
 */
export function conversionValueFromFils(fils: number): string {
  if (!Number.isInteger(fils)) {
    throw new AppError(
      'validation',
      `A conversion value was asked for from ${fils} fils, which is not a whole number. Money is ` +
        'integer fils in this build (ADR 0007), and a fractional fils here is a figure that came from a ' +
        'float somewhere upstream — pushing it would report a value the journal cannot produce.',
      { details: { fils } },
    )
  }
  return toDecimalString(money(filsFrom(fils)))
}

/**
 * The number form, for a JSON body.
 *
 * `Number(...)` of the exact string rather than `fils / 100`, which is the same value for every amount
 * this catalogue reaches and is NOT the same statement: the string is the authority, and parsing it is
 * what keeps the body and the stored figure derived from one expression. `fils / 100` beside
 * {@link conversionValueFromFils} would be the second statement of one fact, which drifts.
 */
export function conversionValueNumber(fils: number): number {
  return Number(conversionValueFromFils(fils))
}

/**
 * Integer fils from a two-decimal figure, exactly.
 *
 * Parses the two parts as integers rather than multiplying a float, so there is no rounding step to get
 * wrong. A figure with more than two decimal places is REFUSED rather than rounded: this build cannot
 * represent it, and rounding it here would silently decide which way a half-fils goes in a value somebody
 * reconciles against a tax invoice.
 */
export function filsFromConversionValue(value: string): Fils {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (match === null) {
    throw new AppError(
      'validation',
      `${JSON.stringify(value)} is not a conversion value this build can represent. Two decimal places ` +
        'at most, because money is integer fils (ADR 0007) — and rounding a third place here would ' +
        'silently decide which way a half-fils goes in a figure somebody reconciles against an invoice.',
      { details: { value } },
    )
  }
  const [, sign = '', major = '0', minorRaw = ''] = match
  const minor = minorRaw.padEnd(2, '0')
  const magnitude = Number.parseInt(major, 10) * 100 + Number.parseInt(minor, 10)
  return filsFrom(sign === '-' ? -magnitude : magnitude)
}

/* ------------------------------------------------------------------------------------------------
 * The conversion LEDGER (A-MEAS-05): a corrected value is a new statement, not an edit.
 * ------------------------------------------------------------------------------------------------ */

/**
 * Why a statement about one conversion's value exists.
 *
 * ## A correction is append-only, and that is forced rather than chosen
 *
 * The obvious design is one dispatch per conversion whose value is updated when the figure changes. Three
 * separate things in this build forbid it, and they agree:
 *
 *   - **ZY451** freezes a transmitted dispatch's payload, because A-MEAS-07 reconciles internal truth
 *     against what was PUSHED and a pushed side that can be edited to agree with the other is not a
 *     comparison. A corrected figure written over the wrong one makes every variance zero.
 *   - **The platform deduplicates on `event_id`.** A correction re-sent under the original's id is
 *     discarded, so the wrong number stays and nothing says so — the worst of the three outcomes, because
 *     it looks like the correction worked.
 *   - **The journal is append-only** (ADR 0008), and a credit note is the only correction to an issued
 *     document (M-TILL-08). A conversion ledger that edited would disagree with the document ledger that
 *     cannot, and the disagreement would be in whichever direction nobody checked.
 *
 * So each statement carries its own revision — {@link AnalyticsEventSubject.revision}, which is what makes
 * its `event_id` its own — its own instant, and a value that is a DELTA. The platform's figure for a
 * conversion is the sum, which is why `no_show_void` is exactly the negative of what was pushed and why
 * {@link conversionLedgerNetFils} is an arithmetic claim rather than a description.
 */
export const CONVERSION_STATEMENT_REASONS = [
  'initial',
  'no_show_void',
  'credit_note',
  'invoice_correction',
  'package_redemption',
] as const
export type ConversionStatementReason = (typeof CONVERSION_STATEMENT_REASONS)[number]

export interface ConversionStatement {
  /** 0 for the original; 1, 2, … for each correction, in the order they were made. */
  readonly revision: number
  readonly reason: ConversionStatementReason
  /**
   * The DELTA this statement contributes, integer fils, signed.
   *
   * A delta and not an absolute figure, because the platform's number for a conversion is the sum over the
   * ids it has seen and the earlier ones cannot be withdrawn. An absolute figure would make the void
   * `0` — which sums to the original rather than to nothing — and the acceptance line is that a
   * booking followed by a no-show sums to exactly zero fils.
   */
  readonly valueFils: number
  /**
   * When the fact this statement is about HAPPENED. Never the instant of the pass.
   *
   * Each statement has its OWN instant rather than inheriting the conversion's: a credit note raised three
   * weeks after a treatment is a fact about the day it was raised, and a platform dates every statement on
   * the value it is given. Stamping a correction with the original's instant would put it inside an
   * attribution window it does not belong to; stamping it with `now()` would put the ORIGINAL there too,
   * which is A-MEAS-05's own subject.
   */
  readonly occurredAtIso: string
}

/**
 * The arithmetic over a conversion's statements. Integer fils, exact, no float anywhere.
 *
 * This is the assertion the no-show acceptance line names — *"dispatch rows whose values sum to exactly
 * zero fils"* — and it is a function rather than a test helper so that the suite and the pass agree about
 * what the sum IS. A test that summed the rows itself would be a second statement of this.
 */
export function conversionLedgerNetFils(statements: readonly ConversionStatement[]): number {
  let net = 0
  for (const statement of statements) {
    if (!Number.isInteger(statement.valueFils)) {
      throw new AppError(
        'invariant_violated',
        `A conversion statement carries ${statement.valueFils} fils, which is not a whole number. Money ` +
          'is integer fils (ADR 0007), and a fractional fils in this sum is a float arriving from ' +
          'upstream — the figure would be one the journal cannot produce.',
        { details: { revision: statement.revision, reason: statement.reason } },
      )
    }
    net += statement.valueFils
  }
  return net
}

/** What happened to one conversion, in this build's own vocabulary. The pass reads it off the till. */
export interface ConversionOutcome {
  /**
   * What the conversion was worth when it was first pushed, integer fils.
   *
   * For an invoiced treatment this is the invoice GROSS and never the booking estimate — VAT-inclusive
   * gross is the authoritative figure (ADR 0007), and a discount, a promotion or a price-list change means
   * the estimate and the gross are different numbers. Pushing the estimate would report revenue the
   * journal never saw, which is the variance A-MEAS-07 exists to find and nobody could attribute.
   */
  readonly initialFils: number
  /** When the treatment, payment or visit happened. For an offline upload, days before the pass. */
  readonly occurredAtIso: string
  /**
   * The conversion did not happen after all: the appointment was a no-show.
   *
   * A VOID and not a deletion, because the original push cannot be withdrawn from the platform. The void's
   * value is exactly `-initialFils`, so the two statements sum to zero.
   */
  readonly noShow?: { readonly atIso: string } | undefined
  /** A credit note or partial refund, with the credited GROSS as a positive figure. */
  readonly credited?: { readonly grossFils: number; readonly atIso: string } | undefined
  /**
   * The figure already pushed, when it differs from {@link initialFils}.
   *
   * The discounted-invoice case arriving the other way round: a conversion pushed on the booking carries
   * the estimate, and the invoice is later issued for a different gross. The correction is the DIFFERENCE,
   * so the sum is the gross — not a second absolute figure, which would double the conversion.
   */
  readonly alreadyPushedFils?: number | undefined
}

/**
 * Every statement a conversion's outcome produces, in order, with the revisions that make their ids.
 *
 * Pure, total over its input, and the one place the four corrections in this unit's acceptance lines are
 * decided. The pass reads facts off the till and asks this; the integration suite asserts the SUM over the
 * dispatch rows the pass wrote. Neither holds a second copy of the arithmetic.
 *
 * The order is the revision order, and it is not cosmetic: the revision is a component of the `event_id`,
 * so two corrections swapping places would swap their identities and a replay would write a different row.
 */
export function conversionStatements(outcome: ConversionOutcome): readonly ConversionStatement[] {
  const statements: ConversionStatement[] = []
  const push = (
    reason: ConversionStatementReason,
    valueFils: number,
    occurredAtIso: string,
  ): void => {
    statements.push({ revision: statements.length, reason, valueFils, occurredAtIso })
  }

  if (!Number.isInteger(outcome.initialFils)) {
    throw new AppError(
      'validation',
      `A conversion was asked for at ${outcome.initialFils} fils, which is not a whole number. Money is ` +
        'integer fils in this build (ADR 0007).',
      { details: { initialFils: outcome.initialFils } },
    )
  }

  /*
   * The invoice-correction case, and the reason it comes FIRST.
   *
   * `alreadyPushedFils` is what a platform has been told; `initialFils` is what the document says. When
   * they differ the initial statement is the figure that WENT OUT, because that is the one the platform
   * deduplicates under the original id, and the difference is a correction on top. Writing the corrected
   * figure as the initial statement would be an edit of a dispatch that is frozen (ZY451), and sending it
   * as a second absolute figure would double the conversion.
   */
  const pushed = outcome.alreadyPushedFils
  if (pushed !== undefined && pushed !== outcome.initialFils) {
    push('initial', pushed, outcome.occurredAtIso)
    push('invoice_correction', outcome.initialFils - pushed, outcome.occurredAtIso)
  } else {
    push('initial', outcome.initialFils, outcome.occurredAtIso)
  }

  if (outcome.noShow !== undefined) {
    /*
     * The void is the negative of everything stated so far and not of `initialFils`.
     *
     * The distinction is the whole acceptance line. A no-show after a corrected invoice has had TWO
     * figures pushed, and a void of `-initialFils` alone would leave the correction standing — so the
     * ledger would sum to the correction rather than to nothing, which is a conversion worth the discount.
     */
    push('no_show_void', -conversionLedgerNetFils(statements), outcome.noShow.atIso)
  }

  const credited = outcome.credited
  if (credited !== undefined) {
    if (!Number.isInteger(credited.grossFils) || credited.grossFils < 0) {
      throw new AppError(
        'validation',
        `A credit of ${credited.grossFils} fils is not a whole non-negative amount. A credit note's gross ` +
          "is a positive figure and the SIGN is this function's to apply — a negative credit would push a " +
          'positive value and report a refund as a second sale.',
        { details: { grossFils: credited.grossFils } },
      )
    }
    push('credit_note', -credited.grossFils, credited.atIso)
  }

  return statements
}

/**
 * The statements a PACKAGE produces, which is the one case whose figure is a provisional position.
 *
 * `Y11-vat-package` is open and the provisional position is recorded on A-MEAS-05's manifest entry and in
 * ADR 0092: *conversion value and date of supply are recognised at REDEMPTION; a package sale creates a
 * deferred-revenue liability and pushes zero conversion value.*
 *
 * So a sale is a statement worth ZERO rather than no statement at all, and that is deliberate. A sale with
 * no dispatch is indistinguishable from a sale the pass never saw, which is the distinction A-MEAS-07's
 * whole classification rests on — `missing` against `intentionally_not_pushed`. A zero-value conversion
 * records that the sale was considered and valued at nothing yet.
 *
 * If `Y11-vat-package` answers the other way — value at the sale — this function changes and nothing else
 * does: the ledger, the dispatch rows and the reconciliation are all arithmetic over whatever it returns.
 */
export function packageConversionStatements(input: {
  readonly saleAtIso: string
  readonly redemption?:
    | { readonly releasedFils: number; readonly redeemedAtIso: string }
    | undefined
}): readonly ConversionStatement[] {
  const statements: ConversionStatement[] = [
    {
      revision: 0,
      reason: 'initial',
      // Zero, and stated rather than omitted. See the header.
      valueFils: 0,
      occurredAtIso: input.saleAtIso,
    },
  ]
  const redemption = input.redemption
  if (redemption === undefined) return statements
  if (!Number.isInteger(redemption.releasedFils) || redemption.releasedFils < 0) {
    throw new AppError(
      'validation',
      `A package redemption released ${redemption.releasedFils} fils, which is not a whole non-negative ` +
        'amount. The figure is the gross released from the liability at redemption (M-TILL-09).',
      { details: { releasedFils: redemption.releasedFils } },
    )
  }
  statements.push({
    revision: 1,
    reason: 'package_redemption',
    valueFils: redemption.releasedFils,
    occurredAtIso: redemption.redeemedAtIso,
  })
  return statements
}

/**
 * Why an offline conversion's instant may not be the instant of the pass, as a value.
 *
 * The acceptance line is *"event_time equal to the actual past visit instant, inside the provider's
 * accepted window and never now()"*, and the window is the half this build does not have: the accepted age
 * for a past event is the platform's figure and nobody has it on file here. So nothing clamps, truncates
 * or warns against a number — `META_PAST_EVENT_WINDOW_IS_AN_OPEN_QUESTION` in `@berelax/analytics` says so
 * in the adapter, and this is the pure half of the same refusal to guess (brief rule 15).
 */
export const OFFLINE_CONVERSION_INSTANT_IS_THE_VISIT =
  'An offline conversion carries the instant of the actual visit, payment or credit note and never the ' +
  'instant of the pass that uploaded it: a platform dates the conversion on this value and every ' +
  'attribution window is measured from it, so a conversion stamped with the pass instant is credited to ' +
  'whatever campaign was running on the night the worker ran. The accepted AGE for a past event is the ' +
  "platform's figure and is not on file in this build (OPEN-QUESTIONS Y1-analytics-credentials), so no " +
  'window is assumed and nothing is clamped to one.'

/**
 * Refuses a statement dated at or after the instant of the pass that would upload it.
 *
 * The one check that makes the acceptance line's *"never now()"* a property rather than a hope. It is here
 * rather than in the pass because it is arithmetic over two instants and nothing else, and because the
 * database's own `occurred_at <= decided_at` (0137) cannot see the difference between "the visit was two
 * days ago" and "the visit was this instant": equality satisfies it, and equality is exactly what a clock
 * read in the wrong place produces.
 */
export function assertStatementIsInThePast(input: {
  readonly statement: ConversionStatement
  readonly passAtIso: string
}): void {
  const at = Date.parse(input.statement.occurredAtIso)
  const pass = Date.parse(input.passAtIso)
  if (Number.isNaN(at) || Number.isNaN(pass)) {
    throw new AppError(
      'validation',
      `A conversion statement was dated ${JSON.stringify(input.statement.occurredAtIso)} and the pass ` +
        `${JSON.stringify(input.passAtIso)}; one of them is not an instant, so neither the window nor the ` +
        'ordering could be judged.',
      { details: { occurredAtIso: input.statement.occurredAtIso, passAtIso: input.passAtIso } },
    )
  }
  if (at < pass) return
  throw new AppError(
    'invariant_violated',
    `A conversion statement is dated ${input.statement.occurredAtIso}, which is not before the pass at ` +
      `${input.passAtIso}. ${OFFLINE_CONVERSION_INSTANT_IS_THE_VISIT}`,
    {
      details: {
        revision: input.statement.revision,
        reason: input.statement.reason,
        occurredAtIso: input.statement.occurredAtIso,
        passAtIso: input.passAtIso,
      },
    },
  )
}
