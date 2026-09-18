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
 */
import { FIXTURE_NOW } from '../packages/fixtures/src/clock.ts'
import { uniqueViolations } from '../packages/harness/src/accessibility.ts'
import { accessibilityResults, createCaptureHarness } from '../packages/harness/src/capture.ts'
import { renderSpecimenHtml } from '../packages/harness/src/specimen.ts'

const SOURCES = [{ name: 'specimen', html: renderSpecimenHtml }]

const harness = await createCaptureHarness({ nowMs: FIXTURE_NOW })
try {
  const captures = []
  for (const source of SOURCES) captures.push(...(await harness.capture(source)))

  const results = accessibilityResults(captures)
  const violations = uniqueViolations(results)
  const incomplete = [...new Set(results.flatMap((result) => result.incomplete))].sort()

  for (const violation of violations) {
    console.error(
      `  ${(violation.impact ?? 'unknown').padEnd(9)} ${violation.id.padEnd(28)} ${violation.help}`,
    )
    for (const node of violation.nodes.slice(0, 4)) console.error(`            ${node}`)
    console.error(`            ${violation.helpUrl}`)
  }
  if (incomplete.length > 0) {
    console.log(`  (${incomplete.length} rule(s) axe could not decide: ${incomplete.join(', ')})`)
  }

  console.log(
    `${captures.length} renders audited against WCAG 2.1/2.2 A and AA, ${violations.length} violation(s).`,
  )
  if (violations.length > 0) process.exit(1)
} finally {
  await harness.close()
}
