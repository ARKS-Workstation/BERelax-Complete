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

/* The same fill pair as the primary action, which is one of the combinations docs/08 §2 measures. */
.be-slot[aria-pressed='true'] {
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
  /** `11:00`. Formatted by the caller, because the zone is always an argument. */
  readonly label: string
  readonly available: boolean
  readonly selected?: boolean
}

export interface SlotGridProps {
  readonly slots: readonly Slot[]
  /** Labels the group, because a grid of times with no heading says nothing on its own. */
  readonly ariaLabel: string
}

export function SlotGrid({ slots, ariaLabel }: SlotGridProps) {
  return (
    <div className="be-slots">
      <ul className="be-slots__list" aria-label={ariaLabel}>
        {slots.map((slot) => (
          <li key={slot.label}>
            <button
              className="be-slot"
              type="button"
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
