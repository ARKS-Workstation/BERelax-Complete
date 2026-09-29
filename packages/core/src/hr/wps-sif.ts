import { AppError } from '@berelax/shared'

/**
 * The Wage Protection System salary file: a format adapter, a validator, and deliberately no way to send it.
 *
 * ## What this build has been told about WPS, which is one sentence
 *
 * `docs/04-uae-compliance.md` §7 says: *"**Wage Protection System** salary file, in the format the bank
 * requires."* That is the whole of it. There is no bank named, no agent code, no establishment id, no
 * record layout and no field spec anywhere in the eleven handover documents. So this module is built around
 * an absence, and the absence is `Y8-wps` in `docs/OPEN-QUESTIONS.md`.
 *
 * ## Brief rule 15, and why a plausible employer id is the worst thing in this file
 *
 * A WPS file identifies the EMPLOYER — an establishment or MOL id — and the bank or exchange house acting
 * as agent. Those are registration numbers issued to this business, and this build has never seen them.
 * Inventing one would produce a file that is structurally perfect, passes every check, looks exactly like a
 * configured one, and pays nineteen people against somebody else's registration. A blank field is visibly
 * unanswered; thirteen plausible digits are indistinguishable from the truth.
 *
 * So the defaults are {@link PLACEHOLDER_WPS_EMPLOYER_ID} and {@link PLACEHOLDER_WPS_AGENT_ID}, and they
 * are chosen to fail validation TWICE over, exactly as `PLACEHOLDER_TRN` is: each says what it is in words,
 * and neither is a run of digits. {@link validateWpsFile} refuses either by name, so a file cannot be
 * produced until somebody sets them — and the refusal names `Y8-wps` so a reader knows what to go and ask.
 *
 * ## What the validator checks, and what it deliberately does not
 *
 * The layout is PROVISIONAL and the validator does not pretend otherwise. Every rule it enforces is either
 * arithmetic that is true of any wage file, or a published standard with a published algorithm:
 *
 *   - **`wps_employer_id_not_configured` / `wps_agent_id_not_configured`** — the identifiers are unset or
 *     still carry a placeholder marker. No format is asserted, because none is known.
 *   - **`wps_record_count_disagrees`** — the header's declared record count is not the number of detail
 *     records. Arithmetic, and the first thing a receiving bank rejects a file for.
 *   - **`wps_total_disagrees`** — the header's declared total is not the sum of the detail amounts.
 *     Arithmetic, in integer fils (ADR 0007).
 *   - **`wps_iban_malformed`** — the IBAN fails ISO 13616's structure or its ISO 7064 mod-97-10 check
 *     digits. A published algorithm over a published registry, not a claim about this business.
 *   - **`wps_phone_not_e164`** — the phone is not ITU-T E.164: `+`, a non-zero leading digit, and at most
 *     fifteen digits in all.
 *
 * **The country-specific IBAN length is deliberately NOT asserted.** ISO 13616 allows 15 to 34 characters
 * and each country registers its own length; asserting one for `AE` would be this build stating a fact
 * about UAE banking that nobody has confirmed to it, and a correct account refused by an invented length is
 * a therapist not paid. The bank's own format specification states it, and that specification is `Y8-wps`.
 *
 * ## There is no submit path, and that is a deliverable
 *
 * This module returns a STRING. There is no HTTP call, no bank SDK, no endpoint and no URL anywhere in the
 * repository — absent, not disabled, for the reason docs/04 §4 gives about VAT201's auto-file capability:
 * *"a future maintainer will eventually switch a flag on"*. Filing a wage file against an invented
 * establishment id would be an offence rather than a bug, and the only structural defence is that the code
 * to do it does not exist. `packages/fixtures/src/wps-no-submission.test.ts` is the scan that keeps it
 * absent, and gate block 132 plants a fixture to prove the scan fires.
 *
 * Pure: strings and integers in, a string out. No clock, no I/O, no `process`.
 */

/**
 * The layouts this build can write. One member, and it is provisional.
 *
 * A closed set with a single member rather than a boolean or an absent concept, for
 * `attendance_grace_rule.capture_method`'s recorded reason: the day the bank's real spec arrives it is a
 * NEW member and a new format, and every file already written keeps saying which layout produced it. A
 * single implementation with no name would make the day the layout changes indistinguishable from the day
 * before it.
 */
export const WPS_SIF_FORMATS = ['generic_mohre_v1'] as const

export type WpsSifFormat = (typeof WPS_SIF_FORMATS)[number]

