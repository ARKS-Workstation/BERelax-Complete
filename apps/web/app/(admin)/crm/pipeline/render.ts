import { safeText } from '@berelax/core'
import type { PipelineBoard, PipelineCard, PipelineColumn } from '@berelax/db'
import { tokensCss } from '@berelax/ui'
import {
  type AdminChrome,
  GOOGLE_REAUTH_BANNER_CSS,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'

/**
 * The pipeline board, as HTML (C-AUTO-08).
 *
 * Pure: a board in, a document out. No database, no clock — every figure on the page is a function of the
 * rows it is given, which is what lets `apps/web/src/pipeline-render.test.ts` assert the screen without a
 * server and what makes two consecutive renders of one board byte-identical.
 *
 * ## Why a route handler and not a page
 *
 * The reason the Messages inbox, the template editor, the compliance calendar and the duplicate queue all
 * give: W-SITE-01's registry requires every *document* to be served in both locales, so a `page.tsx` here
 * would need an Arabic admin document and the W-SYS-01 shell. `?dir=rtl` re-renders this English document
 * mirrored, which is a layout axis rather than a locale: it is how the direction half of the accessibility
 * and screenshot matrices is audited without inventing an Arabic admin surface. **Not authenticated**,
 * exactly as every route under `/compliance`, `/hr`, `/clients` and `/settings` records.
 *
 * ## The three things the markup has to get right, and why each is not a detail
 *
 * **A card is a `<button>`.** Not a `<div>` with `draggable="true"` and a `tabindex`. The keyboard path is
 * an acceptance criterion, and a native button is what gives it focus order, `Enter`, `Space` and a role a
 * screen reader announces — for free, and identically in both directions. `aria-pressed` carries the
 * picked-up state, which is what makes "the card is held" a fact in the accessibility tree rather than a
 * CSS class.
 *
 * **The optimistic move is a real DOM move.** On a drop the script moves the card element into the target
 * column's list BEFORE the server has answered, and remembers where it came from. That is what makes the
 * 409 acceptance line meaningful: "the optimistic card returns to its origin column" is only an assertion
 * if the card really went somewhere. A page that waited for the answer would pass a revert test that
 * proved nothing.
 *
 * **Every column carries its own ordered position and its own label.** `aria-labelledby` on the column
 * region points at the heading, so a reader navigating by region hears which column they are in; the count
 * is in the heading rather than in a decorative badge, because a count no assistive technology reads is a
 * count for sighted users only.
 */

export type RenderDirection = 'ltr' | 'rtl'

/** What a refused move is called on the page and in `document.documentElement.dataset`. */
export type PipelineOutcome =
  | { readonly kind: 'moved'; readonly toStageKey: string; readonly label: string }
  | { readonly kind: 'refused'; readonly refusal: string; readonly message: string }

export interface PipelineView {
  /**
   * The Google re-auth banner and the page a reconnect comes back to (G-CONN-08).
   *
   * Required rather than optional, for the reason the duplicate queue's view states: an optional field is
   * a permissive default, and the default would be the one state this banner exists to make impossible —
   * an admin page that says nothing while the Google grant is dead.
   */
  readonly chrome: AdminChrome
  readonly board: PipelineBoard
  readonly direction: RenderDirection
  /** The OPEN-QUESTIONS id the stage vocabulary is tracked under, so the page cites it. */
  readonly vocabularyOpenQuestion: string
  /** The announcement a no-JavaScript round trip comes back with, or null on a plain load. */
  readonly outcome: PipelineOutcome | null
}

/** The sentence the live region and the no-JavaScript round trip both use. One wording, one meaning. */
export function pipelineAnnouncement(outcome: PipelineOutcome): string {
  return outcome.kind === 'moved' ? `Moved to ${outcome.label}.` : `Not moved: ${outcome.message}`
}

/** The page's own styles. Colours are tokens only; there is no literal in this file. */
const PIPELINE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 96rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  h2 { font-size: 1rem; margin: 0; }
  p { margin: 0 0 var(--space-5); max-width: 46rem; }
  .lede {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-inline-start-color: var(--color-accent-gold);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  .live {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-3) var(--space-5);
    margin: 0 0 var(--space-5);
    min-height: 48px;
    display: flex;
    align-items: center;
  }
  .board {
    display: grid;
    gap: var(--space-5);
    grid-auto-flow: row;
    margin: 0 0 var(--space-7);
  }
  /*
    The BOARD scrolls, not the page. Eight columns at their minimum width are wider than a laptop, and a
    page that scrolls sideways moves the heading, the live region and the banner off screen with the
    columns - so the one warning an operator must not miss leaves the viewport when they look at the last
    column. Scrolling the track keeps the page still.
  */
  @media (min-width: 60rem) {
    .board { overflow-x: auto; padding-bottom: var(--space-3); }
  }
  .column {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    min-width: 0;
  }
  .column-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    margin: 0 0 var(--space-3);
  }
  .tally { color: var(--color-ink-2); font-variant-numeric: tabular-nums; }
  .what { color: var(--color-ink-2); margin: 0 0 var(--space-3); font-size: 0.875rem; }
  ol.cards { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
  ol.cards > li { margin: 0; }
  button.card {
    display: block;
    width: 100%;
    min-height: 48px;
    padding: var(--space-3) var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-ground);
    color: var(--color-ink);
    font: inherit;
    text-align: start;
    cursor: grab;
  }
  button.card:focus-visible { outline: 3px solid var(--color-accent-teal); outline-offset: 2px; }
  button.card[aria-pressed="true"] { border-color: var(--color-accent-teal); cursor: grabbing; }
  button.card[data-dragging="true"] { cursor: grabbing; }
  .card-label { display: block; font-weight: 600; }
  .card-meta { display: block; color: var(--color-ink-2); font-size: 0.875rem; }
  .empty { color: var(--color-ink-2); font-size: 0.875rem; margin: 0; min-height: 48px; }
  form.move {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    display: grid;
    gap: var(--space-3);
  }
  form.move label { display: grid; gap: var(--space-2); }
  form.move select, form.move button {
    min-height: 48px;
    padding: var(--space-3) var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-ground);
    color: var(--color-ink);
    font: inherit;
  }
  form.move button { background: var(--color-surface-sand); font-weight: 600; }
  form.move select:focus-visible, form.move button:focus-visible {
    outline: 3px solid var(--color-accent-teal);
    outline-offset: 2px;
  }
  @media (min-width: 60rem) {
    .board { grid-auto-flow: column; grid-auto-columns: minmax(14rem, 1fr); }
  }
