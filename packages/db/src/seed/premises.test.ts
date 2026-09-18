import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
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
  // The three below are W-SITE-02's, whose acceptance is a grep gate over apps/web and packages/ui with
  // its own known-bad fixture. It depends on this unit, so these are its to retire, not this unit's:
  // removing them now would mean writing the /api/facts read path B-CAT-06 does not own.
  { path: join('apps', 'web', 'app', '_document', 'shell.tsx'), why: 'W-SITE-02 (metadata)' },
  {
    path: join('apps', 'web', 'app', '(en)', '(public)', 'page.tsx'),
    why: 'W-SITE-02 (home copy)',
  },
  {
    path: join('apps', 'web', 'app', '(en)', '(dev)', 'kitchen-sink', 'page.tsx'),
    why: 'W-SITE-02 (component gallery copy)',
  },
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

const SCANNED_ROOTS = ['packages', 'apps', 'scripts']
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mjs']
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'dist', 'artifacts', '.turbo'])
/** Tests may carry a literal: a fixture asserting the seeded value has to name it. */
const isTestFile = (path: string) => /\.(?:test|itest)\.(?:ts|tsx|mjs)$/.test(path)

function sourceFiles(): readonly string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIPPED_DIRS.has(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full)
    }
  }
  for (const root of SCANNED_ROOTS) walk(root)
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
    for (const entry of EXEMPT) {
      expect(() => statSync(entry.path), `${entry.path} is exempt but absent`).not.toThrow()
      expect(entry.why.length, `${entry.path} is exempt with no stated reason`).toBeGreaterThan(10)
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
