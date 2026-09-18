#!/usr/bin/env node
/**
 * The accessibility gate: axe-core against every cell of the capture matrix.
 *
 * Twelve renders per page, because a violation is not a property of a page — it is a property of a
 * page at a size, in a theme, in a direction. A control that is 48px on desktop and 32px on a phone
 * passes one and fails the other, and mirroring the layout changes which elements are adjacent.
 *
 * Violations fail the build. `incomplete` results — rules axe could not decide, usually a contrast it
 * cannot compute behind an image — are printed and never failed on: a gate that fires on correct code
 * gets suppressed, and then it is not a gate.
 *
 * ## What it audits
 *
 * With no arguments: the design specimen, across the whole matrix, through the capture harness — so a
 * violation and the screenshot that shows it come from one render.
 *
 * With arguments: each one is a path to an HTML document, audited once at 390px in the light theme.
 * That is how `scripts/test-gates.mjs` proves this gate fires — a fixture page whose button has no
 * accessible name and whose body text sits on `#C08A43` at 2.90:1, asserted to have been rejected by
 * **rule id** (`button-name`, `color-contrast`) rather than by a non-zero count. A rule id is what
 * says axe examined a rendered DOM; a count can come from anything (ADR 0003).
 *
 * One render rather than twelve for a fixture, because a fixture states its own colours and its own
 * sizes: the matrix exists to catch what changes between a phone and a desk in the *product*, and the
 * product's twelve-render sweep over the kitchen-sink route runs against a real server in
 * `apps/web/src/primitives.itest.ts`.
 *
 * Live routes are not audited here at all. This script has no server, and starting one would make the
 * cheapest gate in `pnpm verify` depend on a `next build`.
 */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { FIXTURE_NOW } from '../packages/fixtures/src/clock.ts'
import {
  auditPage,
  blockingViolations,
  describeViolation,
  uniqueViolations,
} from '../packages/harness/src/accessibility.ts'
import { accessibilityResults, createCaptureHarness } from '../packages/harness/src/capture.ts'
import { renderSpecimenHtml } from '../packages/harness/src/specimen.ts'

const files = process.argv.slice(2).filter((argument) => !argument.startsWith('-'))

/** Audits static HTML documents, one render each. Used by the known-bad fixture. */
async function auditFiles(paths) {
  // The same flags as every other browser in this repository: no sandbox because the container has no
  // user namespaces, and hinting off because host-dependent rasterisation is not worth a gate that
  // only works on one machine.
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--font-render-hinting=none'],
  })
  const results = []
  try {
    for (const path of paths) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: 'light',
      })
      try {
        // On the context and before the page exists: `setContent` does not navigate, so an init script
        // registered on a page already at about:blank never runs. esbuild's `keepNames` rewrites every
        // named function as `__name(fn, 'fn')`, and Playwright serialises the *compiled* source of a
        // callback into a page where that helper does not exist.
        await context.addInitScript({
          content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
        })
        const page = await context.newPage()
        await page.setContent(readFileSync(path, 'utf8'), { waitUntil: 'networkidle' })
        results.push(
          await auditPage(page, {
            page: path,
            viewport: { name: 'phone', width: 390, height: 844, scale: 2, why: 'the fixture' },
            theme: 'light',
            direction: 'ltr',
          }),
        )
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
  return results
}

/** Audits the specimen across the matrix, sharing the capture harness's page. */
async function auditSpecimen() {
  const harness = await createCaptureHarness({ nowMs: FIXTURE_NOW })
  try {
    const captures = await harness.capture({ name: 'specimen', html: renderSpecimenHtml })
    return accessibilityResults(captures)
  } finally {
    await harness.close()
  }
}

const results = files.length > 0 ? await auditFiles(files) : await auditSpecimen()
const violations = uniqueViolations(results)
const incomplete = [...new Set(results.flatMap((result) => result.incomplete))].sort()

for (const violation of violations) {
  // The rule id first and in brackets, so a known-bad fixture can be asserted to have been rejected by
  // the rule written for it.
  console.error(`  ${describeViolation(violation)}`)
  console.error(`            ${violation.helpUrl}`)
}
if (incomplete.length > 0) {
  console.log(`  (${incomplete.length} rule(s) axe could not decide: ${incomplete.join(', ')})`)
}

const blocking = blockingViolations(violations)
console.log(
  `${results.length} render(s) audited against WCAG 2.1/2.2 A and AA, ${violations.length} ` +
    `violation(s), ${blocking.length} of them serious or critical.`,
)
// Any violation fails here, not just the serious and critical ones: this gate audits documents this
// repository authored in full, so a moderate finding is a defect rather than a fact about a portal.
if (violations.length > 0) process.exit(1)
