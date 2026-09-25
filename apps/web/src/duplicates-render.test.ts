import {
  buildDuplicateQueue,
  type CustomerMergeSubject,
  DUPLICATE_AUTO_MERGE_THRESHOLD,
  DUPLICATE_REVIEW_THRESHOLD,
  DUPLICATE_THRESHOLDS_OPEN_QUESTION,
  type Instant,
  instantFromIso,
} from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { renderMergePreviewHtml } from '../app/(admin)/clients/duplicates/preview/render.ts'
import {
  type DuplicateQueueView,
  previewHref,
  type QueueScopeView,
  renderDuplicateQueueHtml,
  scopeQuery,
} from '../app/(admin)/clients/duplicates/render.ts'

/**
 * The two C-CRM-06 documents, without a server.
 *
 * Both renderers are pure — a view in, a document out — so everything except "does the built application
 * really answer this" can be asserted here in milliseconds. `apps/web/src/duplicates.itest.ts` drives the
 * rest against `next start`, which is the only place axe, the redirect and the row counts either side of the
 * confirm click can be proved.
 *
 * The one thing that can ONLY be checked here is the escaping, and it is the reason this file exists: a
 * `display_name` is whatever the front desk typed, it reaches an admin page that also carries a form which
 * performs an irreversible write, and a stored `<script>` in it would run in that origin. The integration
 * suite's labels are all `Customer NNNN` (ADR 0020), so it would never notice.
 */

const AT = (iso: string): Instant => instantFromIso(iso)

const subject = (over: Partial<CustomerMergeSubject> & { id: string }): CustomerMergeSubject => ({
  createdAt: AT('2026-01-01T08:00:00.000Z'),
  phoneE164: '+971590009601',
  displayName: 'Customer 9601',
  nameMatchKey: '9601 customer:9601',
  locale: 'en',
  notes: null,
  createdVia: 'front_desk',
  phoneVerifiedAt: null,
  ...over,
})

const SURVIVOR = subject({
  id: '00000000-0000-7000-8000-00000000d601',
  createdAt: AT('2025-05-06T08:00:00.000Z'),
})
const LOSER = subject({
  id: '00000000-0000-7000-8000-00000000d602',
  createdAt: AT('2026-07-08T08:00:00.000Z'),
  phoneE164: '+971590009602',
})

const scope = (over: Partial<QueueScopeView> = {}): QueueScopeView => ({
  customerIds: null,
  recordsProbed: 2,
  scansIssued: 2,
  bounded: false,
  subjectLimit: 100,
  atIso: '2094-04-18T12:00:00.000Z',
  direction: 'ltr',
  ...over,
})

const queueView = (over: Partial<DuplicateQueueView> = {}): DuplicateQueueView => ({
  queue: buildDuplicateQueue({
    records: [
      { subject: SURVIVOR, isMergedAway: false },
      { subject: LOSER, isMergedAway: false },
    ],
    edges: [{ aId: SURVIVOR.id, bId: LOSER.id }],
  }),
  scope: scope(),
  reviewPerMille: DUPLICATE_REVIEW_THRESHOLD * 1000,
  autoMergePerMille: DUPLICATE_AUTO_MERGE_THRESHOLD * 1000,
  thresholdsOpenQuestion: DUPLICATE_THRESHOLDS_OPEN_QUESTION,
  ...over,
})

describe('the queue document', () => {
  it('prints the score, both records and a link to the preview', () => {
    const html = renderDuplicateQueueHtml(queueView())
    expect(html).toContain('<h1>Duplicate review queue</h1>')
    expect(html).toContain('data-field="score">0.900')
    expect(html).toContain(SURVIVOR.phoneE164)
    expect(html).toContain(LOSER.phoneE164)
    expect(html).toContain(`survivor=${SURVIVOR.id}`)
    // The threshold the page filtered on, and the open question behind it, because a filter nobody states
    // is a filter a reviewer cannot argue with.
    expect(html).toContain('0.700')
    expect(html).toContain(DUPLICATE_THRESHOLDS_OPEN_QUESTION)
  })

  it('says which of the three reasons an empty queue is', () => {
    const empty = renderDuplicateQueueHtml(
      queueView({
        queue: buildDuplicateQueue({
          records: [
            { subject: SURVIVOR, isMergedAway: false },
            { subject: LOSER, isMergedAway: true },
          ],
          edges: [{ aId: SURVIVOR.id, bId: LOSER.id }],
        }),
      }),
    )
    expect(empty).toContain('Nothing to review')
    expect(empty).toMatch(/Already merged away<\/dt><dd>1<\/dd>/)
    expect(empty).toMatch(/Pairs the scan found<\/dt><dd>1<\/dd>/)
    // The control: the same document with the pair present is not the empty one.
    expect(renderDuplicateQueueHtml(queueView())).not.toContain('Nothing to review')
  })

  it('says when the probe bound bit, so a window is not read as the whole table', () => {
    expect(renderDuplicateQueueHtml(queueView({ scope: scope({ bounded: true }) }))).toContain(
      'This is a window, not the whole table',
    )
    expect(renderDuplicateQueueHtml(queueView())).toContain('Every record in scope was probed')
  })

  it('mirrors on `dir=rtl` and is otherwise the same document', () => {
    const ltr = renderDuplicateQueueHtml(queueView())
    const rtl = renderDuplicateQueueHtml(queueView({ scope: scope({ direction: 'rtl' }) }))
    expect(ltr).toContain('<html lang="en" dir="ltr">')
    expect(rtl).toContain('<html lang="en" dir="rtl">')
    // The direction reaches the links too, or a reviewer who followed one would lose the mirror.
    expect(rtl).toContain('dir=rtl')
    expect(ltr).not.toContain('dir=rtl')
  })

  it('carries the scope onto every link, so a narrowed queue stays narrowed', () => {
    const narrowed = scope({ customerIds: [SURVIVOR.id, LOSER.id] })
    const query = scopeQuery(narrowed)
    expect(query).toContain(`customer=${SURVIVOR.id}`)
    expect(query).toContain(`customer=${LOSER.id}`)
    const row = queueView().queue.rows[0]
    if (row === undefined) throw new Error('the fixture pair is not in the queue')
    // The survivor is named EXPLICITLY on the link even though it is the default: a link meaning "the
    // default" would change meaning if the rule ever did.
    expect(previewHref(row, narrowed)).toContain(`survivor=${SURVIVOR.id}`)
    expect(previewHref(row, narrowed)).toContain(`loser=${LOSER.id}`)
  })

  it('escapes a hostile label rather than rendering it', () => {
    // The reason this file exists. `display_name` is whatever the front desk typed, and this page carries a
    // form that performs an irreversible write — so a stored `<script>` here would run in the admin origin.
    const hostile = '<script>alert(1)</script>'
    const html = renderDuplicateQueueHtml(
      queueView({
        queue: buildDuplicateQueue({
          records: [
            { subject: { ...SURVIVOR, displayName: hostile }, isMergedAway: false },
            { subject: { ...LOSER, displayName: hostile }, isMergedAway: false },
          ],
          edges: [{ aId: SURVIVOR.id, bId: LOSER.id }],
        }),
      }),
    )
    expect(html).not.toContain(hostile)
    expect(html).toContain('&lt;script&gt;')
    // The control: the same label DOES reach the page, escaped, so the assertion above is not passing
    // because the label was dropped.
    expect(html).toContain('alert(1)')
  })
})

