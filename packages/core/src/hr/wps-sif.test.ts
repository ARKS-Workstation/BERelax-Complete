import { describe, expect, it } from 'vitest'
import {
  GENERIC_MOHRE_V1_CONTROL_FIELDS,
  GENERIC_MOHRE_V1_DETAIL_FIELDS,
  ibanChecksumValid,
  isE164,
  PLACEHOLDER_WPS_AGENT_ID,
  PLACEHOLDER_WPS_EMPLOYER_ID,
  renderWpsSif,
  validateWpsFile,
  WPS_REFUSALS,
  WPS_SIF_FORMATS,
  type WpsDetailRecord,
  type WpsFile,
  WpsFileRefused,
  type WpsRefusal,
} from './wps-sif.ts'

/**
 * P-HR-12 — the WPS file's validator, its known-bad fixtures, and the placeholders that fail it.
 *
 * ## Every fixture fails BY RULE NAME (ADR 0003)
 *
 * A test that asserted only "the validator refused" would pass while the file bounced off an unrelated rule
 * and the one under test had quietly stopped matching anything. So every case here names the rule it expects,
 * and {@link expectExactly} asserts the rule set EXACTLY rather than containment — which is the half that
 * catches a rule firing on a file it should not, and the half a `toContain` would miss.
 *
 * ## The IBANs here are structurally valid and belong to nobody
 *
 * `ibanChecksumValid` implements ISO 7064 mod-97-10, so a fixture has to satisfy real check digits. Every
 * IBAN in this file is built by {@link withCheckDigits} from a body of zeros and a serial — so the checksum
 * is genuine and the account number is visibly synthetic. A plausible-looking real account number would be a
 * bank identifier this build invented, which is brief rule 15's subject, and `AE07 0331 2345 6789 0123 456`
 * — the example that appears in every IBAN tutorial — is somebody's.
 *
 * The country code is `ZZ`, which ISO 3166 does not assign and never will: it is reserved for private use. So
 * no fixture here can be mistaken for a UAE account, and the validator's deliberate silence about
 * country-specific length (`Y8-wps`, the bank's own spec) is exercised rather than worked around.
 */

/** A structurally valid IBAN over a private-use country code, with genuine mod-97 check digits. */
function withCheckDigits(country: string, body: string): string {
  const expand = (text: string): string =>
    [...text]
      .map((character) => {
        const code = character.charCodeAt(0)
        return code >= 65 ? String(code - 55) : character
      })
      .join('')
  // ISO 13616: check digits are 98 minus the mod-97 of the rearranged string with '00' in their place.
  const rearranged = `${body}${country}00`
  let remainder = 0
  for (const digit of expand(rearranged)) remainder = (remainder * 10 + Number(digit)) % 97
  const check = String(98 - remainder).padStart(2, '0')
  return `${country}${check}${body}`
}

const IBAN_A = withCheckDigits('ZZ', '000000000000000001')
const IBAN_B = withCheckDigits('ZZ', '000000000000000002')
/** A body of DISTINCT digits, so a transposition fixture actually transposes something. */
const IBAN_C = withCheckDigits('ZZ', '123456789012345678')

const PHONE_A = '+971500000001'

/** The two identifiers, set. Not real ones: `Y8-wps` is open and these are the shape of an answer. */
const EMPLOYER_ID_SET = 'SET-BY-OWNER-1'
const AGENT_ID_SET = 'SET-BY-OWNER-2'

function record(over: Partial<WpsDetailRecord> = {}): WpsDetailRecord {
  return {
    employeeId: 'e-1',
    staffReference: 'Therapist 07',
    iban: IBAN_A,
    phone: PHONE_A,
    netFils: 750_000,
    payableMinutes: 10_560,
    ...over,
  }
}

/** A file that passes, which every fixture below breaks in exactly one way. */
function goodFile(over: Partial<WpsFile['header']> = {}, records = [record()]): WpsFile {
  return {
    header: {
      format: 'generic_mohre_v1',
      employerId: EMPLOYER_ID_SET,
      agentId: AGENT_ID_SET,
      periodStartsOn: '2026-03-01',
      periodEndsOn: '2026-03-31',
      declaredRecordCount: records.length,
      declaredTotalFils: records.reduce((total, row) => total + row.netFils, 0),
      ...over,
    },
    records,
  }
}

