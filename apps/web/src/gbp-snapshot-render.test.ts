import type { GbpConsistencyFinding } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { snapshotFromForm } from '../app/(admin)/agents/seo/gbp-snapshot/handler.ts'
import { renderGbpSnapshotHtml } from '../app/(admin)/agents/seo/gbp-snapshot/render.ts'
import type { GbpSnapshotView } from '../app/(admin)/agents/seo/gbp-snapshot/view.ts'
import type { AdminChrome } from './components/admin/google-reauth-banner.ts'

/**
 * The snapshot screen: the render and the form read, both pure.
 *
 * The assertion that matters most is the NEGATIVE one — the form must not carry the website's own
 * figures. A pre-filled Google column is answered by pressing Enter, and the check would then report
 * *"consistent"* about a profile nobody looked at, which is the self-comparison the whole NAP rule
 * exists to prevent and the one form of it a lint cannot see.
 */

/** No banner to show, which is the ordinary state. G-CONN-08 requires the CALL, not the banner. */
const CHROME: AdminChrome = {
  googleReauth: null,
  sendBacklog: null,
  returnTo: '/agents/seo/gbp-snapshot',
}

const FINDING: GbpConsistencyFinding = {
  rule: 'opening_hours_disagree',
  subject: 'every day',
  website: {
    value: '11:00-02:00 (the next day)',
    provenance: { side: 'website', authority: 'premises_hours_row' },
  },
  google: {
    value: '11:00-01:00 (the next day)',
    provenance: {
      side: 'google',
      authority: 'manual_snapshot',
      claimedBy: 'staff/BR-0001',
      claimedAtIso: '2026-10-02T06:00:00.000Z',
    },
  },
  why: 'A visitor who reads the Google profile is told a different closing time.',
}

const BASE: GbpSnapshotView = {
  readAtIso: '2026-10-02T07:00:00.000Z',
  actorLabel: 'staff/BR-0001',
  provenance: 'The Google figures are what staff/BR-0001 recorded seeing on the profile.',
  mode: 'manual_snapshot',
  form: {
    reason: 'The Google profile could not be read (AccessNotGranted). docs/10 §4 and Y3-gbp-api.',
    fields: [
      { name: 'open-0', label: 'Sunday: opens', kind: 'time_of_day' },
      { name: 'close-0', label: 'Sunday: closes', kind: 'time_of_day' },
      { name: 'closed-0', label: 'Sunday: closed', kind: 'closed_flag' },
      {
        name: 'price-swedish-massage-60',
        label: 'Swedish massage (60 minutes): price on the profile',
        kind: 'amount_aed',
      },
    ],
  },
  findings: [FINDING],
  compared: true,
  refusal: null,
  refusalDetail: null,
  recorded: false,
  mayRecord: true,
}

