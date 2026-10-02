import { createHmac } from 'node:crypto'
import type { SuppressionPepper } from '@berelax/db'
import { describe, expect, it } from 'vitest'
import type { ContactNormaliser } from '../customers/dedup.ts'
import type { VisitsImporterOptions } from './import.ts'
import {
  MINIMISED_VISIT_PAYLOAD_KEYS,
  planVisitImport,
  stageVisitCell,
  therapistClashes,
  VISIT_REJECTION_REASONS,
  VISIT_REJECTIONS,
  validateStagedVisit,
  visitClashKey,
  visitsImporter,
} from './import.ts'
import type { VisitCell } from './workbook.ts'
import {
  buildVisitWorkbook,
  parseVisitWorkbook,
  VISIT_COLUMNS,
  VISIT_HEADER,
  VISIT_OUTCOMES,
} from './workbook.ts'

/**
 * H-MIG-05's pure half: the workbook's shape, every named rejection, and the two file-scoped passes.
 *
 * What is NOT here, deliberately: every claim about a reconstructed visit's effect on the database —
 * the trading date resolved from `business_day`, the quarantines, the domain invariants, the P&L, the
 * cohorts and all six refusals — is a claim about PostgreSQL and is proved in
 * `packages/fixtures/src/visit-import.itest.ts` against a real one. A mock cannot produce a COMMIT, and
 * `packages/migration` is excluded from the coverage floor for exactly that reason (see its `index.ts`).
 *
 * The normaliser is a STUB here and the real `e164IdentityResult` is used in the pairing suite. That is
 * the seam `packages/migration` may not cross — it cannot import `@berelax/core` — and a stub is honest
 * for these cases because not one of them is about normalisation: they are about what the importer does
 * with a key once it has one. The pairing suite is where the real normaliser's vocabulary is exercised.
 */

const PEPPER: SuppressionPepper = {
  secret: 'h-mig-05-unit-test-pepper-not-a-secret',
  version: 'u1',
}

/**
 * A stub normaliser: `+971` plus the digits, or a refusal for a cell with no digits at all.
 *
 * Deliberately NOT an identity function. An identity normaliser would key every spelling of one number
 * separately, which is the defect `stageVisitCell` has no fallback for — so a stub that normalises
 * nothing would make these tests pass over the arrangement the real one exists to prevent.
 */
const normalise: ContactNormaliser = (raw) => {
  const digits = raw.replace(/\D/g, '')
  return digits.length === 0
    ? { ok: false, reason: 'no_digits' }
    : { ok: true, e164: `+971${digits.slice(-9)}`, messageable: true }
}

const OPTIONS: VisitsImporterOptions = { pepper: PEPPER, normalise }

const CELL: VisitCell = {
  lineNumber: 2,
  phoneAsListed: '059 000 0042',
  startedAt: '2026-06-02T22:30:00+04:00',
  finishedAt: '2026-06-02T23:30:00+04:00',
  durationMinutes: '60',
  serviceSlug: 'relax-massage',
  therapistStaffReference: 'THP-0001',
  roomCode: 'R1',
  outcome: 'completed',
  grossChargedFils: '25000',
}

const cell = (overrides: Partial<VisitCell>): VisitCell => ({ ...CELL, ...overrides })
const payloadOf = (overrides: Partial<VisitCell>): Record<string, unknown> => ({
  ...stageVisitCell(OPTIONS, cell(overrides)).payload,
})

