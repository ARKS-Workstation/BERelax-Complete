import {
  ASIA_DUBAI,
  type CalendarAxes,
  type CalendarBand,
  type CalendarCard,
  type CalendarLane,
  type CalendarSlot,
  type Instant,
  safeText,
  toLocal,
} from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import {
  type AdminChrome,
  GOOGLE_REAUTH_BANNER_CSS,
  renderAdminBanner,
} from '../../../src/components/admin/google-reauth-banner.ts'

/**
 * The front-desk diary, as HTML. Room × time first, therapist × time second, one read behind both.
 *
 * Pure: axes in, a document out. No database, no clock, no `new Date()` — every instant on the page arrives
 * in {@link CalendarView}, which is what lets `apps/web/src/calendar-render.test.ts` assert the markup
 * without a server and what makes two renders of an unchanged day byte-identical (the repeat-screenshot
 * criterion is a claim about this file, not about the browser).
 *
 * ## Why a route handler and not a `page.tsx`
 *
 * The same reason the Messages inbox, the template editor, the credentials screen and the compliance
 * calendar all give: `apps/web/src/routes/registry.ts` is in exact bijection with the filesystem and
 * requires every *document* to be served in **both** locales, so a `page.tsx` here would need an Arabic
 * admin document and the W-SYS-01 admin shell, and it would join a screenshot matrix whose RTL half must be
 * a real Arabic route. This surface is English-only on purpose and is photographed at 768 / 1440 in both
 * themes by `apps/web/src/admin-calendar-grid.itest.ts`.
 *
 * ## The two things this page will not do, stated rather than left to be noticed
 *
 * **Dropping onto a therapist lane is not a reschedule.** The therapist axis is READ-ONLY. Changing the
 * therapist re-applies B-AVAIL-04's eligibility on the new date, and under strict same-gender matching that
 * needs the client's gender — which no table holds (B-AVAIL-05: `customer` has no gender column), exactly
 * as the reassignment queue records. A lane that accepted a drop would accept one the transaction then
 * refuses, which is the failure that unit exists to prevent. Rooms are the scarce resource and the room
 * axis is where a reschedule happens.
 *
 * **No card names anybody.** Not the customer — a diary answers "what is in which room when", and a grid
 * left open on a desk is the most-read screen in the building — and not the therapist: `staff_reference` is
 * the handle, nineteen employees have no name recorded, and the ones that do have it under a publication
 * guard (ADR 0020, brief rule 10).
 */

/** What the live region says, and why. One composer for the script, the redirect and the no-JS form. */
export type CalendarOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'moved'; readonly startsAtLabel: string; readonly roomLabel: string }
  | { readonly kind: 'refused'; readonly refusal: string }

export interface CalendarView {
  /**
   * The Google re-auth banner and the page a reconnect comes back to (G-CONN-08).
   *
   * Required rather than optional. An optional field would be a permissive default, and the default
   * would be the one state this banner exists to make impossible: an admin page that says nothing while
   * the Google grant is dead. `apps/web/src/google-reauth-banner.test.ts` walks every admin document on
   * disk and fails by name if one of them does not render it.
   */
  readonly chrome: AdminChrome
  readonly axes: CalendarAxes
  /** The business day the clock resolves to right now, so the page can say whether it is showing it. */
  readonly currentTradingDate: string
  /** The previous and next trading date to offer, or null when the reader is at the end of the calendar. */
  readonly previousTradingDate: string | null
  readonly nextTradingDate: string | null
  /** `HH:MM`–`HH:MM` in the business zone, from the `business_day` row. Never a literal. */
  readonly opensAtLabel: string
  readonly closesAtLabel: string
  readonly outcome: CalendarOutcome
}

