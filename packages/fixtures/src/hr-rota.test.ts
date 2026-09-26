import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CredentialPolicy,
  evaluateCredentialsOn,
  type HeldCredential,
  localDate,
  ROTA_RULE_NAMES,
  validateRota,
} from '@berelax/core'
import { describe, expect, it } from 'vitest'

/**
 * P-HR-06 — the claims about the SOURCE of the validator, and the one about a shared function.
 *
 * Two acceptance criteria are statements about text rather than about behaviour, so this file reads the
 * text. It lives in `packages/fixtures` for the reason `hr-working-hours.test.ts` gives: `packages/core`
 * may not import `node:fs` — the purity gate forbids it — so a test that reads a file cannot live beside
 * the file it reads.
 *
 *   1. **"reusing the P-HR-02 evaluator rather than a second implementation (asserted by a test that both
 *      call the same function)".** Two halves, because either alone is satisfiable by the wrong code. The
 *      BEHAVIOURAL half compares the validator's credential verdict against `evaluateCredentialsOn`'s over
 *      a table of cases including the boundary day — but a second implementation that happened to agree
 *      would pass it. The SOURCE half asserts that `rota-validator.ts` imports `evaluateCredentialsOn` and
 *      contains no expiry comparison, no status literal and no window arithmetic of its own — so there is
 *      nothing in it that could agree by coincidence.
 *
 *   2. **The rule names are a contract.** `rota_change_request.refused_rule` stores one, the screen prints
 *      one, and 0081's comment on that column lists them. So every name in `ROTA_RULE_NAMES` must appear
 *      in the migration's text, and the migration must name no rule the vocabulary does not have — which
 *      is the direction that catches a rule renamed in TypeScript and left alone in SQL.
 */
const REPO = join(import.meta.dirname, '..', '..', '..')

const VALIDATOR = join(REPO, 'packages', 'core', 'src', 'hr', 'rota-validator.ts')
const CREDENTIALS = join(REPO, 'packages', 'core', 'src', 'hr', 'credentials.ts')
const MIGRATION = join(REPO, 'packages', 'db', 'migrations', '0081_hr_rota_version.sql')

/**
 * Comments, string literals and template literals blanked, so the prose explaining why a status literal is
 * not in the code does not read as the literal being in the code.
 *
 * Copied from `hr-working-hours.test.ts` rather than shared, deliberately: that file's version is calibrated
 * to its own two rules and a shared helper would be one both files then had to agree about. The mistake it
 * exists to prevent has been made in this repository —
 * `check-schema-conventions.mjs` records reporting the word "timestamp" in a sentence about timestamps.
 */
