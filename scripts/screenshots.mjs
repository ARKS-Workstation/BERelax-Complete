#!/usr/bin/env node
/**
 * Captures the screenshot gallery.
 *
 * Writes `artifacts/screens/*.png` and `artifacts/screens/gallery.html`, which is self-contained and
 * publishable as a private Artifact — review is then one link on a phone rather than a checkout and a
 * build.
 *
 * `--critique-only` skips writing images and prints the findings, which is what CI runs: the gallery
 * is for a human, the findings are for the build.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE_NOW } from '../packages/fixtures/src/clock.ts'
import { createCaptureHarness, critiqueResults } from '../packages/harness/src/capture.ts'
import { summarise, uniqueFindings } from '../packages/harness/src/critique.ts'
import { renderGalleryHtml } from '../packages/harness/src/gallery.ts'
import { renderSpecimenHtml } from '../packages/harness/src/specimen.ts'

const OUT = join(import.meta.dirname, '..', 'artifacts', 'screens')
const critiqueOnly = process.argv.includes('--critique-only')

const SOURCES = [{ name: 'specimen', html: renderSpecimenHtml }]

const harness = await createCaptureHarness({ nowMs: FIXTURE_NOW })
try {
  const captures = []
  for (const source of SOURCES) captures.push(...(await harness.capture(source)))

  const results = critiqueResults(captures)
  const counts = summarise(results)
  for (const finding of uniqueFindings(results)) {
    console.log(
      `  ${finding.severity.padEnd(7)} ${finding.rule.padEnd(22)} ${finding.where} — ${finding.detail}`,
    )
  }
  console.log(
    `${captures.length} captures, ${counts.defects} defect(s), ${counts.warnings} warning(s)`,
  )

  if (!critiqueOnly) {
    mkdirSync(OUT, { recursive: true })
    for (const capture of captures) writeFileSync(join(OUT, capture.filename), capture.png)
    writeFileSync(
      join(OUT, 'gallery.html'),
      renderGalleryHtml(captures, {
        title: 'BE RELAX — screenshot gallery',
        subtitle: `Fixture salon at ${new Date(FIXTURE_NOW).toISOString()}. Light beside dark, LTR beside RTL, at three viewports.`,
      }),
    )
    console.log(`wrote artifacts/screens/ — ${captures.length} images and gallery.html`)
  }

  if (counts.defects > 0) {
    console.error(
      `\n${counts.defects} defect(s). A defect is a docs/08 rule broken, not a preference.`,
    )
    process.exit(1)
  }
} finally {
  await harness.close()
}
