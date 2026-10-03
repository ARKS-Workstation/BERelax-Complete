/**
 * The acquirer's go-live prerequisites, as DATA and a pure verdict (Y-PAY-10).
 *
 * The list is here rather than in `scripts/go-live-payments.mjs` for the reason `ALERT_REGISTRY` is in
 * `@berelax/shared` rather than in the worker that reads it: a list nothing but a script can see is a
 * list no test can hold against anything. `apps/web/src/payments-go-live.test.ts` compares every
 * `route` with the route registry, and {@link paymentsGoLiveVerdict} is judged with no database at all.
 *
 * ## Why these five, and why the list is not longer
 *
 * They are what a card scheme asks a new merchant for before it will underwrite card-not-present
 * payments: a published refund and cancellation policy, a privacy policy, prices in the settlement
 * currency, contact details and a trading address. No acquirer has been approached — docs/05 names none
 * and `Y7-mcc` is open — so this is the set every scheme has in common rather than one acquirer's form,
 * and that is stated here so nobody reads it as a contract.
 *
 * ## Why an absent page and an unpublished page are DIFFERENT states
 *
 * A route that does not exist is work nobody has done. A route that exists and has never been published
 * is a page nobody has approved, which is the state W-SITE's publication control plane exists to make
 * visible — and it is the more dangerous of the two, because the page is there and looks finished.
 * {@link PaymentsGoLiveItemState} keeps them apart so the report can say which.
 */

/** One prerequisite's state. `missing` is no route; `unpublished` is a route nobody approved. */
export type PaymentsGoLiveItemState = 'live' | 'missing' | 'unpublished' | 'no_content'

export interface PaymentsGoLivePrerequisite {
  readonly id: string
  readonly label: string
  /** Why an acquirer asks for it. A sentence a reader can disagree with. */
  readonly why: string
  /** The path the content must be served at, as `apps/web/src/routes/registry.ts` spells it. */
  readonly route: string
  /** The `publication_record` surface it must be published on. */
  readonly surface: string
  /**
   * A `premises` column the page's content depends on, or null.
   *
   * The one prerequisite that is a DATA fact rather than a page: an address is only an address if the row
   * holds one, and a published contact page with a placeholder address satisfies every check about pages
   * while showing nothing. `no_content` is that state.
   */
  readonly premisesColumn: string | null
}

export const PAYMENTS_GO_LIVE_PREREQUISITES: readonly PaymentsGoLivePrerequisite[] = Object.freeze([
  Object.freeze({
    id: 'refund-and-cancellation-policy',
    label: 'Refund and cancellation policy',
    why:
      'Every card scheme requires a published refund and cancellation policy before a merchant may take ' +
      'a card-not-present payment. Its absence is the commonest reason a new merchant account is held, ' +
      'and it is also the document a chargeback is judged against.',
    route: '/refunds',
    surface: 'refunds',
    premisesColumn: null,
  }),
  Object.freeze({
    id: 'privacy-policy',
    label: 'Privacy policy',
    why:
      'Required by the schemes and by the PDPL (docs/04 §8). The acquirer looks for a reachable page; ' +
      'the regulator looks for what it says. This checks the first.',
    route: '/privacy',
    surface: 'privacy',
    premisesColumn: null,
  }),
  Object.freeze({
    id: 'prices-in-aed-gross',
    label: 'Prices, in AED and VAT-inclusive',
    why:
      'The settlement currency must be stated where a customer sees a price. AED gross is this build’s ' +
      'authoritative form (ADR 0007), so the price list is already in the right shape.',
    route: '/pricing',
    surface: 'pricing',
    premisesColumn: null,
  }),
  Object.freeze({
    id: 'contact-details',
    label: 'Contact details',
    why:
      'A cardholder must be able to reach the merchant without going through their bank. An unreachable ' +
      'merchant is a chargeback rather than a conversation.',
    route: '/contact',
    surface: 'contact',
    premisesColumn: null,
  }),
  Object.freeze({
    id: 'physical-address',
    label: 'Physical address',
    why:
      'The acquirer needs the trading address, and it has to be on the site as well as on the ' +
      'application. This one is a DATA fact: the page can exist and say nothing.',
    route: '/contact',
    surface: 'contact',
    premisesColumn: 'address_line_1',
  }),
])

