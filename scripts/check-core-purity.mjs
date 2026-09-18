#!/usr/bin/env node
/**
 * packages/core must be pure: no I/O, no ambient globals, no clock.
 *
 * `pnpm boundaries` catches forbidden *imports*, but ambient globals are not imports — `process.env`
 * and `Date.now()` are reachable anywhere once @types/node is in scope. This closes that hole.
 *
 * Why the clock matters: every calculation in core (availability, VAT, leave accrual, commission)
 * must be reproducible from its inputs. A hidden `new Date()` makes a test pass today and fail in
 * Ramadan, and makes an availability bug impossible to reproduce.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'packages/core/src'

const FORBIDDEN = [
  { re: /\bprocess\s*\./g, why: 'process is ambient I/O; pass configuration in as an argument' },
  { re: /\bDate\.now\s*\(/g, why: 'reading the clock; inject a Clock and pass the instant in' },
  {
    re: /\bnew\s+Date\s*\(\s*\)/g,
    why: 'reading the clock; inject a Clock and pass the instant in',
  },
  { re: /\bMath\.random\s*\(/g, why: 'non-determinism; inject the value or a seeded generator' },
  { re: /\bfetch\s*\(/g, why: 'network I/O has no place in core' },
  { re: /\bglobalThis\b/g, why: 'ambient state; pass it in' },
  { re: /\bconsole\s*\./g, why: 'core must not log; return a result and let the caller decide' },
]

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })

/**
 * Blanks out comments and string literals while preserving line numbers and length, so a rule
 * explained in a doc comment is not reported as a violation of itself. Newlines are kept so the
 * reported line number still matches the file.
 */
function stripNonCode(src) {
  const out = src.split('')
  let i = 0
  // Comments become whitespace; string CONTENTS become a placeholder character. Blanking a string
  // to whitespace would make `new Date(`${d}T00:00:00Z`)` look like an argument-less `new Date()`.
  const blank = (from, to, fill = ' ') => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = fill
    }
  }
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    if (two === '//') {
      const end = src.indexOf('\n', i)
      blank(i, end === -1 ? src.length : end)
      i = end === -1 ? src.length : end
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      blank(i, stop)
      i = stop
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const quote = src[i]
      let k = i + 1
      while (k < src.length && src[k] !== quote) {
        if (src[k] === '\\') k += 1
        k += 1
      }
      blank(i + 1, Math.min(k, src.length), 'x')
      i = Math.min(k + 1, src.length)
    } else {
      i += 1
    }
  }
  return out.join('')
}

let violations = 0
for (const file of walk(ROOT)) {
  const code = stripNonCode(readFileSync(file, 'utf8'))
  code.split('\n').forEach((line, i) => {
    for (const { re, why } of FORBIDDEN) {
      re.lastIndex = 0
      if (re.test(line)) {
        console.log(`${file}:${i + 1}  ${line.trim()}`)
        console.log(`    -> ${why}`)
        violations += 1
      }
    }
  })
}

if (violations > 0) {
  console.error(`\n${violations} purity violation(s) in packages/core. See docs/adr/0001.`)
  process.exit(1)
}
console.log(`packages/core is pure (${walk(ROOT).length} files checked).`)