/** The rules a file is refused by, exactly — not merely including. */
function expectExactly(file: WpsFile, rules: readonly WpsRefusal[]): void {
  const failures = validateWpsFile(file)
  expect([...failures.map((failure) => failure.rule)].sort()).toEqual([...rules].sort())
}

describe('the file that passes, which is the control for every fixture below', () => {
  it('is refused by nothing once both identifiers are set', () => {
    expect(validateWpsFile(goodFile())).toEqual([])
  })

  it('renders a record per payslip plus a control record, and a trailing newline', () => {
    const content = renderWpsSif(
      goodFile({}, [record(), record({ employeeId: 'e-2', iban: IBAN_B, phone: '+971500000002' })]),
    )
    const lines = content.split('\n')
    // Three comment lines, two EDR, one SCR, and the empty string after the trailing newline.
    expect(lines.filter((line) => line.startsWith('EDR,'))).toHaveLength(2)
    expect(lines.filter((line) => line.startsWith('SCR,'))).toHaveLength(1)
    expect(content.endsWith('\n')).toBe(true)
  })

  it('says on its face that the layout is provisional, in the bytes', () => {
    // A marker in the ARTEFACT and not only in a flag, for the reason the seeded consent wording carries
    // `[DRAFT WORDING]` in its text: a plausible artefact is indistinguishable from an approved one, and the
    // person reading a bank's rejection needs to know the layout was this build's guess.
    const content = renderWpsSif(goodFile())
    expect(content.split('\n')[0]).toContain('provisional=Y8-wps')
    expect(content).toContain('format=generic_mohre_v1')
  })

  it('states the amount column as fils, so nothing can read it as dirhams', () => {
    expect(GENERIC_MOHRE_V1_DETAIL_FIELDS).toContain('net_amount_fils')
    expect(GENERIC_MOHRE_V1_CONTROL_FIELDS).toContain('total_amount_fils')
    const content = renderWpsSif(goodFile())
    expect(content).toContain('net_amount_fils')
    // The control: a figure printed in dirhams would be 7500 for a 750,000-fils net, and must not appear.
    const edr = content.split('\n').find((line) => line.startsWith('EDR,')) ?? ''
    expect(edr).toContain('750000')
    expect(edr.split(',')).not.toContain('7500')
  })
})

