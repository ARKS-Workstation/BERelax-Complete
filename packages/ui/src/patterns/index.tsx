/**
 * `@berelax/ui/patterns` — the three container-query components.
 *
 * A `.tsx` barrel behind a subpath export, for the reason given at the top of
 * `packages/ui/src/layout/index.tsx`: the root typecheck project has no `jsx`, and its `include` glob
 * matches `.ts` only, so JSX has to stay out of both the `@berelax/ui` barrel and any `.ts` file.
 *
 * Each of these answers to its **container**, never to the viewport. `pnpm layout` fails if any file in
 * this directory contains `@media (min-width`.
 */

export type { ServiceRowLayout, ServiceRowProps } from './service-row.tsx'
export { SERVICE_ROW_CSS, SERVICE_ROW_LAYOUTS, ServiceRow } from './service-row.tsx'
export type { Slot, SlotGridProps } from './slot-grid.tsx'
export { SLOT_GRID_COLUMNS, SLOT_GRID_CSS, SlotGrid } from './slot-grid.tsx'
export type { TherapistCardLayout, TherapistCardProps } from './therapist-card.tsx'
export { THERAPIST_CARD_CSS, THERAPIST_CARD_LAYOUTS, TherapistCard } from './therapist-card.tsx'