/*
  The two placeholders are `@berelax/shared`'s and are RE-EXPORTED here rather than defined.

  `packages/config` declares the settings whose defaults they are and may import `@berelax/shared` alone, so
  a string defined in this module would have to be re-spelled in the registry — and a placeholder the
  validator no longer recognises reads as CONFIGURED, which is `PLACEHOLDER_TRN`'s own recorded lesson. See
  `packages/shared/src/wps.ts` for what they are and why the default is a marker rather than a blank.
*/
export { PLACEHOLDER_WPS_AGENT_ID, PLACEHOLDER_WPS_EMPLOYER_ID } from '@berelax/shared'

/**
 * Every way a WPS file can be refused, as names.
 *
 * ADR 0003: a gate case asserts that a known-bad fixture was rejected BY THE RULE WRITTEN FOR IT. A test
 * that asserted only "the validator refused" would pass while the file bounced off an unrelated rule and
 * the one under test had quietly stopped matching anything.
 */
export const WPS_REFUSALS = [
  'wps_employer_id_not_configured',
  'wps_agent_id_not_configured',
  'wps_record_count_disagrees',
  'wps_total_disagrees',
  'wps_iban_malformed',
  'wps_phone_not_e164',
] as const

export type WpsRefusal = (typeof WPS_REFUSALS)[number]

/** One refusal, with enough context to act on it. */
export interface WpsValidationFailure {
  readonly rule: WpsRefusal
  /** The detail record the refusal is about, or null for a header rule. */
  readonly employeeId: string | null
  readonly detail: string
}

/** One employee's line of the file. Every figure comes off a completed payslip. */
export interface WpsDetailRecord {
  readonly employeeId: string
  /**
   * The internal handle, never a person's name.
   *
   * A real WPS file carries a person's name as registered on their work permit, and this build has none:
   * nineteen employees have `display_name` null (`Y12-names`, brief rule 10), and the name on a permit is
   * a third thing again. `staff_reference` is what the build honestly holds, and `Y8-wps` records that the
   * permit name is part of what answering it must supply.
   */
  readonly staffReference: string
  /** The account the payment goes to, from `employee_bank_detail`'s sealed payload. */
  readonly iban: string
  /**
   * The contact number, E.164 — or NULL, which is the state this build is actually in.
   *
   * There is no phone column on `employee` at all: 0030 and 0050 give it an employment period, a gender,
   * wages and sealed bank details, and no contact number. So the honest value here is null, and
   * `wps_phone_not_e164` refuses it by the same rule that refuses a local-format number — one rule, two
   * causes, both named in the detail. Whether the layout needs a contact number at all is part of `Y8-wps`;
   * WHERE one would come from is part of `Y8-staff`, which already records that the staff list is a
   * fixture. Neither is answered by putting a plausible number here.
   */
  readonly phone: string | null
  /** The payslip's net, in integer fils. */
  readonly netFils: number
  /** The approved payable minutes, which a real SIF states as days and hours. See {@link renderWpsSif}. */
  readonly payableMinutes: number
}

/** The header, and the two identifiers that are the subject of `Y8-wps`. */
export interface WpsFileHeader {
  readonly format: WpsSifFormat
  readonly employerId: string
  readonly agentId: string
  /** The payroll period, as `YYYY-MM-DD` trading dates. */
  readonly periodStartsOn: string
  readonly periodEndsOn: string
  /**
   * The record count and total AS DECLARED, not as computed.
   *
   * Passed in rather than derived from `records.length`, and that is what makes the two rules real: a count
   * this function computed could not disagree with the records, so `wps_record_count_disagrees` would be
   * unfalsifiable and the check would be theatre. These come off `payroll_run.payslip_count` and
   * `payroll_run.net_total_fils` — the header figures the run recorded — so the rule compares the RUN's
   * claim with the FILE's rows, which is the disagreement worth catching.
   */
  readonly declaredRecordCount: number
  readonly declaredTotalFils: number
}

export interface WpsFile {
  readonly header: WpsFileHeader
  readonly records: readonly WpsDetailRecord[]
}

/** ITU-T E.164: `+`, a non-zero leading digit, 15 digits at most. */
const E164 = /^\+[1-9][0-9]{1,14}$/

/** ISO 13616 structure: two letters, two check digits, then 11 to 30 alphanumerics. */
const IBAN_STRUCTURE = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/

/**
 * Whether a value is standing in for an answer nobody has given.
 *
 * A near-copy of `PLACEHOLDER_MARKERS`'s intent rather than an import of the list: the markers there are
 * the ones `is_placeholder_text()` implements in SQL and are matched against text a CUSTOMER may see. What
 * matters here is narrower and stricter — an identifier that is blank, or that says PENDING, is not
 * configured — and the two placeholders above are spelled to be caught by either reading.
 */
