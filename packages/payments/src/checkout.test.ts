import { describe, expect, it } from 'vitest'
import {
  CHECKOUT_FIELD_NAMES,
  CHECKOUT_FIELDS,
  CHECKOUT_INSTRUMENT,
  CHECKOUT_REFUSAL_SENTENCES,
  CHECKOUT_REFUSALS,
  type CheckoutBody,
  type CheckoutRefusal,
  parseCheckoutSubmission,
} from './checkout.ts'
import { CARD_DATA_FIELD_NAMES, normaliseFieldName } from './redaction.ts'

/**
 * The checkout submission boundary: every refusal shown to fire, and the control that says they are about the
 * body (Y-PAY-03).
 *
 * Driven through BOTH body shapes on purpose. A `<form>` delivers `URLSearchParams` where every value is a
 * string, and the gateway's script delivers JSON where an amount is a number — so a parser tested against one
 * of them has a branch nothing has ever exercised, and the untested branch is the one a second transport uses.
 */

const PAN = '4111111111111111'

const GOOD = {
  instrumentToken: 'tok_019a3f5c0b2d',
  amountFils: '20000',
  reference: 'INV-2026-0042',
  idempotencyKey: 'checkout-019a3f5c-0b2d-7c9e-8f01-2d3e4f5a6b7c',
} as const

const asForm = (fields: Readonly<Record<string, string>>): URLSearchParams =>
  new URLSearchParams(fields)

/** The same submission as the gateway's script would send it: an amount that is a real number. */
const asJson = (fields: Readonly<Record<string, string>>): Record<string, unknown> => ({
  ...fields,
  ...(fields['amountFils'] === undefined ? {} : { amountFils: Number(fields['amountFils']) }),
})

const refusalOf = (body: CheckoutBody): CheckoutRefusal | 'accepted' => {
  const parsed = parseCheckoutSubmission(body)
  return parsed.kind === 'refused' ? parsed.refusal : 'accepted'
}

describe('the contract itself', () => {
  it('names four fields and not one of them is card data', () => {
    // The structural half of "no field this build renders may accept a card number": the MARKUP is scanned by
    // `pnpm saq-a`, and the CONTRACT is scanned here, so a card field cannot arrive by either route.
    expect(CHECKOUT_FIELD_NAMES).toHaveLength(4)
    const offenders = CHECKOUT_FIELD_NAMES.filter((name) =>
      CARD_DATA_FIELD_NAMES.includes(normaliseFieldName(name)),
    )
    expect(offenders, 'a checkout field is named after card data').toEqual([])
    // The control: the comparison can fail. Without it, a `CARD_DATA_FIELD_NAMES` that had gone empty would
    // make the assertion above pass over anything.
    expect(CARD_DATA_FIELD_NAMES.filter((n) => ['cvv', 'pan'].includes(n))).toHaveLength(2)
  })

  it('takes one instrument, and it is the online card', () => {
    expect(CHECKOUT_INSTRUMENT).toBe('card_online')
  })

  it('has a sentence for every refusal', () => {
    for (const refusal of CHECKOUT_REFUSALS) {
      expect(CHECKOUT_REFUSAL_SENTENCES[refusal].length, refusal).toBeGreaterThan(20)
    }
    expect(Object.keys(CHECKOUT_REFUSAL_SENTENCES).sort()).toEqual([...CHECKOUT_REFUSALS].sort())
  })

  it('no refusal sentence repeats a value, because they reach a screen, a body and a log at once', () => {
    for (const sentence of Object.values(CHECKOUT_REFUSAL_SENTENCES)) {
      expect(sentence).not.toMatch(/\d{13,}/)
    }
  })
})

