'use client'

/**
 * The booking flow's **one** client island: the day strip, the slot grid, and the keyboard behaviour.
 *
 * docs/09 §3: *"The booking flow is the one heavy client island; everything else is a server component."*
 * `book.itest.ts` reads the route's `page_client-reference-manifest.js` out of the build and asserts this
 * is the only first-party client module on it beyond the two the shared root layout contributes — so this
 * file is the boundary, and anything it imports has to be server-safe or it joins this chunk rather than
 * becoming a second island.
 *
 * ## Why it renders forms rather than handlers
 *
 * Every control here is a `<button type="submit">` inside a GET form, and that is the whole reason steps
 * 1–3 work with JavaScript off: the browser submits the form, the server renders the next state, and the
 * URL that comes back is shareable and restorable. An `onClick` that set React state would produce a
 * picker that renders nothing on the server and loses the choice on a reload.
 *
 * **The day strip is not in here.** It is a form of submit buttons and needs no JavaScript at all, so it
 * is a server component in `booking-page.tsx` — which is also what makes it present in the very first
 * state of the page, before a treatment has been chosen and before the availability engine has anything
 * to answer. Two reasons it could not be one form with the times either way: forms cannot nest, and a
 * single form would have to carry `date` as a hidden field for the slot buttons *and* as the day buttons'
 * own name, so `?date=` would arrive twice with the previous value first and choosing a day would
 * silently keep the old one. Choosing a day also drops the chosen time for free, which is correct: a
 * time from another day means nothing.
 *
 * ## What the JavaScript actually adds
 *
 * Three things, all of which docs/09 §3 asks for by name and none of which HTML gives:
 *
 *   - **a roving tabindex** across the grid, so the whole picker is one tab stop rather than forty. The
 *     server renders the roving state too (one option with `tabindex="0"`), so the tab order is right
 *     before hydration and does not change after it;
 *   - **arrow-key movement**, mirrored: in an RTL document `ArrowRight` moves to the *previous* time,
 *     read from the computed `direction` rather than from the locale, because the direction is a property
 *     of the rendered document;
 *   - **a live region announcing the selected date**, filled after mount. It is deliberately empty in the
 *     server HTML: a region that already holds its text has not changed, so a screen reader says nothing,
 *     and the announcement has to be an update to be an announcement.
 */

import { SlotGrid } from '@berelax/ui/patterns'
import { useEffect, useRef, useState } from 'react'

/** One offerable start. */
export interface PickerSlot {
  /** Epoch milliseconds — what the next step needs and what a wall-clock label cannot carry. */
  readonly startsAt: number
  /** `19:45`, Latin digits in both documents. */
  readonly label: string
  /** The time, the day and the duration in one sentence; `19:45` alone says nothing out of context. */
  readonly ariaLabel: string
  readonly selected: boolean
}

/** One part of the day — morning, afternoon or evening — with its own grid. */
export interface PickerGroup {
  readonly group: string
  readonly heading: string
  readonly ariaLabel: string
  readonly slots: readonly PickerSlot[]
}

export interface SlotPickerProps {
  /** Where the form submits: this locale's own `/book`. */
  readonly action: string
  /** The fields that survive every submission — treatment, client, therapist. */
  readonly carried: Readonly<Record<string, string>>
  /** The field names, from `src/book/state.ts`, so nothing here spells one. */
  readonly fields: { readonly date: string; readonly slot: string }
  readonly groups: readonly PickerGroup[]
  readonly selectedDate: string
  readonly copy: {
    readonly heading: string
    readonly count: string
    readonly timesLabel: string
    /** What the live region says once it is filled. */
    readonly announceDay: string
  }
}

/** Every option in the grid, in the order a reader sees them, live from the DOM. */
function optionsOf(root: HTMLElement | null): readonly HTMLElement[] {
  if (root === null) return []
  return [...root.querySelectorAll<HTMLElement>('[role="option"]:not([disabled])')]
}