/** The closed set of words a refusal reaches the reader as. A name not in it says nothing it cannot. */
const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  slot_taken: 'That time is already taken in that room. The appointment has not moved.',
  new_slot_outside_trading: 'That time is outside the trading day. The appointment has not moved.',
  not_a_trading_date: 'The premises does not trade on that date. The appointment has not moved.',
  new_period_invalid: 'That is not a time this diary can use. The appointment has not moved.',
  reschedule_changes_nothing: 'That is where the appointment already is.',
  therapist_not_eligible:
    'The therapist may not take that appointment on that date. The appointment has not moved.',
  appointment_moved: 'Somebody else moved that appointment while this page was open. Reload it.',
  appointment_not_found: 'That appointment is no longer in the diary. Reload the page.',
  illegal_transition: 'That appointment cannot be moved from the state it is in.',
  footprint_not_offered:
    'That treatment is no longer sold in that shape. The appointment has not moved.',
  delivery_incoherent:
    'The rows of that treatment would disagree about the room. Nothing has moved.',
  unknown_appointment: 'This diary does not hold that appointment on this day.',
  unknown_room: 'This diary does not hold that room.',
  unknown_slot: 'That is not a time on this day’s grid.',
}

/**
 * What the live region says. One function, three callers: the inline script paints what the server sent,
 * the no-JavaScript redirect renders it into the document, and the form's refusal takes the same words.
 *
 * A refusal nobody named reads as words that claim nothing rather than as a database message — the same
 * arrangement the manage-booking page takes, and for the same reason: a page must never put a constraint
 * name in front of a reader, and it must never imply that something happened when the server did not say
 * so.
 */
export function calendarAnnouncement(outcome: CalendarOutcome): string {
  if (outcome.kind === 'moved') {
    return `Moved to ${outcome.startsAtLabel} in ${outcome.roomLabel}.`
  }
  if (outcome.kind === 'refused') {
    return (
      REFUSAL_WORDS[outcome.refusal] ??
      'The diary refused that move and the appointment has not changed. Try another time.'
    )
  }
  return 'Nothing has been moved.'
}

const CALENDAR_CSS = `
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
  h2 { font-size: 1.125rem; margin: 0 0 var(--space-3); }
  p { margin: 0 0 var(--space-5); max-width: 46rem; }
  a { color: var(--color-accent-teal); }
  .day {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-5);
    align-items: baseline;
    margin: 0 0 var(--space-5);
  }
  .day strong { font-variant-numeric: tabular-nums; }
  .live {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  section { margin: 0 0 var(--space-9); }
  .grid { display: grid; gap: var(--space-3); }
  .lane { display: grid; grid-template-columns: 9rem 1fr; gap: var(--space-5); align-items: stretch; }
  .lane-label { font-weight: 600; font-size: 0.875rem; align-self: center; }
  .ruler { display: grid; grid-template-columns: 9rem 1fr; gap: var(--space-5); }
  .ruler-track { position: relative; height: 1.5rem; }
  .ruler-mark {
    position: absolute;
    inset-block: 0;
    inset-inline-start: calc(var(--o) * 100%);
    border-inline-start: 1px solid var(--color-hairline);
    padding-inline-start: var(--space-2);
    font-size: 0.75rem;
    color: var(--color-ink-2);
    font-variant-numeric: tabular-nums;
  }
  .track {
    position: relative;
    min-height: 3.5rem;
    background: var(--color-ground-sunk);
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-1);
  }
  .slot {
    position: absolute;
    inset-block: 0;
    inset-inline-start: calc(var(--o) * 100%);
    width: calc(var(--l) * 100%);
    border-inline-start: 1px solid var(--color-hairline);
  }
  .slot[data-hour="true"] { border-inline-start-color: var(--color-border); }
  .band {
    position: absolute;
    inset-block: var(--space-3);
    inset-inline-start: calc(var(--o) * 100%);
    width: calc(var(--l) * 100%);
    border-radius: var(--radius-1);
  }
  .band-turnaround {
    background: repeating-linear-gradient(
      135deg,
      var(--color-surface-sand) 0 6px,
      var(--color-ground-sunk) 6px 12px
    );
    border: 1px dashed var(--color-border);
  }
  .band-buffer {
    background: var(--color-surface-sand);
    border: 1px dotted var(--color-border-strong);
  }
  .card {
    position: absolute;
    inset-block: var(--space-2);
    inset-inline-start: calc(var(--o) * 100%);
    width: calc(var(--l) * 100%);
    min-height: 3rem;
    display: grid;
    align-content: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-1);
    background: var(--color-surface-raised);
    color: var(--color-ink);
    font: inherit;
    font-size: 0.8125rem;
    text-align: start;
    overflow: hidden;
  }
  .card:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .card[data-draggable="true"] { cursor: grab; touch-action: none; }
  .card[data-dragging="true"] { cursor: grabbing; border-color: var(--color-accent-teal); }
  .card[aria-pressed="true"] { border-color: var(--color-accent-teal); border-width: 2px; }
  .card .when { font-weight: 600; font-variant-numeric: tabular-nums; }
  .card .what { color: var(--color-ink-2); }
  .readonly { color: var(--color-ink-2); font-size: 0.875rem; margin: 0 0 var(--space-5); }
  form.move {
    display: grid;
    gap: var(--space-3);
    max-width: 34rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    padding: var(--space-5);
    background: var(--color-surface);
  }
  form.move label { font-weight: 600; }
  form.move select, form.move input {
    min-height: 3rem;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface-raised);
    color: var(--color-ink);
    font: inherit;
  }
  form.move button {
    justify-self: start;
    min-height: 3rem;
    min-width: 3rem;
    padding: var(--space-3) var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface-raised);
    color: var(--color-ink);
    font: inherit;
  }
  .empty {
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-2);
    padding: var(--space-9) var(--space-5);
    text-align: center;
    color: var(--color-ink-2);
  }
`

