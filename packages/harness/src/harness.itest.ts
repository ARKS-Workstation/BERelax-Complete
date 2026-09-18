import { createHash } from 'node:crypto'
import { FIXTURE_NOW } from '@berelax/fixtures'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Capture, type CaptureHarness, createCaptureHarness } from './capture.ts'
import { summarise, uniqueFindings } from './critique.ts'
import { renderGalleryHtml } from './gallery.ts'
import {
  captureFilename,
  DIRECTIONS,
  parseCaptureFilename,
  THEMES,
  targetsFor,
  VIEWPORTS,
} from './matrix.ts'
import { renderNonCompliantSpecimenHtml } from './non-compliant.ts'
import { renderSpecimenHtml } from './specimen.ts'

/**
 * H04 — the screenshot harness, and the two things that decide whether it is worth having.
 *
 * **It must not flap.** A visual gate with a false-positive rate is worse than no gate: people learn
 * to approve diffs without looking, and the one real regression goes through with the noise. So the
 * assertion is the blunt one — two consecutive runs produce byte-identical images.
 *
 * **The critique pass must actually find things.** A pass that reports nothing on a compliant page
 * proves nothing on its own; it has to be shown finding the defects in a page built to contain them.
 */

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

let harness: CaptureHarness
let compliant: Capture[]
let nonCompliant: Capture[]

beforeAll(async () => {
  harness = await createCaptureHarness({ nowMs: FIXTURE_NOW })
  compliant = await harness.capture({ name: 'specimen', html: renderSpecimenHtml })
  nonCompliant = await harness.capture({
    name: 'non-compliant',
    html: renderNonCompliantSpecimenHtml,
  })
}, 180_000)

afterAll(async () => {
  await harness?.close()
})

describe('the capture matrix', () => {
  it('captures three viewports, two themes and two directions', () => {
    expect(compliant).toHaveLength(VIEWPORTS.length * THEMES.length * DIRECTIONS.length)
    expect(compliant).toHaveLength(12)
  })

  it('names every file deterministically, and the names round-trip', () => {
    for (const target of targetsFor('specimen')) {
      const filename = captureFilename(target)
      expect(parseCaptureFilename(filename)).toEqual({
        page: 'specimen',
        viewport: target.viewport.name,
        theme: target.theme,
        direction: target.direction,
      })
    }
  })

  it('produces no duplicate filenames, so no capture overwrites another', () => {
    const names = compliant.map((capture) => capture.filename)
    expect(new Set(names).size).toBe(names.length)
  })

  it('renders every cell differently, so no axis is being ignored', () => {
    // If light and dark produced the same bytes, the theme axis would be decorative.
    const hashes = compliant.map((capture) => hash(capture.png))
    expect(new Set(hashes).size).toBe(hashes.length)
  })
})

describe('acceptance — two consecutive runs produce zero pixel diff', () => {
  it('is byte-identical on a second capture of unchanged input', async () => {
    const second = await harness.capture({ name: 'specimen', html: renderSpecimenHtml })
    for (const [index, capture] of compliant.entries()) {
      const other = second[index]
      expect(other?.filename).toBe(capture.filename)
      expect(hash(other?.png ?? new Uint8Array()), `${capture.filename} differed`).toBe(
        hash(capture.png),
      )
    }
  }, 120_000)

  it('freezes the clock inside the page, so a page rendering "today" does not drift', async () => {
    const frozen = await harness.capture({
      name: 'clock',
      html: () =>
        `<!doctype html><html><body><p id="now"></p><script>
           document.getElementById('now').textContent = new Date().toISOString() + ' ' + Date.now()
         </script></body></html>`,
    })
    const first = frozen[0]
    expect(first).toBeDefined()
    const again = await harness.capture({
      name: 'clock',
      html: () =>
        `<!doctype html><html><body><p id="now"></p><script>
           document.getElementById('now').textContent = new Date().toISOString() + ' ' + Date.now()
         </script></body></html>`,
    })
    expect(hash(again[0]?.png ?? new Uint8Array())).toBe(hash(first?.png ?? new Uint8Array()))
  }, 120_000)
})

