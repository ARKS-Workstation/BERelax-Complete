import type { SuppressionPepper } from '@berelax/db'
import { IMPORT_CONTACT_KEY_KINDS, importContactHmac } from '@berelax/db'
import { describe, expect, it } from 'vitest'
import { MINIMISED_PAYLOAD_KEYS, planContactImport, stageContactCell } from './dedup.ts'
import {
  CONTACT_REJECTION_REASONS,
  CONTACT_REJECTIONS,
  CUSTOMERS_IMPORTER_TARGETS,
  customersImporter,
  planContactList,
  validateStagedContact,
} from './import.ts'
import {
  buildContactWorkbook,
  CONSENT_CLAIM_VALUES,
  CONTACT_COLUMNS,
  CONTACT_HEADER,
  parseContactWorkbook,
} from './workbook.ts'

/**
 * The customer importer, with nothing running: the workbook, the minimised payload, and the five
 * rejections.
 *
 * Everything here is pure. What a run DOES — a customer row, a quarantine record, zero consent rows, the
 * refusals the database raises — is `packages/fixtures/src/customer-import.itest.ts`'s, because every one
 * of those claims is a claim about PostgreSQL and a mock cannot produce a COMMIT (H-MIG-01's reason for
 * this package being outside the coverage floor).
 *
 * The case that carries the unit is `the staged payload holds no digit of the source`. It is the whole of
 * this unit's answer to `Y9-import-ledger` as an assertion rather than a decision: the ledger keeps
 * `import_row.payload` for ever, with no DELETE grant anywhere in `import_staging` and `jsonb` invisible
 * to all five of C-CRM-10's catalogue probes, so a number in there is unreachable rather than retained.
 */

/**
 * A pepper for the pure tests. Not a secret and not read from anywhere: these cases assert that the digest
 * is a digest and that the same input keys the same way, neither of which depends on the value.
 *
 * Long enough to satisfy `MIN_SUPPRESSION_PEPPER_LENGTH` had it been loaded through
 * `loadSuppressionPeppers`, so nobody reading it is misled about what a real one looks like.
 */
const PEPPER: SuppressionPepper = {
  version: 'unit-test',
  secret: 'unit-test-pepper-not-a-secret-0123456789abcdef',
}

/**
 * The normaliser, as the importer takes it: `e164IdentityResult`'s shape, implemented here.
 *
 * `packages/migration` may not import `@berelax/core`, so these cases cannot call the real one. That is a
 * boundary and not a gap: the real normaliser's own census lives in
 * `packages/core/src/identity/e164.test.ts`, and the agreement between THAT function and this importer is
 * asserted in `customer-import.itest.ts`, which may import both. What this stand-in has to be is faithful
 * about the two things the importer branches on — whether a cell was read, and what its canonical form is.
 */
const normalise = (
  raw: string,
):
  | { readonly ok: true; readonly e164: string; readonly messageable: boolean }
  | { readonly ok: false; readonly reason: string } => {
  const digits = raw.replace(/[\s()[\].\-–—/]/g, '')
  if (digits.length === 0) return { ok: false, reason: 'empty' }
  if (!/^(\+|00)?\d+$/.test(digits)) return { ok: false, reason: 'not_digits' }
  const bare = digits.replace(/^(\+|00)?971/, '').replace(/^0/, '')
  if (/^5\d{8}$/.test(bare)) return { ok: true, e164: `+971${bare}`, messageable: true }
  if (/^[234679]\d{7}$/.test(bare)) return { ok: true, e164: `+971${bare}`, messageable: false }
  return { ok: false, reason: 'wrong_length' }
}

const keying = { pepper: PEPPER, normalise }

/** A filled file, built from the generated blank so the header can never be written twice. */
const fileOf = (rows: readonly (readonly [string, string])[]): string =>
  `${buildContactWorkbook()}${rows.map((row) => row.join('\t')).join('\n')}\n`

