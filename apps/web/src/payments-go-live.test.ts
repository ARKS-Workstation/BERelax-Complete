import {
  MERCHANT_CATEGORY_CODE_PREREQUISITE,
  PAYMENTS_GO_LIVE_PREREQUISITES,
  paymentsGoLiveVerdict,
} from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { ROUTES } from './routes/registry.ts'

/**
 * Y-PAY-10's acceptance line: *"a route test asserts the refund and cancellation policy, privacy policy,
 * AED gross prices, contact details and physical address are live on the public site, and an unpublished
 * item makes the payments go-live check exit non-zero."*
 *
 * ## Two of the five are NOT live, and that is the finding
 *
 * This application serves no route at `/refunds` and none at `/privacy`. The registry is the one
 * declaration of what it serves and its own test holds it to the filesystem in both directions, so the
 * absence is a fact rather than an omission in this file — and a test asserting that they ARE live would
 * have had to be written against something that does not exist.
 *
 * So the claim this file makes is the one that is true and is worth making: the prerequisite list names
 * all five, every item resolves to the registry or is reported MISSING by name, and the verdict is not
 * `ok`. The second half of the acceptance line — the non-zero exit — is gate case 188e, which runs the
 * script and asserts the exit status, because an exit status is not a thing a unit test observes.
 *
 * ## Why the facts are passed in rather than read
 *
 * `paymentsGoLiveVerdict` is pure, which is what lets this file assert the verdict for states this
 * database is not in: a published page, an unpublished one, a page with no content. A test that could
 * only see today's database could only ever assert today's answer, and the answer that matters is the
 * one it gives on the day somebody publishes four of the five.
 */

/** Every path the registry declares, widened to `string[]` so a test may add one the registry lacks. */
const servedRoutes: readonly string[] = ROUTES.map((route) => route.path)

/** Every prerequisite published, every premises column filled, the MCC on file. The all-clear state. */
const allClear = () => ({
  servedRoutes: [...servedRoutes, ...PAYMENTS_GO_LIVE_PREREQUISITES.map((item) => item.route)],
  publicationState: new Map<string, string>(
    PAYMENTS_GO_LIVE_PREREQUISITES.map((item) => [item.surface, 'published']),
  ),
  premisesContent: new Map<string, boolean>(
    PAYMENTS_GO_LIVE_PREREQUISITES.flatMap((item) =>
      item.premisesColumn === null ? [] : [[item.premisesColumn, true] as [string, boolean]],
    ),
  ),
  mcc: {
    mcc: '0000',
    confirmedAtIso: '2026-10-03T00:00:00.000Z',
    confirmedBy: 'Fixture: no acquirer has issued an MCC (Y7-mcc)',
  },
})

describe('the acquirer’s public-site prerequisites', () => {
  it('names all five, each with a route and a publication surface', () => {
    expect(PAYMENTS_GO_LIVE_PREREQUISITES.map((item) => item.id)).toEqual([
      'refund-and-cancellation-policy',
      'privacy-policy',
      'prices-in-aed-gross',
      'contact-details',
      'physical-address',
    ])
    for (const item of PAYMENTS_GO_LIVE_PREREQUISITES) {
      expect(item.route, item.id).toMatch(/^\//)
      expect(item.surface, item.id).not.toBe('')
      // Each carries the reason an acquirer asks for it, because a list with no reasons is a list
      // somebody shortens.
      expect(item.why.length, item.id).toBeGreaterThan(40)
    }
  })

  it('reports the two prerequisites this application serves NO route for, by name', () => {
    const verdict = paymentsGoLiveVerdict({
      servedRoutes,
      publicationState: new Map(),
      premisesContent: new Map(),
      mcc: { mcc: null, confirmedAtIso: null, confirmedBy: null },
    })
    const missing = verdict.items.filter((item) => item.state === 'missing').map((item) => item.id)
    // The finding, as a fact: there is no refund-policy page and no privacy page on this site.
    expect(missing).toContain('refund-and-cancellation-policy')
    expect(missing).toContain('privacy-policy')
    expect(missing).toContain(MERCHANT_CATEGORY_CODE_PREREQUISITE)
    // And the control: the three that DO have routes are not reported missing, so the assertion above
    // is about two specific absences rather than about a list nothing resolves in.
    expect(missing).not.toContain('prices-in-aed-gross')
    expect(missing).not.toContain('contact-details')
    expect(verdict.ok).toBe(false)
  })

  it('distinguishes a route that exists and was never published from one that does not exist', () => {
    const verdict = paymentsGoLiveVerdict({
      servedRoutes,
      publicationState: new Map(),
      premisesContent: new Map(),
      mcc: { mcc: null, confirmedAtIso: null, confirmedBy: null },
    })
    const byId = new Map(verdict.items.map((item) => [item.id, item]))
    // `/pricing` is served and unrecorded: a page nobody has approved, which is the more dangerous of
    // the two states because the page is there and looks finished.
    expect(byId.get('prices-in-aed-gross')?.state).toBe('unpublished')
    expect(byId.get('privacy-policy')?.state).toBe('missing')
  })

  it('refuses a published contact page whose address is a placeholder', () => {
    // The one prerequisite that is a DATA fact. A published page with a placeholder address satisfies
    // every check about pages while showing nothing, which is what `no_content` is for.
    const verdict = paymentsGoLiveVerdict({
      ...allClear(),
      premisesContent: new Map([['address_line_1', false]]),
    })
    const address = verdict.items.find((item) => item.id === 'physical-address')
    expect(address?.state).toBe('no_content')
    expect(verdict.ok).toBe(false)
  })

  it('is ok only when every item is live AND the MCC is confirmed', () => {
    // The control for every refusal above: a verdict that could never be ok would satisfy all of them.
    expect(paymentsGoLiveVerdict(allClear()).ok).toBe(true)

    // One unpublished item is enough to refuse, which is the acceptance line's own claim.
    const facts = allClear()
    const oneUnpublished = new Map(facts.publicationState)
    oneUnpublished.set('pricing', 'approved')
    expect(paymentsGoLiveVerdict({ ...facts, publicationState: oneUnpublished }).ok).toBe(false)

    // And so is an unconfirmed MCC, with every page live.
    expect(
      paymentsGoLiveVerdict({
        ...facts,
        mcc: { mcc: null, confirmedAtIso: null, confirmedBy: null },
      }).ok,
    ).toBe(false)
  })

  it('every item that resolves names a route the registry actually declares', () => {
    // The direction a list of paths cannot check about itself: a prerequisite naming `/refund-policy`
    // when the route is `/refunds` would be reported MISSING for ever and read as unfinished work.
    const declared = new Set(servedRoutes)
    const resolvable = PAYMENTS_GO_LIVE_PREREQUISITES.filter((item) => declared.has(item.route))
    expect(resolvable.map((item) => item.id)).toEqual([
      'prices-in-aed-gross',
      'contact-details',
      'physical-address',
    ])
  })
})