/**
 * The inline script. It moves a card with a pointer or with the keyboard, and it computes no times.
 *
 * Every instant it sends comes off a `[data-slot]` element the server rendered, and every position it uses
 * is MEASURED with `getBoundingClientRect`. That is the same discipline the template editor's script
 * follows and it is here for a sharper reason: a browser that converted a pixel offset into a time would be
 * a second implementation of the grid, and it would disagree with the server's at exactly the two edges
 * nobody drags onto while testing — the midnight crossing and the close.
 *
 * Three details that are not decoration:
 *
 *  - **A refusal returns the card to its origin.** The drag is a `transform`, so a refused drop is
 *    `transform = ''` and the card is byte-for-byte where it was; the acceptance criterion is asserted by
 *    final DOM coordinates, and a card that had been re-laid-out could not satisfy it.
 *  - **A success repaints from the server.** The response carries the grid's own markup, re-rendered from
 *    the rows the transaction wrote, so the page after a move is what a fresh GET would serve. The script
 *    never patches a position it guessed.
 *  - **`data-calendar-moves` on `<html>`.** It counts server answers, which is how the integration test
 *    knows a move happened in the same document rather than through a form submission that reloaded the
 *    page — a navigation would reset the counter and lose the evidence.
 */
const CALENDAR_SCRIPT = `
  const root = document.documentElement
  const live = document.querySelector('[data-calendar-live]')
  const grid = document.querySelector('[data-calendar-grid]')
  let drag = null
  let held = null

  function slotsOf(card) {
    const track = card.closest('[data-track]')
    return track === null ? [] : [...track.querySelectorAll('[data-slot]')]
  }
  function indexOfStart(slots, card) {
    const exact = slots.findIndex((slot) => slot.dataset.startsAt === card.dataset.startsAt)
    if (exact !== -1) return exact
    // An existing appointment need not start on a quarter hour — a 20-minute turnaround pushes the next
    // sale to 19:05 — so the fallback is the slot the card's leading edge sits in. MEASURED, not computed:
    // the alternative is arithmetic over instants, which is the second implementation of the grid this
    // script exists not to have. Without it, the first arrow key on such a card would jump to the open.
    const left = card.getBoundingClientRect().left
    let found = 0
    for (let index = 0; index < slots.length; index += 1) {
      if (slots[index].getBoundingClientRect().left <= left + 1) found = index
    }
    return found
  }
  function say(text) {
    if (live !== null) live.textContent = text
  }
  function shift(card, slots, index) {
    const from = slots[indexOfStart(slots, card)]
    const to = slots[index]
    if (from === undefined || to === undefined) return
    const delta = to.getBoundingClientRect().left - from.getBoundingClientRect().left
    card.style.transform = 'translateX(' + delta + 'px)'
  }
  function release(card) {
    card.style.transform = ''
    card.dataset.dragging = 'false'
    card.setAttribute('aria-pressed', 'false')
  }

  /**
   * The lane and the quarter hour under a point, found by MEASUREMENT.
   *
   * document.elementFromPoint is the obvious way and it is wrong here (and no backtick appears in this
   * comment, because it lives INSIDE a template literal and one would end it early — which is the defect
   * css-rule-must-have-a-block in scripts/check-layout-rules.mjs exists to catch): the topmost element at a drop
   * point is whatever is painted last, which is a band or — on exactly the drop this diary must refuse —
   * another card. That answered "dropped outside the diary" for a drop squarely on an occupied slot, so the
   * refusal the server exists to give was never asked for. Comparing rectangles asks the right question,
   * and it asks it of the ROOM lanes only, because the therapist axis is read-only.
   */
  function dropTargetAt(x, y) {
    const tracks = [...document.querySelectorAll('[data-axis="room"][data-track]')]
    const track = tracks.find((candidate) => {
      const rect = candidate.getBoundingClientRect()
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    })
    if (track === undefined) return null
    let slot = null
    for (const candidate of track.querySelectorAll('[data-slot]')) {
      const rect = candidate.getBoundingClientRect()
      if (x >= rect.left && x < rect.right) slot = candidate
    }
    return slot === null ? null : { track: track, slot: slot }
  }

  async function commit(card, target) {
    const track = target.track
    const slot = target.slot
    const response = await fetch(location.pathname + location.search, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appointmentId: card.dataset.appointment,
        startsAt: slot.dataset.startsAt,
        roomId: track.dataset.roomId,
      }),
    })
    let data
    try {
      data = await response.json()
    } catch (error) {
      root.dataset.calendarError = String(error && error.message ? error.message : error)
      release(card)
      return
    }
    say(String(data.announcement || ''))
    root.dataset.calendarMoves = String(Number(root.dataset.calendarMoves || '0') + 1)
    if (data.ok === true && typeof data.grid === 'string' && grid !== null) {
      grid.innerHTML = data.grid
      return
    }
    // Refused: the card goes back to where it was, and it is the SAME element — nothing re-rendered.
    release(card)
    root.dataset.calendarRefusal = String(data.refusal || 'unknown')
  }

  function elementOf(event) {
    return event.target instanceof Element ? event.target : null
  }

  document.addEventListener('pointerdown', (event) => {
    const target = elementOf(event)
    const card = target === null ? null : target.closest('.card[data-draggable="true"]')
    if (card === null) return
    drag = { card: card, x: event.clientX, y: event.clientY }
    card.dataset.dragging = 'true'
    try {
      card.setPointerCapture(event.pointerId)
    } catch (error) {
      // A pointer id the element cannot capture — the card still follows the pointer because the move
      // listener is on the document. Swallowed rather than logged: capture is an improvement to the drag,
      // not a precondition for it, and a throw here would abandon a drag the reader has already started.
    }
    // Prevents the text selection a drag across a label would otherwise make. It also prevents the button
    // taking focus on a pointer press, which is correct: a reader who dragged did not ask to focus, and the
    // keyboard path focuses explicitly.
    event.preventDefault()
  })
  document.addEventListener('pointermove', (event) => {
    if (drag === null) return
    // Both axes, because a drop onto another ROOM lane is a room change and the card has to be seen to go
    // there. Horizontal-only movement would let a reader drop a card two lanes down while it appeared to
    // stay in its own.
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    drag.card.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)'
  })
  document.addEventListener('pointerup', async (event) => {
    if (drag === null) return
    const card = drag.card
    drag = null
    const target = dropTargetAt(event.clientX, event.clientY)
    if (target === null) {
      release(card)
      say('Dropped outside the diary. Nothing has moved.')
      return
    }
    // The transform goes before the request, not after the answer: the card sits in its ORIGIN slot while
    // the server decides, so a refusal leaves it exactly where it was and a success repaints over it.
    card.style.transform = ''
    await commit(card, target)
  })

  document.addEventListener('keydown', async (event) => {
    const target = elementOf(event)
    const card = target === null ? null : target.closest('.card')
    if (card === null) return
    const slots = slotsOf(card)
    if (held !== null && held.card === card) {
      if (event.key === 'Escape') {
        event.preventDefault()
        held = null
        release(card)
        say('Move cancelled. Nothing has moved.')
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const step = event.key === 'ArrowRight' ? 1 : -1
        const next = Math.min(Math.max(held.index + step, 0), slots.length - 1)
        held = { card: card, index: next }
        shift(card, slots, next)
        const slot = slots[next]
        say('Proposed ' + (slot === undefined ? '' : slot.dataset.label) + '. Enter to move, Escape to cancel.')
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const slot = slots[held.index]
        const track = card.closest('[data-track]')
        held = null
        card.setAttribute('aria-pressed', 'false')
        // The card's OWN lane: the arrow keys move it in time and never between rooms, because a room
        // change by keyboard needs a second axis of navigation this page does not offer yet.
        if (slot !== undefined && track !== null) await commit(card, { track: track, slot: slot })
        return
      }
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      if (card.dataset.draggable !== 'true') return
      event.preventDefault()
      held = { card: card, index: indexOfStart(slots, card) }
      card.setAttribute('aria-pressed', 'true')
      say('Picked up ' + card.dataset.label + '. Left and right arrows move it a quarter hour at a time.')
    }
  })
`

