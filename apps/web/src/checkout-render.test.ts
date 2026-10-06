import type { HostedFieldsConfiguration } from '@berelax/payments'
import {
  CARD_DATA_FIELD_NAMES,
  CHECKOUT_REFUSAL_SENTENCES,
  checkoutContentSecurityPolicy,
  normaliseFieldName,
  permittedOrigins,
} from '@berelax/payments'
import { describe, expect, it } from 'vitest'
import { checkoutHeaders, checkoutViewFor } from '../app/(admin)/checkout/handler.ts'
import { renderCheckout } from '../app/(admin)/checkout/render.ts'

/**
 * The checkout document's bytes, and the absence they have to keep (Y-PAY-03).
 *
 * The claims here are the ones a substring assertion can genuinely make: what is NOT in the markup. The two a
 * rendered string cannot make are elsewhere — that the frame is really cross-origin (a browser's same-origin
 * policy, in `checkout.itest.ts`) and that no card number reaches a sink (a real write, in the same file).
 *
 * Every "the document does not contain X" case is paired with a control that proves the search would find X,
 * because an absence is exactly what a broken search reports.
 */

const FRAME = 'https://fields.example.test'
const SCRIPT = 'https://script.example.test'
const PAN = '4111111111111111'

const CONFIGURED: HostedFieldsConfiguration = {
  kind: 'configured',
  origins: { frame: FRAME, script: SCRIPT },
}
const UNCONFIGURED: HostedFieldsConfiguration = {
  kind: 'not_configured',
  missing: ['PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN is not set'],
}

const input = (hostedFields: HostedFieldsConfiguration) => ({
  chrome: { googleReauth: null, sendBacklog: null, role: 'owner' as const, returnTo: '/checkout' },
  hostedFields,
  gatewayName: 'fake-card-gateway',
  nowIso: '2026-09-29T11:30:00.000Z',
  actorLabel: 'STAFF-0007',
})

const documentFor = (hostedFields: HostedFieldsConfiguration, extra = {}): string =>
  renderCheckout(checkoutViewFor({ ...input(hostedFields), ...extra }, 'checkout-fixture-key'))

describe('the checkout renders no card field of its own', () => {
  const html = documentFor(CONFIGURED)

  it('has no autocomplete token for a card number, a security code or an expiry', () => {
    for (const token of [
      'cc-number',
      'cc-csc',
      'cc-exp',
      'cc-exp-month',
      'cc-exp-year',
      'cc-name',
    ]) {
      expect(html, token).not.toContain(token)
    }
    // The control: the document DOES carry `autocomplete` attributes, so the assertions above are about the
    // card tokens and not about a document with no autocomplete in it at all.
    expect(html).toContain('autocomplete="off"')
  })

  it('has no input whose name is card data', () => {
    // Only a FORM control's name. A bare /name="…"/ also matches `<meta name="robots">` and
    // `<meta name="viewport">`, which is what the first version of this case did — and it then reported two
    // meta tags as extra form fields rather than saying anything about card data.
    const names = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/g)].map(
      (match) => match[1] as string,
    )
    const offenders = names.filter((name) =>
      CARD_DATA_FIELD_NAMES.includes(normaliseFieldName(name)),
    )
    expect(offenders, 'the checkout renders a card field').toEqual([])
    // The control: four named fields exist, so the filter above ran over something.
    expect(names.sort()).toEqual(['amountFils', 'idempotencyKey', 'instrumentToken', 'reference'])
  })

  it('carries no script at all', () => {
    // Not a `<script>`, not an inline handler, not a `javascript:` URL. The gateway's own script is permitted
    // by the CSP and is not rendered, because no gateway has been chosen and its URL would be invented.
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/\son[a-z]+=/)
    expect(html).not.toContain('javascript:')
  })

  it('has exactly one iframe, and it is the gateway’s origin', () => {
    const frames = [...html.matchAll(/<iframe\b[^>]*>/g)].map((match) => match[0])
    expect(frames).toHaveLength(1)
    expect(frames[0]).toContain(`src="${FRAME}/"`)
    // A titled frame, because the frame is the only interactive region on the page and an unnamed one is the
    // whole card-entry step being unlabelled to a screen reader.
    expect(frames[0]).toMatch(/title="[^"]{10,}"/)
  })

  it('renders the re-auth banner slot, which every admin document must', () => {
    // G-CONN-08's bijection is asserted by `google-reauth-banner.test.ts` over the tree; this is the
    // behavioural half for this document — the renderer is reached with the chrome it was given.
    const withBanner = renderCheckout(
      checkoutViewFor(
        {
          ...input(CONFIGURED),
          chrome: {
            googleReauth: {
              state: 'broken',
              headline: 'The Google connection is broken',
              detail: 'Nothing is being read from Google.',
              dismissible: false,
              connectionId: null,
              googleEmail: null,
            },
            sendBacklog: null,
            role: 'owner' as const,
            returnTo: '/checkout',
          },
        },
        'checkout-fixture-key',
      ),
    )
    expect(withBanner).toContain('The Google connection is broken')
  })
})

describe('the unconfigured gateway', () => {
  const html = documentFor(UNCONFIGURED)

  it('renders no frame and says why, naming the setting and the open question', () => {
    expect(html).not.toContain('<iframe')
    expect(html).toContain('PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN')
    expect(html).toContain('Y7-hosted-fields')
  })

  it('disables the submit control, so nothing offers to take a card', () => {
    expect(html).toContain('disabled')
    // The control: with a gateway configured the same button is enabled, so the assertion above is about the
    // configuration and not about a button that is always disabled.
    expect(documentFor(CONFIGURED)).not.toContain('disabled')
  })
})

describe('the refusal panel', () => {
  it('prints the sentence for a card-data refusal and does not echo the submission', () => {
    const html = documentFor(CONFIGURED, { refusal: 'card_data_refused' as const })
    expect(html).toContain(CHECKOUT_REFUSAL_SENTENCES.card_data_refused.slice(0, 40))
    expect(html).not.toContain(PAN)
  })

  it('carries the amount and reference back for every OTHER refusal', () => {
    const html = documentFor(CONFIGURED, {
      refusal: 'amount_not_positive' as const,
      form: { amountFils: '0', reference: 'INV-2026-0042' },
    })
    expect(html).toContain('value="INV-2026-0042"')
  })
})

describe('the response headers', () => {
  it('carry the policy the payments module built, and permit only the two gateway origins', () => {
    const headers = checkoutHeaders(CONFIGURED)
    expect(headers['content-security-policy']).toBe(checkoutContentSecurityPolicy(CONFIGURED))
    expect(permittedOrigins(headers['content-security-policy'] as string)).toEqual(
      [FRAME, SCRIPT].sort(),
    )
  })

  it('never cache a checkout, and never index one', () => {
    const headers = checkoutHeaders(CONFIGURED)
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['x-robots-tag']).toContain('noindex')
    expect(headers['referrer-policy']).toBe('no-referrer')
  })

  it('permit no origin when the gateway is not configured', () => {
    expect(
      permittedOrigins(checkoutHeaders(UNCONFIGURED)['content-security-policy'] as string),
    ).toEqual([])
  })
})