describe('the Google profile snapshot screen', () => {
  it('renders both values and names which source each came from', () => {
    const html = renderGbpSnapshotHtml({ ...BASE, chrome: CHROME })
    expect(html).toContain('11:00-02:00 (the next day)')
    expect(html).toContain('11:00-01:00 (the next day)')
    expect(html).toContain('premises_hours_row')
    expect(html).toContain('manual_snapshot')
    expect(html).toContain('opening_hours_disagree')
  })

  it('carries no value from the website side in the form', () => {
    // The fields are empty. Asserted over the form half only, because the FINDINGS legitimately quote
    // both figures — the hazard is a value sitting in an input, not a value in a comparison.
    const formOnly = renderGbpSnapshotHtml({
      ...BASE,
      findings: [],
      compared: false,
      chrome: CHROME,
    })
    expect(formOnly).not.toContain('11:00')
    expect(formOnly).not.toContain('value="0')
    expect(formOnly).toContain('name="open-0"')
    expect(formOnly).toContain('name="price-swedish-massage-60"')
  })

  it('is noindex, no-store and carries no bare brand in its title', () => {
    const html = renderGbpSnapshotHtml({ ...BASE, chrome: CHROME })
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">')
    expect(html).toContain('<title>Google profile snapshot — agents admin</title>')
  })

  it('shows the fields read-only and offers no button when the role may not record', () => {
    // The hidden action field is excluded: it carries no value a person types, and there is no submit
    // button to send it with when the role may not record.
    const inputs = (html: string): readonly string[] =>
      (html.match(/<input [^>]*>/g) ?? []).filter((tag) => !tag.includes('type="hidden"'))

    const refused = renderGbpSnapshotHtml({ ...BASE, mayRecord: false, chrome: CHROME })
    // EVERY input, not "the html contains the word disabled". The first version of this assertion was
    // satisfied by one disabled field out of five, so a render that greyed the instant and left the hours
    // typeable passed it.
    expect(inputs(refused).length).toBeGreaterThan(1)
    for (const input of inputs(refused)) expect(input, input).toContain('disabled')
    expect(refused).not.toContain('<button type="submit">')
    expect(refused).toContain('read-only')

    // The control: the permitted render offers the button and disables nothing, or the assertions above
    // are about a screen that is read-only for everybody.
    const permitted = renderGbpSnapshotHtml({ ...BASE, chrome: CHROME })
    expect(permitted).toContain('<button type="submit">')
    for (const input of inputs(permitted)) expect(input, input).not.toContain('disabled')
  })

  it('distinguishes "nothing compared yet" from "nothing disagrees"', () => {
    const notRun = renderGbpSnapshotHtml({
      ...BASE,
      findings: [],
      compared: false,
      chrome: CHROME,
    })
    const agreed = renderGbpSnapshotHtml({ ...BASE, findings: [], compared: true, chrome: CHROME })
    expect(notRun).toContain('Nothing has been compared yet')
    expect(agreed).toContain('agree on everything compared')
    expect(agreed).not.toContain('Nothing has been compared yet')
  })

  it('reads a submitted form into a snapshot, and refuses one with no instant on it', () => {
    const body = new URLSearchParams()
    body.set('observed-at', '2026-10-02T06:00:00.000Z')
    body.set('open-0', '11:00')
    body.set('close-0', '01:00')
    body.set('price-swedish-massage-60', '300')
    const read = snapshotFromForm(body, 'staff/BR-0001')
    expect('snapshot' in read).toBe(true)
    if (!('snapshot' in read)) return
    expect(read.snapshot.claimedBy).toBe('staff/BR-0001')
    expect(read.snapshot.days).toEqual([{ dayOfWeek: 0, openText: '11:00', closeText: '01:00' }])
    expect(read.snapshot.prices).toEqual([
      { serviceKey: 'swedish-massage', durationMinutes: 60, grossAedText: '300' },
    ])

    const noInstant = new URLSearchParams(body)
    noInstant.delete('observed-at')
    expect(snapshotFromForm(noInstant, 'staff/BR-0001')).toMatchObject({
      refusal: 'nothing_transcribed',
    })
    const blank = new URLSearchParams()
    blank.set('observed-at', '2026-10-02T06:00:00.000Z')
    expect(snapshotFromForm(blank, 'staff/BR-0001')).toMatchObject({
      refusal: 'nothing_transcribed',
    })
    const unreadable = new URLSearchParams(body)
    unreadable.set('observed-at', 'yesterday evening')
    expect(snapshotFromForm(unreadable, 'staff/BR-0001')).toMatchObject({
      refusal: 'unreadable_value',
    })
  })

  it('reads a closed day as closed, and skips a row left entirely blank', () => {
    const body = new URLSearchParams()
    body.set('observed-at', '2026-10-02T06:00:00.000Z')
    body.set('open-0', '')
    body.set('close-0', '')
    body.append('open-1', '')
    body.set('closed-1', 'yes')
    body.set('price-swedish-massage-60', '300')
    const read = snapshotFromForm(body, 'staff/BR-0001')
    if (!('snapshot' in read)) throw new Error('expected a snapshot')
    // The screen says a row may be left blank, so a blank one is not a half-filled one.
    expect(read.snapshot.days).toEqual([{ dayOfWeek: 1, closed: true }])
  })
})
