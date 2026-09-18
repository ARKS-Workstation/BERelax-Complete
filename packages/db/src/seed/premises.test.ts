import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AREA_ALIASES,
  areaAliasesFor,
  PREMISES_NAP,
  TRADING_CLOSE_TIME,
  TRADING_DAYS_OF_WEEK,
  TRADING_OPEN_TIME,
  WHATSAPP_CANDIDATES,
  WHATSAPP_PENDING,
} from './premises.ts'

/**
 * The premises seed, and the rule that keeps it the only spelling of the address.
 *
 * docs/09 §4 and the comment on `premises` in 0003 both say the row is the single source of truth for
 * NAP. That is a claim about the *repository*, not about the row: a footer with the street typed into it
 * renders the same whether or not anybody ever corrects the database, and docs/13 §3 is a record of
 * exactly that failure happening in the wild — two published WhatsApp numbers, and no way to tell which
 * an AI assistant will repeat.
 *
 * So this file greps. Every tracked `.ts`, `.tsx` and `.mjs` file under `packages/`, `apps/` and
 * `scripts/` is scanned for the address fragments and the phone numbers, and every match outside the
 * closed exemption list below is a failure naming {@link NAP_RULE}.
 */

const NAP_RULE = 'nap-literal-outside-the-seed'

/**
 * What a hard-coded NAP looks like.
 *
 * The phone patterns are the business's own numbers in both the E.164 form the database stores and the
 * spaced forms docs/13 §3 prints, because a footer is as likely to carry one as the other. The address
 * patterns are the fragments that identify the building rather than the whole line, so a re-ordered or
 * partially copied address is still caught.
 *
 * `05\d ?\d{3} ?\d{4}` is deliberately NOT here. It would match
 * `packages/core/src/identity/normalise-phone.ts`, whose doc comment uses `050 510 8633` as a worked
 * example of four spellings of one number — which is the module that exists to normalise them, and a
 * rule that refused its own documentation is a rule somebody switches off. The numbers this business
 * actually publishes are matched exactly instead.
 */
const NAP_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'street', pattern: /Al Meena/i },
  { name: 'area', pattern: /Al Zahiyah/i },
  { name: 'building', pattern: /Tower Block/i },
  { name: 'floor', pattern: /M-Floor/i },
  { name: 'landline', pattern: /\+?971\s?2\s?557\s?6533|02\s?557\s?6533/ },
  { name: 'mobile', pattern: /\+?971\s?56\s?342\s?9399|056\s?342\s?9399/ },
  { name: 'whatsapp-prototype', pattern: /\+?971\s?52\s?510\s?8633|052\s?510\s?8633/ },
  { name: 'whatsapp-live', pattern: /\+?971\s?52\s?823\s?9069|052\s?823\s?9069/ },
]

/**
 * Every file that may carry one, and why.
 *
 * A **closed** list, which is the whole value of it: a new hard-coded address anywhere in the repository
 * fails this test, and removing an entry from here is how a duplicate gets retired. Each entry names the
 * unit that owns it, so an exemption is a deferral rather than a permanent carve-out.
 */
