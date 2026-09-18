/**
 * The one shadow token, and the one place a colour literal is written by hand.
 *
 * docs/08 §2 specifies exactly one shadow, for overlays, and none in dark mode — elevation there is
 * surface lightness rather than a darker shadow, because a shadow on a dark ground reads as a smudge.
 *
 * It is a literal rather than a derived token because a shadow has no contrast requirement: nothing
 * is read against it, so `scripts/palette.py` has nothing to measure and nothing to fail on. That is
 * why this file, and only this file, is on the colour gate's allowlist. Keeping it to fifteen lines
 * keeps the exception small enough to see.
 *
 * OKLCH here on purpose: a shadow is one colour at two alphas, and OKLCH keeps the light and heavy
 * layers the same hue rather than letting the translucent one drift cool.
 */

/** Ink at 5% and 12%, as two layers: a contact shadow and a soft cast. */
export const SHADOW_OVERLAY =
  '0 1px 2px oklch(20% 0.01 60 / 0.05), 0 12px 32px -8px oklch(20% 0.01 60 / 0.12)'

export function shadowCss(): string {
  return [
    ':root {',
    `  --shadow-overlay: ${SHADOW_OVERLAY};`,
    '}',
    '',
    '/* No shadow in dark mode: elevation is surface lightness. */',
    ':root[data-theme="dark"] {',
    '  --shadow-overlay: none;',
    '}',
    '',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]) {',
    '    --shadow-overlay: none;',
    '  }',
    '}',
  ].join('\n')
}