describe('card data is refused first', () => {
  for (const [shape, build] of [
    ['a form', asForm],
    ['JSON', asJson],
  ] as const) {
    it(`refuses a card-shaped reference from ${shape}`, () => {
      expect(refusalOf(build({ ...GOOD, reference: `${GOOD.reference} ${PAN}` }))).toBe(
        'card_data_refused',
      )
    })

    it(`refuses a field named after card data from ${shape}`, () => {
      expect(refusalOf(build({ ...GOOD, cvv: '737' }))).toBe('card_data_refused')
    })
  }

  it('reports card data BEFORE any other defect in the same body', () => {
    // The order is load-bearing: every other refusal constructs a message about a field, and a message about a
    // submission that has not been cleared of card data is a message that may carry one. So a body that is
    // wrong in two ways is reported as `card_data_refused` and nothing else.
    const both = asForm({
      instrumentToken: '',
      reference: PAN,
      idempotencyKey: '',
      amountFils: 'x',
    })
    expect(refusalOf(both)).toBe('card_data_refused')
  })

  it('names the paths and never the value', () => {
    const parsed = parseCheckoutSubmission(asForm({ ...GOOD, reference: PAN }))
    expect(parsed.kind).toBe('refused')
    if (parsed.kind !== 'refused') return
    expect(parsed.paths).toEqual(['reference'])
    expect(JSON.stringify(parsed)).not.toContain(PAN)
  })
})

describe('every other refusal', () => {
  const cases: readonly (readonly [CheckoutRefusal, Readonly<Record<string, string>>])[] = [
    ['instrument_token_missing', { ...GOOD, instrumentToken: '' }],
    ['idempotency_key_missing', { ...GOOD, idempotencyKey: '   ' }],
    ['reference_missing', { ...GOOD, reference: '' }],
    ['amount_missing', { ...GOOD, amountFils: '' }],
    ['amount_not_integer_fils', { ...GOOD, amountFils: '200.5' }],
    ['amount_not_integer_fils', { ...GOOD, amountFils: 'twenty' }],
    ['amount_not_positive', { ...GOOD, amountFils: '0' }],
    ['amount_not_positive', { ...GOOD, amountFils: '-1' }],
  ]

  for (const [expected, fields] of cases) {
    it(`refuses ${expected} for ${JSON.stringify(fields['amountFils'] ?? '')}`, () => {
      expect(refusalOf(asForm(fields))).toBe(expected)
    })
  }

  it('refuses a body that is not a submission at all', () => {
    expect(refusalOf(new URLSearchParams(''))).toBe('instrument_token_missing')
  })

  it('refuses a fractional amount rather than rounding it, in both shapes', () => {
    // ADR 0007: `filsFrom` is the one place the integer rule lives, and rounding here would move real money.
    expect(refusalOf(asForm({ ...GOOD, amountFils: '200.5' }))).toBe('amount_not_integer_fils')
    expect(refusalOf({ ...GOOD, amountFils: 200.5 })).toBe('amount_not_integer_fils')
  })
})

describe('the control', () => {
  it('accepts a well-formed submission from a form and from JSON', () => {
    // Without this, every refusal above is satisfied by a parser that refuses everything.
    for (const body of [asForm(GOOD), asJson(GOOD)]) {
      const parsed = parseCheckoutSubmission(body)
      expect(parsed.kind).toBe('submission')
      if (parsed.kind !== 'submission') continue
      expect(parsed.submission.amountFils).toBe(20_000)
      expect(parsed.submission.reference).toBe(GOOD.reference)
      expect(parsed.submission.instrumentToken).toBe(GOOD.instrumentToken)
      expect(parsed.submission.idempotencyKey).toBe(GOOD.idempotencyKey)
    }
  })

  it('trims the reference and the key, because a form sends whatever was typed', () => {
    const parsed = parseCheckoutSubmission(
      asForm({
        ...GOOD,
        reference: `  ${GOOD.reference}  `,
        idempotencyKey: ` ${GOOD.idempotencyKey} `,
      }),
    )
    expect(parsed.kind).toBe('submission')
    if (parsed.kind !== 'submission') return
    expect(parsed.submission.reference).toBe(GOOD.reference)
    expect(parsed.submission.idempotencyKey).toBe(GOOD.idempotencyKey)
  })

  it('reads the field names from the declared map rather than from literals', () => {
    // A field renamed in `CHECKOUT_FIELDS` and not in the parser would make the parser read nothing, and the
    // symptom would be `instrument_token_missing` on a correct submission.
    const renamed = new URLSearchParams({
      [CHECKOUT_FIELDS.instrumentToken]: GOOD.instrumentToken,
      [CHECKOUT_FIELDS.amountFils]: GOOD.amountFils,
      [CHECKOUT_FIELDS.reference]: GOOD.reference,
      [CHECKOUT_FIELDS.idempotencyKey]: GOOD.idempotencyKey,
    })
    expect(parseCheckoutSubmission(renamed).kind).toBe('submission')
  })
})
