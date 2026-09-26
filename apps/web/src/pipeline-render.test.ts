import type { PipelineBoard, PipelineCard } from '@berelax/db'
import { describe, expect, it } from 'vitest'
import {
  cardLabel,
  type PipelineView,
  pipelineAnnouncement,
  renderPipelineHtml,
} from '../app/(admin)/crm/pipeline/render.ts'

/**
 * C-AUTO-08 — the board's DOCUMENT, asserted without a server.
 *
 * The render is pure: a board in, a document out. Everything here is a claim about the bytes, which is the
 * half of this unit that does not need a browser — the drag, the keyboard path, axe and the screenshots are
 * `pipeline.itest.ts`'s, because a sequence of pointer events and a `getBoundingClientRect` cannot be
 * checked by reading source.
 *
 * The one thing worth saying about the split: a substring assertion cannot tell an element that is in the
 * document from one the page's own CSS has collapsed to nothing. So the empty-state and the hidden-state
 * claims here are about the ATTRIBUTE, and whether a reader can see the card is asserted in a real browser.
 */

const PHONE_A = '+971590000811'
const PHONE_B = '+971590000812'
const PHONE_C = '+971590000813'

/** ADR 0020: a record with no label is `Customer NNNN`, and this build never invents a person's name. */
const card = (overrides: Partial<PipelineCard> & { customerId: string }): PipelineCard => ({
  displayName: null,
  phoneE164: PHONE_A,
  lifecycleState: 'lead',
  isVip: false,
  stageEnteredAtIso: '2099-04-01T08:00:00.000Z',
  ...overrides,
})

const ID_A = '01a00000-0000-7000-8000-00000000000a'
const ID_B = '01a00000-0000-7000-8000-00000000000b'
const ID_C = '01a00000-0000-7000-8000-00000000000c'

function board(): PipelineBoard {
  return {
    columns: [
      {
        stageKey: 'new_enquiry',
        displayOrder: 1,
        description: 'Somebody has made contact and nothing has been offered yet.',
        isProvisional: true,
        openQuestionId: 'Y9-crm-pipeline',
        entryFlowKey: null,
        cards: [
          card({ customerId: ID_A, displayName: 'Customer 0042' }),
          card({ customerId: ID_B, phoneE164: PHONE_B, lifecycleState: 'active', isVip: true }),
        ],
      },
      {
        stageKey: 'contacted',
        displayOrder: 2,
        description: 'The salon has replied and is waiting on the enquirer.',
        isProvisional: true,
        openQuestionId: 'Y9-crm-pipeline',
        entryFlowKey: 'cauto08_welcome',
        cards: [],
      },
      {
        stageKey: 'booked',
        displayOrder: 3,
        description: 'An appointment exists and has not been attended yet.',
        isProvisional: true,
        openQuestionId: 'Y9-crm-pipeline',
        entryFlowKey: null,
        cards: [card({ customerId: ID_C, phoneE164: PHONE_C, displayName: 'Customer 0043' })],
      },
    ],
    cardCount: 3,
  }
}

function view(overrides: Partial<PipelineView> = {}): PipelineView {
  return {
    chrome: { googleReauth: null, returnTo: '/crm/pipeline' },
    board: board(),
    direction: 'ltr',
    vocabularyOpenQuestion: 'Y9-crm-pipeline',
    outcome: null,
    ...overrides,
  }
}

describe('the board draws one column per stage, in the order the rows declare', () => {
  it('draws three columns with their keys, descriptions and counts', () => {
    const html = renderPipelineHtml(view())
    for (const stage of ['new_enquiry', 'contacted', 'booked']) {
      expect(html, stage).toContain(`data-testid="column-${stage}"`)
      expect(html, stage).toContain(`data-stage="${stage}"`)
    }
    // Order, not presence: a board that rendered the columns alphabetically would satisfy three
    // `toContain`s and be wrong in the only way a board can be wrong about its columns.
    expect(html.indexOf('column-new_enquiry')).toBeLessThan(html.indexOf('column-contacted'))
    expect(html.indexOf('column-contacted')).toBeLessThan(html.indexOf('column-booked'))
    expect(html).toContain('Somebody has made contact and nothing has been offered yet.')
    expect(html).toContain('<span class="tally" data-tally>2</span>')
    expect(html).toContain('<span class="tally" data-tally>0</span>')
  })

  it('the control: a reordered board draws its columns in the new order', () => {
    // Without this the assertion above is satisfied by a render that hard-coded the six seeded keys in
    // their migration order, which is the one bug a reorder screen can ship.
    const reversed = board()
    const html = renderPipelineHtml(
      view({ board: { ...reversed, columns: [...reversed.columns].reverse() } }),
    )
    expect(html.indexOf('column-booked')).toBeLessThan(html.indexOf('column-new_enquiry'))
  })
})