function notConfigured(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return true
  return /pending|placeholder|tbc|tbd|to be confirmed|not configured|\[confirm\]/i.test(trimmed)
}

/**
 * ISO 7064 mod-97-10 over an IBAN, the published check-digit algorithm.
 *
 * The remainder is carried a few characters at a time rather than assembled into one enormous integer: a
 * 34-character IBAN expands to up to 68 digits, which no `Number` holds exactly. `BigInt` would also work
 * and this does not need it — the running remainder is never above 97 × 10^7, well inside exact integer
 * arithmetic, and it is the form the standard itself describes.
 */
export function ibanChecksumValid(iban: string): boolean {
  const compact = iban.replace(/\s+/g, '').toUpperCase()
  if (!IBAN_STRUCTURE.test(compact)) return false
  // The four leading characters move to the end, per ISO 13616.
  const rearranged = compact.slice(4) + compact.slice(0, 4)
  let remainder = 0
  for (const character of rearranged) {
    const code = character.charCodeAt(0)
    // A..Z become 10..35; 0..9 stay themselves. The structure test above admits nothing else.
    const expanded = code >= 65 ? String(code - 55) : String.fromCharCode(code)
    for (const digit of expanded) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97
    }
  }
  return remainder === 1
}

/** ITU-T E.164. Exported so the screen and the validator ask one function. Null is not E.164. */
export function isE164(phone: string | null): boolean {
  return phone !== null && E164.test(phone.trim())
}

/**
 * Every refusal a file earns, in one pass. Empty means the file may be written.
 *
 * Returns a LIST rather than throwing on the first, and that is deliberate: a payroll clerk with four bad
 * IBANs wants all four, not one per attempt, and a validator that stopped at the first would make fixing a
 * file a sequence of runs. {@link renderWpsSif} is the one that throws, so nothing can write a file that
 * has failures — the refusal and the byte production are separate for `render-document.ts`'s reason, that
 * a file on disk is a file somebody emails.
 */
export function validateWpsFile(file: WpsFile): readonly WpsValidationFailure[] {
  const failures: WpsValidationFailure[] = []
  const { header, records } = file

  if (notConfigured(header.employerId)) {
    failures.push({
      rule: 'wps_employer_id_not_configured',
      employeeId: null,
      detail:
        `The employer identifier is "${header.employerId}", which is not configured. It is the ` +
        'establishment or MOL id registered to this business and the build has never been told it ' +
        '(docs/OPEN-QUESTIONS.md Y8-wps). A plausible one would produce a file that passes every check ' +
        "and pays nineteen people against somebody else's registration, which is why the default fails.",
    })
  }
  if (notConfigured(header.agentId)) {
    failures.push({
      rule: 'wps_agent_id_not_configured',
      employeeId: null,
      detail:
        `The agent identifier is "${header.agentId}", which is not configured. It identifies the bank or ` +
        'exchange house carrying the file and is issued to them, not chosen (Y8-wps).',
    })
  }
  if (header.declaredRecordCount !== records.length) {
    failures.push({
      rule: 'wps_record_count_disagrees',
      employeeId: null,
      detail:
        `The header declares ${header.declaredRecordCount} records and the file carries ` +
        `${records.length}. The declared figure is the payroll run's own payslip_count, so this is the ` +
        'run and the file disagreeing about who is being paid — not a formatting slip.',
    })
  }
  const summed = records.reduce((total, record) => total + record.netFils, 0)
  if (header.declaredTotalFils !== summed) {
    failures.push({
      rule: 'wps_total_disagrees',
      employeeId: null,
      detail:
        `The header declares ${header.declaredTotalFils} fils and the detail records sum to ${summed}. ` +
        "The declared figure is the run's net_total_fils, so this is the run and the file disagreeing " +
        'about how much is being paid.',
    })
  }
  for (const record of records) {
    if (!ibanChecksumValid(record.iban)) {
      failures.push({
        rule: 'wps_iban_malformed',
        employeeId: record.employeeId,
        detail:
          `"${record.iban}" is not a well-formed IBAN: it fails ISO 13616's structure or its ISO ` +
          '7064 mod-97-10 check digits. The country-specific length is deliberately not asserted here — ' +
          "the bank's format specification states it and that specification is Y8-wps.",
      })
    }
    if (!isE164(record.phone)) {
      failures.push({
        rule: 'wps_phone_not_e164',
        employeeId: record.employeeId,
        detail:
          record.phone === null
            ? 'No contact number is on file, and there is no column on `employee` holding one: 0030 and ' +
              '0050 give an employment period, a gender, wages and sealed bank details, and no phone. ' +
              'Whether the layout needs one is Y8-wps; where one would come from is Y8-staff. A plausible ' +
              'number here would be indistinguishable from a recorded one.'
            : `"${record.phone}" is not an E.164 number. E.164 is "+", a non-zero leading digit and at ` +
              'most fifteen digits in all; a local-format number reaches the bank as an unreachable contact.',
      })
    }
  }
  return failures
}

