/**
 * The whole token layer as one stylesheet.
 *
 * `packages/pdf` inlines this into a document; the web app imports the committed `tokens.css`, which
 * is this function's output written to disk by `pnpm tokens:emit` and drift-checked in CI. Keeping
 * the committed file generated rather than authored is what stops a stylesheet and a PDF from
 * drifting apart — the failure mode where an invoice is a slightly different grey from the page that
 * produced it, and nobody can say which is right.
 */
import { paletteCss } from './palette.ts'
import { scaleCss } from './scale.ts'
import { shadowCss } from './shadow.ts'

export function tokensCss(): string {
  return [
    '/*',
    ' * GENERATED from packages/ui/src/tokens. Do not edit.',
    ' *',
    ' * Colours come from scripts/palette.py, which re-derives and re-measures them on every CI run.',
    ' * Scales come from tokens/scale.ts. Regenerate with `pnpm tokens:emit`.',
    ' */',
    '',
    paletteCss(),
    '',
    shadowCss(),
    '',
    scaleCss(),
    '',
  ].join('\n')
}
