import {
  CONNECTION_PRESENTATION_STATES,
  CONNECTION_STATE_COPY,
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
  type GoogleConnectionDisplayState,
  grantedScopeLabels,
  type Instant,
  instantFromIso,
  recencyPhrase,
} from '@berelax/core'
import { testingExpiryFor } from '@berelax/google'
import { describe, expect, it } from 'vitest'
import {
  type ConnectionCardView,
  type IntegrationsView,
  renderIntegrationsPage,
} from '../app/(admin)/settings/integrations/connection-card.ts'

/**
 * G-CONN-07 — the connection card's bytes, without a database and without a browser.
 *
 * `connection-card.ts` is pure, so these run in milliseconds on every commit and cover the branches: a
 * state and its sentence, the recency that may not be missing, the amber paragraph in both of its
 * configured/unconfigured forms, and the prohibition docs/10 §4 states outright — no scope string anywhere.
 *
 * What is deliberately NOT here is anything that needs a parser. *"The tripwire element is absent"* and
 * *"the document contains no scope URL"* are claims a substring assertion gets wrong in the interesting
 * direction — an element rendered with `hidden`, or inside a comment, satisfies `not.toContain` — so those
 * live in `google-connection-card.itest.ts` against a real DOM, beside the axe audit and the screenshots.
 */

const NOW = instantFromIso('2026-09-25T10:00:00.000Z')
const HOUR = 60 * 60 * 1000
const CONNECTION_ID = '01920000-0000-7000-8000-0000000000ca'
/** A mailbox spelling with no person's name in it, and the one docs/10 §5 recommends. */
const ACCOUNT = 'google-admin@berelax.ae'

function view(overrides: Partial<ConnectionCardView> = {}): IntegrationsView {
  const card: ConnectionCardView = {
    connectionId: CONNECTION_ID,
    googleEmail: ACCOUNT,
    state: 'healthy',
    derivedState: 'healthy',
    degradedCause: null,
    recency: recencyPhrase(2),
    scopes: grantedScopeLabels([
      GOOGLE_SCOPE_BUSINESS_MANAGE,
      GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
    ]),
    capabilities: [
      { capability: 'gbp_reviews', health: 'ok', resource: 'ChIJ-fixture-place-id' },
      { capability: 'gsc', health: 'permission_missing', resource: 'sc-domain:example.test' },
    ],
    listing: {
      placeId: 'ChIJ-fixture-place-id',
      title: 'A listing title from the picker',
      address: 'An address the picker recorded',
      confirmedOn: '20 September 2026',
    },
    searchConsoleProperty: 'sc-domain:example.test',
    expiry: null,
    nextCheck: '26 September 2026 at 03:00 (Asia/Dubai)',
    pendingApproval: null,
    ...overrides,
  }
  return {
    connections: [card],
    narrowed: true,
    reconnectPath: '/settings/integrations/google/connect',
    testConnectionPath: '/settings/integrations/test-connection',
  }
}

describe('acceptance — no scope string reaches the card', () => {
  it('renders both permissions in English and no scope URL', () => {
    const html = renderIntegrationsPage(view())
    expect(html).not.toContain('googleapis.com/auth/')
    expect(html).not.toContain('googleapis.com')
    expect(html).toContain('no read-only version of this permission')
    expect(html).toContain('Read Search Console performance figures')
  })

  it('and would say so if the lookup handed it the raw scope', () => {
    // The control. The prohibition is only worth asserting if the assertion can fail, and the way it would
    // fail in practice is a scope arriving unmapped.
    const html = renderIntegrationsPage(
      view({
        scopes: [{ recognised: true, label: GOOGLE_SCOPE_BUSINESS_MANAGE, token: '' }],
      }),
    )
    expect(html).toContain('googleapis.com/auth/')
  })

  it('names an unrecognised permission by its last segment, never by its URL', () => {
    const html = renderIntegrationsPage(
      view({ scopes: grantedScopeLabels(['https://www.googleapis.com/auth/gmail.send']) }),
    )
    expect(html).not.toContain('googleapis.com')
    expect(html).toContain('gmail.send')
    expect(html).toContain('data-scope-recognised="false"')
  })
})