function attribute(name: string, value: string): string {
  return `${name}="${safeText(value)}"`
}

/** A band, positioned by two custom properties. The only numbers in this document that are not text. */
function bandElement(
  band: CalendarBand,
  appointmentId: string,
  axis: 'room' | 'therapist',
): string {
  if (band.kind === 'treatment') return ''
  const testId = band.kind === 'turnaround' ? 'room-turnaround-band' : 'therapist-buffer-band'
  const className = band.kind === 'turnaround' ? 'band band-turnaround' : 'band band-buffer'
  // `aria-hidden`, because the minutes are in the card's own visible text. A band that carried the fact
  // only as a colour would be a status told by colour alone, which docs/08 treats as a defect.
  return (
    `<div class="${className}" ${attribute('data-testid', testId)} ` +
    `${attribute('data-band', band.kind)} ${attribute('data-axis', axis)} ` +
    `${attribute('data-band-for', appointmentId)} ${attribute('data-minutes', String(band.minutes))} ` +
    `style="--o:${band.offset.toFixed(6)};--l:${band.length.toFixed(6)}" aria-hidden="true"></div>`
  )
}

/**
 * The `HH:MM` of an instant, in the zone the business trades in.
 *
 * Through `toLocal` from `@berelax/core` rather than arithmetic over the day's open label, which is what
 * this did first: that version was right only for as long as the zone's offset never changes inside a
 * trading day, and "the zone is always an argument" is the rule precisely because that kind of correctness
 * is invisible when it stops holding. `Asia/Dubai` and not the request's locale, for the reason the
 * credentials screen and the reassignment queue both give: an implicit zone makes the rendering depend on a
 * header, and a UTC time printed beside a trading date is how somebody concludes the diary is four hours
 * wrong.
 *
 * A card need not start on a quarter hour — a 20-minute turnaround pushes the next sale to 19:05 — so this
 * is not the slot labels with a lookup.
 */