describe('a card is a button, and it never carries a name nobody supplied', () => {
  it('renders each card as a button with its contact id and no pressed state', () => {
    const html = renderPipelineHtml(view())
    expect(html).toContain(`data-testid="card-${ID_A}"`)
    expect(html).toContain(`data-customer="${ID_A}"`)
    // A native button, not a div with a tabindex: the keyboard path is an acceptance criterion and the
    // role, the focus order and Enter all come from the element.
    expect(html).toContain('<button type="button" class="card"')
    expect(html).toContain('aria-pressed="false"')
    // The MARKUP only. The inline script sets `aria-pressed` to true when a card is picked up, so scanning
    // the whole document for that string would be scanning the behaviour rather than the initial state.
    expect(markupOf(html)).not.toContain('aria-pressed="true"')
  })

  it('labels an unlabelled record by its number and never by an invented name', () => {
    const unlabelled = card({ customerId: ID_B, phoneE164: PHONE_B })
    expect(cardLabel(unlabelled)).toBe(`No label recorded — ${PHONE_B}`)
    // And the control, which is the half that matters: a record the front desk HAS labelled shows that
    // label rather than the fallback.
    expect(cardLabel(card({ customerId: ID_A, displayName: 'Customer 0042' }))).toBe(
      'Customer 0042',
    )
    const html = renderPipelineHtml(view())
    expect(html).toContain(`No label recorded — ${PHONE_B}`)
  })

  it('shows the lifecycle state beside the column, because the two disagree on purpose', () => {
    const html = renderPipelineHtml(view())
    // `active` in the lifecycle while sitting in `new_enquiry` on the board is the disagreement the page
    // exists to make visible: somebody the front desk has not chased who is still buying treatments.
    expect(html).toContain('Lifecycle active')
    expect(html).toContain('· VIP')
    // The control: a card that is not VIP does not say so.
    expect(html.match(/· VIP/g)).toHaveLength(1)
  })
})

describe('an empty column says so, and a full one carries the same element hidden', () => {
  it('leaves the empty note visible for an empty column and hidden for a full one', () => {
    const html = renderPipelineHtml(view())
    expect(html).toContain('<p class="empty" data-empty>No cards in this column.</p>')
    expect(html).toContain('<p class="empty" data-empty hidden>No cards in this column.</p>')
    // Present in BOTH states, which is what lets the script reveal it without building an element: a node
    // created by script is a second place the markup is decided, and the two copies drift.
    expect(markupOf(html).match(/data-empty/g)).toHaveLength(3)
  })
})

describe('the live region is the only feedback a keyboard move gives', () => {
  it('is a polite status region, empty on a plain load', () => {
    const html = renderPipelineHtml(view())
    expect(html).toContain('role="status" aria-live="polite" data-pipeline-live')
    expect(html).toContain('data-testid="pipeline-live">')
    expect(html).toContain('data-testid="pipeline-live"></p>')
  })

  it('carries the announcement a no-JavaScript round trip came back with', () => {
    const moved = renderPipelineHtml(
      view({ outcome: { kind: 'moved', toStageKey: 'booked', label: 'booked' } }),
    )
    expect(moved).toContain('Moved to booked.')
    const refused = renderPipelineHtml(
      view({
        outcome: {
          kind: 'refused',
          refusal: 'stage_archived',
          message: 'that column is archived.',
        },
      }),
    )
    expect(refused).toContain('Not moved: that column is archived.')
    // The refusal is NAMED on the root element, so a browser case can wait for it rather than for a
    // sentence — and a silent revert is distinguishable from a refused one.
    expect(refused).toContain('data-pipeline-refusal="stage_archived"')
    expect(moved).not.toContain('data-pipeline-refusal')
  })

  it('uses one wording for both paths', () => {
    // The fetch path and the 303 path both call this, which is what stops a move announcing two different
    // sentences depending on whether JavaScript ran.
    expect(pipelineAnnouncement({ kind: 'moved', toStageKey: 'repeat', label: 'repeat' })).toBe(
      'Moved to repeat.',
    )
    expect(
      pipelineAnnouncement({ kind: 'refused', refusal: 'stage_archived', message: 'gone.' }),
    ).toBe('Not moved: gone.')
  })
})

