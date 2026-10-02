import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WHATSAPP_NUMBER_OPEN_QUESTION, whatsappLinkFor } from './premises-links.ts'
import {
  normaliseWhatsappRefCode,
  WHATSAPP_REF_CODE_PATTERN,
  whatsappRefMessage,
} from './whatsapp-ref.ts'

/**
 * A-FIRST-07 — the `wa.me` link, and the rule that it is composed from the row and nowhere else.
 *
 * Three claims, and the third is the one that needs a scan rather than an assertion:
 *
 *   1. The composer REFUSES a value that is not a dialable number, which today is every value the row can
 *      hold (Y1-nap). A union rather than a string, so there is no return value a page could render by
 *      accident.
 *   2. The prefilled message begins `Ref: <code>`, which is the half of the round trip this package owns.
 *   3. **No WhatsApp number literal exists anywhere in the repository**, and no second `wa.me` URL is
 *      assembled by hand. The first half is already `packages/db/src/seed/premises.test.ts`'s — it greps
 *      for this business's own numbers, both disputed WhatsApp candidates included. What that gate cannot
 *      see is a link built from a DIFFERENT number, or from an interpolation: `wa.me/${number}` written
 *      inline somewhere else carries no literal to grep for and is exactly the duplicate docs/09 §4 exists
 *      to prevent, because it is the copy that goes stale when the row is corrected.
 */

describe('whatsappLinkFor — a link, or a named refusal, and never a guess', () => {
  it('refuses the placeholder the premises row actually holds, naming the open question', () => {
    // The literal the seed writes, as the seed writes it. This is the state the build is in: docs/13 §3
    // records two candidate numbers and `premises.phone_whatsapp` ranks neither.
    const link = whatsappLinkFor({ phoneWhatsapp: 'WHATSAPP-PENDING-Y1-NAP' })
    expect(link.kind).toBe('unavailable')
    if (link.kind !== 'unavailable') throw new Error('unreachable')
    expect(link.refusal).toBe('whatsapp_number_unanswered')
    expect(link.openQuestionId).toBe(WHATSAPP_NUMBER_OPEN_QUESTION)
  })

  it('refuses every other value the column can hold that is not a dialable number', () => {
    // A POSITIVE shape test, so the refusal does not depend on recognising a placeholder. Each of these is
    // a real state: an unseeded row, a display-formatted number, a national number, a note somebody typed.
    // The last one is the one that matters — `+9715` is E.164-SHAPED and too short to dial.
    for (const value of [
      null,
      '',
      '   ',
      '+971 59 000 0001',
      '0590000001',
      'ask at the desk',
      '+9715',
      '971590000001',
    ]) {
      const link = whatsappLinkFor({ phoneWhatsapp: value })
      expect(link.kind, JSON.stringify(value)).toBe('unavailable')
    }
  })

  it('composes the link from the stored number, stripping only the plus', () => {
    // The unallocated +971 59 band `@berelax/fixtures` draws every synthetic number from, so this number
    // cannot reach a handset. Spelled here rather than imported because `shared` may import nothing
    // internal, and `59` is the one fact being relied on.
    const link = whatsappLinkFor({ phoneWhatsapp: '+971590000001' })
    expect(link.kind).toBe('link')
    if (link.kind !== 'link') throw new Error('unreachable')
    expect(link.href).toBe('https://wa.me/971590000001')
    // No `?text=` at all rather than an empty one: a trailing `?text=` opens WhatsApp with an empty draft
    // on some clients and is indistinguishable from a composer that forgot its argument.
    expect(link.href).not.toContain('?')
  })

  it('carries the prefilled message as an encoded parameter, newline included', () => {
    const link = whatsappLinkFor({
      phoneWhatsapp: '+971590000001',
      text: whatsappRefMessage('7K2Q', 'Hello'),
    })
    if (link.kind !== 'link') throw new Error('unreachable')
    const url = new URL(link.href)
    // Read back through `URL` rather than string-matched: what matters is what the client decodes, and a
    // raw newline in a URL is dropped or truncated depending on the client.
    expect(url.searchParams.get('text')).toBe('Ref: 7K2Q\nHello')
    expect(link.href).not.toContain('\n')
  })
})

describe('whatsappRefMessage — the ref line is first, and it is the whole message by default', () => {
  it('begins with Ref: and the code, which is the acceptance line', () => {
    expect(whatsappRefMessage('7K2Q')).toBe('Ref: 7K2Q')
    expect(whatsappRefMessage('7K2Q').startsWith('Ref: 7K2Q')).toBe(true)
    // With a body too, because the claim is about the BEGINNING and a body must not be able to get in front
    // of it: WhatsApp shows the start of a prefilled message, and a customer who edits edits the end.
    expect(whatsappRefMessage('7K2Q', 'Hello').startsWith('Ref: 7K2Q')).toBe(true)
  })

  it('adds no parameter for a blank body rather than a trailing newline', () => {
    for (const blank of ['', '   ', '\n\t']) {
      expect(whatsappRefMessage('7K2Q', blank)).toBe('Ref: 7K2Q')
    }
  })
})

/**
 * The normalisation table the acceptance line names, as a table.
 *
 * Here rather than beside the normaliser because the claim is about the ROUND TRIP: what the customer
 * reads off a phone screen, what the desk types, and what the column holds are three renderings of one
 * code, and the only thing that makes them one is this function. Case and surrounding space are the two
 * things a paste off a phone actually changes.
 */