/** Thrown by {@link renderWpsSif}. Carries every failure, so one call answers the whole file. */
export class WpsFileRefused extends AppError {
  readonly failures: readonly WpsValidationFailure[]
  constructor(failures: readonly WpsValidationFailure[]) {
    super(
      'validation',
      `The WPS file was refused by ${failures.length} rule(s) and no bytes were produced: ` +
        `${failures.map((failure) => `[${failure.rule}] ${failure.detail}`).join(' ')}`,
      { details: { rules: failures.map((failure) => failure.rule) } },
    )
    this.name = 'WpsFileRefused'
    this.failures = failures
  }
}

/** The field order of `generic_mohre_v1`'s detail record, named so a reader can see what is provisional. */
export const GENERIC_MOHRE_V1_DETAIL_FIELDS = [
  'record_type',
  'employee_reference',
  'iban',
  'payment_period',
  'payable_minutes',
  'net_amount_fils',
] as const

/** The field order of `generic_mohre_v1`'s control record. */
export const GENERIC_MOHRE_V1_CONTROL_FIELDS = [
  'record_type',
  'employer_id',
  'agent_id',
  'period_starts_on',
  'period_ends_on',
  'record_count',
  'total_amount_fils',
] as const

/**
 * The file as bytes-to-be, or a refusal with nothing produced.
 *
 * ## The layout is provisional and says so IN the file
 *
 * The first line is a comment naming the format and `Y8-wps`. That is not decoration: a file that reached a
 * bank would be rejected, and the person reading the rejection needs to know immediately that the layout
 * was this build's guess rather than their configuration being wrong. It is the same argument as the
 * `[DRAFT WORDING]` prefix on the seeded consent text (`Y9-consent-wording`) — a marker in the artefact and
 * not only in a flag, because a plausible artefact is indistinguishable from an approved one.
 *
 * ## Amounts are integer fils, and that is also provisional
 *
 * A real SIF states an amount in a fixed-width decimal field whose scale the bank's spec fixes. This writes
 * integer fils because that is what the database holds (ADR 0007) and converting to an unverified field
 * format would be two guesses instead of one. The column is named `net_amount_fils` so nothing can read it
 * as dirhams.
 */
export function renderWpsSif(file: WpsFile): string {
  const failures = validateWpsFile(file)
  if (failures.length > 0) throw new WpsFileRefused(failures)

  const { header, records } = file
  if (header.format !== 'generic_mohre_v1') {
    /*
      Not a fall-through to the only layout that exists.

      A format nobody implemented must not silently be written in another one's shape: the file would be
      accepted by this function, rejected by the bank, and the rejection would name a layout nobody chose.
      `commissionFilsFor` refuses an unknown rounding mode for the same reason and in the same words.
    */
    throw new AppError(
      'invariant_violated',
      `"${String(header.format)}" is not a WPS layout this build can write. The layouts are ` +
        `${WPS_SIF_FORMATS.join(', ')}; a new one is a new member of WPS_SIF_FORMATS AND a branch here.`,
    )
  }

  const period = `${header.periodStartsOn}..${header.periodEndsOn}`
  const lines = [
    `# format=${header.format} provisional=Y8-wps — the layout is this build's, not the bank's`,
    `# fields: EDR=${GENERIC_MOHRE_V1_DETAIL_FIELDS.join(',')}`,
    `# fields: SCR=${GENERIC_MOHRE_V1_CONTROL_FIELDS.join(',')}`,
    ...records.map((record) =>
      [
        'EDR',
        record.staffReference,
        record.iban.replace(/\s+/g, '').toUpperCase(),
        period,
        String(record.payableMinutes),
        String(record.netFils),
      ].join(','),
    ),
    [
      'SCR',
      header.employerId,
      header.agentId,
      header.periodStartsOn,
      header.periodEndsOn,
      String(header.declaredRecordCount),
      String(header.declaredTotalFils),
    ].join(','),
  ]
  // A trailing newline: a record-per-line file whose last record has no terminator is the one a naive
  // reader drops, and the count then disagrees by exactly one in the direction that looks like a rounding
  // error rather than a truncation.
  return `${lines.join('\n')}\n`
}
