import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deserialiseFlowDefinition, serialiseFlowDefinition } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import {
  INVALID_FLOW_FIXTURES,
  VALID_FLOW_FIXTURES,
} from '../../core/test/fixtures/flow-definitions/index.ts'

/**
 * The committed corpus, as BYTES.
 *
 * This file exists because `packages/core` may not read a file. `core-must-be-pure` forbids `node:fs`
 * from every module in that package including its tests, so the corpus reaches a core test as static
 * imports — and a static import is a parsed OBJECT. The acceptance line says "round-trips
 * byte-identically", and the only place the committed bytes can be compared with what the serialiser
 * produces is a package that may do both: `packages/fixtures` may import core and may read files (brief
 * rule 4).
 *
 * Three claims, and each of them catches something the object-level tests cannot:
 *
 *   - **Every file in the directory is listed in the index.** A corpus file added and not listed is a
 *     document nothing exercises, which is the quiet way a corpus stops being a corpus.
 *   - **Every valid file's bytes are exactly `serialiseFlowDefinition`'s output.** So the committed form
 *     IS the canonical form, which is what makes "the stored definition still serialises to what was
 *     published" assertable at all (`flow-versioning.itest.ts` relies on it).
 *   - **Twelve and twelve**, which is the acceptance line's own arithmetic.
 */
const DIRECTORY = fileURLToPath(
  new URL('../../core/test/fixtures/flow-definitions/', import.meta.url),
)

const committedFiles = readdirSync(DIRECTORY)
  .filter((name) => name.endsWith('.json'))
  .sort()

describe('the committed flow-definition corpus', () => {
  it('is twelve valid and twelve invalid documents, and nothing else is in the directory', () => {
    expect(VALID_FLOW_FIXTURES).toHaveLength(12)
    expect(INVALID_FLOW_FIXTURES).toHaveLength(12)
    const listed = [...VALID_FLOW_FIXTURES, ...INVALID_FLOW_FIXTURES]
      .map((fixture) => fixture.file)
      .sort()
    expect(
      committedFiles,
      'a file in the directory that the index does not list is unexercised',
    ).toEqual(listed)
  })

  it('every valid document is committed in the canonical byte form', () => {
    for (const fixture of VALID_FLOW_FIXTURES) {
      const bytes = readFileSync(`${DIRECTORY}${fixture.file}`, 'utf8')
      const parsed = deserialiseFlowDefinition(bytes)
      expect(
        parsed.ok,
        parsed.ok ? '' : `${fixture.file}: ${parsed.refusals.map((r) => r.rule).join(', ')}`,
      ).toBe(true)
      if (!parsed.ok) continue
      expect(
        serialiseFlowDefinition(parsed.definition),
        `${fixture.file} is not in the canonical form — regenerate it rather than editing the serialiser`,
      ).toBe(bytes)
    }
  })

  it('the control: a byte changed in a committed file is detected', () => {
    // Without this, the comparison above could be reading a file it also wrote — and the one thing this
    // file is for is that the committed bytes are not merely self-consistent.
    const first = VALID_FLOW_FIXTURES[0]
    if (first === undefined) throw new Error('the corpus is empty')
    const bytes = readFileSync(`${DIRECTORY}${first.file}`, 'utf8')
    const nudged = bytes.replace('"dslVersion": 1', '"dslVersion":  1')
    expect(nudged, 'the anchor has gone stale against the committed form').not.toBe(bytes)
    const parsed = deserialiseFlowDefinition(nudged)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(serialiseFlowDefinition(parsed.definition)).not.toBe(nudged)
  })

  it('every invalid document is committed in the canonical byte form as well', () => {
    // They cannot go through the serialiser — the schema refuses them — so the claim is narrower: the
    // bytes are what `JSON.stringify` of the sorted document produces, so a reviewer diffing the corpus
    // sees content changes rather than formatting ones.
    for (const fixture of INVALID_FLOW_FIXTURES) {
      const bytes = readFileSync(`${DIRECTORY}${fixture.file}`, 'utf8')
      expect(`${JSON.stringify(sorted(JSON.parse(bytes)), null, 2)}\n`, fixture.file).toBe(bytes)
    }
  })
})

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of [...Object.keys(source)].sort()) out[key] = sorted(source[key])
    return out
  }
  return value
}