describe('normaliseWhatsappRefCode — every spelling of one code is one code', () => {
  const SPELLINGS = ['7k2q', '7K2Q', ' 7K2Q ', ' 7k2q', '7K2q\t', '\n7k2Q\n'] as const

  it('resolves every spelling of 7K2Q to the same canonical code', () => {
    for (const spelling of SPELLINGS) {
      expect(normaliseWhatsappRefCode(spelling), JSON.stringify(spelling)).toBe('7K2Q')
    }
    // The control: the canonical form is what the COLUMN admits, so this is not a function agreeing with
    // itself about an arbitrary string.
    expect(WHATSAPP_REF_CODE_PATTERN.test('7K2Q')).toBe(true)
  })

  it('refuses to fold a character onto a neighbour, which would be a confident wrong join', () => {
    // `0` is not in the alphabet, so `7K20` cannot be a code. Folding it onto `O` — which is also not in
    // the alphabet — or onto anything else would be a GUESS about what the operator meant, and the thing
    // being guessed at is an attribution: a fold that lands on a real code produces a confident, wrong
    // join, where refusing produces `unknown_code` and an honestly unknown attribution.
    for (const near of ['7K20', '7K2O', '7K2U', '7K2L', '7K21', '7K2I']) {
      expect(normaliseWhatsappRefCode(near), near).toBeNull()
    }
    // And a value that is a code with something else attached is not that code: the pattern is anchored,
    // so a code is the whole value and never a substring.
    for (const extended of ['7K2QA', 'X7K2Q', 'Ref: 7K2Q', '7K2Q,']) {
      expect(normaliseWhatsappRefCode(extended), extended).toBeNull()
    }
  })
})

/** The rule name a violation is reported by (ADR 0003), so a known-bad fixture can assert on it. */
const WA_ME_RULE = 'wa-me-number-literal'

/**
 * The files allowed to contain `wa.me` at all, and why. A CLOSED list.
 *
 * Two entries. The composer holds the host and no digits; this file holds the expectations, which have to
 * be spelled somewhere. Anything else is a second URL assembled by hand, which is the duplicate the whole
 * `premises`-row arrangement exists to prevent.
 */
const WA_ME_EXEMPT: readonly { readonly path: string; readonly why: string }[] = [
  {
    path: join('packages', 'shared', 'src', 'premises-links.ts'),
    why: 'the composer: the one place the host is spelled, and it is spelled without a number',
  },
  {
    path: join('packages', 'shared', 'src', 'whatsapp-link.test.ts'),
    why: 'this file: the assertions and the scan patterns have to be spelled somewhere',
  },
  {
    // Found by this scan on its own first run, against the gate case written to prove it works: gate 157a
    // writes a fixture file holding a hand-built link, so the gate file holds that link as a string. The
    // same exemption, for the same reason, as `premises.test.ts`'s — "the gate file, whose own known-bad
    // fixtures are addresses and phone numbers".
    path: join('scripts', 'test-gates.mjs'),
    why: 'the gate file: case 157a’s own known-bad fixture is a hand-built wa.me link',
  },
]

const SCAN_ROOTS = ['packages', 'apps', 'scripts']
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.mjs']
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.next', '.claude', 'artifacts'])

function sourceFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRECTORIES.has(entry)) continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      if (SCAN_EXTENSIONS.some((extension) => entry.endsWith(extension))) found.push(path)
    }
  }
  walk(root)
  return found
}

/** The repository root, from this file's own location, so the scan does not depend on the cwd. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

describe('the wa.me link is composed from the premises row and nowhere else', () => {
  /**
   * `wa.me/` followed by anything that could be a number: a digit, a `+`, or a template interpolation.
   *
   * The interpolation case is the one a literal-number grep cannot see, and it is the likelier defect:
   * nobody types a phone number into a component twice, but somebody will write
   * `` `https://wa.me/${facts.phoneWhatsapp}` `` inline — which skips the E.164 check, publishes the
   * placeholder, and goes stale the day the row is corrected.
   */
  const NUMBERISH_WA_ME = /wa\.me\/\s*[0-9+$]/

  it('contains no hand-built wa.me URL anywhere in the repository', () => {
    const exemptPaths = new Set(WA_ME_EXEMPT.map((entry) => entry.path))
    const offenders: string[] = []
    let scanned = 0
    for (const root of SCAN_ROOTS) {
      for (const absolute of sourceFiles(join(REPO_ROOT, root))) {
        scanned += 1
        const relativePath = relative(REPO_ROOT, absolute).split(sep).join(sep)
        if (exemptPaths.has(relativePath)) continue
        const text = readFileSync(absolute, 'utf8')
        if (NUMBERISH_WA_ME.test(text)) {
          offenders.push(`[${WA_ME_RULE}] ${relativePath}`)
        }
      }
    }
    // The control first: a scan that read nothing would report no offenders, which is ADR 0002's failure.
    expect(scanned, 'files scanned').toBeGreaterThan(500)
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('names every file that mentions wa.me at all, so a second composer cannot appear quietly', () => {
    const mentions: string[] = []
    for (const root of SCAN_ROOTS) {
      for (const absolute of sourceFiles(join(REPO_ROOT, root))) {
        if (readFileSync(absolute, 'utf8').includes('wa.me/')) {
          mentions.push(relative(REPO_ROOT, absolute).split(sep).join(sep))
        }
      }
    }
    // Exactly the exemption list, in both directions. A third file mentioning the host is a second
    // composer, and a missing one means the composer has been renamed or deleted — which the first
    // assertion above could not tell from a repository with no WhatsApp link at all.
    expect([...mentions].sort()).toEqual([...WA_ME_EXEMPT.map((entry) => entry.path)].sort())
  })

  it('states a reason for every exemption', () => {
    for (const entry of WA_ME_EXEMPT) expect(entry.why.length, entry.path).toBeGreaterThan(20)
  })
})