`

/*
  The page's behaviour, and the reason each part is the shape it is.

  No backtick appears anywhere in this literal or its comments: one would END the template early, and the
  document would then carry the remainder as text. `css-rule-must-have-a-block` in
  scripts/check-layout-rules.mjs exists because that has happened.

  The drop target is found by comparing RECTANGLES and not with document.elementFromPoint. The topmost
  element at a drop point is whatever is painted last, which on a board is another card — so a drop
  squarely onto an occupied column answered "dropped outside the board", and the refusal the server exists
  to give was never asked for. B-UI-03's diary records the same defect.
*/
const PIPELINE_SCRIPT = `
  const root = document.documentElement
  const live = document.querySelector('[data-pipeline-live]')
  let drag = null
  let held = null

  function say(text) {
    if (live !== null) live.textContent = text
  }
  function columns() {
    return [...document.querySelectorAll('[data-track]')]
  }
  function columnOf(card) {
    return card.closest('[data-track]')
  }
  function indexOfColumn(column) {
    return columns().indexOf(column)
  }
  /* Where the card was, exactly: its list and the element it sat before. Restoring needs both. */
  function origin(card) {
    return { list: card.parentElement.parentElement, before: card.parentElement.nextElementSibling }
  }
  /*
    Focus does not survive a DOM move, and the keyboard path is nothing without it.

    list.append and insertBefore both REMOVE the node before inserting it, and removing the focused element
    blurs it - so the card a reader picked up with Enter stops receiving their arrow keys and their Escape,
    and the move can be started and then neither finished nor cancelled. It presents as a page that ignores
    the keyboard after the first arrow key, which reads like the handler never existed.
  */
  function keepFocus(card, hadFocus) {
    if (hadFocus) card.focus()
  }
  function restore(card, where) {
    const hadFocus = document.activeElement === card
    where.list.insertBefore(card.parentElement, where.before)
    keepFocus(card, hadFocus)
    card.style.transform = ''
    card.dataset.dragging = 'false'
    card.setAttribute('aria-pressed', 'false')
  }
  /* The optimistic move: a real DOM move, so a revert is a revert rather than a repaint. */
  function place(card, column) {
    const list = column.querySelector('[data-cards]')
    if (list === null) return
    const hadFocus = document.activeElement === card
    const empty = column.querySelector('[data-empty]')
    if (empty !== null) empty.hidden = true
    list.append(card.parentElement)
    keepFocus(card, hadFocus)
    card.style.transform = ''
  }
  function refreshEmptyStates() {
    for (const column of columns()) {
      const list = column.querySelector('[data-cards]')
      const empty = column.querySelector('[data-empty]')
      const count = list === null ? 0 : list.children.length
      if (empty !== null) empty.hidden = count > 0
      const tally = column.querySelector('[data-tally]')
      if (tally !== null) tally.textContent = String(count)
    }
  }

  function columnAt(x, y) {
    return (
      columns().find((candidate) => {
        const rect = candidate.getBoundingClientRect()
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      }) ?? null
    )
  }

  async function commit(card, column, where) {
    const response = await fetch(location.pathname + location.search, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId: card.dataset.customer,
        toStageKey: column.dataset.stage,
      }),
    })
    let data
    try {
      data = await response.json()
    } catch (error) {
      root.dataset.pipelineError = String(error && error.message ? error.message : error)
      restore(card, where)
      refreshEmptyStates()
      return
    }
    root.dataset.pipelineMoves = String(Number(root.dataset.pipelineMoves || '0') + 1)
    root.dataset.pipelineStatus = String(response.status)
    say(String(data.announcement || ''))
    if (data.ok === true) {
      card.dataset.stageEntered = String(data.occurredAt || '')
      card.dataset.dragging = 'false'
      card.setAttribute('aria-pressed', 'false')
      refreshEmptyStates()
      return
    }
    /* Refused: the SAME element goes back where it was, and the refusal is named on the page. */
    restore(card, where)
    refreshEmptyStates()
    root.dataset.pipelineRefusal = String(data.refusal || 'unknown')
  }

  function elementOf(event) {
    return event.target instanceof Element ? event.target : null
  }

  document.addEventListener('pointerdown', (event) => {
    const target = elementOf(event)
    const card = target === null ? null : target.closest('button.card')
    if (card === null) return
    drag = { card: card, x: event.clientX, y: event.clientY, where: origin(card) }
    card.dataset.dragging = 'true'
    try {
      card.setPointerCapture(event.pointerId)
    } catch (error) {
      /*
        A pointer id the element cannot capture. The card still follows the pointer, because the move
        listener is on the document. Swallowed rather than logged: capture improves the drag, it is not a
        precondition for it, and a throw here would abandon a drag the reader has already started.
      */
    }
    /* Prevents the text selection a drag across a label makes, and the focus a pointer press would take. */
    event.preventDefault()
  })
  document.addEventListener('pointermove', (event) => {
    if (drag === null) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    drag.card.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)'
  })
  document.addEventListener('pointerup', async (event) => {
    if (drag === null) return
    const card = drag.card
    const where = drag.where
    drag = null
    const column = columnAt(event.clientX, event.clientY)
    if (column === null) {
      restore(card, where)
      say('Dropped outside the board. Nothing has moved.')
      return
    }
    if (column === where.list.closest('[data-track]')) {
      restore(card, where)
      say('Dropped in the same column. Nothing has moved.')
      return
    }
    place(card, column)
    refreshEmptyStates()
    await commit(card, column, where)
  })

  document.addEventListener('keydown', async (event) => {
    const target = elementOf(event)
    const card = target === null ? null : target.closest('button.card')
    if (card === null) return
    const all = columns()
    if (held !== null && held.card === card) {
      if (event.key === 'Escape') {
        event.preventDefault()
        const where = held.where
        held = null
        restore(card, where)
        refreshEmptyStates()
        say('Move cancelled. Nothing has moved.')
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        /*
          The arrow keys move the card one column along the ORDER the board declares, not one column to
          the left on screen. In a mirrored document the left arrow would otherwise walk the board
          backwards for a reader and forwards for the markup, and the two would disagree about what was
          proposed.
        */
        const step = event.key === 'ArrowRight' ? 1 : -1
        const next = Math.min(Math.max(held.index + step, 0), all.length - 1)
        held = { card: card, index: next, where: held.where }
        const column = all[next]
        place(card, column)
        refreshEmptyStates()
        say('Proposed ' + column.dataset.stageLabel + '. Enter to move, Escape to cancel.')
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const column = all[held.index]
        const where = held.where
        held = null
        card.setAttribute('aria-pressed', 'false')
        if (column === where.list.closest('[data-track]')) {
          restore(card, where)
          say('Dropped in the same column. Nothing has moved.')
          return
        }
        await commit(card, column, where)
        return
      }
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const column = columnOf(card)
      held = { card: card, index: indexOfColumn(column), where: origin(card) }
      card.setAttribute('aria-pressed', 'true')
      say(
        'Picked up ' +
          card.dataset.cardLabel +
          '. Left and right arrows move it one column at a time.',
      )
    }
  })
