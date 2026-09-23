/**
 * The slot grid: the times a treatment can start, as a grid that answers to its own width.
 *
 * ## The column counts
 *
 * docs/08 §4 asks for 3, 4 and 6 columns by container width. Three columns is the phone; six is a
 * desk. The counts are a readability decision, not arithmetic: a slot list is scanned by row, and more
 * than six columns turns "which times are free this evening" into a search.
 *
 * `SLOT_GRID_COLUMNS` is exported so a test can drive the container to exactly the declared widths.
 *
 * ## 48×48, not docs/08's 48×44
 *
 * docs/08 §4 says "Slot buttons 48×44" two lines after it says the mobile minimum is 48px, and this
 * unit's acceptance asks for a 390px audit where every control is at least 48×48. A 44px-tall slot
 * fails the audit the same document demands, so the floor wins and the slot is 48×48 everywhere. The
 * cost is four pixels of vertical rhythm; the alternative is a rule that cannot be enforced.
 *
 * `pnpm layout` fails if this file contains `@media (min-width`: a page breakpoint here would make the
 * grid right on the home page and wrong in the booking sheet, which is narrower at the same viewport.
 */

/** Container width thresholds and the column count each one selects. */
export const SLOT_GRID_COLUMNS = [
  { minInlineSize: 0, columns: 3 },
  { minInlineSize: 360, columns: 4 },
  { minInlineSize: 520, columns: 6 },
] as const