describe('the contact list file', () => {
  it('generates the same bytes every time, because the file hash is its identity', () => {
    expect(buildContactWorkbook()).toBe(buildContactWorkbook())
    expect(buildContactWorkbook()).toContain(CONTACT_HEADER)
  })

  it('puts the consent sentence in the file, not in an email beside it', () => {
    const blank = buildContactWorkbook()
    // Short phrases, because the preamble is wrapped onto `#` lines at a readable width and a longer
    // match would be asserting where the wrap happens to fall.
    expect(blank).toContain('NO marketing consent')
    expect(blank).toContain('Transactional messages')
    expect(blank).toContain('quarantined with the reason')
    // Every column's hint travels with the file, from the one statement of the columns.
    for (const column of CONTACT_COLUMNS) expect(blank).toContain(column.name)
  })

  it('round-trips a filled copy of the generated file', () => {
    const cells = parseContactWorkbook(
      fileOf([
        ['052 510 8633', 'yes'],
        ['059 000 0042', ''],
      ]),
    )
    expect(cells).toEqual([
      // The line numbers are the lines of the FILE, which is what a person opens the spreadsheet at.
      { lineNumber: cells[0]?.lineNumber, phoneAsListed: '052 510 8633', sourceConsentClaim: true },
      {
        lineNumber: cells[1]?.lineNumber,
        phoneAsListed: '059 000 0042',
        sourceConsentClaim: false,
      },
    ])
    expect(cells[1]?.lineNumber).toBe((cells[0]?.lineNumber ?? 0) + 1)
  })

  it('refuses a header that is not the generated one, naming what moved', () => {
    expect(() => parseContactWorkbook('phone\tconsent\n+971590000001\tyes\n')).toThrow(
      /not the generated one/,
    )
    expect(() => parseContactWorkbook('# nothing but comments\n')).toThrow(/no header row/)
  })

  it('reads every spelling of a consent claim, because under-reading hides the evidence', () => {
    for (const value of CONSENT_CLAIM_VALUES) {
      const [cell] = parseContactWorkbook(fileOf([['059 000 0042', value.toUpperCase()]]))
      expect(cell?.sourceConsentClaim, `${value} read as a claim`).toBe(true)
    }
    const [none] = parseContactWorkbook(fileOf([['059 000 0042', 'no']]))
    expect(none?.sourceConsentClaim).toBe(false)
  })
})

describe('the staged payload', () => {
  it('holds no digit of the source, which is the whole of the Y9-import-ledger answer', () => {
    const numbers = ['052 510 8633', '+971590000042', '02 557 6533', 'not a number at all', '']
    const plan = planContactImport(
      keying,
      numbers.map((phoneAsListed, index) => ({
        lineNumber: index + 1,
        phoneAsListed,
        sourceConsentClaim: true,
      })),
    )
    const staged = JSON.stringify(plan.rows)
    for (const raw of numbers) {
      const digits = raw.replace(/\D/g, '')
      if (digits.length < 4) continue
      // Every run of four or more digits from the source, including the tail a person recognises.
      for (let at = 0; at + 4 <= digits.length; at += 1) {
        expect(
          staged,
          `${digits.slice(at, at + 4)} from "${raw}" reached the ledger`,
        ).not.toContain(digits.slice(at, at + 4))
      }
    }
    // The control: the plaintext DOES exist, in memory, or the case above would pass over a plan that
    // staged nothing at all.
    expect([...plan.plaintextByHmac.values()].sort()).toEqual(
      ['+971525108633', '+971590000042', '+97125576533'].sort(),
    )
  })

  it('carries exactly the minimised keys, and the reason only when the cell was not read', () => {
    const read = stageContactCell(keying, {
      lineNumber: 2,
      phoneAsListed: '052 510 8633',
      sourceConsentClaim: false,
    })
    expect(Object.keys(read.payload).sort()).toEqual([
      'contactHmac',
      'pepperVersion',
      'sourceConsentClaim',
    ])
    expect(read.e164).toBe('+971525108633')

    const unread = stageContactCell(keying, {
      lineNumber: 3,
      phoneAsListed: 'ask at the desk',
      sourceConsentClaim: false,
    })
    expect(Object.keys(unread.payload).sort()).toEqual([
      'contactHmac',
      'pepperVersion',
      'quarantineReason',
      'sourceConsentClaim',
    ])
    expect(unread.payload.quarantineReason).toBe('not_digits')
    expect(unread.e164).toBeNull()
    // Every key either kind produces is in the minimised set, which is what `validate` enforces.
    for (const key of [...Object.keys(read.payload), ...Object.keys(unread.payload)]) {
      expect(MINIMISED_PAYLOAD_KEYS as readonly string[]).toContain(key)
    }
  })

  it('keys a number and an unreadable cell under different kinds, so neither can be the other', () => {
    const number = stageContactCell(keying, {
      lineNumber: 1,
      phoneAsListed: '+971590000042',
      sourceConsentClaim: false,
    })
    expect(number.payload.contactHmac).toBe(
      importContactHmac(PEPPER, IMPORT_CONTACT_KEY_KINDS.number, '+971590000042'),
    )
    // The same STRING keyed as a cell is a different digest. Without the kind in the HMAC input, a cell
    // that happened to read like a number would key identically to the number.
    expect(number.payload.contactHmac).not.toBe(
      importContactHmac(PEPPER, IMPORT_CONTACT_KEY_KINDS.cell, '+971590000042'),
    )
  })

  it('keys a cell that could not be read, whatever is in it', () => {
    // `suppressionKey` refuses a value containing U+001F, which is its own separator, and a cell out of a
    // contact export may hold anything — so the HMAC input is the JSON encoding of the value. Without
    // that, this line throws and one odd cell stops a two-thousand-line import.
    const staged = stageContactCell(keying, {
      lineNumber: 1,
      phoneAsListed: `05\u001f0 510 8633`,
      sourceConsentClaim: false,
    })
    expect(staged.payload.contactHmac).toMatch(/^[a-f0-9]{64}$/)
    expect(staged.payload.quarantineReason).toBe('not_digits')
  })
})

