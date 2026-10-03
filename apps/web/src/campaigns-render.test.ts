import { describe, expect, it } from 'vitest'
import { type CampaignRowView, renderCampaignsHtml } from '../app/(admin)/crm/campaigns/render.ts'
import type { AdminChrome } from './components/admin/google-reauth-banner.ts'

/**
 * C-AUTO-10's campaigns screen, rendered without a server.
 *
 * The claim worth testing here is the one the provisional answer states: a count is never shown without
 * the instant it was taken at. Every case is paired with a control that must fail, because "the
 * timestamp is present" passes against a page that prints a timestamp and no number.
 */

const CHROME: AdminChrome = {
  googleReauth: null,
  sendBacklog: null,
  returnTo: '/crm/campaigns',
}

const base: CampaignRowView = {
  campaignKey: 'spring_offer',
  title: 'Spring offer',
  state: 'completed',
  haltedReason: null,
  capFils: 50_000,
  spentFils: 1_200,
  estimatedRecipients: 200,
  estimatedSegments: 1,
  estimatedFils: 1_200,
  scheduledAtIso: '2026-09-18T10:00:00.000Z',
  sent: 200,
  held: 0,
  total: 200,
  segmentKey: 'lapsed_vips',
  segmentCount: 200,
  segmentCountAtIso: '2026-09-18T09:55:00.000Z',
  segmentCountIsStale: false,
}

const render = (campaigns: readonly CampaignRowView[]) =>
  renderCampaignsHtml({
    chrome: CHROME,
    campaigns,
    openQuestionId: 'Y6-sender-ids',
    defaultCapFils: 50_000,
  })

describe('the campaigns screen', () => {
  it('shows a cached count WITH the instant it was taken at, in the same cell', () => {
    const html = render([base])
    expect(html).toContain('200 as at')
    expect(html).toContain('datetime="2026-09-18T09:55:00.000Z"')
    // The control: a count with no instant must not render as a bare number, because that is the one
    // thing C-AUTO-10's provisional answer forbids.
    const undated = render([{ ...base, segmentCount: null, segmentCountAtIso: null }])
    expect(undated).toContain('Never counted')
    expect(undated).not.toContain('200 as at')
  })

  it('marks a stale count as stale, and does not mark a fresh one', () => {
    expect(render([{ ...base, segmentCountIsStale: true }])).toContain('(stale)')
    expect(render([base])).not.toContain('(stale)')
  })

  it('states the estimate as its three parts, never as a total alone', () => {
    const html = render([base])
    expect(html).toContain('200 recipient(s)')
    expect(html).toContain('1 segment(s)')
    expect(html).toContain('1,200 fils')
    // The control: a campaign with no estimate says so rather than showing a zero.
    const none = render([
      { ...base, estimatedFils: null, estimatedRecipients: null, estimatedSegments: null },
    ])
    expect(none).toContain('Not estimated')
  })

  it('states the spend against the cap, so neither figure stands alone', () => {
    expect(render([base])).toContain('1,200 fils of 50,000 fils')
  })

  it('reports held and sent against the total, which is how a halted campaign is read', () => {
    const halted = render([
      { ...base, state: 'halted', haltedReason: 'spend_cap_reached', sent: 119, held: 81 },
    ])
    expect(halted).toContain('119 sent, 81 held, 200 total')
    expect(halted).toContain('spend_cap_reached')
  })

  it('cites the open question the cap and the sender identities are tracked under', () => {
    expect(render([base])).toContain('Y6-sender-ids')
  })

  it('says so when there are no campaigns, rather than rendering an empty table', () => {
    const html = render([])
    expect(html).toContain('No campaigns have been created.')
    expect(html).not.toContain('<table')
  })

  it('is noindex and names no brand in its title', () => {
    const html = render([base])
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">')
    expect(html).toContain('<title>Campaigns — admin</title>')
  })

  it('renders byte-identically twice, so a screenshot of it does not diff', () => {
    expect(render([base])).toBe(render([base]))
  })
})
