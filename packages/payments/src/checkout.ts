import type { IdempotencyKey, InstrumentToken, TenderKind } from '@berelax/core'
import { filsFrom, money } from '@berelax/core'
import type { Actor, PaymentIntentRow, Sql } from '@berelax/db'
import { paymentIntentError, withUnitOfWork } from '@berelax/db'
import { createPaymentIntent } from './intent.ts'
import { assertNoCardData, CardDataRefused, redactCardData } from './redaction.ts'
import type { PaymentGatewayRegistry } from './registry.ts'

/**
 * The ONE place a card-payment submission is read, refused, and turned into an authorisation (Y-PAY-03).
 *
 * Two transports reach a hosted-fields checkout — the admin screen's own `<form>` POST and the JSON endpoint
 * the gateway's script posts the token to — and they are one BOUNDARY, here, not two. That is the point of the
 * file rather than a tidiness preference. The boundary's first act is {@link assertNoCardData}, and the
 * failure this unit exists to prevent is a second transport that forgets it: one endpoint checks, the other
 * does not, and the second is the one somebody adds in six months for a different client. `pnpm saq-a`
 * requires every payments transport to route through this module, with a known-bad fixture per rule (ADR
 * 0003), and the requirement is satisfiable exactly because there is one function to route through.
 *
 * ## The order of the checks, which is load-bearing
 *
 * Card data is refused FIRST — before the amount is parsed, before the reference is trimmed, before anything
 * is logged and before a single statement is issued. Every other refusal here names a field, which means it
 * constructs a message about the submission, and a message about a submission that has not yet been cleared
 * of card data is a message that may carry one. So the sequence is: refuse card data, then read the rest.
 *
 * The consequence, which is easy to misread as a bug: a submission with BOTH a card number in `reference` AND
 * a missing amount is reported as `card_data_refused` and nothing else. That is deliberate — the caller is
 * told the one thing they must fix before anybody looks at the rest.
 *
 * ## Nothing here logs the submission
 *
 * No branch of this module puts a submitted value into a message, an audit payload or an outbox payload.
 * `redactCardData` is exported alongside for the callers that must record something about a refusal, and the
 * audit row this module writes carries the refusal NAME, the field PATHS and no value at all.
 */

/** Every field a checkout submission may carry, and there are four. */
export const CHECKOUT_FIELDS = {
  /** The opaque token the gateway's hosted fields produced. The one value that crosses the origin boundary. */
  instrumentToken: 'instrumentToken',
  /** Integer fils, VAT-inclusive gross (ADR 0007). */
  amountFils: 'amountFils',
  /** The invoice or booking this pays for. Free text, so the one field a PAN could be typed into. */
  reference: 'reference',
  /** The caller's key for this attempt, drawn per attempt and never reused (the port's rule). */
  idempotencyKey: 'idempotencyKey',
} as const

/**
 * The field names, as a list, for the gate and for the parser.
 *
 * `scripts/check-saq-a.mjs` reads this and refuses a name that normalises into `CARD_DATA_FIELD_NAMES`. That
 * is the structural half of "no field this build renders may accept a card number": the markup is scanned for
 * an input, and the CONTRACT is scanned here, so a card field cannot arrive by either route.
 */
export const CHECKOUT_FIELD_NAMES: readonly string[] = Object.freeze(Object.values(CHECKOUT_FIELDS))

/** Why a submission was refused, by name. A closed set, so a refusal with no wording is a type error. */
export const CHECKOUT_REFUSALS = [
  'card_data_refused',
  'instrument_token_missing',
  'amount_missing',
  'amount_not_integer_fils',
  'amount_not_positive',
  'reference_missing',
  'idempotency_key_missing',
  'unreadable_request',
  'write_refused',
] as const
export type CheckoutRefusal = (typeof CHECKOUT_REFUSALS)[number]

/**
 * The sentence each refusal puts in front of a person. Total over the set by type.
 *
 * Every sentence is about the SHAPE of the request and none quotes a value, for this module's reason: these
 * strings reach a screen, a JSON body and a log line, and a sentence that echoed the submission would leak
 * through all three at once.
 */