export interface PaymentsGoLiveFacts {
  /** Every path the application declares it serves. */
  readonly servedRoutes: readonly string[]
  /** The newest `publication_record` state per surface. An absent surface is `unrecorded`. */
  readonly publicationState: ReadonlyMap<string, string>
  /** Whether the premises row holds a usable value for each column a prerequisite names. */
  readonly premisesContent: ReadonlyMap<string, boolean>
  /** Whether `legal_entity.mcc_confirmed_at` is set, with the code and the recorder beside it. */
  readonly mcc: {
    readonly mcc: string | null
    readonly confirmedAtIso: string | null
    readonly confirmedBy: string | null
  }
}

export interface PaymentsGoLiveItem {
  readonly id: string
  readonly label: string
  readonly state: PaymentsGoLiveItemState
  readonly detail: string
}

export interface PaymentsGoLiveVerdict {
  readonly ok: boolean
  readonly items: readonly PaymentsGoLiveItem[]
  /** The ids that are not `live`, including `merchant-category-code`. */
  readonly unmet: readonly string[]
}

/** The MCC's own prerequisite id. Not a page, and the only one no publication can satisfy. */
export const MERCHANT_CATEGORY_CODE_PREREQUISITE = 'merchant-category-code'

/**
 * Whether this business may be taken live on a card gateway, item by item.
 *
 * Pure: the facts arrive as arguments, so the whole verdict is testable with no database and no server.
 * `scripts/go-live-payments.mjs` is the I/O around it — two queries and the route registry — and the
 * reason it is thin is that a check whose judgement lives in a script is a judgement no test reaches.
 */
export function paymentsGoLiveVerdict(facts: PaymentsGoLiveFacts): PaymentsGoLiveVerdict {
  const served = new Set(facts.servedRoutes)
  const items: PaymentsGoLiveItem[] = []

  items.push(
    facts.mcc.confirmedAtIso === null
      ? {
          id: MERCHANT_CATEGORY_CODE_PREREQUISITE,
          label: 'Merchant category code',
          state: 'missing',
          detail:
            'legal_entity.mcc_confirmed_at is null, so no acquirer has confirmed a merchant category ' +
            'code in writing (Y7-mcc). While it is null, ZY771 refuses a payment intent against any ' +
            'gateway but the manual till and the card fake, and PAYMENT_PROVIDER=real is refused at ' +
            'construction.',
        }
      : {
          id: MERCHANT_CATEGORY_CODE_PREREQUISITE,
          label: 'Merchant category code',
          state: 'live',
          detail:
            `${String(facts.mcc.mcc)}, confirmed ${facts.mcc.confirmedAtIso} by ` +
            `${String(facts.mcc.confirmedBy)}`,
        },
  )

  for (const item of PAYMENTS_GO_LIVE_PREREQUISITES) {
    if (!served.has(item.route)) {
      items.push({
        id: item.id,
        label: item.label,
        state: 'missing',
        detail: `this application serves no route at ${item.route}. ${item.why}`,
      })
      continue
    }
    const state = facts.publicationState.get(item.surface) ?? 'unrecorded'
    if (state !== 'published') {
      items.push({
        id: item.id,
        label: item.label,
        state: 'unpublished',
        detail:
          `${item.route} is served, and surface "${item.surface}" is ${state}. A route that exists ` +
          'and has never been published is a page nobody has approved.',
      })
      continue
    }
    if (item.premisesColumn !== null && facts.premisesContent.get(item.premisesColumn) !== true) {
      items.push({
        id: item.id,
        label: item.label,
        state: 'no_content',
        detail:
          `${item.route} is published, and premises.${item.premisesColumn} is absent or a ` +
          `placeholder, so the page has nothing to show. ${item.why}`,
      })
      continue
    }
    items.push({
      id: item.id,
      label: item.label,
      state: 'live',
      detail: `${item.route}, published`,
    })
  }

  const unmet = items.filter((item) => item.state !== 'live').map((item) => item.id)
  return { ok: unmet.length === 0, items, unmet }
}
