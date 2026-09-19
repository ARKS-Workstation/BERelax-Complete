import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The acceptance criterion's gate: *"grep finds no numeric price literal in any template"*.
 *
 * It is the same shape of rule as `packages/db/src/seed/premises.test.ts`'s NAP scan, and for the same
 * reason: "every price comes from the catalogue" is a claim about the **repository**, not about one page. A
 * template with `AED 250` typed into it renders the same figure whether or not anybody ever changes the row,
 * and the failure is silent — the page looks right, the till charges something else, and the first person to
 * notice is a customer holding a phone with the old price on it.
 *
 * ## What counts as a template
 *
 * Every rendered surface of the catalogue routes: the page files, the shared bodies in `app/_treatments/`,
 * the copy modules and the content model. Not the whole application — the design-system gallery is a
 * specimen whose whole job is to show the components with plausible values, and W-SYS-02's own NOTE records
 * that its menu is docs/13 §4 as literals until the real catalogue arrives. It has its own exemption below,
 * with the unit that owns it named.
 *
 * ## What counts as a price literal
 *
 * Three shapes, because a price reaches a template in three ways and each looks different:
 *
 *   - **an `aed(...)` or `fils(...)` call** — the money constructors. Legitimate in a fixture, never in a
 *     template: the figure it takes is the one the catalogue holds;
 *   - **a currency-marked number** — `AED 250`, `250 AED`, `250 dirhams`, `درهم 250`;
 *   - **a decimal amount** — `250.00`, `1,200.00`. Two decimals is what a price looks like and what nothing
 *     else on these pages is: a duration is a whole number of minutes and a count is an integer.
 *
 * A bare integer is deliberately **not** matched. `45`, `60`, `90` and `120` are durations, `8` is the number
 * of treatments and `32` the number of price points — all of them read off the catalogue and all of them
 * legitimate in a sentence. A rule that refused every number would be a rule with an exemption per page,
 * which is the blanket this file exists not to be.
 */

const PRICE_RULE = 'price-literal-in-a-template'

const PRICE_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'money-constructor', pattern: /\b(?:aed|fils)\(\s*[\d_]+\s*\)/i },
  {
    name: 'currency-marked',
    // A digit is required after the currency, not merely a digit-or-comma: the comma class alone matches the
    // comma in "in AED, gross", which would refuse the sentence that states the currency and names no figure.
    pattern: /\bAED\s*\d[\d,]*|\d[\d,]*\s*(?:AED|dirhams?)\b|درهم\s*\d[\d,]*/i,
  },
  {
    name: 'decimal-amount',
    // Two or more digits before the point, or a grouping comma. `0.08`, `0.97` and `1.03` are CSS ratios and
    // line heights in the pattern components — a single-digit integer part is not a price on this menu, where
    // the cheapest treatment is three digits, and a rule that refused them would need an exemption per
    // component and would stop being read. `250.00` and `1,200.00` are matched; so is `10.00`.
    pattern: /(?<![\d.])(?:\d{1,3},\d{3}|\d{2,})\.\d{2}(?![\d])/,
  },
]

/**
 * The templates this rule covers: the rendered surfaces of the catalogue routes.
 *
 * Directories rather than a whole-app scan, for the reason in the header — and listed rather than globbed so
 * that a new catalogue page is added here deliberately. `route-spine.itest.ts`'s bijection is what catches a
 * page nobody registered; this catches a price nobody read from a row.
 */
const TEMPLATE_ROOTS: readonly string[] = [
  join('apps', 'web', 'app', '(en)', '(public)'),
  join('apps', 'web', 'app', '(ar)', 'ar'),
  join('apps', 'web', 'app', '_treatments'),
  join('apps', 'web', 'src', 'treatments'),
  join('packages', 'ui', 'src', 'patterns'),
]

/**
 * Every file that may carry one, and why. A **closed** list.
 *
 * Empty of real templates on purpose: the two entries are this test and the price table's own documentation,
 * which has to be able to say what a formatted figure looks like. A page added with a literal price fails
 * here and the answer is to read the row, not to add a line to this list.
 */
const EXEMPT: readonly { readonly path: string; readonly why: string }[] = [
  {
    path: join('apps', 'web', 'src', 'treatments', 'no-price-literals.test.ts'),
    why: 'this file: the patterns have to be spelled somewhere',
  },
  {
    path: join('packages', 'ui', 'src', 'patterns', 'price-table.tsx'),
    why:
      'the price table component: its doc comment shows what a formatted cell looks like (AED 1,200.00) ' +
      'to explain why the currency is in the column head. Prose, and the component itself takes the ' +
      'formatted string as a prop — it formats nothing',
  },
  {
    path: join('packages', 'ui', 'src', 'patterns', 'service-row.tsx'),
    why: 'the service row: its doc comment says the price prop is formatMoney output. W-SYS-02 owns it',
  },
  {
    path: join('apps', 'web', 'app', '(ar)', 'ar', 'kitchen-sink', 'page.tsx'),
    why:
      'the Arabic design-system gallery: a specimen, indexable false, whose menu is docs/13 4 as ' +
      'literals until the real catalogue arrives — W-SYS-02 records that and owns it. It is in a scanned ' +
      'directory because it is inside the Arabic locale group, not because it is a public page',
  },
]