const EXEMPT: readonly { readonly path: string; readonly why: string }[] = [
  {
    path: 'packages/db/src/seed/premises.ts',
    why: 'the seed itself — the one place the values are written down',
  },
  {
    path: 'packages/db/src/seed/premises.test.ts',
    why: 'this file: the patterns have to be spelled somewhere',
  },
  {
    path: 'packages/harness/src/specimen.ts',
    why: 'a prose specimen fed to the LLM harness, not a rendered surface. G-SEO owns its copy',
  },
  {
    path: 'packages/pdf/src/testing/sample-invoice.ts',
    why: 'a committed PDF render specimen. F10 owns it, and it is deliberately not the real issuer',
  },
  {
    path: 'packages/pdf/src/documents/bidi-specimen.ts',
    why: 'the bidi rendering specimen. F10 owns it',
  },
  {
    path: 'scripts/test-gates.mjs',
    why: 'the gate file, whose own known-bad fixtures are addresses and phone numbers',
  },
  // The locality as a SEARCH QUERY — 'massage al zahiyah' — in the fake Search Console figures and the
  // fake LLM's commentary on them. Not contact data, and `packages/providers` may not depend on
  // `@berelax/db`, so it could not read the seed even if it wanted to. G-SEO owns these numbers.
  {
    path: join('packages', 'providers', 'src', 'google', 'fake-google.ts'),
    why: 'fake Search Console rows: the locality is a query string, not an address',
  },
  {
    path: join('packages', 'providers', 'src', 'llm', 'fake-llm.ts'),
    why: 'fake LLM commentary quoting that query string back',
  },
  // Three entries stood here for `apps/web/app/_document/shell.tsx`, `app/(en)/(public)/page.tsx` and
  // `app/(en)/(dev)/kitchen-sink/page.tsx`, each marked "W-SITE-02's to retire". W-SITE-02 retired them:
  // the gallery reads the row through `readPremisesFacts` and renders `@berelax/ui`'s NAP block, and the
  // two statically prerendered documents no longer assert an address at all — a root layout's metadata is
  // evaluated during `next build`, where there is no database, so a build-time read would have baked a
  // literal rather than removed one. Nothing may be added back here without a unit named beside it.
  //
  // The three below landed in the same batch as this gate, so its first run found them. Each is a
  // different reason, and none of them is a rendered surface that could go stale:
  //
  // The issuer address on a tax document is **snapshotted at issue and never joined** — that is migration
  // 0026's central rule, because a view that joined `legal_entity` would rewrite every historic document
  // the day the business moved. A specimen of a *stored* document therefore carries the address as data,
  // exactly as the already-exempt `sample-invoice.ts` does. `packages/pdf` may not import `@berelax/db`
  // either, so it could not read the seed.
  {
    path: join('packages', 'pdf', 'src', 'testing', 'stored-documents.ts'),
    why: 'stored-document specimens: a snapshotted issuer address is data, not a lookup. M-TILL-12 owns it',
  },
  // Prose, not data. One is a doc comment explaining why a one-location business still needs a location
  // picker (the wrong choice publishes replies against another company's listing); the other is a
  // developer-facing error string naming which listing the local stand-in serves. A comment cannot render
  // stale, and the gate's own note about `normalise-phone.ts` makes the same argument: a rule that
  // refused its own documentation is a rule somebody switches off.
  {
    path: join('packages', 'google', 'src', 'capability-resolver.ts'),
    why: 'doc comment on why one location still needs a picker. G-CONN-05 owns it',
  },
  {
    path: join(
      'apps',
      'web',
      'app',
      '(admin)',
      'settings',
      'integrations',
      'google',
      'picker',
      'route.ts',
    ),
    why: 'developer error string naming the stand-in listing. G-CONN-05 owns it',
  },
]

/**
 * The second rule: the trading hours, in the surfaces that render them.
 *
 * W-SITE-02's acceptance asks for "zero `11:00`/`02:00` hours literals" alongside the street and the phone
 * numbers, and scopes the whole gate to **apps/web and packages/ui**. That scope is the rule's design, not
 * a shortcut. `11:00` and `02:00` appear in about forty doc comments across `packages/core`,
 * `packages/db` and `packages/messaging`, every one of them explaining *why* the close is less than the
 * open — that a 01:30 appointment belongs to the previous trading date, that `crosses_midnight` is a
 * generated column, that the TDRA promotional window sits inside trading hours. Refusing those would take
 * forty exemptions, which turns a closed list into a blanket, and it would refuse the documentation that
 * makes the model comprehensible. The gate's own note about `normalise-phone.ts` makes the same argument.
 *
 * What is refused is a **rendered** surface with the hours typed into it: a page, a component, a template.
 * Those are the files that go on showing 11:00 after an owner has changed the opening time, and there are
 * only two packages where such a file can live.
 *
 * The lookbehind is what keeps it honest. `(?<![\d:])` refuses a match preceded by a digit or a colon, so
 * `2026-09-16T11:02:00.000Z` — a real timestamp in `fake-google.ts` — is not a closing time and `211:00` is
 * not an opening one. `02:00:00` still matches, because a `time` literal with its seconds is exactly the
 * hard-coded hours this refuses. `premises_hours` holds `time` values and every consumer formats them, so a
 * literal in a rendered file is always a decision somebody typed.
 */
const HOURS_RULE = 'nap-hours-literal-outside-the-seed'

const HOURS_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'open-time', pattern: /(?<![\d:])11:00/ },
  { name: 'close-time', pattern: /(?<![\d:])02:00/ },
]

/** The rendered surfaces: the application and the component library. Nothing else renders. */
const HOURS_SCANNED_ROOTS = [join('apps', 'web'), join('packages', 'ui')]

/**
 * Empty, and asserted to stay that way by the scan itself.
 *
 * It exists as a list rather than as a hard-coded `[]` because the next surface that legitimately needs
 * one — a specimen, say — should arrive with its unit named beside it, exactly as `EXEMPT` requires, rather
 * than as a pattern somebody loosens.
 */
const HOURS_EXEMPT: readonly { readonly path: string; readonly why: string }[] = []

