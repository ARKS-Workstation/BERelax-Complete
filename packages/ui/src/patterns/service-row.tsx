/**
 * A treatment as one row: what it is, how long it takes, what it costs, and how to book it.
 *
 * A service is the pair `(style × treatment)` with four duration variants (docs/13 §4), so a menu is
 * thirty-two rows and the row is the component that matters most on the site. It is a container-query
 * component for the same reason the card is: the same row appears in the measure column of a treatment
 * page, in a full-width band on the home page, and in a narrow admin rail.
 *
 * The price is `formatMoney`'s output — VAT-inclusive gross, integer fils underneath (ADR 0007) — and
 * is rendered with `tabular-nums` so a column of prices lines up on the decimal.
 *
 * `pnpm layout` fails if this file contains `@media (min-width`.
 */
import type { ReactNode } from 'react'

/** The container width at which the row stops stacking. */
export const SERVICE_ROW_LAYOUTS = [
  { minInlineSize: 0, layout: 'stack' },
  { minInlineSize: 420, layout: 'inline' },
] as const

export type ServiceRowLayout = (typeof SERVICE_ROW_LAYOUTS)[number]['layout']

export const SERVICE_ROW_CSS = `
.be-row {
  container-type: inline-size;
  container-name: service-row;
  border-block-end: 1px solid var(--color-hairline);
}

.be-row__inner {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-5);
  padding-block: var(--space-6);
  align-items: start;
  --row-layout: stack;
}

.be-row__name { font-weight: 600; margin: 0; }
.be-row__meta { color: var(--color-ink-2); font-size: var(--text-sm); margin: 0; }
.be-row__price { font-weight: 600; font-variant-numeric: tabular-nums; margin: 0; }

/* The action's own 48px floor and fill come from .be-action in layout/styles.tsx: one class states the
   touch floor, so a row cannot arrive at 44px through its own padding arithmetic. */
.be-row__action { justify-self: start; }

/* From 420px the row is a row: name, price and action on one line, which is how a menu is read. */
@container service-row (min-width: 420px) {
  .be-row__inner {
    --row-layout: inline;
    grid-template-columns: 1fr auto auto;
    align-items: center;
  }
}
`

export interface ServiceRowProps {
  readonly name: string
  /** Duration and style, already formatted and translated by the caller. */
  readonly meta: string
  /** `formatMoney` output. Gross, VAT-inclusive. */
  readonly price: string
  readonly action: { readonly label: string; readonly href: string }
  readonly children?: ReactNode
}

export function ServiceRow({ name, meta, price, action, children }: ServiceRowProps) {
  return (
    <div className="be-row">
      <div className="be-row__inner">
        <div>
          <p className="be-row__name">{name}</p>
          <p className="be-row__meta">{meta}</p>
          {children}
        </div>
        <p className="be-row__price">{price}</p>
        <a className="be-action be-row__action" href={action.href}>
          {action.label}
        </a>
      </div>
    </div>
  )
}
