import { describe, expect, it } from 'vitest'
import {
  type RotaPageView,
  type RotaShortfallView,
  type RotaViolationView,
  renderRotaHtml,
} from '../app/(admin)/hr/rota/render.ts'

/**
 * The rota document, without a server (P-HR-06).
 *
 * Everything the screen has to make visible is decidable from the markup, so there is no server here and no
 * port band claimed: a band declared and not used fails `ports.test.ts`, and a suite that started `next
 * start` to read a `<dl>` would be paying two minutes for what a string match answers.
 *
 * Every assertion has its control, because a renderer that prints nothing satisfies every "must not show"
 * claim on its own:
 *
 *   * "does not name a therapist" is paired with the counts and the rule names being present, so the
 *     document is asserted to be a rota rather than asserted to be empty.
 *   * "prints the unpriced count" is paired with the same document printing the forecast, because the whole
 *     point is that the two appear TOGETHER: 0 fils on its own reads as a free rota.
 *   * "says the high-intensity cap cannot fire" is paired with the other branch — a rule version whose list
 *     is non-empty must print the codes instead — so the sentence is a function of the data and not a
 *     constant somebody left in the template.
 */
const VIOLATIONS: readonly RotaViolationView[] = [
  {
    rule: 'minimum_floor_coverage',
    detail: '2026-07-06 00:30-01:00: 1 therapist(s) on the floor, 2 required',
  },
  { rule: 'credential_not_current', detail: '2026-07-06: labour_card EXPIRED' },
]

const SHORTFALLS: readonly RotaShortfallView[] = [
  {
    label: '2026-07-06 00:30-01:00',
    rule: 'minimum_floor_coverage',
    onFloor: 1,
    required: 2,
  },
]

function view(overrides: Partial<RotaPageView> = {}): RotaPageView {
  return {
    chrome: { googleReauth: null, returnTo: '/hr/rota' },
    readAtIso: '2026-07-06T06:00:00.000Z',
    fromTradingDate: '2026-07-06',
    toTradingDate: '2026-07-12',
    published: {
      versionNo: 3,
      publishedAtIso: '2026-07-01T09:00:00.000Z',
      publishedBy: 'front desk',
      assignmentCount: 34,
      noticeCount: 6,
      forecastLabourCostFils: 0,
      forecastUnpricedEmployees: 6,
    },
    draftAssignmentCount: 34,
    draftTherapistCount: 6,
    unskilledRosteredCount: 0,
    isPublishable: false,
    violations: VIOLATIONS,
    shortfalls: SHORTFALLS,
    segmentCount: 210,
    forecastTotalFils: 0,
    forecastTotalMinutes: 16_320,
    unpricedEmployeeCount: 6,
    pricedEmployeeCount: 0,
    thresholds: {
      effectiveFrom: '1900-01-01',
      openQuestionId: 'Y9-coverage',
      minimumTherapistsOnFloor: 2,
      minimumWetRoomCapable: 1,
      coverageSegmentMinutes: 30,
      treatmentMinutesCapPerDay: 360,
      highIntensityMinutesCapPerDay: 240,
      highIntensityTreatmentCodes: [],
    },
    wageDivisorEffectiveFrom: '1900-01-01',
    wageDivisorOpenQuestionId: 'Y9-overtime',
    ...overrides,
  }
}