describe('acceptance — every state renders its own sentence', () => {
  it('renders the headline and the tone for each of the six', () => {
    for (const state of CONNECTION_PRESENTATION_STATES) {
      const html = renderIntegrationsPage(
        view({
          state,
          derivedState: state,
          ...(state === 'degraded' ? { degradedCause: 'capability_failing' as const } : {}),
          ...(state === 'pending_gbp_approval'
            ? { pendingApproval: { submittedOn: null, quotaPageUrl: null } }
            : {}),
        }),
      )
      expect(html, state).toContain(`data-connection-headline="${state}"`)
      expect(html, state).toContain(CONNECTION_STATE_COPY[state].headline)
      expect(html, state).toContain(`data-tone="${CONNECTION_STATE_COPY[state].tone}"`)
    }
  })

  it('renders the cause sentence for degraded, not the generic one', () => {
    const never = renderIntegrationsPage(
      view({
        state: 'degraded',
        derivedState: 'healthy',
        degradedCause: 'never_verified',
        recency: null,
      }),
    )
    expect(never).toContain('Nothing has been read from Google on this connection yet')
    expect(never).not.toContain(CONNECTION_STATE_COPY.degraded.detail)
    // The control: a different cause renders a different sentence from the same state.
    const stale = renderIntegrationsPage(
      view({ state: 'degraded', degradedCause: 'stale', recency: recencyPhrase(96) }),
    )
    expect(stale).toContain('more than two days')
    expect(stale).not.toContain('Nothing has been read from Google on this connection yet')
  })

  it('keeps the derivation visible beside the state it is shown as', () => {
    // The two differ for exactly one case, and a surface that only carried the shown state would make the
    // difference unobservable — which is how a rule like `stateShownFor` quietly becomes a second
    // derivation nobody can check.
    const html = renderIntegrationsPage(
      view({
        state: 'degraded',
        derivedState: 'healthy',
        degradedCause: 'never_verified',
        recency: null,
      }),
    )
    expect(html).toContain('data-connection-state="degraded"')
    expect(html).toContain('data-derived-state="healthy"')
  })
})

describe('acceptance — Connected never renders without a timestamp', () => {
  it('puts the recency in the same card as the healthy headline', () => {
    const html = renderIntegrationsPage(view())
    expect(html).toContain('data-connection-headline="healthy"')
    expect(html).toContain('data-recency="Last verified 2 hours ago"')
    expect(html).toContain('Last verified 2 hours ago.')
  })

  it('never emits the healthy headline for a card with no recency', () => {
    // The pairing is structural: `stateShownFor` cannot return `healthy` with a null recency, so a card
    // built that way is one no handler can produce — and the renderer still must not print the headline,
    // because the next surface to build a view by hand is the one that would.
    const html = renderIntegrationsPage(
      view({
        state: 'degraded',
        derivedState: 'healthy',
        degradedCause: 'never_verified',
        recency: null,
      }),
    )
    expect(html).not.toContain('data-connection-headline="healthy"')
    expect(html).toContain('data-recency="never"')
    expect(html).toContain('Nothing has been read from Google on this account yet')
  })
})

describe('acceptance — the amber state carries what docs/10 §4 asks of it', () => {
  const pending = (over: Partial<ConnectionCardView> = {}) =>
    renderIntegrationsPage(
      view({
        state: 'pending_gbp_approval',
        derivedState: 'pending_gbp_approval',
        capabilities: [
          { capability: 'gbp_reviews', health: 'quota_zero', resource: 'ChIJ-fixture-place-id' },
        ],
        pendingApproval: { submittedOn: null, quotaPageUrl: null },
        ...over,
      }),
    )

  it('renders the exact sentence, the recorded date and a link to the quota page', () => {
    const html = pending({
      pendingApproval: {
        submittedOn: '2026-09-01',
        quotaPageUrl: 'https://console.example.test/quotas/business-profile',
      },
    })
    expect(html).toContain('Connected, Business Profile access pending Google approval')
    expect(html).toContain('The application was submitted on 2026-09-01.')
    expect(html).toContain('data-submitted-on="2026-09-01"')
    expect(html).toContain('data-quota-link="set"')
    expect(html).toContain('href="https://console.example.test/quotas/business-profile"')
    // The figures the page exists to point at, in the words docs/10 §1 uses.
    expect(html).toContain('from 0 to 300 requests per minute')
  })

  it('says the date is unrecorded rather than inventing one, and names the page in words', () => {
    // Brief rule 15, on the surface it matters most: a plausible submission date is indistinguishable from
    // a recorded one, and a console URL written from memory opens the wrong project or nothing at all.
    const html = pending()
    expect(html).toContain('The date the application was submitted has not been recorded.')
    expect(html).toContain('data-submitted-on="not-recorded"')
    expect(html).toContain('data-quota-link="unset"')
    expect(html).toContain('APIs and services')
    // No anchor at all in the unconfigured branch, which is the assertion a rendered "#" would fail.
    expect(html).not.toContain('open the Cloud console quota page</a>')
  })

  it('renders the paragraph in no other state', () => {
    for (const state of CONNECTION_PRESENTATION_STATES.filter(
      (candidate): candidate is GoogleConnectionDisplayState =>
        candidate !== 'pending_gbp_approval',
    )) {
      const html = renderIntegrationsPage(
        view({
          state,
          derivedState: state,
          ...(state === 'degraded' ? { degradedCause: 'capability_failing' as const } : {}),
        }),
      )
      expect(html, state).not.toContain('data-pending-approval')
    }
  })
})