const SCANNED_ROOTS = ['packages', 'apps', 'scripts']
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mjs']
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'dist', 'artifacts', '.turbo'])
/** Tests may carry a literal: a fixture asserting the seeded value has to name it. */
const isTestFile = (path: string) => /\.(?:test|itest)\.(?:ts|tsx|mjs)$/.test(path)

function sourceFiles(roots: readonly string[] = SCANNED_ROOTS): readonly string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIPPED_DIRS.has(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full)
    }
  }
  for (const root of roots) walk(root)
  return found
}

interface NapFinding {
  readonly file: string
  readonly line: number
  readonly pattern: string
}

/**
 * Every NAP literal in `files`, skipping the exempt ones unless told not to.
 *
 * `respectExemptions: false` exists for the control below: pointed at the seed, the scan has to report
 * every pattern, which is what proves the patterns match the spellings they were written for. A grep
 * nobody has seen match is not a grep.
 */
function findNapLiterals(
  files: readonly string[],
  options: { readonly respectExemptions?: boolean } = {},
): readonly NapFinding[] {
  const respect = options.respectExemptions ?? true
  const exempt = new Set(EXEMPT.map((entry) => entry.path.split(sep).join('/')))
  const findings: NapFinding[] = []
  for (const file of files) {
    const relativePath = relative('.', file).split(sep).join('/')
    if (respect && (exempt.has(relativePath) || isTestFile(relativePath))) continue
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const { name, pattern } of NAP_PATTERNS) {
          if (pattern.test(line))
            findings.push({ file: relativePath, line: index + 1, pattern: name })
        }
      })
  }
  return findings
}

/**
 * Every hours literal in `files`, by the same mechanism and against a different pattern set.
 *
 * Deliberately a second function rather than a parameter on the one above. The two rules have different
 * scopes, different exemption lists and different failure messages, and folding them together would produce
 * one function with three flags whose callers each disable two of them.
 */
function findHoursLiterals(
  files: readonly string[],
  options: { readonly respectExemptions?: boolean } = {},
): readonly NapFinding[] {
  const respect = options.respectExemptions ?? true
  const exempt = new Set(HOURS_EXEMPT.map((entry) => entry.path.split(sep).join('/')))
  const findings: NapFinding[] = []
  for (const file of files) {
    const relativePath = relative('.', file).split(sep).join('/')
    if (respect && (exempt.has(relativePath) || isTestFile(relativePath))) continue
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const { name, pattern } of HOURS_PATTERNS) {
          if (pattern.test(line))
            findings.push({ file: relativePath, line: index + 1, pattern: name })
        }
      })
  }
  return findings
}

describe('the premises row is the only source of NAP', () => {
  const files = sourceFiles()

  it('scans a non-empty set of files, so a pass cannot mean "found nothing to look at"', () => {
    // The failure mode this guards against is the one ADR 0002 records for `pnpm boundaries`: a
    // toolchain or layout change reduces the scan to zero files and the gate reports success for ever.
    expect(files.length).toBeGreaterThan(200)
    expect(files.some((f) => f.includes(join('packages', 'db', 'src')))).toBe(true)
    expect(files.some((f) => f.includes(join('apps', 'web')))).toBe(true)
  })

  it(`finds no NAP literal outside the seed (${NAP_RULE})`, () => {
    const findings = findNapLiterals(files)
    const report = findings.map((f) => `${f.file}:${f.line} (${f.pattern})`).join('\n      ')
    expect(
      findings,
      `${NAP_RULE}: the address and the phone numbers live in packages/db/src/seed/premises.ts and in ` +
        `the premises row, nowhere else.\n      ${report}`,
    ).toEqual([])
  })

  it('detects a literal that IS hard-coded, so the scan is not vacuous', () => {
    const seed = join('packages', 'db', 'src', 'seed', 'premises.ts')
    // Exempt, so the scan says nothing about it — which is what the assertion above relies on.
    expect(findNapLiterals([seed])).toEqual([])
    // With the exemption lifted, every pattern must fire on it. The seed spells the whole address,
    // stores the landline and the mobile, and quotes both disputed WhatsApp numbers, so all eight
    // patterns have something to match. A pattern missing from this list is a pattern that matches
    // nothing anywhere and would let the real literal through.
    const found = findNapLiterals([seed], { respectExemptions: false })
    expect([...new Set(found.map((f) => f.pattern))].sort()).toEqual(
      NAP_PATTERNS.map((p) => p.name).sort(),
    )
  })

  it('exempts nothing that does not exist, so the list cannot rot into a blanket', () => {
    for (const entry of [...EXEMPT, ...HOURS_EXEMPT]) {
      expect(() => statSync(entry.path), `${entry.path} is exempt but absent`).not.toThrow()
      expect(entry.why.length, `${entry.path} is exempt with no stated reason`).toBeGreaterThan(10)
    }
  })

  it('no longer exempts any surface W-SITE-02 was to retire', () => {
    // The three files that used to be on the list, named here so that adding one back is a failing test
    // rather than a diff nobody reads. Each is a page or a shared document shell: the two static documents
    // publish no address at all now, and the component gallery renders the row through `NapBlock`.
    const retired = [
      join('apps', 'web', 'app', '_document', 'shell.tsx'),
      join('apps', 'web', 'app', '(en)', '(public)', 'page.tsx'),
      join('apps', 'web', 'app', '(en)', '(dev)', 'kitchen-sink', 'page.tsx'),
    ]
    for (const path of retired) {
      // Still there — this asserts the exemption was retired, not that the file was deleted.
      expect(() => statSync(path), `${path} is gone`).not.toThrow()
      expect(EXEMPT.map((entry) => entry.path)).not.toContain(path)
    }
    // And the scan really does cover them, so the assertion above is not about files nobody reads.
    const scanned = new Set(sourceFiles().map((file) => relative('.', file).split(sep).join('/')))
    for (const path of retired) {
      expect(scanned.has(path.split(sep).join('/')), `${path} is outside the scan`).toBe(true)
    }
  })
})

