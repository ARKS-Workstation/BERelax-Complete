import type { ImportMap } from 'payload'

/**
 * Types for the generated `importMap.js`.
 *
 * `payload generate:importmap` writes plain JavaScript — it is loaded by Next's own config step before
 * any TypeScript exists — so without this declaration the three files that import it are `any`, and
 * `noImplicitAny` fails the build. Regenerating the map does not touch this file.
 */
export declare const importMap: ImportMap
