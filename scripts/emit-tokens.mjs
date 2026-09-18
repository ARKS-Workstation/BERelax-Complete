#!/usr/bin/env node
/**
 * Writes the generated token stylesheets, and checks them when not asked to write.
 *
 * Two files, both generated, both committed:
 *
 *   packages/ui/src/tokens/tokens.css    every token as a CSS custom property
 *   packages/ui/src/tokens/tailwind.css  the Tailwind v4 theme, which clears Tailwind's own palette
 *
 * Committing generated files is a deliberate trade. It means a reviewer sees the colour change in the
 * diff rather than having to run a build to find out what moved, and it means the PDF renderer and
 * the web app read the same bytes. The cost is that they can go stale, which is what the check mode
 * is for: `pnpm tokens` fails if either file is not what this script would write today.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tokensCss } from '../packages/ui/src/tokens/emit.ts'
import { tailwindThemeCss } from '../packages/ui/src/tokens/tailwind.ts'

const TOKENS_DIR = join(import.meta.dirname, '..', 'packages', 'ui', 'src', 'tokens')

const FILES = [
  { path: join(TOKENS_DIR, 'tokens.css'), content: tokensCss() },
  { path: join(TOKENS_DIR, 'tailwind.css'), content: tailwindThemeCss() },
]

const emit = process.argv.includes('--emit')
let failures = 0

for (const { path, content } of FILES) {
  const name = path.slice(path.indexOf('packages/'))
  if (emit) {
    writeFileSync(path, content)
    console.log(`wrote ${name} (${content.length} bytes)`)
    continue
  }
  let current = null
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    console.error(`FAIL  ${name} does not exist — run \`pnpm tokens:emit\``)
    failures += 1
    continue
  }
  if (current === content) {
    console.log(`PASS  ${name} matches`)
  } else {
    console.error(`FAIL  ${name} is stale or hand-edited — run \`pnpm tokens:emit\``)
    failures += 1
  }
}

if (failures > 0) process.exit(1)