function labelAt(instant: number): string {
  return toLocal(instant as Instant, ASIA_DUBAI).time
}

/** The start of a card, as a reader sees it. */
function cardLabel(card: CalendarCard): string {
  const treatment = card.bands.find((band) => band.kind === 'treatment')
  return labelAt(treatment?.startsAt ?? 0)
}

/**
 * Whether a card may be moved.
 *
 * The room axis only — the therapist axis is read-only, and the module header says why — and never a
 * treatment that is already `completed`. `completed` still HOLDS its resources, so it is drawn (the room
 * really was occupied), but it is terminal in the lifecycle and every move from it is refused: offering the
 * drag would be offering a control known to fail, which is the defect P-HR-04's candidate list and B-UI-01's
 * therapist selector each avoid the same way. It is the same rule the manage-booking page's `changeable`
 * applies, spelled once per surface because the two pages ask it of different things.
 */
function isMovable(card: CalendarCard, lane: CalendarLane): boolean {
  return lane.axis === 'room' && card.appointment.status !== 'completed'
}

function cardElement(card: CalendarCard, lane: CalendarLane): string {
  const treatment = card.bands.find((band) => band.kind === 'treatment')
  const startsAtIso = new Date(treatment?.startsAt ?? 0).toISOString()
  const when = `${cardLabel(card)}–${labelAt(treatment?.endsAt ?? 0)}`
  const draggable = isMovable(card, lane)
  const minutes = card.appointment.turnaroundMinutes
  const buffer = card.appointment.therapistBufferMinutes
  const detail =
    lane.axis === 'room'
      ? `${card.appointment.serviceLabel} · room held ${minutes} min after`
      : `${card.appointment.serviceLabel} · therapist held ${buffer} min either side`
  return (
    `<button type="button" class="card" ${attribute('data-appointment', card.appointment.id)} ` +
    `${attribute('data-testid', `appointment-${card.appointment.id}`)} ` +
    `${attribute('data-axis', lane.axis)} ${attribute('data-starts-at', startsAtIso)} ` +
    `${attribute('data-label', when)} ${attribute('data-status', card.appointment.status)} ` +
    `${attribute('data-draggable', String(draggable))} ` +
    (draggable ? 'aria-pressed="false" ' : '') +
    `style="--o:${(treatment?.offset ?? 0).toFixed(6)};--l:${(treatment?.length ?? 0).toFixed(6)}">` +
    `<span class="when">${safeText(when)}</span>` +
    `<span class="what">${safeText(detail)}</span>` +
    '</button>'
  )
}