describe('the visit-history workbook', () => {
  it('states its columns once: the header is derived and the parser demands exactly it', () => {
    expect(VISIT_HEADER).toBe(VISIT_COLUMNS.map((column) => column.name).join('\t'))
    const generated = buildVisitWorkbook()
    expect(generated).toContain(VISIT_HEADER)
    // The control: a header with one column renamed must be refused, not parsed into the wrong cells.
    // Anchored on the HEADER LINE and not on the column name, which also appears in the preamble — the
    // first spelling of this case replaced the comment and the parse then succeeded, which is brief
    // rule 20's hazard reached inside a test rather than inside a gate.
    const broken = generated.replace(VISIT_HEADER, VISIT_HEADER.replace('room_code', 'room'))
    expect(() => parseVisitWorkbook(`${broken}${CELL.phoneAsListed}\n`)).toThrow(
      /not the generated one/,
    )
  })

  it('is the same bytes every time, because a source file is identified by its hash', () => {
    expect(buildVisitWorkbook()).toBe(buildVisitWorkbook())
  })

  it('names no person, no therapist and no price in its instructions', () => {
    const text = buildVisitWorkbook()
    /*
      Brief rule 15 and ADR 0020. The illustration in the phone column IS on `+971`, exactly as the
      contact list's is and for the same reason: a person has to be shown that the three spellings reach
      one record. What makes it safe is the PREFIX — `59` is not an allocated UAE mobile prefix, so the
      example cannot ring anybody (`packages/fixtures/src/synthetic.ts` gives every fixture number the
      same guarantee). So the claim asserted here is the one that matters, which is that no ALLOCATED
      prefix appears; an earlier spelling of this case banned `+971` outright and failed against a file
      that was correct.
    */
    for (const prefix of ['50', '52', '54', '55', '56', '58']) {
      expect(text).not.toContain(`+971${prefix}`)
      expect(text).not.toContain(`+971 ${prefix}`)
    }
    expect(text).toContain('staff reference')
    expect(text).toContain('Not their name')
  })

  it('drops comments and blanks and reads the cells as typed', () => {
    const file = [
      buildVisitWorkbook(),
      '# a spreadsheet spacer follows',
      '',
      [
        CELL.phoneAsListed,
        CELL.startedAt,
        CELL.finishedAt,
        CELL.durationMinutes,
        CELL.serviceSlug,
        CELL.therapistStaffReference,
        CELL.roomCode,
        'COMPLETED',
        CELL.grossChargedFils,
      ].join('\t'),
      '',
    ].join('\n')
    const cells = parseVisitWorkbook(file)
    expect(cells).toHaveLength(1)
    // Lower-cased, because a spreadsheet will offer to capitalise a word; and the line number is the
    // line in the FILE, which is the number a person opens the spreadsheet at.
    expect(cells[0]?.outcome).toBe('completed')
    expect(cells[0]?.lineNumber).toBe(file.split('\n').indexOf(file.split('\n').at(-2) ?? '') + 1)
  })

  it('refuses a file nobody filled in rather than importing nothing', () => {
    expect(() => parseVisitWorkbook('# only comments\n\n')).toThrow(/no header row/)
  })

  it('admits exactly the four finished labels', () => {
    expect([...VISIT_OUTCOMES]).toEqual([
      'completed',
      'no_show',
      'cancelled_by_customer',
      'cancelled_by_salon',
    ])
    // `rescheduled` is terminal in the lifecycle and is absent here on purpose: it means a successor row
    // exists, and a reconstruction has none to point at.
    expect(VISIT_OUTCOMES).not.toContain('rescheduled')
  })
})

describe('the staged payload', () => {
  it('carries the minimised keys and no number', () => {
    const payload = payloadOf({})
    expect(Object.keys(payload).sort()).toEqual([...MINIMISED_VISIT_PAYLOAD_KEYS].sort())
    // The claim ADR 0072 is about: no digit of the source number may be anywhere in the payload.
    const serialised = JSON.stringify(payload)
    expect(serialised).not.toContain('0000042')
    expect(serialised).not.toContain('590000042')
  })

  it('keys a number under the same digest the contact importer wrote', () => {
    // Recomputed here from the primitive rather than taken from the importer, so this asserts the KIND
    // and the JSON encoding rather than asserting that the function equals itself.
    const expected = createHmac('sha256', PEPPER.secret)
      .update(`import_contact_phone\u001f${JSON.stringify('+971590000042')}`)
      .digest('hex')
    expect(payloadOf({})['contactHmac']).toBe(expected)
  })

  it('keys an unreadable cell under the OTHER kind, so it cannot collide with a number', () => {
    const readable = stageVisitCell(OPTIONS, cell({ phoneAsListed: '590000042' }))
    const unreadable = stageVisitCell(OPTIONS, cell({ phoneAsListed: 'no number recorded' }))
    expect(unreadable.e164).toBeNull()
    expect(unreadable.payload.contactHmac).not.toBe(readable.payload.contactHmac)
  })
})