describe('the trading hours are not typed into a rendered surface', () => {
  const surfaces = sourceFiles(HOURS_SCANNED_ROOTS)

  it('scans a non-empty set of rendered files', () => {
    // The ADR 0002 guard again, on a much smaller scan: two roots, so a layout change that renamed either
    // would silently reduce this to nothing while reporting success.
    expect(surfaces.length).toBeGreaterThan(30)
    expect(surfaces.some((file) => file.includes(join('apps', 'web', 'app')))).toBe(true)
    expect(surfaces.some((file) => file.includes(join('packages', 'ui', 'src', 'patterns')))).toBe(
      true,
    )
  })

  it(`finds no opening or closing time in apps/web or packages/ui (${HOURS_RULE})`, () => {
    const findings = findHoursLiterals(surfaces)
    const report = findings.map((f) => `${f.file}:${f.line} (${f.pattern})`).join('\n      ')
    expect(
      findings,
      `${HOURS_RULE}: the trading hours live in premises_hours and reach a page through ` +
        `readPremisesFacts, never as a literal in a template. A rendered surface with the hours typed ` +
        `into it goes on showing them after the owner has changed them.\n      ${report}`,
    ).toEqual([])
  })

  it('detects the hours where they ARE written down, so the patterns are not dead', () => {
    // Pointed at the seed, which is outside the scanned roots and is where both times legitimately live.
    // Every pattern must fire, or a pattern matches nothing anywhere and the rule above is decoration.
    const seed = join('packages', 'db', 'src', 'seed', 'premises.ts')
    const found = findHoursLiterals([seed], { respectExemptions: false })
    expect([...new Set(found.map((f) => f.pattern))].sort()).toEqual(
      HOURS_PATTERNS.map((p) => p.name).sort(),
    )
    // And the seed is NOT in the scan, which is why the rule above can be empty while this one fires.
    expect(surfaces.map((file) => relative('.', file).split(sep).join('/'))).not.toContain(
      seed.split(sep).join('/'),
    )
  })

  it('does not fire on a time that merely contains those digits', () => {
    // The control on the lookbehind. A timestamp's seconds and a three-digit hour are not the trading
    // hours, and a rule that flagged them would be switched off within a week. The first of these is a
    // real line from `packages/providers/src/google/fake-google.ts`.
    const noise = ['createdAt: 2026-09-16T11:02:00.000Z', 'const port = 211:00', '011:000']
    for (const line of noise) {
      for (const { pattern, name } of HOURS_PATTERNS) {
        expect(pattern.test(line), `${name} fired on ${line}`).toBe(false)
      }
    }
    // The other half: the spellings it must fire on.
    for (const line of ["  open: '11:00',", 'closes at 02:00 the next day']) {
      expect(
        HOURS_PATTERNS.some(({ pattern }) => pattern.test(line)),
        line,
      ).toBe(true)
    }
  })
})