function codeOnly(source: string): string {
  return withoutComments(source)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/**
 * Comments blanked and STRING LITERALS KEPT, which one of the four patterns below needs.
 *
 * A credential status is a string — 'EXPIRED' — so blanking strings leaves the pattern looking for one
 * unable to match anything, in the validator and in the evaluator alike. The first version of this file did
 * exactly that and its control failed, which is what a control is for: the rule reported the validator clean
 * because it could not have reported anything else. Comments still have to go, because this file's own prose
 * says EXPIRING_SOON several times and the validator's says it once.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
}

/**
 * Every way the validator could be judging a credential for itself.
 *
 * Each pattern is a spelling of the second implementation, and the list is the shape it would actually
 * take: a comparison against an expiry date, one of the four status labels, or the EXPIRING_SOON window.
 */
const SECOND_IMPLEMENTATION = [
  { rule: 'compares an expiry date', re: /\bexpiresOn\s*[<>=!]/, strip: codeOnly },
  {
    rule: 'derives a credential status',
    re: /\b(?:EXPIRED|EXPIRING_SOON|MISSING|VALID)\b/,
    // Strings KEPT: a status label is a string, so codeOnly would leave nothing to find.
    strip: withoutComments,
  },
  { rule: 'reads the EXPIRING_SOON window', re: /\bexpiringSoonDays\b/, strip: codeOnly },
  {
    rule: 'ranks credential statuses',
    re: /\b(?:worstStatus|statusSatisfies|credentialStatusFor)\b/,
    strip: codeOnly,
  },
] as const

/** The patterns a source matches, by rule name, each with the stripping it needs. */
function secondImplementationSigns(source: string): readonly string[] {
  return SECOND_IMPLEMENTATION.filter((pattern) => pattern.re.test(pattern.strip(source))).map(
    (pattern) => pattern.rule,
  )
}

const MANDATORY = ['labour_card', 'occupational_health_card'] as const
const POLICY: CredentialPolicy = {
  mandatoryTypes: [...MANDATORY],
  nonExpiringTypes: [],
  expiringSoonDays: 60,
}

const DAY = localDate('2026-03-04')

function rotaFor(credentials: readonly HeldCredential[]) {
  const opensAt = Date.parse('2026-03-04T11:00:00+04:00')
  const closesAt = Date.parse('2026-03-05T02:00:00+04:00')
  return {
    days: [
      {
        tradingDate: DAY,
        opensAt: opensAt as never,
        closesAt: closesAt as never,
        wetRoomBookableDuring: [],
        isPublicHoliday: false,
      },
    ],
    // Two therapists on the floor, so the coverage rule cannot fire and the only thing left to refuse is
    // the credential. The second one is always current.
    therapists: [
      { employeeId: 't1', skills: ['asian_style'], credentials },
      { employeeId: 't2', skills: ['asian_style'], credentials: currentCredentials() },
    ],
    assignments: ['t1', 't2'].map((employeeId) => ({
      shiftId: `shift-${employeeId}`,
      employeeId,
      tradingDate: DAY,
      period: { startsAt: opensAt, endsAt: closesAt } as never,
    })),
    treatmentLoads: [],
    coverageRuleVersions: [
      {
        effectiveFrom: localDate('1900-01-01'),
        coverageSegmentMinutes: 30,
        minimumTherapistsOnFloor: 2,
        minimumWetRoomCapable: 1,
        treatmentMinutesCapPerDay: 360,
        highIntensityMinutesCapPerDay: 240,
        highIntensityTreatmentCodes: [],
      },
    ],
    // A rule set that cannot fire, so the hours rules leave the credential claim alone: a 15-hour shift
    // would otherwise breach the real 2-hour overtime cap and this file would be testing two rules.
    workingHoursRuleVersions: [
      {
        effectiveFrom: localDate('1900-01-01'),
        ordinaryMinutesPerDay: 900,
        ordinaryMinutesPerWeek: 10_080,
        weekStartsOn: 1,
        overtimeDailyCapMinutes: 0,
        minimumRestMinutes: 0,
        nightWindow: { from: '22:00' as never, until: '04:00' as never },
        multiplierBp: { ordinary: 10_000, overtime: 12_500, night: 15_000, publicHoliday: 15_000 },
      },
    ],
    wetRoomSkills: ['asian_style', 'arabic_style'],
    credentialPolicy: POLICY,
  }
}

function currentCredentials(): readonly HeldCredential[] {
  return MANDATORY.map((documentType) => ({
    documentType,
    expiresOn: localDate('2036-01-01'),
  }))
}

describe('acceptance — the credential gate is the P-HR-02 evaluator, not a second one', () => {
  it('imports evaluateCredentialsOn from the module that owns it', () => {
    const source = codeOnly(readFileSync(VALIDATOR, 'utf8'))
    expect(source).toMatch(/evaluateCredentialsOn/)
    // From `./credentials.ts` specifically. An import of a local re-export would satisfy a name check and
    // could be pointing at anything.
    expect(readFileSync(VALIDATOR, 'utf8')).toMatch(
      /import\s*\{[^}]*evaluateCredentialsOn[^}]*\}\s*from\s*'\.\/credentials\.ts'/s,
    )
  })

  it('contains no expiry comparison, status literal or window arithmetic of its own', () => {
    expect(secondImplementationSigns(readFileSync(VALIDATOR, 'utf8'))).toEqual([])
  })

  it('has a scan that DOES fire, over the module that legitimately contains all four', () => {
    // The control. `credentials.ts` is the evaluator, so every pattern above must match it — a scan that
    // had stopped matching (a renamed field, a broken regular expression, a strip that emptied the file)
    // would otherwise report the validator clean having examined nothing, which is ADR 0003's subject.
    const found = secondImplementationSigns(readFileSync(CREDENTIALS, 'utf8'))
    expect([...found].sort()).toEqual(
      SECOND_IMPLEMENTATION.map((pattern) => pattern.rule as string).sort(),
    )
  })

  it('and the scan fires on the validator when a second implementation is spliced in', () => {
    // The other half of the control, over the file that is actually being asserted about: a rule that
    // matches `credentials.ts` and could not match `rota-validator.ts` — because the strip deleted it,
    // say — would pass both cases above.
    const found = secondImplementationSigns(
      `${readFileSync(VALIDATOR, 'utf8')}\nfunction sneaky(c: { expiresOn: string }) { return c.expiresOn < '2026-01-01' ? 'EXPIRED' : 'VALID' }\n`,
    )
    expect(found).toContain('compares an expiry date')
    expect(found).toContain('derives a credential status')
  })

  it('agrees with evaluateCredentialsOn on every case, including the boundary day', () => {
    // The behavioural half. Each case is judged twice — once through the validator and once by calling the
    // evaluator directly — and the two must give the same answer. The boundary day is the case that
    // matters: `credentialStatusFor` treats the expiry date as the LAST valid day, so a second
    // implementation comparing `<=` would differ on exactly one date out of every licence's life.
    const cases: { readonly label: string; readonly credentials: readonly HeldCredential[] }[] = [
      { label: 'all current', credentials: currentCredentials() },
      { label: 'nothing on file', credentials: [] },
      {
        label: 'expires ON the trading date',
        credentials: [
          { documentType: 'labour_card', expiresOn: DAY },
          { documentType: 'occupational_health_card', expiresOn: localDate('2036-01-01') },
        ],
      },
      {
        label: 'expired the day before',
        credentials: [
          { documentType: 'labour_card', expiresOn: localDate('2026-03-03') },
          { documentType: 'occupational_health_card', expiresOn: localDate('2036-01-01') },
        ],
      },
      {
        label: 'inside the EXPIRING_SOON window',
        credentials: [
          { documentType: 'labour_card', expiresOn: localDate('2026-03-20') },
          { documentType: 'occupational_health_card', expiresOn: localDate('2036-01-01') },
        ],
      },
      {
        label: 'one of two on file',
        credentials: [{ documentType: 'labour_card', expiresOn: localDate('2036-01-01') }],
      },
    ]
    let refused = 0
    let allowed = 0
    for (const testCase of cases) {
      const direct = evaluateCredentialsOn({
        credentials: testCase.credentials,
        policy: POLICY,
        asOfDate: DAY,
      })
      const throughValidator = validateRota(rotaFor(testCase.credentials)).violations.filter(
        (violation) => violation.rule === 'credential_not_current' && violation.employeeId === 't1',
      )
      expect(throughValidator.length === 0, testCase.label).toBe(direct.eligible)
      if (direct.eligible) allowed += 1
      else {
        refused += 1
        const violation = throughValidator[0]
        // The blocking list is the evaluator's OWN answer, passed through unchanged. A validator that
        // rebuilt it would agree about eligibility and could differ about which document is the problem,
        // which is the half a therapist is told.
        expect(
          violation?.rule === 'credential_not_current' &&
            violation.blocking.map(
              (assessment) => `${assessment.documentType}:${assessment.status}`,
            ),
          testCase.label,
        ).toEqual(
          direct.blocking.map((assessment) => `${assessment.documentType}:${assessment.status}`),
        )
      }
    }
    // Both branches were reached. A table whose every case fell one way would report a clean pass while
    // proving agreement in one direction only.
    expect(refused).toBeGreaterThan(0)
    expect(allowed).toBeGreaterThan(0)
  })
})