describe('the preview document', () => {
  const previewView = {
    kind: 'preview' as const,
    survivor: SURVIVOR,
    loser: LOSER,
    scorePerMille: 900,
    phoneAgreement: 'one_digit_apart',
    labelAgreement: 'identical',
    authority: 'operator_confirmed',
    tables: [
      {
        participant: 'public.customer_tag',
        strategy: 'repoint_update',
        rowsBeforeSurvivor: 1,
        rowsBeforeLoser: 2,
        rowsAfterSurvivor: 2,
        rowsAfterLoser: 1,
        rowsMoved: 1,
        rowsInserted: 0,
        rowsRetainedOnLoser: 1,
        retainedReason: 'The survivor already carries that tag.',
      },
    ],
    consent: [{ channel: 'sms', purpose: 'marketing', before: 'granted', after: 'withdrawn' }],
    fields: [
      {
        field: 'phoneE164' as const,
        resolution: 'not_transferable' as const,
        survivorValue: SURVIVOR.phoneE164,
        loserValue: LOSER.phoneE164,
        why: 'customer.phone_e164 is UNIQUE.',
      },
    ],
    wouldWrite: { mergeRecords: 1, mergeRecordTables: 10, auditEvents: 1 },
    swapHref: '/clients/duplicates/preview?survivor=b&loser=a',
    queueHref: '/clients/duplicates',
    atIso: '2094-04-18T12:00:00.000Z',
    direction: 'ltr' as const,
    survivorWasNominated: false,
  }

  it('prints what moves, what is retained and why, and the consent state either side', () => {
    const html = renderMergePreviewHtml(previewView)
    expect(html).toContain('data-participant="public.customer_tag"')
    expect(html).toContain('data-field="moved">1<')
    expect(html).toContain('data-field="retained">1<')
    expect(html).toContain('The survivor already carries that tag.')
    expect(html).toContain('data-field="before">granted<')
    expect(html).toContain('data-field="after">withdrawn<')
    // The page says nothing has been merged, which is the whole claim of a preview.
    expect(html).toContain('Nothing has been merged')
    // And it says what authorising it WOULD write, from the figures the rolled-back merge measured.
    expect(html).toContain('data-field="would-write">1<')
  })

  it('offers the confirm form with both stated fields required, and the swap', () => {
    const html = renderMergePreviewHtml(previewView)
    expect(html).toContain('<form method="post" action="/clients/duplicates/preview">')
    expect(html).toContain('name="authorisedBy" required')
    expect(html).toContain('name="reason" required')
    expect(html).toContain('name="confirm" value="yes"')
    expect(html).toContain('data-action="swap"')
    // Both ids travel in the form, so the POST acts on the pair the page was about and not on whatever the
    // query string said at the time.
    expect(html).toContain(`name="survivor" value="${SURVIVOR.id}"`)
    expect(html).toContain(`name="loser" value="${LOSER.id}"`)
  })

  it('says whether the survivor is the default or was chosen by hand', () => {
    expect(renderMergePreviewHtml(previewView)).toContain('<strong>default</strong> survivor')
    expect(renderMergePreviewHtml({ ...previewView, survivorWasNominated: true })).toContain(
      'chosen by hand',
    )
  })

  it('renders the already-merged state with no form on it at all', () => {
    const html = renderMergePreviewHtml({
      kind: 'already_merged',
      mergeRecordId: '00000000-0000-7000-8000-00000000d6ff',
      survivorCustomerId: SURVIVOR.id,
      loserCustomerId: LOSER.id,
      mergedAtIso: '2094-04-18T12:00:00.000Z',
      queueHref: '/clients/duplicates',
      direction: 'ltr',
    })
    expect(html).toContain('<h1>Already merged</h1>')
    expect(html).toContain('data-field="merge-record"')
    // No form, because there is nothing left to authorise: a second attempt on one pair is refused by
    // `merge_record_one_merge_per_loser` and a button that looked live would be a lie.
    expect(html).not.toContain('<form')
    expect(html).not.toContain('name="confirm"')
  })
})
