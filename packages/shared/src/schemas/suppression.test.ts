import { describe, expect, it } from 'vitest'
import {
  isUnsuppressionSource,
  SUPPRESSION_KEY_KINDS,
  SUPPRESSION_KINDS,
  SUPPRESSION_SOURCES,
  type SuppressionEntryInput,
  suppressionEntrySchema,
  UNSUPPRESSION_SOURCES,
} from './suppression.ts'

/**
 * C-CRM-04's zod half, and the acceptance criterion's known-bad fixture for the edge.
 *
 * The database half of every rule here is a CHECK or an enum in migration 0064 and is exercised by the
 * psql probes in `scripts/test-gates.mjs` block 82. Both halves exist deliberately: zod gives a person a
 * readable message at the edge, and the constraint is what holds when the write arrives from psql, a
 * migration, or a caller that forgot the repository exists. Either alone is a gap.
 *
 * The one rule where that is more than belt-and-braces is `keyHmacHex`. A plaintext recipient reaching
 * `suppression.key_hmac` is the failure the whole keying scheme exists to prevent, and a caller that
 * passed one would otherwise learn about it from a CHECK violation rendered as a 500.
 */

const VALID: SuppressionEntryInput = {
  keyKind: 'phone',
  keyHmacHex: 'a1b2c3d4'.repeat(8),
  pepperVersion: 'v1',
  kind: 'suppressed',
  source: 'complaint',
  reason: 'Complaint reported by the aggregator against this number.',
  actorKind: 'system',
  actorLabel: 'Aggregator feedback',
  recordedAtIso: '2026-09-18T10:00:00.000Z',
  contactCustomerId: null,
}

const parse = (overrides: Record<string, unknown> = {}) =>
  suppressionEntrySchema.safeParse({ ...VALID, ...overrides })

const issuePaths = (result: ReturnType<typeof parse>): readonly string[] =>
  result.success ? [] : result.error.issues.flatMap((issue) => issue.path.map(String))

describe('the vocabularies', () => {
  it('is the closed set of five sources, and the two kinds', () => {
    expect(SUPPRESSION_SOURCES).toEqual([
      'manual',
      'complaint',
      'hard_bounce',
      'dnc_register',
      'preference_centre',
    ])
    expect(SUPPRESSION_KINDS).toEqual(['suppressed', 'unsuppressed'])
    // The same two labels `customer_blocklist.key_kind` uses (0053), not a second vocabulary: a key is
    // the same thing in both lists even though the lists answer different questions.
    expect(SUPPRESSION_KEY_KINDS).toEqual(['phone', 'email'])
  })

  it('restricts an unsuppression to the three sources with a decision behind them', () => {
    expect(UNSUPPRESSION_SOURCES).toEqual(['manual', 'preference_centre', 'dnc_register'])
    for (const source of UNSUPPRESSION_SOURCES) expect(isUnsuppressionSource(source)).toBe(true)
    // A complaint and a hard bounce happened and cannot un-happen.
    for (const event of ['complaint', 'hard_bounce']) {
      expect(isUnsuppressionSource(event)).toBe(false)
    }
    expect(isUnsuppressionSource('whatever_the_admin_typed')).toBe(false)
    // Every unsuppression source must be a source at all: a fourth label here that was not in
    // SUPPRESSION_SOURCES would be a value the enum refuses and zod accepts.
    for (const source of UNSUPPRESSION_SOURCES) {
      expect(SUPPRESSION_SOURCES as readonly string[]).toContain(source)
    }
  })
})

describe('suppressionEntrySchema', () => {
  it('accepts a whole entry, so every refusal below is about the fault', () => {
    // The positive control, first. A schema that refused everything would satisfy every case after this.
    expect(parse().success).toBe(true)
  })

  it('refuses a source outside the closed set — the acceptance criterion own fixture', () => {
    const result = parse({ source: 'email_blast' })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('source')
  })

  it('refuses a kind outside the two', () => {
    expect(parse({ kind: 'paused' }).success).toBe(false)
  })

  it('refuses a key that is not 64 lower-case hex characters', () => {
    for (const bad of [
      // The one that matters: a plaintype E.164 number, which is what a caller that forgot to hash passes.
      '+971590009101',
      'guest@example.com',
      'A1B2C3D4'.repeat(8),
      'a1b2c3d4'.repeat(7),
      `${'a1b2c3d4'.repeat(8)}a`,
      '',
    ]) {
      const result = parse({ keyHmacHex: bad })
      expect(result.success, JSON.stringify(bad)).toBe(false)
      expect(issuePaths(result)).toContain('keyHmacHex')
    }
  })

  it('requires a pepper version, because a row must say which pepper keyed it', () => {
    expect(parse({ pepperVersion: '' }).success).toBe(false)
    expect(parse({ pepperVersion: '   ' }).success).toBe(false)
  })

  it('refuses a placeholder reason and a placeholder actor', () => {
    for (const placeholder of ['TBC', 'to be confirmed', 'pending', 'unknown']) {
      expect(parse({ reason: placeholder }).success, placeholder).toBe(false)
      expect(parse({ actorLabel: placeholder }).success, placeholder).toBe(false)
    }
    expect(parse({ reason: '' }).success).toBe(false)
    expect(parse({ actorLabel: '  ' }).success).toBe(false)
  })

  it('refuses an unsuppression whose source is an event that cannot un-happen', () => {
    expect(parse({ kind: 'unsuppressed', source: 'hard_bounce' }).success).toBe(false)
    expect(parse({ kind: 'unsuppressed', source: 'complaint' }).success).toBe(false)
    // The control: the same unsuppression from a source with a decision behind it is accepted.
    expect(parse({ kind: 'unsuppressed', source: 'manual' }).success).toBe(true)
  })

  it('refuses a preference-centre entry attributed to anybody but the customer', () => {
    // A withdrawal nobody made, recorded as though somebody had.
    expect(parse({ source: 'preference_centre', actorKind: 'staff' }).success).toBe(false)
    expect(parse({ source: 'preference_centre', actorKind: 'system' }).success).toBe(false)
    expect(
      parse({
        source: 'preference_centre',
        actorKind: 'customer',
        actorLabel: 'Preference centre (link holder)',
      }).success,
    ).toBe(true)
  })

  it('requires an instant with an offset, never a bare local time', () => {
    expect(parse({ recordedAtIso: '2026-09-18T10:00:00' }).success).toBe(false)
    expect(parse({ recordedAtIso: 'yesterday' }).success).toBe(false)
  })

  it('refuses a contact id that is not a uuid, and accepts none at all', () => {
    expect(parse({ contactCustomerId: 'customer-42' }).success).toBe(false)
    // Null is the normal case for three of the five sources: a complaint, a bounce or a register entry
    // can be about a detail this business has no record for, which is why the list is keyed on the detail.
    expect(parse({ contactCustomerId: null }).success).toBe(true)
    expect(parse({ contactCustomerId: '00000000-0000-7000-8000-00000000c401' }).success).toBe(true)
  })

  it('is strict, so an unexpected key is an error rather than data silently dropped', () => {
    expect(parse({ recipient: '+971590009101' }).success).toBe(false)
  })
})