describe('acceptance — the rule names are a contract with the migration', () => {
  it('names every rule in 0081, so a refused row can carry any of them', () => {
    const migration = readFileSync(MIGRATION, 'utf8')
    for (const rule of ROTA_RULE_NAMES) {
      expect(migration, `0081 does not mention ${rule}`).toMatch(rule)
    }
  })

  it('mentions no rule name the vocabulary does not have', () => {
    // The direction that catches a rename: a rule renamed in TypeScript and left alone in the SQL comment
    // leaves the migration describing a vocabulary that no longer exists, and nothing else would notice.
    // Scanned for the SHAPE of a rule name inside the comment that lists them, so the search is bounded.
    const migration = readFileSync(MIGRATION, 'utf8')
    const listing =
      /ROTA_RULE_NAMES in[\s\S]*?so the enumeration is checked rather than decorative/.exec(
        migration,
      )?.[0] ?? ''
    expect(listing, 'the comment listing the rule names was not found').not.toBe('')
    const quoted = [...listing.matchAll(/`([a-z][a-z_]+)`/g)].map((match) => match[1] as string)
    const unknown = quoted.filter((name) => !(ROTA_RULE_NAMES as readonly string[]).includes(name))
    expect(unknown).toEqual([])
    // And the listing is about something: it quoted several of them.
    expect(quoted.length).toBe(ROTA_RULE_NAMES.length)
  })
})