export const SLOT_GRID_CSS = `
.be-slots {
  container-type: inline-size;
  container-name: slot-grid;
}

.be-slots__list {
  display: grid;
  /* The count is a custom property so the container queries change one number rather than restating
     the whole template three times. */
  --slot-columns: ${SLOT_GRID_COLUMNS[0].columns};
  grid-template-columns: repeat(var(--slot-columns), minmax(0, 1fr));
  gap: var(--space-5);
  list-style: none;
  padding: 0;
  margin: 0;
}

.be-slot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 100%;
  min-block-size: 48px;
  min-inline-size: 48px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-2);
  background: var(--color-surface);
  color: var(--color-ink);
  font-variant-numeric: tabular-nums;
  font-size: var(--text-base);
  /* docs/08 §5: the press is 90ms of CSS, before any shared-element exchange. */
  transition: transform var(--dur-instant) var(--ease-calm);
}

.be-slot:active { transform: scale(0.97); }

/* The same fill pair as the primary action, which is one of the combinations docs/08 §2 measures.
   Both attributes, because a slot expresses the choice one way in a specimen and the other in a
   booking page — see SlotSelection. One rule rather than two, so the two spellings cannot drift into
   two appearances. */
.be-slot[aria-pressed='true'],
.be-slot[aria-selected='true'] {
  background: var(--color-accent-gold);
  color: var(--color-ground);
  border-color: var(--color-accent-gold);
}

.be-slot[disabled] {
  background: var(--color-ground-sunk);
  color: var(--color-ink-2);
  border-color: var(--color-border);
}
${SLOT_GRID_COLUMNS.filter((step) => step.minInlineSize > 0)
  .map((step) =>
    [
      `@container slot-grid (min-width: ${step.minInlineSize}px) {`,
      `  .be-slots__list { --slot-columns: ${step.columns}; }`,
      '}',
    ].join('\n'),
  )
  .join('\n')}
`

export interface Slot {
  /** A wall-clock label such as `19:45`. Formatted by the caller: the zone is always an argument. */
  readonly label: string
  readonly available: boolean
  readonly selected?: boolean
  /**
   * An accessible name that says more than the time.
   *
   * `19:45` on its own is unreadable out of context: a screen-reader user working through a grid of
   * times hears a dozen numbers with no date and no duration attached to any of them. The caller
   * supplies the sentence, because it carries a locale, a calendar and a plural rule.
   */
  readonly ariaLabel?: string
  /**
   * What a `listbox` slot submits, in the form it is rendered inside.
   *
   * A button with a `name` and a `value` carries the choice **with JavaScript off**: the browser
   * submits the enclosing form and every other field in it. An `onClick` would not, which is why this
   * is a value rather than a handler.
   */
  readonly value?: string
  /**
   * True for the one slot that is in the tab order — the roving tabindex.
   *
   * One across the whole picker, not one per group: a grid of forty times with forty tab stops is a
   * keyboard trap in practice, because reaching the control after it takes forty presses. The caller
   * decides which, because the caller decides the order the groups are rendered in.
   */
  readonly active?: boolean
}

/**
 * How a chosen slot is expressed.
 *
 * `pressed` is the original — a `<button>` per slot carrying `aria-pressed` — which is what a specimen
 * grid with no enclosing form wants. `listbox` is what a booking page needs, and the difference is not
 * cosmetic: `aria-pressed` says *this toggle is on*, `aria-selected` says *this is the one chosen out of
 * the set*. Only the second is true of a time grid, and it is the one docs/09 §3 names ("a roving
 * tabindex, `aria-selected`, and a live region announcing the selected date").
 */
export type SlotSelection = 'pressed' | 'listbox'

export interface SlotGridProps {
  readonly slots: readonly Slot[]
  /** Labels the group, because a grid of times with no heading says nothing on its own. */
  readonly ariaLabel: string
  readonly selection?: SlotSelection
  /** The field name a `listbox` slot submits under. Required in that mode, unread in the other. */
  readonly name?: string
}

export function SlotGrid({ slots, ariaLabel, selection = 'pressed', name }: SlotGridProps) {
  const listbox = selection === 'listbox'
  if (listbox && name === undefined) {
    // Refused rather than defaulted. A submit button with no `name` submits nothing, so the slot would
    // look chosen, navigate, and carry no choice — a page that appears to work and silently loses the
    // selection on the one step the whole flow exists for.
    throw new Error("SlotGrid: selection='listbox' needs a `name` for its slots to submit under")
  }
  /*
    Two whole branches rather than one element with conditional attributes, and that is not a style
    preference. Biome's `useAriaPropsSupportedByRole` resolves an element's role statically: with
    `role={listbox ? 'option' : undefined}` it sees a `<button>` carrying `aria-selected`, which a button
    genuinely may not have, and refuses the file. Writing the role as a literal is what lets the rule check
    the thing it is for — and the rule is right, which is why the answer is to state the role rather than to
    suppress it.
  */
  if (listbox) {
    return (
      <div className="be-slots">
        {/*
          A `div` and not a `ul`, and the options are its DIRECT children.

          Two reasons, and they are the same reason twice. A listbox owns its options, so a `<li>` between
          them is an element the listbox does not own and `aria-required-children` reports it; and a `<ul>`
          carrying `role="listbox"` is a non-interactive element given an interactive role, which Biome
          refuses — correctly, because the list semantics it would have had are then gone anyway. The grid
          is a class, so the layout is unchanged by which element carries it.
        */}
        <div className="be-slots__list" aria-label={ariaLabel} role="listbox">
          {slots.map((slot) => (
            <button
              key={slot.label}
              className="be-slot"
              // `submit`, not `button`: this is how the choice survives with JavaScript off. The slot
              // submits the picker's own GET form and the next render is the server's.
              type="submit"
              name={name}
              value={slot.value}
              role="option"
              aria-label={slot.ariaLabel}
              aria-selected={slot.selected === true}
              tabIndex={slot.active === true ? 0 : -1}
              disabled={!slot.available}
            >
              {slot.label}
            </button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="be-slots">
      <ul className="be-slots__list" aria-label={ariaLabel}>
        {slots.map((slot) => (
          <li key={slot.label}>
            <button
              className="be-slot"
              type="button"
              aria-label={slot.ariaLabel}
              aria-pressed={slot.selected === true}
              disabled={!slot.available}
            >
              {slot.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