function slotElement(slot: CalendarSlot): string {
  return (
    `<div class="slot" data-slot ${attribute('data-starts-at', slot.startsAtIso)} ` +
    `${attribute('data-label', slot.label)} ` +
    `${attribute('data-hour', String(slot.label.endsWith(':00')))} ` +
    `style="--o:${slot.offset.toFixed(6)};--l:${slot.length.toFixed(6)}" aria-hidden="true"></div>`
  )
}

function laneElement(lane: CalendarLane, view: CalendarGridView): string {
  const slots = view.axes.slots.map((slot) => slotElement(slot)).join('')
  const bands = lane.cards
    .flatMap((card) => card.bands.map((band) => bandElement(band, card.appointment.id, lane.axis)))
    .join('')
  const cards = lane.cards.map((card) => cardElement(card, lane)).join('')
  return (
    `<div class="lane" ${attribute('data-lane', lane.axis)} ${attribute('data-lane-id', lane.id)}>` +
    `<div class="lane-label">${safeText(lane.label)}</div>` +
    `<div class="track" data-track ${attribute('data-axis', lane.axis)} ` +
    `${attribute(lane.axis === 'room' ? 'data-room-id' : 'data-therapist-id', lane.id)}>` +
    `${slots}${bands}${cards}</div></div>`
  )
}