describe('acceptance — the self-critique pass reports a non-compliant fixture as a defect', () => {
  const findings = () =>
    uniqueFindings(
      nonCompliant.map((capture) => ({
        page: capture.target.page,
        viewport: capture.target.viewport,
        theme: capture.target.theme,
        direction: capture.target.direction,
        findings: capture.findings,
      })),
    )

  it('catches body text on the decorative brand gold', () => {
    // 2.90:1 against the light ground. This is the specific case H04's acceptance names, and the
    // single most likely way this palette gets misused, because it looks lovely.
    const contrast = findings().filter((finding) => finding.rule === 'contrast')
    expect(contrast.length).toBeGreaterThan(0)
    expect(contrast.some((finding) => finding.where.includes('brand-text'))).toBe(true)
  })

  it('catches a measure running past 76ch', () => {
    const measure = findings().filter((finding) => finding.rule === 'measure')
    expect(measure.length).toBeGreaterThan(0)
  })

  it('catches a touch target under 48px on the phone', () => {
    const phone = nonCompliant.filter((capture) => capture.target.viewport.name === 'phone')
    const targets = phone.flatMap((capture) =>
      capture.findings.filter((finding) => finding.rule === 'touch-target'),
    )
    expect(targets.length).toBeGreaterThan(0)
    expect(targets.every((finding) => finding.severity === 'defect')).toBe(true)
  })

  it('catches a physical margin, which does not mirror', () => {
    const rtl = findings().filter((finding) => finding.rule === 'rtl-physical-property')
    expect(rtl.length).toBeGreaterThan(0)
    expect(rtl.some((finding) => finding.detail.includes('margin-left'))).toBe(true)
  })

  it('reports them as defects, not as a clean run', () => {
    const counts = summarise(
      nonCompliant.map((capture) => ({
        page: capture.target.page,
        viewport: capture.target.viewport,
        theme: capture.target.theme,
        direction: capture.target.direction,
        findings: capture.findings,
      })),
    )
    expect(counts.defects).toBeGreaterThan(0)
  })
})

describe('the compliant specimen is the control', () => {
  it('reports nothing, which is what makes the findings above mean something', () => {
    const counts = summarise(
      compliant.map((capture) => ({
        page: capture.target.page,
        viewport: capture.target.viewport,
        theme: capture.target.theme,
        direction: capture.target.direction,
        findings: capture.findings,
      })),
    )
    expect(counts.defects).toBe(0)
    expect(counts.warnings).toBe(0)
  })

  it('checks the RTL rule in both directions, so a stylesheet defect cannot hide in LTR', () => {
    // The rule reads the authored stylesheet, so it fires whichever way the page is pointing. The
    // first version read computed styles, which are always physical, and flagged correct CSS.
    const ltr = nonCompliant.filter((capture) => capture.target.direction === 'ltr')
    expect(
      ltr.some((capture) =>
        capture.findings.some((finding) => finding.rule === 'rtl-physical-property'),
      ),
    ).toBe(true)
  })
})

describe('the gallery', () => {
  const gallery = () =>
    renderGalleryHtml([...compliant, ...nonCompliant], {
      title: 'BE RELAX — screenshot gallery',
      subtitle: 'test run',
    })

  it('groups by page', () => {
    expect(gallery()).toContain('>specimen<')
    expect(gallery()).toContain('>non-compliant<')
  })

  it('puts theme and direction side by side at each viewport', () => {
    const html = gallery()
    for (const viewport of VIEWPORTS) expect(html).toContain(`>${viewport.name} <`)
    expect(html).toContain('light · ltr')
    expect(html).toContain('dark · rtl')
  })

  it('inlines every image, so it is one self-contained file publishable as an Artifact', () => {
    const html = gallery()
    expect(html).not.toContain('src="./')
    expect((html.match(/data:image\/png;base64,/g) ?? []).length).toBe(
      compliant.length + nonCompliant.length,
    )
  })

  it('lists the critique findings above the images they came from', () => {
    expect(gallery()).toContain('Self-critique')
    expect(gallery()).toContain('finding--defect')
  })

  it('escapes a finding’s text, because it contains page content', () => {
    const html = renderGalleryHtml([], { title: '<script>alert(1)</script>', subtitle: 'x' })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