describe('what docs/13 states and what it does not', () => {
  it('transcribes the address from docs/13 §2', () => {
    expect(PREMISES_NAP.addressLine1).toBe('250 Al Meena Street')
    expect(PREMISES_NAP.area).toBe('Al Zahiyah')
    expect(PREMISES_NAP.floor).toBe('M-Floor')
    expect(PREMISES_NAP.emirate).toBe('Abu Dhabi')
    expect(PREMISES_NAP.countryCode).toBe('AE')
    // Every token docs/13 §2 prints survives somewhere, including the sector code, which has no column.
    const printed = [
      PREMISES_NAP.addressLine1,
      PREMISES_NAP.addressLine2,
      PREMISES_NAP.floor,
      PREMISES_NAP.area,
      PREMISES_NAP.emirate,
    ].join(' ')
    for (const token of ['250', 'Al Meena', 'Tower Block A/B', 'M-Floor', 'Al Zahiyah', 'E14']) {
      expect(printed, `docs/13 §2 prints "${token}"`).toContain(token)
    }
  })

  it('knows the district by every name docs/13 §2 gives it, keyed on the row value', () => {
    // docs/09 §4 needs all three names on every citation — they are how a machine tells this business
    // apart from the airport-spa chain of the same name — and `premises` has no column for an alias.
    expect([...areaAliasesFor(PREMISES_NAP.area)]).toEqual(['Al Mina', 'Tourist Club Area'])
    expect(AREA_ALIASES[PREMISES_NAP.area]).toBeDefined()
    // Case is not part of the fact: an owner retyping the area must not silently lose two of the names.
    expect([...areaAliasesFor(PREMISES_NAP.area.toUpperCase())]).toHaveLength(2)
    // The control, and the reason this is a mapping rather than a list. An area the mapping does not know
    // yields NOTHING, so a business that moved would publish no aliases rather than the old district's —
    // which a bare `AREA_ALIASES: string[]` read beside the row would have gone on doing for ever.
    expect([...areaAliasesFor('Khalifa City')]).toEqual([])
    expect([...areaAliasesFor('')]).toEqual([])
    // And no alias repeats the area itself: they are the OTHER names, and a payload listing the area
    // twice reads to a consumer as two different localities.
    expect(areaAliasesFor(PREMISES_NAP.area)).not.toContain(PREMISES_NAP.area)
  })

  it('stores the two numbers docs/13 §3 agrees on, in E.164', () => {
    expect(PREMISES_NAP.phoneLandline).toBe('+97125576533')
    expect(PREMISES_NAP.phoneMobile).toBe('+971563429399')
  })

  it('refuses to pick a canonical WhatsApp number, because docs/13 §3 shows two', () => {
    expect(PREMISES_NAP.phoneWhatsapp).toBe(WHATSAPP_PENDING)
    // The property that matters: it is not a number. A plausible one would be dialled.
    expect(PREMISES_NAP.phoneWhatsapp).not.toMatch(/\d{6}/)
    expect(WHATSAPP_PENDING.toLowerCase()).toContain('pending')
    expect(WHATSAPP_PENDING).toContain('Y1-NAP')
    // Both candidates are recorded, and neither is promoted. Two, because docs/13 §3 found two.
    expect(WHATSAPP_CANDIDATES).toHaveLength(2)
    expect(WHATSAPP_CANDIDATES.map((c) => c.value)).toEqual(['+971525108633', '+971528239069'])
    for (const candidate of WHATSAPP_CANDIDATES) {
      expect(candidate.source).toMatch(/docs\/13/)
      expect(candidate.value).not.toBe(PREMISES_NAP.phoneWhatsapp)
    }
  })

  it('trades 11:00 to 02:00, every day, which is what makes crosses_midnight true', () => {
    expect(TRADING_OPEN_TIME).toBe('11:00')
    expect(TRADING_CLOSE_TIME).toBe('02:00')
    // The close is LESS than the open. The whole business-day model rests on this comparison, and a
    // seed of 09:00–17:00 would leave every after-midnight path untested while every test passed.
    expect(TRADING_CLOSE_TIME < TRADING_OPEN_TIME).toBe(true)
    expect([...TRADING_DAYS_OF_WEEK]).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('carries no value docs/13 does not state', () => {
    // The fields deliberately absent from the seed. A plausible coordinate would put a map pin on the
    // wrong building, and a plausible PO box would be printed on a document.
    const keys = Object.keys(PREMISES_NAP)
    for (const absent of [
      'latitude',
      'longitude',
      'plusCode',
      'googlePlaceId',
      'poBox',
      'makaniNumber',
      'email',
      'directionsNotes',
    ]) {
      expect(keys, `docs/13 states no ${absent}`).not.toContain(absent)
    }
    // And the one free-text field it DOES state, verbatim.
    expect(PREMISES_NAP.parkingNotes).toBe(
      'Large public parking available at the back of the building',
    )
  })
})