describe('every named rejection', () => {
  /**
   * One payload per reason, producing exactly it (ADR 0003 and ADR 0065).
   *
   * Iterating the PAIR rather than asserting "the row failed": a typo in a key name satisfies "something
   * was refused" and satisfies it for ever.
   */
  const cases: readonly [string, Record<string, unknown>][] = [
    [VISIT_REJECTIONS.payloadNotMinimised, { ...payloadOf({}), customerPhone: '+971590000042' }],
    [VISIT_REJECTIONS.digestNotKeyed, { ...payloadOf({}), contactHmac: 'not-a-digest' }],
    [VISIT_REJECTIONS.pepperVersionMissing, { ...payloadOf({}), pepperVersion: '  ' }],
    // No offset: `Date.parse` would read it as local time, so the trading date would depend on `TZ`.
    [VISIT_REJECTIONS.startedAtNotAnInstant, payloadOf({ startedAt: '2026-06-02T22:30:00' })],
    [VISIT_REJECTIONS.finishedAtNotAnInstant, payloadOf({ finishedAt: '2026-06-02' })],
    [
      VISIT_REJECTIONS.finishedAtNotAfterStartedAt,
      payloadOf({ finishedAt: '2026-06-02T22:30:00+04:00' }),
    ],
    [VISIT_REJECTIONS.durationNotWholeMinutes, payloadOf({ durationMinutes: '' })],
    // `Number('60.0')` is 60 — an integer, positive, and equal to the period — so a cell written with a
    // decimal point passes every one of those checks. `wholeOrNaN` is what refuses it, and this case is
    // what proves `wholeOrNaN` is doing the refusing rather than the integer check.
    [VISIT_REJECTIONS.durationNotWholeMinutes, payloadOf({ durationMinutes: '60.0' })],
    [VISIT_REJECTIONS.durationDisagreesWithThePeriod, payloadOf({ durationMinutes: '90' })],
    [VISIT_REJECTIONS.serviceSlugMissing, payloadOf({ serviceSlug: '' })],
    [VISIT_REJECTIONS.therapistReferenceMissing, payloadOf({ therapistStaffReference: '' })],
    [VISIT_REJECTIONS.roomCodeMissing, payloadOf({ roomCode: '' })],
    [VISIT_REJECTIONS.outcomeNotAFinishedVisit, payloadOf({ outcome: 'confirmed' })],
    [VISIT_REJECTIONS.grossNotIntegerFils, payloadOf({ grossChargedFils: '250.00' })],
    [VISIT_REJECTIONS.grossNotPositive, payloadOf({ grossChargedFils: '0' })],
  ]

  for (const [reason, payload] of cases) {
    it(`produces ${reason}`, () => {
      const verdict = validateStagedVisit(payload)
      expect(verdict.ok).toBe(false)
      expect(verdict.ok ? '' : verdict.reason).toBe(reason)
    })
  }

  it('accepts the well-formed payload the cases above are built from', () => {
    // The control. Every case above is satisfied by a FAILURE, so one has to be satisfied by a pass, or
    // a `validateStagedVisit` that refused everything would make all fourteen green.
    expect(validateStagedVisit(payloadOf({}))).toEqual({ ok: true })
  })

  it('leaves no reason unreachable and invents none', () => {
    const reached = new Set(cases.map(([reason]) => reason))
    // `therapistOverlapsAnotherLine` is the one reason no single payload can produce: it is a claim about
    // the FILE, so it is reached through the importer's own `validate` below.
    reached.add(VISIT_REJECTIONS.therapistOverlapsAnotherLine)
    expect([...reached].sort()).toEqual([...VISIT_REJECTION_REASONS].sort())
  })
})