/** The hour marks, so a reader can tell 19:00 from 23:00 without counting quarter hours. */
function rulerElement(view: CalendarGridView): string {
  const marks = view.axes.slots
    .filter((slot) => slot.label.endsWith(':00'))
    .map(
      (slot) =>
        `<span class="ruler-mark" style="--o:${slot.offset.toFixed(6)}">${safeText(slot.label)}</span>`,
    )
    .join('')
  return `<div class="ruler"><div></div><div class="ruler-track">${marks}</div></div>`
}

function axisSection(
  lanes: readonly CalendarLane[],
  view: CalendarGridView,
  args: { readonly axis: 'room' | 'therapist'; readonly heading: string; readonly note: string },
): string {
  const body =
    lanes.length === 0
      ? `<p class="empty">${safeText(args.note)}</p>`
      : `${rulerElement(view)}${lanes.map((lane) => laneElement(lane, view)).join('')}`
  const id = `${args.axis}-axis-heading`
  return (
    `<section ${attribute('data-testid', `axis-${args.axis}`)} ${attribute('aria-labelledby', id)}>` +
    `<h2 id="${id}">${safeText(args.heading)}</h2>` +
    (lanes.length === 0 ? '' : `<p class="readonly">${safeText(args.note)}</p>`) +
    `<div class="grid" ${attribute('data-axis', args.axis)}>${body}</div>` +
    '</section>'
  )
}

/**
 * Both axes, as the fragment the inline script paints after a successful move.
 *
 * The same function the full document calls, so the grid after a move is the grid a fresh GET would serve —
 * there is no second renderer for the "after" state, which is how a moved card comes to be drawn in a place
 * a reload would not put it.
 */
/**
 * The day without the chrome.
 *
 * The grid fragment is repainted by the inline script after a move and carries no banner: the banner is a
 * fact about a credential and the fragment is a fact about one day, and replacing the whole document to
 * repaint a lane would lose the operator's scroll position. So everything that reads the day but not the
 * chrome takes this, which also means the write path does not have to invent a chrome to compute an
 * announcement.
 */
export type CalendarGridView = Omit<CalendarView, 'chrome'>

export function renderCalendarGridFragment(view: CalendarGridView): string {
  return (
    axisSection(view.axes.rooms, view, {
      axis: 'room',
      heading: 'Rooms',
      note:
        'Rooms are the scarce resource, so this is the diary. Drag a card, or focus it and press Enter, ' +
        'to move it — every move is the same transaction the front desk and the customer’s own link use. ' +
        'The hatched band after a treatment is the room’s turnaround: it is sold to nobody.',
    }) +
    axisSection(view.axes.therapists, view, {
      axis: 'therapist',
      heading: 'Therapists',
      note:
        'The same appointments, read a second way — not a second query. Read-only: changing the therapist ' +
        'needs the client’s gender under strict same-gender matching, and no table holds it, so a card ' +
        'dropped here would be a move the booking transaction refuses. The dotted band either side of a ' +
        'treatment is the therapist’s buffer, which is a different length from the room’s turnaround.',
    })
  )
}