describe('the plan', () => {
  it('counts the people the list is about, not the lines it has', () => {
    const plan = planContactList(
      keying,
      fileOf([
        ['052 510 8633', ''],
        ['0525108633', 'yes'],
        ['+971 52 510 8633', ''],
        ['059 000 0042', ''],
        ['02 557 6533', ''],
        ['ask at the desk', ''],
        // An empty phone cell with something in the claim column. Written that way deliberately: a line
        // whose every cell is empty is a BLANK LINE to the parser and is dropped with the spacers and the
        // trailing newline, so `empty` is only reachable when the row says something else — which is the
        // real shape of the mistake, a claim column filled in beside a number nobody copied.
        ['', 'yes'],
        ['+447700900123', ''],
      ]),
    )
    expect(plan.lines).toBe(8)
    // Three spellings of one number, one synthetic mobile, one landline.
    expect(plan.distinct).toBe(3)
    expect(plan.repeated).toBe(2)
    expect(plan.quarantined).toBe(3)
    expect(plan.quarantinedByReason).toEqual({ not_digits: 1, empty: 1, wrong_length: 1 })
    // The landline: a real customer nothing can send to. Imported, flagged in the plan, never stored.
    expect(plan.unmessageable).toBe(1)
    expect(plan.consentClaims).toBe(2)
    // Every line is staged, repeats included: the ledger must not disagree with the file.
    expect(plan.rows).toHaveLength(8)
  })

  it('declares the two tables it writes and nothing else', () => {
    expect(CUSTOMERS_IMPORTER_TARGETS).toEqual(['public.imported_contact', 'public.customer'])
    // `imported_contact` first because it is the row that always exists — including for a line that
    // created no customer, which is what makes a quarantine and a repeat expressible.
    expect(CUSTOMERS_IMPORTER_TARGETS[0]).toBe('public.imported_contact')
  })
})