describe('the known-bad fixtures, each refused by the rule written for it (ADR 0003)', () => {
  it('missing employer id — the DEFAULT state of this build', () => {
    expectExactly(goodFile({ employerId: PLACEHOLDER_WPS_EMPLOYER_ID }), [
      'wps_employer_id_not_configured',
    ])
    // And a blank one, which is the other way nobody has answered.
    expectExactly(goodFile({ employerId: '   ' }), ['wps_employer_id_not_configured'])
  })

  it('missing agent id', () => {
    expectExactly(goodFile({ agentId: PLACEHOLDER_WPS_AGENT_ID }), ['wps_agent_id_not_configured'])
  })

  it('record-count mismatch, between the RUN’s claim and the rows', () => {
    expectExactly(goodFile({ declaredRecordCount: 2 }), ['wps_record_count_disagrees'])
  })

  it('total mismatch, in integer fils', () => {
    expectExactly(goodFile({ declaredTotalFils: 750_001 }), ['wps_total_disagrees'])
  })

  it('malformed IBAN — bad check digits, bad structure, and empty', () => {
    // Bad CHECK DIGITS on an otherwise well-formed IBAN. This is the fixture that proves mod-97 is actually
    // running: a validator that only checked the structure would accept it.
    const wrongCheck = `ZZ00${IBAN_A.slice(4)}`
    expect(wrongCheck).toHaveLength(IBAN_A.length)
    expectExactly(goodFile({}, [record({ iban: wrongCheck })]), ['wps_iban_malformed'])
    // Bad structure: too short for ISO 13616's 15-character floor.
    expectExactly(goodFile({}, [record({ iban: 'ZZ12345' })]), ['wps_iban_malformed'])
    // Absent, which is what an employee with no bank account on file produces.
    expectExactly(goodFile({}, [record({ iban: '' })]), ['wps_iban_malformed'])
  })

  it('non-E.164 phone — a local format, and the ABSENCE this build actually has', () => {
    expectExactly(goodFile({}, [record({ phone: '0501234567' })]), ['wps_phone_not_e164'])
    expectExactly(goodFile({}, [record({ phone: '+0501234567' })]), ['wps_phone_not_e164'])
    // Null: there is no phone column on `employee` at all, and the detail says so rather than a number
    // being invented to fill the field.
    const failures = validateWpsFile(goodFile({}, [record({ phone: null })]))
    expect(failures.map((failure) => failure.rule)).toEqual(['wps_phone_not_e164'])
    expect(failures[0]?.detail).toContain('no column on `employee`')
    expect(failures[0]?.detail).toContain('Y8-staff')
  })

  it('names the employee on a per-record refusal and not on a header one', () => {
    // Without this a screen listing four bad IBANs could not say whose, and the operator would have to open
    // every payslip to find out.
    const perRecord = validateWpsFile(goodFile({}, [record({ employeeId: 'e-9', iban: 'nope' })]))
    expect(perRecord[0]?.employeeId).toBe('e-9')
    const header = validateWpsFile(goodFile({ declaredTotalFils: 1 }))
    expect(header[0]?.employeeId).toBeNull()
  })

  it('reports EVERY refusal in one pass rather than stopping at the first', () => {
    // A clerk with four bad IBANs wants all four, not one per attempt. Four rules at once here.
    const file = goodFile({ employerId: PLACEHOLDER_WPS_EMPLOYER_ID, declaredTotalFils: 5 }, [
      record({ iban: 'nope', phone: 'nope' }),
    ])
    expectExactly(file, [
      'wps_employer_id_not_configured',
      'wps_total_disagrees',
      'wps_iban_malformed',
      'wps_phone_not_e164',
    ])
  })

  it('every declared refusal is reachable, so none of them is a rule nothing fires', () => {
    /*
      The direction ADR 0002 is about, applied to the refusal vocabulary rather than to a gate: a rule name in
      `WPS_REFUSALS` that no fixture above can produce is a rule that may not work at all. Collected from the
      cases rather than asserted as a count, so adding a rule without a fixture fails here.
    */
    const produced = new Set<string>()
    for (const file of [
      goodFile({ employerId: PLACEHOLDER_WPS_EMPLOYER_ID }),
      goodFile({ agentId: PLACEHOLDER_WPS_AGENT_ID }),
      goodFile({ declaredRecordCount: 9 }),
      goodFile({ declaredTotalFils: 9 }),
      goodFile({}, [record({ iban: 'nope' })]),
      goodFile({}, [record({ phone: null })]),
    ]) {
      for (const failure of validateWpsFile(file)) produced.add(failure.rule)
    }
    expect([...produced].sort()).toEqual([...WPS_REFUSALS].sort())
  })
})

