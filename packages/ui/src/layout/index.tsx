/**
 * `@berelax/ui/layout` — the grid, the bands, the measure, and the stylesheet that carries them.
 *
 * ## Why this is a subpath and a `.tsx` file, not part of the `@berelax/ui` barrel
 *
 * Every file here is a React component, so every file is `.tsx`. The root typecheck project
 * (`tsconfig.json`) deliberately has neither `jsx` nor the DOM lib — that absence is what stops a
 * `document.querySelector` compiling inside `packages/core` — and its `include` is
 * `packages/**\/*.ts`, which does not match `.tsx`. So a `.tsx` barrel is invisible to the root project,
 * while a `.ts` barrel here would be picked up by that glob, drag every component into a project with
 * no `jsx`, and fail `pnpm typecheck` at the repository root.
 *
 * This is the same reasoning that put `ThemeProvider` behind `@berelax/ui/theme-provider` in W-SYS-01,
 * applied to a directory rather than a file: re-exporting any of this from `packages/ui/src/index.ts`
 * would pull JSX into every project that imports a colour token. These components are typechecked by
 * the app that renders them (`next build` runs `tsc` over `apps/web/tsconfig.json`, which has `jsx`,
 * the DOM lib and React's types), which is the project where they actually run.
 */

export type { GridCellProps, GridProps, GridSpan } from './grid.tsx'
export { EDITORIAL_GRID_TEMPLATE, GRID_CSS, Grid, GridCell } from './grid.tsx'
export type { MeasureProps, MeasureRole } from './measure.tsx'
export { MEASURE_CSS, Measure } from './measure.tsx'
export type { SectionProps, SectionSurface } from './section.tsx'
export { SECTION_CSS, Section } from './section.tsx'
export {
  ACTION_CSS,
  DESIGN_SYSTEM_CSS,
  DesignSystemStyles,
  DISCLOSURE_CSS,
  FIELD_CSS,
  FOCUS_CSS,
} from './styles.tsx'