export const CHECKOUT_REFUSAL_SENTENCES: Readonly<Record<CheckoutRefusal, string>> = Object.freeze({
  card_data_refused:
    'The request carried something shaped like a card number, or a field named after card data, and was ' +
    'refused without being read further. Card details are typed into the gateway’s own fields and never ' +
    'into this form. The value is deliberately not repeated here, in the response, or in any log.',
  instrument_token_missing:
    'No gateway token was presented, so there is nothing to authorise against. A submission with no token ' +
    'did not come from the card fields.',
  amount_missing: 'An amount in fils is required.',
  amount_not_integer_fils: 'The amount must be a whole number of fils. Nothing here rounds money.',
  amount_not_positive: 'The amount must be greater than zero.',
  reference_missing:
    'A reference is required: it is what ties the payment to an invoice or a booking, and a blank one ' +
    'produces a payment nobody can reconcile.',
  idempotency_key_missing:
    'An idempotency key is required. It is what makes a retry return the first answer instead of ' +
    'authorising twice.',
  unreadable_request: 'The request could not be read as a checkout submission.',
  write_refused: 'The ledger refused the write. Nothing was authorised and nothing was recorded.',
})

/** A submission this module is willing to act on. Every field present, typed and non-blank. */
export interface CheckoutSubmission {
  readonly instrumentToken: InstrumentToken
  readonly amountFils: number
  readonly reference: string
  readonly idempotencyKey: IdempotencyKey
}

export type CheckoutParse =
  | { readonly kind: 'submission'; readonly submission: CheckoutSubmission }
  | {
      readonly kind: 'refused'
      readonly refusal: CheckoutRefusal
      /** The paths card data was found at, for `card_data_refused`. Names, never values. */
      readonly paths: readonly string[]
    }

/** A request body as either transport delivers it: parsed JSON, or a form's `URLSearchParams`. */
export type CheckoutBody = URLSearchParams | Record<string, unknown>

const fieldOf = (body: CheckoutBody, name: string): unknown =>
  body instanceof URLSearchParams ? (body.get(name) ?? undefined) : body[name]

/**
 * Reads a submission, refusing card data first and everything else after.
 *
 * Pure: no clock, no connection, no configuration. `packages/payments/src/checkout.test.ts` drives every
 * refusal and the control, which is what makes each one a rule that has been seen to fire rather than a
 * branch nobody has reached.
 *
 * The amount is read from a STRING as well as a number, because a `<form>` delivers everything as text. It
 * goes through `filsFrom`, which is the one place ADR 0007's integer rule lives: `'200.5'` is a refusal and
 * not a rounding, because rounding here would move real money.
 */
export function parseCheckoutSubmission(body: CheckoutBody): CheckoutParse {
  // FIRST, before any field is read for its own sake. See the module header on why the order matters.
  try {
    assertNoCardData(
      body instanceof URLSearchParams ? Object.fromEntries(body) : body,
      'the checkout',
    )
  } catch (error) {
    if (error instanceof CardDataRefused) {
      return {
        kind: 'refused',
        refusal: 'card_data_refused',
        paths: error.findings.map((finding) => finding.path),
      }
    }
    throw error
  }

  const refused = (refusal: CheckoutRefusal): CheckoutParse => ({
    kind: 'refused',
    refusal,
    paths: [],
  })

  const token = fieldOf(body, CHECKOUT_FIELDS.instrumentToken)
  if (typeof token !== 'string' || token.trim() === '') return refused('instrument_token_missing')

  const key = fieldOf(body, CHECKOUT_FIELDS.idempotencyKey)
  if (typeof key !== 'string' || key.trim() === '') return refused('idempotency_key_missing')

  const reference = fieldOf(body, CHECKOUT_FIELDS.reference)
  if (typeof reference !== 'string' || reference.trim() === '') return refused('reference_missing')

  const rawAmount = fieldOf(body, CHECKOUT_FIELDS.amountFils)
  if (rawAmount === undefined || rawAmount === null || rawAmount === '')
    return refused('amount_missing')
  const amountNumber = typeof rawAmount === 'number' ? rawAmount : Number(rawAmount)
  if (!Number.isFinite(amountNumber)) return refused('amount_not_integer_fils')
  try {
    filsFrom(amountNumber)
  } catch {
    return refused('amount_not_integer_fils')
  }
  if (amountNumber <= 0) return refused('amount_not_positive')

  return {
    kind: 'submission',
    submission: {
      instrumentToken: token as InstrumentToken,
      amountFils: amountNumber,
      reference: reference.trim(),
      idempotencyKey: key.trim() as IdempotencyKey,
    },
  }
}