describe('the rota document', () => {
  it('is a noindex admin document with no brand in its title', () => {
    const html = renderRotaHtml(view())
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">')
    expect(html).toContain('<title>Rota — HR admin</title>')
    // docs/09's brand collision: the bare brand may not appear in any title, and
    // `apps/web/src/seo/brand.test.ts` scans every title-bearing line in `apps/web` for it.
    expect(html).not.toMatch(/<title>[^<]*BE ?RELAX/i)
  })

  it('names every refused rule, by the name the database stores', () => {
    const html = renderRotaHtml(view())
    for (const violation of VIOLATIONS) {
      expect(html).toContain(`<code>${violation.rule}</code>`)
      expect(html).toContain(violation.detail)
    }
    // The count, so a screen that listed one of two would fail. And the wording: "refused by 2 rule
    // breach(es)" is what tells a reader the draft is not publishable, and a page that only omitted a
    // publish button would say nothing at all.
    expect(html).toContain('Refused by 2 rule breach(es).')
  })

  it('says the draft is publishable when it is, and offers no way to publish it', () => {
    const html = renderRotaHtml(view({ isPublishable: true, violations: [], shortfalls: [] }))
    expect(html).toContain('satisfies every rule and can be published')
    // READ-ONLY: no form, no button, no method that is not GET. Publishing is a write with an actor and
    // there is no admin session until W-SYS-01.
    expect(html).not.toMatch(/<form|<button|method=/i)
  })

  it('prints the forecast and the unpriced count in the same document', () => {
    const html = renderRotaHtml(view())
    // The pair is the claim. `AED 0.00` alone reads as a free rota; the second line is what makes it a
    // statement about missing wages rather than about a cheap week.
    expect(html).toMatch(/AED\s*0\.00/)
    expect(html).toContain('6 therapist(s) have no basic wage on file')
    expect(html).toContain('<dd>0 of 6 therapist(s)</dd>')
    // And the minutes, which ARE knowable for an unpriced employee.
    expect(html).toContain('<dd>16320</dd>')
  })

  it('says the high-intensity cap cannot fire while no treatment is classified', () => {
    const html = renderRotaHtml(view())
    expect(html).toContain('no treatment is classified as high-intensity yet')
    expect(html).toContain('this cap cannot fire')
  })

  it('prints the classified treatments instead once the rule version names some', () => {
    // The control for the case above: the sentence is a function of the data. Without this, a template that
    // always said "cannot fire" would pass — and would go on saying it after Y9-coverage was answered.
    const html = renderRotaHtml(
      view({
        thresholds: {
          ...view().thresholds,
          highIntensityTreatmentCodes: ['deep_tissue', 'sports_massage'],
        },
      }),
    )
    expect(html).toContain('deep_tissue, sports_massage')
    expect(html).not.toContain('this cap cannot fire')
  })

  it('flags every threshold as provisional, naming both open questions', () => {
    const html = renderRotaHtml(view())
    // docs/12 §2: a provisional figure is marked where it is USED, not only on the assumptions panel.
    expect(html).toContain('Every threshold below is provisional')
    expect(html).toContain('Y9-coverage')
    expect(html).toContain('Y9-overtime')
  })

  it('reports the staff notices as recorded and NOT as sent', () => {
    const html = renderRotaHtml(view())
    // The stub that looks like it works is what docs/12 §1 forbids. Nothing in this build holds a staff
    // phone or email, so the screen says what the notice rows say.
    expect(html).toContain('6 recorded, none sent')
    expect(html).toContain('no staff phone or email is on file')
    expect(html).not.toMatch(/notified 6|6 therapists notified/i)
  })

  it('lists the short segments and counts the rest', () => {
    const html = renderRotaHtml(view())
    expect(html).toContain('1 of 210 segments are short')
    expect(html).toContain('2026-07-06 00:30-01:00')
    expect(html).toContain('1 of 2')
  })

  it('says every segment is covered when none is short', () => {
    const html = renderRotaHtml(view({ shortfalls: [], violations: [], isPublishable: true }))
    expect(html).toContain('Every one of the 210 segments has its minimum cover.')
  })

  it('says nothing is published when nothing is', () => {
    const html = renderRotaHtml(view({ published: null }))
    expect(html).toContain('Nothing has been published for this period yet')
    // And it still shows the draft, because that is the working half of the screen.
    expect(html).toContain('<code>minimum_floor_coverage</code>')
  })

  it('names no therapist and no customer anywhere', () => {
    const html = renderRotaHtml(view())
    // A coverage shortfall is a claim about a NUMBER on the floor. Nineteen employees have no name recorded
    // and the ones that will have it hold it behind ADR 0020's publication guard.
    expect(html).not.toMatch(/Therapist \d+/)
    expect(html).not.toMatch(/customer|Customer \d+/i)
    // The control: the document is a rota rather than empty, so the two assertions above are about
    // something. A renderer that printed nothing would satisfy them both.
    expect(html).toContain('34 assignment(s) across 6 therapist(s)')
    expect(html.length).toBeGreaterThan(2_000)
  })

  it('warns when a rostered employee holds no therapist skill, and stays silent when none does', () => {
    // Both branches, because the sentence is a claim about the DATA. Nothing in this database says who is a
    // therapist except `employee_skill`, so a rostered employee without a skill row is either the front desk
    // or somebody whose skills nobody recorded — and in the second case their shifts look like cover and
    // count for nothing. A page that never said so would hide the understated floor.
    expect(renderRotaHtml(view({ unskilledRosteredCount: 2 }))).toContain(
      '2 rostered employee(s) hold no therapist skill',
    )
    expect(renderRotaHtml(view())).not.toContain('hold no therapist skill')
  })

  it('escapes what it prints, so a published_by value cannot inject markup', () => {
    const html = renderRotaHtml(
      view({
        published: {
          ...(view().published as NonNullable<RotaPageView['published']>),
          publishedBy: '<script>x</script>',
        },
      }),
    )
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('renders the Google re-auth banner, as every admin document must', () => {
    // `apps/web/src/google-reauth-banner.test.ts` walks every admin document on disk and fails by name if
    // one does not call `renderAdminBanner`. Asserted here too, over a live banner rather than a null one,
    // because that walk proves the CALL and this proves the output reaches the page.
    const html = renderRotaHtml(
      view({
        chrome: {
          googleReauth: {
            state: 'broken',
            headline: 'The Google connection has stopped working',
            detail: 'Review replies are being drafted for you to post by hand; nothing is lost.',
            dismissible: false,
            connectionId: '00000000-0000-7000-8000-0000000000aa',
            googleEmail: 'google-admin@example.invalid',
          },
          returnTo: '/hr/rota',
        },
      }),
    )
    expect(html).toContain('The Google connection has stopped working')
    expect(html).toMatch(/reconnect/i)
  })
})
