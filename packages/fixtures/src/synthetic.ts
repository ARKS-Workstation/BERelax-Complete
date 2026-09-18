/**
 * Synthetic identity data, and the rules that keep it obviously synthetic.
 *
 * A fixture that looks like production data is a liability. It gets exported to a spreadsheet, shown
 * in a demo, pasted into a support ticket — and at some point somebody texts it. So the fixture is
 * built to be *unmistakable* at a glance and *undialable* in fact, and both properties are asserted
 * rather than intended.
 *
 * **Phone numbers use `+971 59`, which is not an allocated UAE mobile prefix.** Allocated mobile
 * prefixes are 050, 052, 054, 055, 056 and 058. A number on 059 cannot ring anybody today, which is
 * a stronger guarantee than a convention nobody remembers. `assertSynthetic` fails the build if a
 * generated number lands on a real prefix or matches either of the business's own numbers.
 *
 * **Names come from a fixed pool of plainly fictional names**, and every clinical note is prefixed
 * so that a screenshot of the clinical screen cannot be mistaken for a real record.
 */
import { AppError } from '@berelax/shared'
import type { Rng } from './rng.ts'

/** Mobile prefixes actually allocated in the UAE. A fixture number must avoid all of them. */
export const ALLOCATED_UAE_MOBILE_PREFIXES = ['50', '52', '54', '55', '56', '58'] as const

/** Unallocated, therefore undialable. Every fixture number starts here. */
export const SYNTHETIC_MOBILE_PREFIX = '59'

/** The business's real numbers, from docs/13. No fixture may collide with either. */
export const REAL_BUSINESS_NUMBERS = ['+971528239069', '+971563429399', '+971525108633'] as const

/** Deliberately unroutable: RFC 2606 reserves `.invalid` so nothing can ever be delivered. */
export const SYNTHETIC_EMAIL_DOMAIN = 'fixture.invalid'

/** Every clinical note carries this, so a screenshot cannot be mistaken for a record. */
export const CLINICAL_FIXTURE_PREFIX = 'FIXTURE (not a real record) —'

/**
 * Given names, plainly fictional, spanning the scripts the salon actually serves.
 *
 * Arabic and Latin both appear because a customer list that is entirely Latin never exercises the
 * bidirectional layout, and a therapist roster that is entirely one script never exercises the
 * name-rendering rules. The list is fixed rather than generated, so the fixture is reviewable.
 */
export const SYNTHETIC_GIVEN_NAMES = [
  'Amal',
  'Bilal',
  'Dana',
  'Faris',
  'Hana',
  'Idris',
  'Jamila',
  'Karim',
  'Layla',
  'Marwan',
  'Nadia',
  'Omar',
  'Rania',
  'Samir',
  'Tala',
  'Yusuf',
  'Zara',
  'Elena',
  'Grace',
  'Mei',
  'Nina',
  'Priya',
  'Sofia',
  'Thandi',
] as const

export const SYNTHETIC_FAMILY_NAMES = [
  'Al Fulani',
  'Testovic',
  'Sampleton',
  'Fixture',
  'Placeholder',
  'Demoson',
  'Mockridge',
  'Stubbs',
] as const

/** Arabic display names for the therapists whose profile is Arabic-first. */
export const SYNTHETIC_GIVEN_NAMES_AR = [
  'أمل',
  'بلال',
  'دانة',
  'فارس',
  'هناء',
  'ليلى',
  'كريم',
  'نادية',
] as const

export interface SyntheticPerson {
  readonly displayName: string
  readonly phone: string
  readonly email: string
}

/**
 * A person, whose phone number is derived from an index rather than drawn at random.
 *
 * Derivation guarantees uniqueness without a retry loop, and it makes the fixture's numbers legible:
 * customer 42 is `+971 59 000 0042`. A collision in a fixture is not a cosmetic problem — two
 * customers sharing a number would merge under the phone-first identity rule (ADR 0014) and the
 * fixture would silently have one fewer customer than it claims.
 */
export function syntheticPerson(rng: Rng, index: number): SyntheticPerson {
  const given = rng.pick(SYNTHETIC_GIVEN_NAMES)
  const family = rng.pick(SYNTHETIC_FAMILY_NAMES)
  const serial = String(index).padStart(7, '0')
  return {
    displayName: `${given} ${family}`,
    phone: `+971${SYNTHETIC_MOBILE_PREFIX}${serial}`,
    email: `${given.toLowerCase()}.${index}@${SYNTHETIC_EMAIL_DOMAIN}`,
  }
}

/**
 * Fails if anything in the fixture could be mistaken for, or could reach, a real person.
 *
 * Called by the generator on every person it produces, so the guarantee is enforced at the point of
 * creation rather than asserted once in a test somebody may later delete.
 */
export function assertSynthetic(person: SyntheticPerson): void {
  const problems: string[] = []

  const national = person.phone.replace('+971', '')
  const prefix = national.slice(0, 2)
  if ((ALLOCATED_UAE_MOBILE_PREFIXES as readonly string[]).includes(prefix)) {
    problems.push(
      `${person.phone} is on allocated UAE mobile prefix 0${prefix} and could reach a real handset`,
    )
  }
  if ((REAL_BUSINESS_NUMBERS as readonly string[]).includes(person.phone)) {
    problems.push(`${person.phone} is one of the business's own numbers`)
  }
  if (!person.email.endsWith(`@${SYNTHETIC_EMAIL_DOMAIN}`)) {
    problems.push(`${person.email} is not on the unroutable fixture domain`)
  }

  if (problems.length > 0) {
    throw new AppError(
      'invariant_violated',
      `Fixture data is not synthetic:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
      { details: { person, problems } },
    )
  }
}

/** A clinical note that cannot be mistaken for a real one, even in a screenshot. */
export function syntheticClinicalNote(body: string): string {
  return `${CLINICAL_FIXTURE_PREFIX} ${body}`
}