const SCANNED_EXTENSIONS = ['.ts', '.tsx']
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'dist', 'artifacts'])
const ROOT = new URL('../../../..', import.meta.url).pathname

function sourceFiles(root: string): readonly string[] {
  const absolute = join(ROOT, root)
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIPPED_DIRS.has(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (SCANNED_EXTENSIONS.some((extension) => full.endsWith(extension))) found.push(full)
    }
  }
  walk(absolute)
  return found
}

const isExempt = (path: string): boolean => EXEMPT.some((entry) => path === entry.path)

describe(`acceptance — no numeric price literal in any template (${PRICE_RULE})`, () => {
  const files = TEMPLATE_ROOTS.flatMap((root) => sourceFiles(root)).map((path) =>
    relative(ROOT, path),
  )

  it('scans the templates it claims to scan', () => {
    // The control, and the defect ADR 0002 is about: a scan that found nothing would report a pass for ever.
    // Named files rather than a count, so a moved page fails here rather than shrinking the scan silently.
    expect(files.length).toBeGreaterThan(8)
    for (const expected of [
      join('apps', 'web', 'app', '(en)', '(public)', 'treatments', '[slug]', 'page.tsx'),
      join('apps', 'web', 'app', '(en)', '(public)', 'pricing', 'page.tsx'),
      join('apps', 'web', 'app', '(ar)', 'ar', 'treatments', '[slug]', 'page.tsx'),
      join('apps', 'web', 'app', '(ar)', 'ar', 'pricing', 'page.tsx'),
      join('apps', 'web', 'app', '_treatments', 'pages.tsx'),
      join('apps', 'web', 'src', 'treatments', 'copy-en.ts'),
      join('apps', 'web', 'src', 'treatments', 'copy-ar.ts'),
      join('packages', 'ui', 'src', 'patterns', 'price-table.tsx'),
    ]) {
      expect(files, expected).toContain(expected)
    }
  })

  it('finds no price literal outside the closed exemption list', () => {
    const findings: string[] = []
    for (const file of files) {
      if (isExempt(file)) continue
      const text = readFileSync(join(ROOT, file), 'utf8')
      for (const { name, pattern } of PRICE_PATTERNS) {
        const match = pattern.exec(text)
        if (match === null) continue
        findings.push(`${file}: ${name} — ${match[0]}`)
      }
    }
    expect(
      findings,
      `${PRICE_RULE}: a price typed into a template renders the same figure whether or not the row is ` +
        'corrected, and the till charges the row. Read it from the fact sheet: ' +
        `${findings.join('; ')}`,
    ).toEqual([])
  })

  it('detects each shape of literal it claims to detect', () => {
    // The controls. Each pattern is run against text that must match and text that must not, so a pattern
    // that stopped matching cannot leave this gate green — the failure mode a grep gate always has.
    const cases: readonly [string, string, boolean][] = [
      ['money-constructor', 'const menu = [{ price: aed(250) }]', true],
      ['money-constructor', 'const menu = [{ price: fils(25_000) }]', true],
      ['money-constructor', 'const price = variantMoney(variant)', false],
      ['currency-marked', 'Every treatment is AED 250 today', true],
      ['currency-marked', 'The menu says 250 AED', true],
      ['currency-marked', 'كل جلسة بسعر درهم 250', true],
      ['currency-marked', 'Every price is in AED, gross, with VAT included', false],
      ['decimal-amount', 'reads as 1,200.00 in the column', true],
      ['decimal-amount', 'from 250.00 for 45 minutes', true],
      ['decimal-amount', 'docs/13 §4 lists 32 price points at 4 durations', false],
      // A version number is not a price, and neither is a CSS ratio.
      ['decimal-amount', 'Next.js 16.3.5 (Turbopack)', false],
      ['decimal-amount', 'line-height: 1.03;', false],
      ['decimal-amount', 'aspect-ratio: 0.8;', false],
      ['decimal-amount', 'the 10.00 minimum', true],
    ]
    for (const [name, text, shouldMatch] of cases) {
      const pattern = PRICE_PATTERNS.find((entry) => entry.name === name)?.pattern
      expect(pattern, name).toBeDefined()
      expect(pattern?.test(text) ?? false, `${name}: ${text}`).toBe(shouldMatch)
    }
  })
})
