#!/usr/bin/env node
/**
 * Three rules about the modules that draw a tax document, none of which a review reliably catches.
 *
 * Every violation is reported with its **rule name** first, so `scripts/test-gates.mjs` can assert that
 * a known-bad fixture was rejected by the rule written for it. Asserting only a non-zero exit is how a
 * gate ends up passing because of an unrelated rule while the one under test has quietly stopped
 * matching anything — ADR 0003.
 *
 * **1. `[tax-document-must-not-derive-tax]`** The document layer prints stored figures and derives
 * nothing. `0026_invoice.sql` states the rule for the database: a document total is the SUM of its
 * lines, never a re-derivation from the document gross. The tempting mistake is one call —
 * `splitGross(documentGross)` — and for the committed two-lines-at-11-fils document it prints VAT of 1
 * beside a stored `vat_total` of 2. The PDF is the copy the customer keeps and the copy the FTA is shown,
 * so the arithmetic must not be reachable from a template at all. This rule closes the import.
 *
 * **2. `[arabic-font-weight-must-be-a-shipped-cut]`** CSS weight matching resolves a request for 500
 * *downwards* to 400 when only 400 and 600 are available, so `font-weight: 500` on Arabic body copy in a
 * document is a declaration that silently does nothing. It has already happened once in this repository
 * — `apps/web/app/_fonts/index.ts` records it, where a deliberate recalibration of Arabic weight was
 * dead for exactly this reason — and a PDF has no second paint in which anybody notices. The shipped
 * weights are read out of `packages/pdf/src/fonts.ts`, so adding the 500 cut is what makes `500` legal
 * rather than editing this gate.
 *
 * **3. `[rtl-must-come-from-dir-not-a-direction-mark]`** Right-to-left layout comes from the `dir`
 * attribute and an isolate comes from `<bdi>`. A LEFT-TO-RIGHT MARK or an embedding control written into
 * a template is a different mechanism that looks like the same one: it survives into the extracted text,
 * a reader copies it out with the amount, and `safeText` strips it from every *interpolated* value
 * anyway, so a template that relied on one would behave differently for trusted and untrusted text. The
 * one legitimate appearance is a value being handed to `safeText` to prove it is stripped — the F10 bidi
 * specimen does exactly that — so a line that calls `safeText` is exempt, and that exemption is itself
 * covered by a known-bad fixture.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** The modules that draw or compose a document. Tests are excluded: a control has to name the hazard. */
const SCANNED = [
  'packages/core/src/documents',
  'packages/pdf/src/documents',
  'packages/pdf/src/render-document.ts',
]

const FONTS = 'packages/pdf/src/fonts.ts'

/** Tax arithmetic. Any of these reachable from a template is a second opinion about a filed figure. */
const DERIVATIONS = [
  'splitGross',
  'grossFromNet',
  'deriveTaxLine',
  'deriveDocumentTax',
  'vatIfReDerivedFromTotal',
]

