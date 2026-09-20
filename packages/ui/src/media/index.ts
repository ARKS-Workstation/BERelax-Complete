/**
 * The hero media system's server-side and pure halves.
 *
 * The two `.tsx` files beside this — `pause-control.tsx` and `attach-video.island.tsx` — are deliberately
 * **not** re-exported. The barrel's own note says why: a `.tsx` in this package's entry point pulls JSX and
 * the DOM lib into every project that imports a colour token, and the root typecheck project has neither.
 * They are imported by their own paths, which only an app does.
 */
export * from './attach-video.ts'
export * from './styles.ts'
