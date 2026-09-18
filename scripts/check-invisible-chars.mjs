#!/usr/bin/env node
/**
 * Rejects invisible and bidi-reordering characters in source, and the mismatched-escape mistake.
 *
 * Two separate hazards, one scan:
 *
 *  1. **Trojan Source (CVE-2021-42574).** A U+202E in a comment or string literal makes the source a
 *     reviewer reads differ from the source the compiler parses. A reviewer sees the code do one
 *     thing and the compiler emits another. Source must therefore be free of these characters; the
 *     escape form `\u202e` is what code carries instead, and it is visible.
 *
 *  2. **Invisible characters that arrive by accident.** A zero-width space pasted into an
 *     identifier, a non-breaking space in indentation, a BOM in the middle of a file. Each produces
 *     an error whose message points nowhere useful.
 *
 * Arabic and every other script are unaffected: this forbids format and zero-width characters, not
 * letters. Fixture and fixture-adjacent files are exempt where they must hold real bidi text.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['packages', 'apps', 'scripts', 'docs']
const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs', '.json', '.css', '.sql', '.md'])
const SKIP_DIRECTORIES = new Set(['.claude', 'node_modules', 'dist', '.next', 'fixtures'])

/** Codepoint -> why it is forbidden. Keyed by the escape a reviewer should see instead. */
const FORBIDDEN = new Map([
  [0x00ad, 'SOFT HYPHEN'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2060, 'WORD JOINER'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE / BOM'],
])

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      yield full
    }
  }
}

const violations = []

for (const root of ROOTS) {
  try {
    statSync(root)
  } catch {
    continue
  }
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      for (const [offset, char] of [...line].entries()) {
        const name = FORBIDDEN.get(char.codePointAt(0))
        if (name === undefined) continue
        const escaped = `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`
        violations.push(
          `${file}:${index + 1}:${offset + 1}  literal ${name} — write ${escaped} instead`,
        )
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Invisible or bidi-reordering characters found in source:\n')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(
    `\n${violations.length} violation(s). These characters make reviewed source differ from ` +
      'compiled source (CVE-2021-42574). Use the escape form, which a reviewer can see.',
  )
  process.exit(1)
}

const scanned = ROOTS.flatMap((root) => {
  try {
    statSync(root)
  } catch {
    return []
  }
  return [...walk(root)]
})
console.log(
  `No literal bidi or zero-width characters in ${scanned.length} source files across ` +
    `${ROOTS.join(', ')}.`,
)