describe('validate', () => {
  /**
   * One payload per reason, each producing exactly it.
   *
   * Written as data so the rule name sits beside the payload that must trip it. Asserting "the row was
   * refused" instead would be satisfied by a typo in a key name (ADR 0003) — and here it would also be
   * satisfied by the row being refused for the WRONG reason, which sends whoever is reading a report to
   * the wrong place.
   */
  const good = {
    contactHmac: 'a'.repeat(64),
    pepperVersion: 'fixture',
    sourceConsentClaim: true,
  }
  const cases: readonly { readonly reason: string; readonly payload: Record<string, unknown> }[] = [
    {
      reason: CONTACT_REJECTIONS.payloadNotMinimised,
      payload: { ...good, phoneAsListed: '+971590000042' },
    },
    {
      reason: CONTACT_REJECTIONS.digestNotKeyed,
      payload: { ...good, contactHmac: '+971590000042' },
    },
    { reason: CONTACT_REJECTIONS.pepperVersionMissing, payload: { ...good, pepperVersion: '  ' } },
    {
      reason: CONTACT_REJECTIONS.consentClaimNotBoolean,
      payload: { ...good, sourceConsentClaim: 'yes' },
    },
    {
      reason: CONTACT_REJECTIONS.quarantineReasonNotANamedReason,
      payload: { ...good, quarantineReason: 'The number looked wrong to me' },
    },
  ]

  for (const { reason, payload } of cases) {
    it(`refuses a payload by the name ${reason}`, () => {
      expect(validateStagedContact(payload)).toEqual({ ok: false, reason })
    })
  }

  it('accepts the payload every case above varies ONE key of', () => {
    // Without this, a validator that refused everything would pass all five cases above while examining
    // nothing — and the import would refuse every file.
    expect(validateStagedContact(good)).toEqual({ ok: true })
    expect(validateStagedContact({ ...good, quarantineReason: 'wrong_length' })).toEqual({
      ok: true,
    })
  })

  it('names every reason exactly once, and each is reachable', () => {
    expect(new Set(CONTACT_REJECTION_REASONS).size).toBe(CONTACT_REJECTION_REASONS.length)
    expect([...CONTACT_REJECTION_REASONS].sort()).toEqual(
      [...cases.map((entry) => entry.reason)].sort(),
    )
  })

  it('refuses the number in the payload under the name of the rule, not as a type error', () => {
    // The structural half of the Y9-import-ledger answer: a later change that staged the plaintext does
    // not quietly work, it refuses the whole file and says which rule it broke.
    for (const key of ['phoneAsListed', 'phone', 'e164', 'displayName', 'notes']) {
      expect(validateStagedContact({ ...good, [key]: 'anything' })).toEqual({
        ok: false,
        reason: CONTACT_REJECTIONS.payloadNotMinimised,
      })
    }
  })
})

describe('the importer', () => {
  it('cannot apply a row before it has parsed a file', async () => {
    const importer = customersImporter(keying)
    await expect(
      importer.apply({} as never, {
        contactHmac: 'b'.repeat(64),
        pepperVersion: 'fixture',
        sourceConsentClaim: false,
      }),
    ).rejects.toThrow(/before it had parsed a file/)
  })

  it('refuses a digest the parsed file does not hold rather than guessing a number', async () => {
    const importer = customersImporter(keying)
    importer.parse(fileOf([['059 000 0042', '']]))
    await expect(
      importer.apply({} as never, {
        contactHmac: 'c'.repeat(64),
        pepperVersion: 'fixture',
        sourceConsentClaim: false,
      }),
    ).rejects.toThrow(/cannot say which number it is about/)
  })

  it('starts a new plan for a new file, so one list cannot resolve through another', () => {
    const importer = customersImporter(keying)
    const first = importer.parse(fileOf([['059 000 0001', '']]))
    const second = importer.parse(fileOf([['059 000 0002', '']]))
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0]?.payload['contactHmac']).not.toBe(second[0]?.payload['contactHmac'])
  })

  it('refuses a digest from a file it has since re-parsed', async () => {
    /*
      The case above proves the two files key differently; this proves the PLAN was replaced, which is the
      claim that matters. A `parse` that kept the first plan would leave `apply` resolving a line of file B
      through file A's numbers — attaching a record to somebody else's number, which is the one thing this
      unit may not do — and it would pass every other case in this file.

      The unit of work is `{}`: if the refusal does NOT fire, `apply` goes on to insert a customer through
      it and throws about a missing property instead, so the assertion is on the refusal's own words rather
      than on "it threw".
    */
    const importer = customersImporter(keying)
    const first = importer.parse(fileOf([['059 000 0001', '']]))
    importer.parse(fileOf([['059 000 0002', '']]))
    const stale = first[0]?.payload
    expect(stale).toBeDefined()
    if (stale === undefined) return
    await expect(importer.apply({} as never, stale)).rejects.toThrow(
      /cannot say which number it is about/,
    )
  })

  it('exposes nothing that could grant a consent', () => {
    // The acceptance line says "the importer exposes no option to change this". The options are the
    // pepper and the normaliser, and there is no third — so the claim is about the shape of the call
    // rather than about the diligence of a caller.
    const importer = customersImporter(keying)
    expect(Object.keys(importer).sort()).toEqual([
      'apply',
      'name',
      'parse',
      'targetTables',
      'validate',
      'version',
    ])
  })
})