/** The no-JavaScript path: one appointment, one new time, one room. A GET form would be a write on a link. */
function moveForm(view: CalendarGridView): string {
  const appointments = view.axes.rooms.flatMap((lane) =>
    lane.cards
      // The same rule the cards use: a completed treatment is on the grid and is not on offer here, or the
      // keyboard-only path would be the one route to a move the transaction refuses.
      .filter((card) => isMovable(card, lane))
      .map(
        (card) =>
          `<option value="${safeText(card.appointment.id)}">` +
          `${safeText(`${cardLabel(card)} · ${lane.label} · ${card.appointment.serviceLabel}`)}` +
          '</option>',
      ),
  )
  const rooms = view.axes.rooms.map(
    (lane) => `<option value="${safeText(lane.id)}">${safeText(lane.label)}</option>`,
  )
  if (appointments.length === 0) return ''
  return (
    '<h2>Move one without a pointer</h2>' +
    '<p>The same transaction, for a keyboard with no JavaScript and for a reader who would rather type a ' +
    'time than aim at one. The times offered are this day’s quarter hours.</p>' +
    `<form class="move" method="post" ${attribute('action', `/calendar?date=${view.axes.tradingDate}`)}>` +
    '<label for="move-appointment">Appointment</label>' +
    `<select id="move-appointment" name="appointmentId">${appointments.join('')}</select>` +
    '<label for="move-room">Room</label>' +
    `<select id="move-room" name="roomId">${rooms.join('')}</select>` +
    '<label for="move-start">New start</label>' +
    `<select id="move-start" name="startsAt">${view.axes.slots
      .map(
        (slot) => `<option value="${safeText(slot.startsAtIso)}">${safeText(slot.label)}</option>`,
      )
      .join('')}</select>` +
    '<button type="submit">Move it</button>' +
    '</form>'
  )
}

function dayHeader(view: CalendarView): string {
  const isCurrent = view.axes.tradingDate === view.currentTradingDate
  const link = (date: string | null, words: string): string =>
    date === null ? '' : `<a href="/calendar?date=${safeText(date)}">${safeText(words)}</a>`
  return (
    '<p class="day">' +
    `<strong>Business day ${safeText(view.axes.tradingDate)}</strong>` +
    `<span>${safeText(`${view.opensAtLabel}–${view.closesAtLabel}`)}</span>` +
    (isCurrent
      ? '<span data-testid="calendar-today">the current business day</span>'
      : `<span data-testid="calendar-not-today">${link(
          view.currentTradingDate,
          'back to the current business day',
        )}</span>`) +
    link(view.previousTradingDate, 'previous day') +
    link(view.nextTradingDate, 'next day') +
    '</p>'
  )
}

export function renderCalendarHtml(view: CalendarView): string {
  return [
    // `data-calendar-moves` starts at zero so the script's counter is a delta rather than a presence.
    '<!doctype html>',
    '<html lang="en" dir="ltr" data-calendar-moves="0">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's "brand collision" forbids the bare brand in any title, and an
    // internal screen has no reason to name the business at all.
    '<title>Diary — admin</title>',
    `<style>${tokensCss()}${CALENDAR_CSS}${GOOGLE_REAUTH_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Diary</h1>',
    dayHeader(view),
    // `role="status"` is an implicit `aria-live="polite"`, and both are written because the two together
    // are what makes a change here spoken rather than merely present.
    '<p class="live" role="status" aria-live="polite" data-calendar-live ' +
      'data-testid="calendar-live">' +
      `${safeText(calendarAnnouncement(view.outcome))}</p>`,
    '<div data-calendar-grid>',
    renderCalendarGridFragment(view),
    '</div>',
    moveForm(view),
    '</main>',
    `<script>${CALENDAR_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('')
}

/** The day the premises does not trade on. A named state, because an empty grid would claim a free diary. */
export function renderClosedDayHtml(args: {
  readonly tradingDate: string
  readonly currentTradingDate: string
  /** The banner shows on a closed day too: the connection does not stop being dead on a Sunday. */
  readonly chrome: AdminChrome
}): string {
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<title>Diary — admin</title>',
    `<style>${tokensCss()}${CALENDAR_CSS}${GOOGLE_REAUTH_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(args.chrome),
    '<h1>Diary</h1>',
    `<p class="empty" data-testid="calendar-closed">The premises does not trade on ${safeText(
      args.tradingDate,
    )}. A closed date has no row in the trading calendar at all, which is why this is a named state ` +
      'rather than an empty grid: an empty grid would read as a day with nothing booked.</p>',
    `<p><a href="/calendar?date=${safeText(
      args.currentTradingDate,
    )}">Back to the current business day</a></p>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}