describe('acceptance — the card says what it is pointed at, in English', () => {
  it('names each capability and its health in words, never as a column value', () => {
    const html = renderIntegrationsPage(view())
    expect(html).toContain('Google reviews')
    expect(html).toContain('Search Console')
    expect(html).toContain('Permission missing')
    // The stored values are still present as data attributes — a test needs them — and never as prose.
    expect(html).toContain('data-health="permission_missing"')
    expect(html).not.toContain('>permission_missing<')
  })

  it('distinguishes nothing-chosen from chosen-and-failing', () => {
    const html = renderIntegrationsPage(
      view({
        capabilities: [{ capability: 'gbp_reviews', health: 'unknown', resource: null }],
        listing: null,
        searchConsoleProperty: null,
      }),
    )
    expect(html).toContain('(nothing chosen yet)')
    expect(html).toContain('data-listing="none"')
    expect(html).toContain('data-search-console="none"')
    // The control: the default view has both, so the empty branches above are about the fixture.
    const chosen = renderIntegrationsPage(view())
    expect(chosen).not.toContain('(nothing chosen yet)')
    expect(chosen).toContain('data-listing="ChIJ-fixture-place-id"')
  })

  it('offers Reconnect and Test connection, the second as a POST', () => {
    const html = renderIntegrationsPage(view())
    expect(html).toContain('href="/settings/integrations/google/connect"')
    expect(html).toContain('action="/settings/integrations/test-connection"')
    expect(html).toContain('method="post"')
    expect(html).toContain(`value="${CONNECTION_ID}"`)
    // A GET would let a crawler spend the account's refresh quota, so the button may not be a link.
    expect(html).not.toContain(`href="/settings/integrations/test-connection`)
  })

  it('renders the Testing expiry through the same tripwire the fragment uses', () => {
    const expiry = testingExpiryFor({
      publishingStatus: 'testing',
      consentAt: (NOW - 6 * 24 * HOUR) as Instant,
      now: NOW,
    })
    const html = renderIntegrationsPage(view({ expiry }))
    expect(html).toContain('data-tripwire="google-testing-expiry"')
    // And absent with the consent screen published, which is the half a substring check gets wrong and
    // the itest re-asserts against a parser.
    expect(renderIntegrationsPage(view({ expiry: null }))).not.toContain('data-tripwire')
  })

  it('says when the next automatic check runs', () => {
    expect(renderIntegrationsPage(view())).toContain(
      'data-next-check="26 September 2026 at 03:00 (Asia/Dubai)"',
    )
  })

  it('escapes a listing title, which is whatever somebody typed into the Business Profile', () => {
    const html = renderIntegrationsPage(
      view({
        listing: {
          placeId: 'ChIJ-fixture-place-id',
          title: '<script>alert(1)</script>',
          address: 'An address the picker recorded',
          confirmedOn: '20 September 2026',
        },
      }),
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('acceptance — an empty page says nothing is connected', () => {
  it('renders the no-connection sentence and no card', () => {
    const html = renderIntegrationsPage({
      connections: [],
      narrowed: false,
      reconnectPath: '/settings/integrations/google/connect',
      testConnectionPath: '/settings/integrations/test-connection',
    })
    expect(html).toContain('data-google-connections="0"')
    expect(html).not.toContain('data-google-connection=')
    expect(html).toContain('No Google account is connected')
    // Still a whole document: a fragment here would render unstyled inside the admin.
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">')
  })
})