export interface CheckoutDeps {
  readonly sql: Sql
  readonly registry: PaymentGatewayRegistry
  /** Who the audit row names. A REAL principal: the checkout is behind `guardAdminRoute`. */
  readonly actor: Actor
}

export type CheckoutOutcome =
  | {
      readonly kind: 'authorised'
      readonly intent: PaymentIntentRow
      readonly outcome: 'created' | 'replayed'
    }
  | {
      readonly kind: 'refused'
      readonly refusal: CheckoutRefusal
      readonly paths: readonly string[]
    }

/**
 * The instrument a hosted-fields checkout takes, and there is exactly one.
 *
 * Named here rather than read from the body. A submission that could choose its instrument could choose
 * `cash` — which `ZY165` refuses and the intent endpoint refuses with a 400, so it is not a hole — and the
 * reason not to offer the choice at all is narrower: money taken at the desk is recorded against the invoice
 * and posted in the same transaction (M-TILL-07), so an intent beside it posts the same money twice. A card
 * typed into a gateway's hosted fields is `card_online` and nothing else.
 */
export const CHECKOUT_INSTRUMENT: TenderKind = 'card_online'

/**
 * Takes the payment: one authorisation, one audit row, and the token forwarded and never stored.
 *
 * A refused submission writes an audit row too, and that row is the reason the refusal path is not a bare
 * 400. A request carrying card data is either an operator's accident or somebody probing the endpoint, and
 * telling those apart later needs the attempt on the trail — the same argument `recordClientCallback` makes
 * for auditing a claim it refuses to act on. The row carries the refusal name and the field PATHS; it carries
 * no value, and `redactCardData` is applied to the paths as well, because a path is a string somebody else
 * chose and a caller that posted `{"4111111111111111": "x"}` would otherwise write the number into the key.
 */
export async function authoriseCheckout(
  deps: CheckoutDeps,
  body: CheckoutBody,
): Promise<CheckoutOutcome> {
  const parsed = parseCheckoutSubmission(body)
  if (parsed.kind === 'refused') {
    await withUnitOfWork(deps.sql, deps.actor, async (uow) => {
      await uow.audit.record({
        action: 'payment.checkout_refused',
        entityType: 'payment_intent',
        operation: 'denied',
        after: {
          refusal: parsed.refusal,
          paths: redactCardData(parsed.paths),
        },
      })
    })
    return { kind: 'refused', refusal: parsed.refusal, paths: parsed.paths }
  }

  const submission = parsed.submission
  const gateway = deps.registry.byInstrument(CHECKOUT_INSTRUMENT)
  try {
    const result = await withUnitOfWork(deps.sql, deps.actor, (uow) =>
      createPaymentIntent(uow, gateway, {
        idempotencyKey: submission.idempotencyKey,
        amount: money(filsFrom(submission.amountFils)),
        instrument: CHECKOUT_INSTRUMENT,
        reference: submission.reference,
        // The one place the token goes. Forwarded to the adapter, never written to a column and never put on
        // an audit or outbox payload — see `CreatePaymentIntentRequest`.
        instrumentToken: submission.instrumentToken,
      }),
    )
    return { kind: 'authorised', intent: result.intent, outcome: result.outcome }
  } catch (error) {
    // A named database refusal — ZY231 among them — is reported as `write_refused` and never by echoing the
    // driver's message, because a driver error can carry the statement. `paymentIntentError` is consulted so
    // that an error which is NOT one of ours still propagates: swallowing everything here would turn a lost
    // connection into "the ledger refused the write", which sends somebody to look at the wrong thing.
    if (paymentIntentError(error) !== null) {
      return { kind: 'refused', refusal: 'write_refused', paths: [] }
    }
    throw error
  }
}