`

const attribute = (name: string, value: string): string => `${name}="${safeText(value)}"`

/** A card's own label. Whatever the front desk typed, or a stated absence — never an invented name. */
export function cardLabel(card: PipelineCard): string {
  return card.displayName ?? `No label recorded — ${card.phoneE164}`
}

function cardElement(card: PipelineCard, column: PipelineColumn): string {
  const label = cardLabel(card)
  return [
    '<li>',
    '<button type="button" class="card"',
    ` ${attribute('data-testid', `card-${card.customerId}`)}`,
    ` ${attribute('data-customer', card.customerId)}`,
    ` ${attribute('data-card-label', label)}`,
    ` ${attribute('data-stage', column.stageKey)}`,
    ` ${attribute('data-stage-entered', card.stageEnteredAtIso)}`,
    ' data-dragging="false" aria-pressed="false">',
    `<span class="card-label">${safeText(label)}</span>`,
    // The lifecycle state beside the stage, because the two disagree on purpose and the disagreement is
    // the useful thing: a record that is `active` in the lifecycle and sitting in `lapsed` on the board
    // is somebody the front desk has given up on who is still buying treatments.
    '<span class="card-meta">',
    `Lifecycle ${safeText(card.lifecycleState)}`,
    card.isVip ? ' · VIP' : '',
    ` · in this column since ${safeText(card.stageEnteredAtIso)}`,
    '</span>',
    '</button>',
    '</li>',
  ].join('')
}

function columnElement(column: PipelineColumn): string {
  const headingId = `column-${column.stageKey}-heading`
  return [
    '<section class="column" data-track',
    ` ${attribute('data-testid', `column-${column.stageKey}`)}`,
    ` ${attribute('data-stage', column.stageKey)}`,
    ` ${attribute('data-stage-label', column.stageKey)}`,
    ` ${attribute('data-order', String(column.displayOrder))}`,
    ` ${attribute('aria-labelledby', headingId)}>`,
    '<div class="column-head">',
    `<h2 id="${safeText(headingId)}">${safeText(column.stageKey)}</h2>`,
    `<span class="tally" data-tally>${safeText(String(column.cards.length))}</span>`,
    '</div>',
    `<p class="what">${safeText(column.description)}</p>`,
    `<ol class="cards" data-cards>${column.cards.map((card) => cardElement(card, column)).join('')}</ol>`,
    // Present in both states and HIDDEN rather than absent when the column has cards, so the script can
    // reveal it without building an element: a node created by script is a second place the page's markup
    // is decided, and the two copies drift.
    `<p class="empty" data-empty${column.cards.length === 0 ? '' : ' hidden'}>No cards in this column.</p>`,
    '</section>',
  ].join('')
}

/**
 * The no-JavaScript path: one form, two selects, a 303 back to the board.
 *
 * One form at the foot rather than a form per card. A form per card is 40 duplicated controls on a busy
 * board, which is 40 identically-named submit buttons — and `button-name` does not fire for that, because
 * each one HAS a name. The single form names the card and the column explicitly, which is also the only
 * shape a keyboard user without JavaScript can operate at all.
 */
function moveForm(view: PipelineView): string {
  const cards = view.board.columns.flatMap((column) =>
    column.cards.map((card) => ({ card, column })),
  )
  if (cards.length === 0) return ''
  return [
    '<form class="move" method="post" data-testid="pipeline-move-form">',
    '<h2>Move a card without JavaScript</h2>',
    '<label for="move-customer">Card</label>',
    '<select id="move-customer" name="customerId">',
    ...cards.map(
      ({ card, column }) =>
        `<option value="${safeText(card.customerId)}">${safeText(cardLabel(card))} — ` +
        `${safeText(column.stageKey)}</option>`,
    ),
    '</select>',
    '<label for="move-stage">Column</label>',
    '<select id="move-stage" name="toStageKey">',
    ...view.board.columns.map(
      (column) =>
        `<option value="${safeText(column.stageKey)}">${safeText(column.stageKey)}</option>`,
    ),
    '</select>',
    '<button type="submit">Move the card</button>',
    '</form>',
  ].join('')
}

export function renderPipelineHtml(view: PipelineView): string {
  const announcement = view.outcome === null ? '' : pipelineAnnouncement(view.outcome)
  const refused = view.outcome?.kind === 'refused' ? view.outcome.refusal : null
  return [
    '<!doctype html>',
    `<html lang="en" dir="${view.direction}"${refused === null ? '' : ` data-pipeline-refusal="${safeText(refused)}"`}>`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: `apps/web/src/seo/brand.test.ts` requires the full trading name wherever the
    // brand appears, and an internal board naming it would be citing the wrong entity. The rule is about
    // how the brand is written, so not writing it is compliant.
    '<title>Pipeline board — admin</title>',
    `<style>${tokensCss()}${PIPELINE_CSS}${GOOGLE_REAUTH_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Pipeline</h1>',
    '<div class="lede">',
    '<p><strong>A stage is a claim somebody made about a person.</strong> Every move is recorded with ' +
      'who made it, which column it came from and when — the database refuses a stage change that is not ' +
      '(ZU001), so there is no way to move a card quietly.</p>',
    '<p>A pipeline stage is not the lifecycle state beside it. The lifecycle is derived from what has ' +
      'happened; a column is where a human has put somebody, and the two disagree on purpose. The six ' +
      'columns are provisional and are tracked as ' +
      `<code data-testid="pipeline-open-question">${safeText(view.vocabularyOpenQuestion)}</code>.</p>`,
    '</div>',
    // `aria-live="polite"` and `role="status"`: the announcement is the only feedback a keyboard move
    // gives, and a region that is not live is a region nobody hears.
    '<p class="live" role="status" aria-live="polite" data-pipeline-live ' +
      `data-testid="pipeline-live">${safeText(announcement)}</p>`,
    `<div class="board" data-testid="pipeline-board">${view.board.columns.map(columnElement).join('')}</div>`,
    moveForm(view),
    '</main>',
    `<script>${PIPELINE_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n')
}