describe('the file-scoped claim', () => {
  const second = (overrides: Partial<VisitCell>): VisitCell => cell({ lineNumber: 3, ...overrides })

  it('names BOTH lines of a therapist overlap', () => {
    const clashes = therapistClashes([
      CELL,
      second({ startedAt: '2026-06-02T23:00:00+04:00', finishedAt: '2026-06-03T00:00:00+04:00' }),
    ])
    expect(clashes).toEqual([2, 3])
  })

  it('leaves adjacent periods alone, because the constraint it mirrors compares bare periods', () => {
    // `[22:30, 23:30)` and `[23:30, 00:30)` do not overlap. A padded comparison would refuse this file
    // and the database would have accepted it — the asymmetry the plan must not introduce.
    expect(
      therapistClashes([
        CELL,
        second({ startedAt: '2026-06-02T23:30:00+04:00', finishedAt: '2026-06-03T00:30:00+04:00' }),
      ]),
    ).toEqual([])
  })

  it('leaves two therapists in the same period alone', () => {
    expect(therapistClashes([CELL, second({ therapistStaffReference: 'THP-0002' })])).toEqual([])
  })

  it('reaches the importer, which has no line number to match on', () => {
    const clashing = second({
      startedAt: '2026-06-02T23:00:00+04:00',
      finishedAt: '2026-06-03T00:00:00+04:00',
    })
    const file = [
      buildVisitWorkbook(),
      ...[CELL, clashing].map((row) =>
        [
          row.phoneAsListed,
          row.startedAt,
          row.finishedAt,
          row.durationMinutes,
          row.serviceSlug,
          row.therapistStaffReference,
          row.roomCode,
          row.outcome,
          row.grossChargedFils,
        ].join('\t'),
      ),
      '',
    ].join('\n')
    const importer = visitsImporter(OPTIONS)
    const rows = importer.parse(file)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      const verdict = importer.validate(row.payload)
      expect(verdict.ok ? '' : verdict.reason).toBe(VISIT_REJECTIONS.therapistOverlapsAnotherLine)
    }
  })

  it('does not refuse a clean file, which is the control for the case above', () => {
    const importer = visitsImporter(OPTIONS)
    const file = [
      buildVisitWorkbook(),
      [
        CELL.phoneAsListed,
        CELL.startedAt,
        CELL.finishedAt,
        CELL.durationMinutes,
        CELL.serviceSlug,
        CELL.therapistStaffReference,
        CELL.roomCode,
        CELL.outcome,
        CELL.grossChargedFils,
      ].join('\t'),
      '',
    ].join('\n')
    const rows = importer.parse(file)
    expect(rows.map((row) => importer.validate(row.payload))).toEqual([{ ok: true }])
  })

  it('keys a clash by the four values that identify a line', () => {
    const staged = { ...stageVisitCell(OPTIONS, CELL).payload }
    const key = visitClashKey(staged)
    // The room is not one of the four, because two lines differing only in their room still put one
    // therapist in two places; the therapist is, because two therapists in one period is not a clash.
    expect(visitClashKey({ ...staged, roomCode: 'other' })).toBe(key)
    expect(visitClashKey({ ...staged, therapistStaffReference: 'another' })).not.toBe(key)
  })
})

describe('the importer', () => {
  it('declares every table it writes, so provenance is not refused by ZY194', () => {
    expect([...visitsImporter(OPTIONS).targetTables]).toEqual([
      'public.imported_appointment',
      'public.booking',
      'public.appointment',
    ])
  })

  it('refuses to apply a row before it has parsed a file', async () => {
    const importer = visitsImporter(OPTIONS)
    await expect(importer.apply(null as never, payloadOf({}))).rejects.toThrow(
      /before it had parsed a file/,
    )
  })

  it('refuses to be built without a normaliser, rather than keying every spelling separately', () => {
    expect(() =>
      planVisitImport({ pepper: PEPPER, normalise: undefined as never }, [CELL]),
    ).toThrow(/No phone normaliser was injected/)
  })

  it('replaces its plan on a second parse, so two files cannot resolve through each other', () => {
    const importer = visitsImporter(OPTIONS)
    const fileFor = (phone: string): string =>
      [
        buildVisitWorkbook(),
        [
          phone,
          CELL.startedAt,
          CELL.finishedAt,
          CELL.durationMinutes,
          CELL.serviceSlug,
          CELL.therapistStaffReference,
          CELL.roomCode,
          CELL.outcome,
          CELL.grossChargedFils,
        ].join('\t'),
        '',
      ].join('\n')
    const first = importer.parse(fileFor('059 000 0042'))
    const secondParse = importer.parse(fileFor('059 000 0043'))
    expect(first[0]?.payload['contactHmac']).not.toBe(secondParse[0]?.payload['contactHmac'])
  })
})
