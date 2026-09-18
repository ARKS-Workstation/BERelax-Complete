#!/usr/bin/env node
/**
 * The touch-target gate: every control at least 48x48px on a phone, 40x40 on a desk, 8px apart.
 *
 * docs/08 §4 states those numbers; this is what makes them true. The rules live in
 * `packages/harness/src/touch-targets.ts` and run in the browser, because a target's size is not in
 * the stylesheet — it is padding plus line-height plus whatever the flex container did, and only the
 * engine that laid the page out knows the answer.
 *
 * ## What it audits
 *
 * With no arguments: the design specimen, in both directions, at both floors. Mirroring changes which
 * controls are adjacent, so RTL is a separate render rather than an assumption.
 *
 * With arguments: each one is a path to an HTML document. That is how
 * `scripts/test-gates.mjs` proves the gate fires — a fixture page with a 32px button, rejected by rule
 * name — and it is how a static page can be audited without a server. The live routes are audited
 * against a real `next start` by `apps/web/src/kitchen-sink.itest.ts`, which uses these same rules.
 *
 * Findings print with their rule name in brackets, so a known-bad fixture can assert it was rejected by
 * the rule written for it rather than by an unrelated one (ADR 0003).
 */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { renderSpecimenHtml } from '../packages/harness/src/specimen.ts'
import {
  auditTouchTargetsInPage,
  touchTargetInputFor,
  uniqueTouchTargetFindings,
} from '../packages/harness/src/touch-targets.ts'

/** The phone the booking happens on, and the desk the front office uses. Same widths as the matrix. */
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desk', width: 1280, height: 900 },
]

const files = process.argv.slice(2).filter((argument) => !argument.startsWith('-'))

/** @type {{ name: string, html: string }[]} */
const pages =
  files.length > 0
    ? files.map((file) => ({ name: file, html: readFileSync(file, 'utf8') }))
    : [
        { name: 'specimen (ltr)', html: renderSpecimenHtml({ direction: 'ltr', theme: 'light' }) },
        { name: 'specimen (rtl)', html: renderSpecimenHtml({ direction: 'rtl', theme: 'light' }) },
      ]

const browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] })
let total = 0
let audited = 0

try {
  for (const viewport of VIEWPORTS) {
    for (const page of pages) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      })
      try {
        // On the context and before the page exists: `setContent` does not navigate, so an init script
        // registered on a page already at about:blank never runs. esbuild's `keepNames` rewrites every
        // named function as `__name(fn, 'fn')`, and Playwright serialises the *compiled* source of the
        // callback into a page where that helper does not exist.
        await context.addInitScript({
          content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
        })
        const tab = await context.newPage()
        await tab.setContent(page.html, { waitUntil: 'networkidle' })
        await tab.evaluate(async () => {
          await document.fonts.ready
        })
        const findings = uniqueTouchTargetFindings(
          await tab.evaluate(auditTouchTargetsInPage, touchTargetInputFor(viewport.width)),
        )
        audited += 1
        for (const finding of findings) {
          total += 1
          console.error(
            `  [${finding.rule}] ${viewport.name} ${page.name} — ${finding.where} ${finding.detail}`,
          )
        }
      } finally {
        await context.close()
      }
    }
  }
} finally {
  await browser.close()
}

if (total > 0) {
  console.error(
    `\n${total} touch-target violation(s). docs/08 §4: 48px mobile, 40px desktop, 8px gap.`,
  )
  process.exit(1)
}

console.log(
  `${audited} render(s) audited: every control clears the touch floor for its viewport and its ` +
    'neighbours by 8px.',
)