/** Selectors that style Arabic. A weight declared under one of these must be a weight we ship. */
const ARABIC_SELECTOR = /\.ar\b|\[lang=['"]?ar|\[dir=['"]?rtl|:lang\(ar\)/

/** LRM, RLM, the embeddings and the overrides, as an escape or as a literal character. */
const DIRECTION_MARK = /\\u(200e|200f|202a|202b|202c|202d|202e)|[\u200e\u200f\u202a-\u202e]/i

const violations = []
const report = (rule, file, line, detail) =>
  violations.push(`[${rule}] ${file}${line === null ? '' : `:${line}`} — ${detail}`)

function* walk(target) {
  let stats
  try {
    stats = statSync(target)
  } catch {
    return
  }
  if (stats.isFile()) {
    yield target
    return
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const full = join(target, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.name.endsWith('.ts') && !/\.(test|itest)\.ts$/.test(entry.name)) {
      yield full
    }
  }
}

/**
 * The Arabic weights the PDF actually embeds, read from the woff2 filenames in `fonts.ts`.
 *
 * Read rather than listed, because the whole point of the rule is that the stylesheet and the embedded
 * faces agree: a list here would be a third opinion and the one that goes stale.
 */
function shippedArabicWeights() {
  const source = readFileSync(FONTS, 'utf8')
  const weights = new Set()
  for (const match of source.matchAll(/ibm-plex-sans-arabic-arabic-(\d+)-normal\.woff2/g)) {
    weights.add(Number(match[1]))
  }
  if (weights.size === 0) {
    throw new Error(`${FONTS} declares no Arabic woff2 files; this gate cannot check anything`)
  }
  return weights
}

const arabicWeights = shippedArabicWeights()

/**
 * Every `selector { declarations }` block in a source file.
 *
 * A text scan, not a CSS parse. The stylesheets live inside template literals in TypeScript, so a real
 * parser would first have to decide which template literals are CSS — and the scan only has to be right
 * about blocks that mention both an Arabic selector and a font weight, which no TypeScript does.
 */
function* cssBlocks(source) {
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const before = source.slice(0, match.index)
    yield {
      // The last line before the brace: `[^{}]+` also swallows any comment above the rule, and a
      // violation report is more use when it names the selector than when it quotes the paragraph.
      selector: (match[1] ?? '').trim().split('\n').at(-1)?.trim() ?? '',
      declarations: match[2] ?? '',
      line: before.split('\n').length,
    }
  }
}

for (const target of SCANNED) {
  for (const file of walk(target)) {
    const source = readFileSync(file, 'utf8')
    const lines = source.split('\n')

    // 1. tax arithmetic
    for (const name of DERIVATIONS) {
      const pattern = new RegExp(`\\b${name}\\b`)
      for (const [index, text] of lines.entries()) {
        // Prose in a doc comment explains why the call is forbidden; the rule is about code.
        if (/^\s*(\*|\/\/)/.test(text)) continue
        if (pattern.test(text)) {
          report(
            'tax-document-must-not-derive-tax',
            file,
            index + 1,
            `${name}() is tax arithmetic. A document prints the stored figures: ` +
              'net_total, vat_total, gross_total and the per-line columns, summed at most.',
          )
        }
      }
    }

    // 2. Arabic weights
    for (const block of cssBlocks(source)) {
      if (!ARABIC_SELECTOR.test(block.selector)) continue
      for (const match of block.declarations.matchAll(/font-weight:\s*(\d{3})/g)) {
        const weight = Number(match[1])
        if (!arabicWeights.has(weight)) {
          report(
            'arabic-font-weight-must-be-a-shipped-cut',
            file,
            block.line,
            `font-weight: ${weight} on "${block.selector}" but the embedded Arabic cuts are ` +
              `${[...arabicWeights].sort((a, b) => a - b).join(' and ')}. CSS resolves a missing ` +
              'weight to a neighbour, so the declaration would silently draw a different face.',
          )
        }
      }
    }

    // 3. direction marks
    for (const [index, text] of lines.entries()) {
      if (/^\s*(\*|\/\/)/.test(text)) continue
      if (!DIRECTION_MARK.test(text)) continue
      // The one legitimate appearance: a value handed to safeText to prove it is stripped.
      if (text.includes('safeText(')) continue
      report(
        'rtl-must-come-from-dir-not-a-direction-mark',
        file,
        index + 1,
        'a bidi control in a document template. Right-to-left comes from dir, and an isolated run ' +
          'from bdi() — a control character survives into the extracted text and behaves ' +
          'differently from the same value after safeText has stripped it.',
      )
    }
  }
}

if (violations.length > 0) {
  console.error(`FAIL  ${violations.length} tax-document rule violation(s):`)
  for (const violation of violations) console.error(`      ${violation}`)
  process.exit(1)
}

console.log(
  `PASS  tax documents derive nothing, declare only the Arabic weights the PDF embeds ` +
    `(${[...arabicWeights].sort((a, b) => a - b).join(', ')}) and build RTL from dir`,
)