describe('no bytes are produced for a file that fails', () => {
  it('throws WpsFileRefused carrying every rule, and returns nothing', () => {
    let thrown: unknown
    try {
      renderWpsSif(goodFile({ employerId: PLACEHOLDER_WPS_EMPLOYER_ID }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WpsFileRefused)
    expect((thrown as WpsFileRefused).failures.map((failure) => failure.rule)).toEqual([
      'wps_employer_id_not_configured',
    ])
    expect((thrown as WpsFileRefused).details['rules']).toEqual(['wps_employer_id_not_configured'])
  })

  it('the DEFAULT identifiers refuse the file twice over, which is the state this build ships in', () => {
    // Brief rule 15's whole subject in one assertion: the placeholders say what they are AND fail the
    // validator, so a file cannot be produced until somebody sets them.
    expectExactly(
      goodFile({ employerId: PLACEHOLDER_WPS_EMPLOYER_ID, agentId: PLACEHOLDER_WPS_AGENT_ID }),
      ['wps_employer_id_not_configured', 'wps_agent_id_not_configured'],
    )
    expect(PLACEHOLDER_WPS_EMPLOYER_ID).toMatch(/PENDING-Y8-WPS/)
    expect(PLACEHOLDER_WPS_EMPLOYER_ID).not.toMatch(/^\d+$/)
    expect(PLACEHOLDER_WPS_AGENT_ID).toMatch(/PENDING-Y8-WPS/)
    expect(PLACEHOLDER_WPS_AGENT_ID).not.toMatch(/^\d+$/)
  })

  it('refuses a layout nobody implemented rather than writing it in the one that exists', () => {
    const file = goodFile()
    const wrong: WpsFile = {
      ...file,
      header: { ...file.header, format: 'bank_specific_v2' as never },
    }
    expect(() => renderWpsSif(wrong)).toThrow(/is not a WPS layout this build can write/)
    expect(WPS_SIF_FORMATS).toEqual(['generic_mohre_v1'])
  })
})

describe('the two published standards this validator leans on', () => {
  it('accepts a correct IBAN and rejects one digit changed, in both directions', () => {
    expect(ibanChecksumValid(IBAN_A)).toBe(true)
    expect(ibanChecksumValid(IBAN_B)).toBe(true)
    // One digit of the ACCOUNT changed, check digits untouched: this is what mod-97 exists to catch and what
    // a length-and-charset check would pass.
    const mutated = `${IBAN_A.slice(0, -1)}${IBAN_A.endsWith('9') ? '8' : '9'}`
    expect(mutated).not.toBe(IBAN_A)
    expect(ibanChecksumValid(mutated)).toBe(false)
    /*
      Two digits TRANSPOSED, which mod-97 catches and a digit-sum check would not.

      Over IBAN_C and not IBAN_A, and that correction is worth keeping: the first version of this case
      transposed two characters of IBAN_A, whose body is zeros, so it produced the SAME string and asserted
      that a valid IBAN was invalid. A transposition fixture needs two DIFFERENT digits to transpose, and a
      fixture that changes nothing is a control that controls nothing.
    */
    const transposed =
      IBAN_C.slice(0, 4) + IBAN_C.slice(5, 6) + IBAN_C.slice(4, 5) + IBAN_C.slice(6)
    expect(transposed).not.toBe(IBAN_C)
    expect(ibanChecksumValid(IBAN_C)).toBe(true)
    expect(ibanChecksumValid(transposed)).toBe(false)
  })

  it('tolerates the spacing a human types and normalises case', () => {
    const spaced = IBAN_A.replace(/(.{4})/g, '$1 ').trim()
    expect(spaced).not.toBe(IBAN_A)
    expect(ibanChecksumValid(spaced)).toBe(true)
    expect(ibanChecksumValid(IBAN_A.toLowerCase())).toBe(true)
    // And the rendered record carries the compact upper-case form, not what was typed.
    const content = renderWpsSif(goodFile({}, [record({ iban: spaced })]))
    expect(content).toContain(IBAN_A)
    expect(content).not.toContain(spaced)
  })

  it('asserts no country-specific length, which is deliberately the bank’s to state', () => {
    // ISO 13616 allows 15 to 34. A 20-character and a 30-character IBAN both pass, because asserting a UAE
    // length would be this build stating a banking fact nobody has confirmed to it (Y8-wps) — and a correct
    // account refused by an invented length is a therapist not paid.
    const short = withCheckDigits('ZZ', '00000000000001')
    const long = withCheckDigits('ZZ', '0000000000000000000000000001')
    expect(short).toHaveLength(18)
    expect(long).toHaveLength(32)
    expect(ibanChecksumValid(short)).toBe(true)
    expect(ibanChecksumValid(long)).toBe(true)
    /*
      The control: the ISO bounds are real, so the silence above is about the COUNTRY length and not about
      there being no length rule at all.

      13 characters is below ISO 13616's 15-character floor, and it is refused although its check digits are
      genuine — which is the distinction worth having. The first version of this line expected `true` and was
      simply wrong about the standard.
    */
    const belowFloor = withCheckDigits('ZZ', '000000000')
    expect(belowFloor).toHaveLength(13)
    expect(ibanChecksumValid(belowFloor)).toBe(false)
    expect(ibanChecksumValid('ZZ1200000000')).toBe(false)
  })

  it('applies E.164 as the ITU states it', () => {
    expect(isE164('+971500000001')).toBe(true)
    expect(isE164('+12')).toBe(true)
    expect(isE164('+123456789012345')).toBe(true)
    // Sixteen digits is one too many; a leading zero after the plus is not a country code; no plus at all.
    expect(isE164('+1234567890123456')).toBe(false)
    expect(isE164('+0123456789')).toBe(false)
    expect(isE164('971500000001')).toBe(false)
    expect(isE164('+971 50 000 0001')).toBe(false)
    expect(isE164(null)).toBe(false)
  })
})