describe('the document is the same document in both directions, mirrored', () => {
  it('sets dir and changes nothing else about what it contains', () => {
    const ltr = renderPipelineHtml(view())
    const rtl = renderPipelineHtml(view({ direction: 'rtl' }))
    expect(ltr).toContain('<html lang="en" dir="ltr">')
    expect(rtl).toContain('<html lang="en" dir="rtl">')
    // The direction is a LAYOUT axis, not a locale: the same English document mirrored. If it were a
    // locale the two would differ in their words, and the RTL screenshot cell would be a different page.
    expect(rtl.replace('dir="rtl"', 'dir="ltr"')).toBe(ltr)
  })

  it('mirrors through logical properties only, so no rule names a physical side', () => {
    const html = renderPipelineHtml(view())
    const styles = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
    for (const physical of ['margin-left', 'margin-right', 'padding-left', 'padding-right']) {
      expect(styles, physical).not.toContain(physical)
    }
    expect(styles).toContain('border-inline-start-width')
  })
})

describe('the same board rendered twice is byte-identical', () => {
  it('renders no clock, no random value and no id of its own', () => {
    // The screenshot acceptance line ("two consecutive runs produce zero pixel diff") cannot hold if the
    // document cannot. Asserted here as well as in the browser, because this is where it would break: a
    // relative time or a generated id added to a card is invisible in review and fatal to the capture.
    expect(renderPipelineHtml(view())).toBe(renderPipelineHtml(view()))
    // The control on that equality: a board that differs really does render differently.
    const moved = board()
    const first = moved.columns[0]
    if (first === undefined) throw new Error('fixture has no first column')
    expect(renderPipelineHtml(view())).not.toBe(
      renderPipelineHtml(
        view({
          board: { ...moved, columns: [{ ...first, cards: [] }, ...moved.columns.slice(1)] },
        }),
      ),
    )
  })
})

describe('the no-JavaScript path exists and names both halves of a move', () => {
  it('offers one form with a card select and a column select', () => {
    const html = renderPipelineHtml(view())
    expect(html).toContain('data-testid="pipeline-move-form"')
    expect(html).toContain('name="customerId"')
    expect(html).toContain('name="toStageKey"')
    // One form, not one per card: forty identically-named submit buttons is a page `button-name` cannot
    // fault and nobody can use.
    expect(html.match(/<form/g)).toHaveLength(1)
    expect(html.match(/<option/g)).toHaveLength(6)
  })

  it('offers no form at all when the board holds no cards', () => {
    const empty = board()
    const html = renderPipelineHtml(
      view({
        board: {
          ...empty,
          columns: empty.columns.map((column) => ({ ...column, cards: [] })),
          cardCount: 0,
        },
      }),
    )
    expect(html).not.toContain('<form')
    expect(html).toContain('No cards in this column.')
  })
})

describe('the page states what a stage IS, and cites the open question', () => {
  it('says a stage is a claim about a person and names the vocabulary question', () => {
    const html = renderPipelineHtml(view())
    expect(html).toContain('A stage is a claim somebody made about a person')
    expect(html).toContain('data-testid="pipeline-open-question">Y9-crm-pipeline</code>')
    // The distinction the whole design rests on, on the face of the page: a reader who believes the board
    // shows the lifecycle will read every disagreement as a bug.
    expect(html).toContain('A pipeline stage is not the lifecycle state beside it')
  })

  it('carries no literal colour, because the token layer owns them', () => {
    const html = renderPipelineHtml(view())
    const styles = html.slice(html.indexOf(`${PIPELINE_CSS_MARKER}`))
    expect(styles.length).toBeGreaterThan(0)
    // `pnpm colours` scans the source; this scans the OUTPUT, which is where a hex would actually ship.
    // The token stylesheet is emitted above it and does contain hex values, so the scan starts at the
    // page's own first rule.
    expect(styles).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

/**
 * The document with its inline script removed.
 *
 * Several claims here are about the initial STATE of the markup, and the script contains the strings that
 * state changes to it (`aria-pressed`, `data-empty`) and the stylesheet carries a rule for the pressed state. A scan over the
 * whole document conflates all three, and
 * the direction that bites is the quiet one: an assertion that the page carries no pressed card would be
 * satisfied or broken by a line of behaviour nobody changed.
 */
const markupOf = (html: string): string =>
  html.slice(html.indexOf('<body>'), html.indexOf('<script>'))

/** The first selector of the page's own stylesheet, which is where the token layer stops. */
const PIPELINE_CSS_MARKER = '*, *::before, *::after { box-sizing: border-box; }'
