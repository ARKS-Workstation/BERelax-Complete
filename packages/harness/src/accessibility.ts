/**
 * Accessibility, checked with axe-core in the same page the screenshot comes from.
 *
 * ## Why it runs beside the capture rather than as its own suite
 *
 * An accessibility run against a different render of the page is a run against a different page. The
 * theme, the direction and the viewport all change what is on screen — a control that is 48px on
 * desktop and 32px on a phone fails in one and passes in the other, and RTL changes which elements
 * are adjacent. Sharing the capture's page means a violation and the image that shows it come from
 * one render.
 *
 * ## What is checked, and what is deliberately not
 *
 * axe reports **violations** (a rule definitely broken) and **incomplete** results (a rule it could
 * not decide — usually a colour contrast it cannot compute behind an image). Only violations fail the
 * build. Failing on `incomplete` sounds stricter and is worse: it fires on things that are correct,
 * and a gate that cries wolf gets suppressed.
 *
 * The rule set is WCAG 2.1/2.2 A and AA, which is what UAE federal accessibility policy and every
 * plausible procurement standard actually reference. AAA is not a target and pretending otherwise
 * would make the number meaningless.
 *
 * Colour contrast is checked here *and* by the critique pass, and that is not duplication: axe checks
 * what it can compute from the DOM, and the critique pass checks the palette rules that are specific
 * to this system — that `--color-decor-gold` never carries text, that the measure holds, that a
 * physical margin has not crept in. Neither subsumes the other.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Page } from 'playwright'
import type { CaptureTarget } from './matrix.ts'

const require = createRequire(import.meta.url)

export type Impact = 'minor' | 'moderate' | 'serious' | 'critical'

export interface AxeViolation {
  readonly id: string
  readonly impact: Impact | null
  readonly help: string
  readonly helpUrl: string
  /** CSS selectors for the elements that failed, so a human can find them. */
  readonly nodes: readonly string[]
}

export interface AccessibilityResult {
  readonly target: CaptureTarget
  readonly violations: readonly AxeViolation[]
  /** Rules axe could not decide. Reported, never failed on. */
  readonly incomplete: readonly string[]
}

/** WCAG 2.1 and 2.2, levels A and AA. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const

let axeSource: string | undefined

/** axe-core's browser bundle, read once and injected into each page. */
function axeBundle(): string {
  if (axeSource === undefined) {
    axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')
  }
  return axeSource
}

interface RawAxeResults {
  violations: {
    id: string
    impact: Impact | null
    help: string
    helpUrl: string
    nodes: { target: string[] }[]
  }[]
  incomplete: { id: string }[]
}

/** Runs axe against an already-rendered page. */
export async function auditPage(page: Page, target: CaptureTarget): Promise<AccessibilityResult> {
  await page.addScriptTag({ content: axeBundle() })
  const raw = (await page.evaluate(async (tags: readonly string[]) => {
    const globals = globalThis as unknown as {
      axe: { run(context: unknown, options: unknown): Promise<unknown> }
      document: unknown
    }
    return (await globals.axe.run(globals.document, {
      runOnly: { type: 'tag', values: [...tags] },
      // The screenshot is of the page as loaded; asking axe to reason about hidden elements would
      // report on things that are not on screen in the image beside it.
      resultTypes: ['violations', 'incomplete'],
    })) as unknown
  }, AXE_TAGS)) as RawAxeResults

  return {
    target,
    violations: raw.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      helpUrl: violation.helpUrl,
      nodes: violation.nodes.flatMap((node) => node.target),
    })),
    incomplete: raw.incomplete.map((entry) => entry.id),
  }
}

/** Violations across the matrix, deduplicated by rule and element. */
export function uniqueViolations(results: readonly AccessibilityResult[]): AxeViolation[] {
  const seen = new Map<string, AxeViolation>()
  for (const result of results) {
    for (const violation of result.violations) {
      const key = `${violation.id}|${violation.nodes.join(',')}`
      if (!seen.has(key)) seen.set(key, violation)
    }
  }
  return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
}
