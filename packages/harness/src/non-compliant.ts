/**
 * The deliberately non-compliant specimen.
 *
 * Every rule in `critique.ts` is broken here on purpose, which is why this is its own file: it is on
 * `scripts/check-colour-tokens.mjs`'s allowlist, and an allowlist entry should cover the smallest
 * possible surface. The compliant specimen lives next door and is not exempt from anything.
 *
 * H04's acceptance asks the critique pass to catch body text on `--color-decor-gold`. This is the
 * fixture that proves it does — the known-bad discipline of ADR 0003 applied to a check whose output
 * is a list of findings rather than an exit code. `scripts/test-gates.mjs` runs the pass against this
 * page and fails the build if it comes back clean.
 *
 * Each defect is one somebody would plausibly ship. The gold body text looks lovely at a glance. The
 * over-long measure is what happens when a container loses its max-width. The 32px button is what
 * padding arithmetic produces when nobody states the rule. The physical `margin-left` is what a
 * component written left-to-right first always contains.
 */
import { tokensCss } from '@berelax/ui'
import type { SpecimenOptions } from './specimen.ts'

export function renderNonCompliantSpecimenHtml(options: SpecimenOptions): string {
  const rtl = options.direction === 'rtl'
  const lang = rtl ? 'ar' : 'en'
  const longLine =
    'This paragraph has no measure cap at all, so on a wide viewport it runs the full width of the ' +
    'container and the reader loses their place on every return sweep, which is the entire reason ' +
    'the seventy-six character maximum exists in the first place and is not a matter of taste.'

  return `<!doctype html>
<html lang="${lang}" dir="${options.direction}" data-theme="${options.theme}">
<head>
<meta charset="utf-8">
<title>Non-compliant specimen</title>
<style>
${tokensCss()}
body { margin: 0; background: var(--color-ground); font-family: 'IBM Plex Sans', system-ui, sans-serif; font-size: 17px; }
.wrap { padding: 32px; }
/* 2.90:1. Looks lovely, cannot be read. */
.brand-text { color: var(--color-decor-gold); }
/* No max-width, so the measure runs to whatever the viewport is. */
.wide { max-width: none; }
/* Padding arithmetic instead of a stated rule. */
.small-button { min-height: 32px; padding: 4px 10px; border-radius: 8px; }
/* Written left-to-right first, and never revisited. */
.physical { margin-left: 24px; }
</style>
</head>
<body>
<div class="wrap">
  <p class="brand-text">Body text in the decorative brand gold, which measures 2.90:1 against the ground.</p>
  <p class="wide">${longLine}</p>
  <button class="small-button" type="button">Book</button>
  <p class="physical">A paragraph positioned with a physical margin, which does not mirror in RTL.</p>
</div>
</body>
</html>`
}
