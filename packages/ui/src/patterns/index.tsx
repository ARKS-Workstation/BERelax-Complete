/**
 * `@berelax/ui/patterns` — the container-query components.
 *
 * A `.tsx` barrel behind a subpath export, for the reason given at the top of
 * `packages/ui/src/layout/index.tsx`: the root typecheck project has no `jsx`, and its `include` glob
 * matches `.ts` only, so JSX has to stay out of both the `@berelax/ui` barrel and any `.ts` file.
 *
 * Each of these answers to its **container**, never to the viewport. `pnpm layout` fails if any file in
 * this directory contains `@media (min-width`.
 */

export type { NapBlockCopy, NapBlockLayout, NapBlockProps, NapFacts } from './nap-block.tsx'
export { collapseHours, NAP_BLOCK_CSS, NAP_BLOCK_LAYOUTS, NapBlock } from './nap-block.tsx'
export type { PriceTableGroup, PriceTableProps, PriceTableRow } from './price-table.tsx'
export { PRICE_TABLE_CSS, PRICE_TABLE_LAYOUTS, PriceTable } from './price-table.tsx'
export type { ServiceRowLayout, ServiceRowProps } from './service-row.tsx'
export { SERVICE_ROW_CSS, SERVICE_ROW_LAYOUTS, ServiceRow } from './service-row.tsx'
export type { Slot, SlotGridProps, SlotSelection } from './slot-grid.tsx'
export { SLOT_GRID_COLUMNS, SLOT_GRID_CSS, SlotGrid } from './slot-grid.tsx'
export type { BookBarLayout, StickyBookBarProps } from './sticky-book-bar.tsx'
export {
  BOOK_BAR_CSS,
  BOOK_BAR_LAYOUTS,
  BOOK_BAR_SPACER_CLASS,
  BookBarSpacer,
  StickyBookBar,
} from './sticky-book-bar.tsx'
export type { TherapistCardLayout, TherapistCardProps } from './therapist-card.tsx'
export { THERAPIST_CARD_CSS, THERAPIST_CARD_LAYOUTS, TherapistCard } from './therapist-card.tsx'