export function SlotPicker({
  action,
  carried,
  fields,
  groups,
  selectedDate,
  copy,
}: SlotPickerProps) {
  const flat = groups.flatMap((group) => group.slots)
  const selectedIndex = flat.findIndex((slot) => slot.selected)
  /**
   * The roving tabindex, as an index into the flat list.
   *
   * Initialised to the chosen slot, or the first one. The server renders the same value, so the tab
   * order does not change on hydration — a tab stop that moves after the page settles is a control a
   * keyboard reader has already tabbed past.
   */
  const [active, setActive] = useState(selectedIndex === -1 ? 0 : selectedIndex)
  const [announced, setAnnounced] = useState('')
  const grid = useRef<HTMLFormElement>(null)

  // Filled after mount, and only then: see the header. `copy.announceDay` is the whole sentence, so
  // nothing is composed on the client that the server did not already render the same way.
  useEffect(() => {
    setAnnounced(copy.announceDay)
  }, [copy.announceDay])

  function move(from: number, delta: number): void {
    const options = optionsOf(grid.current)
    if (options.length === 0) return
    const next = Math.min(Math.max(from + delta, 0), options.length - 1)
    setActive(next)
    options[next]?.focus()
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLFormElement>): void {
    const target = event.target as HTMLElement | null
    if (target === null || target.getAttribute('role') !== 'option') return
    const options = optionsOf(grid.current)
    const from = options.indexOf(target)
    if (from === -1) return
    // The direction is read from the rendered document rather than from the locale: an Arabic page is
    // mirrored, so `ArrowRight` has to move to the previous time. `pnpm layout`'s RTL rules are about
    // stylesheets; this is the same decision in JavaScript.
    const rtl = globalThis.getComputedStyle(target).direction === 'rtl'
    const forward = rtl ? -1 : 1
    switch (event.key) {
      case 'ArrowRight':
        move(from, forward)
        break
      case 'ArrowLeft':
        move(from, -forward)
        break
      case 'ArrowDown':
        move(from, 1)
        break
      case 'ArrowUp':
        move(from, -1)
        break
      case 'Home':
        move(from, -options.length)
        break
      case 'End':
        move(from, options.length)
        break
      default:
        return
    }
    // Only for the keys handled above, and only after one was: the page scrolls on an arrow key and a
    // blanket `preventDefault` would also swallow Enter, which is how a slot stops being choosable.
    event.preventDefault()
  }

  const hidden = Object.entries(carried)

  return (
    <div className="be-book__stack">
      {/*
        `role="status"` as well as `aria-live`, because the two are not the same claim: `aria-live`
        says how to announce a change, `role="status"` says the region is an advisory message — which is
        what a screen reader uses to decide whether to interrupt. Empty on the server; see the header.
      */}
      <div className="be-book__hidden" role="status" aria-live="polite">
        {announced}
      </div>

      {/* `aria-label` makes this a named `form` landmark, so a screen-reader user can jump straight to
          the times rather than tabbing through the first step to reach them. */}
      <form
        method="get"
        action={action}
        aria-label={copy.timesLabel}
        ref={grid}
        onKeyDown={onKeyDown}
      >
        {hidden.map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {/* The day the times belong to travels with the choice. Without it, choosing a time would fall
            back to the first day of the strip — the same slot list, a different date. */}
        <input type="hidden" name={fields.date} value={selectedDate} />
        <div className="be-book__group">
          <h2 className="be-book__region-heading">{copy.heading}</h2>
          <p className="be-book__note">{copy.count}</p>
          {groups.map((group, groupIndex) => (
            <div key={group.group} className="be-book__group" data-slot-group={group.group}>
              <h3 className="be-book__group-heading">{group.heading}</h3>
              <SlotGrid
                selection="listbox"
                name={fields.slot}
                ariaLabel={group.ariaLabel}
                slots={group.slots.map((slot) => ({
                  label: slot.label,
                  ariaLabel: slot.ariaLabel,
                  available: true,
                  selected: slot.selected,
                  value: String(slot.startsAt),
                  // The roving tabindex is an index into the FLAT list, so the offset of this group's
                  // first slot is what turns it back into a per-group flag. Counting inside the group
                  // would put one tab stop in each, which is the thing the roving index removes.
                  active: offsetOf(groups, groupIndex) + group.slots.indexOf(slot) === active,
                }))}
              />
            </div>
          ))}
        </div>
      </form>
    </div>
  )
}

/** How many slots come before a group, in the order they are rendered. */
function offsetOf(groups: readonly PickerGroup[], groupIndex: number): number {
  return groups.slice(0, groupIndex).reduce((total, group) => total + group.slots.length, 0)
}
