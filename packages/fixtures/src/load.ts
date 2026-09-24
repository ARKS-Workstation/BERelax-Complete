/**
 * Writing the fixture salon into a database.
 *
 * Two kinds of thing go through here, and the distinction matters more than the file name suggests.
 *
 * The **real business** — the premises and its 11:00–02:00 hours, the legal entity, the 32 prices of
 * docs/13 §4, the publication of the eight services — is seeded from `packages/db/src/seed/`, which
 * holds the transcriptions. The **fixture salon** — synthetic customers, an eight-therapist roster, the
 * historical book — comes from `salon.ts`. Both run from one `pnpm seed` because the demo dataset is
 * placed against the real trading window and the real menu; a loader that seeded its own hours would
 * make the two disagree.
 *
 * Therapists, appointments and invoices are loaded by `B-AVAIL`, `B-LIFE` and `M-VAT` once those tables
 * exist — each registers a loader here rather than writing its own seed script, so `pnpm seed` stays one
 * command and the ordering between loaders is explicit rather than implied by filenames.
 *
 * **Every loader must be idempotent.** Seeding twice from clean has to produce the same rows, which
 * is the acceptance criterion and also what makes a developer's `pnpm seed` safe to run twice when
 * they are not sure whether it worked the first time.
 */
import {
  assertPublicDisplayNameCompliant,
  horizonDates,
  horizonRows,
  hoursFromSchedule,
  localDate,
  localTime,
} from '@berelax/core'
import {
  CONSENT_SEED_STATES,
  type ConsentSeedContact,
  type ConsentSeedState,
  ensureLegalEntity,
  generateBusinessDays,
  readCompliancePolicy,
  readContactsByPhone,
  type Sql,
  type SuppressionSeedEntry,
  seedCatalogue,
  seedConsent,
  seedMessageTemplates,
  seedPremises,
  seedSettingDefaults,
  seedSuppression,
  seedTherapistRoster,
} from '@berelax/db'
import { DEFAULT_TEMPLATES } from '@berelax/messaging'
import {
  FIXTURE_CLOSE,
  FIXTURE_FORWARD_DAYS,
  FIXTURE_HISTORY_DAYS,
  FIXTURE_NOW_ISO,
  FIXTURE_OPEN,
  FIXTURE_TODAY,
} from './clock.ts'
import type { FixtureSalon } from './salon.ts'
import { fixtureSuppressionPeppers } from './suppression.ts'
import { assertSynthetic, syntheticPerson } from './synthetic.ts'

export interface Loader {
  /** Ordered: a loader runs after every loader it names. */
  readonly name: string
  readonly after: readonly string[]
  load(sql: Sql, salon: FixtureSalon): Promise<number>
}

/**
 * The premises, its trading hours and the legal entity — the real ones, from docs/13.
 *
 * The values used to be literals here, which made this file a second spelling of the address the
 * `premises` row is supposed to be the only source of. They now live in
 * `packages/db/src/seed/premises.ts`, which is a real seed rather than a fixture: this is the business's
 * own address and its own hours, not synthetic data, and the fixture salon's appointments are placed
 * against the same 11:00–02:00 window. B-CAT-06 moved them and left this loader as the ordering.
 *
 * Hours are the most load-bearing row in the database: 11:00 to 02:00 is what makes `crosses_midnight`
 * true and what makes every business-day calculation downstream mean something. Seeding 09:00 to 17:00
 * would leave the whole after-midnight path untested while every test still passed.
 */
const premisesLoader: Loader = {
  name: 'premises',
  after: [],
  async load(sql, salon) {
    void salon
    const rows = await seedPremises(sql)
    // The legal entity is 0026's singleton, ensured with 0026's own values and `do nothing`. It is
    // here so `pnpm seed` against a database that predates that migration still has an issuer, and it
    // must never carry a second spelling of the registered name: that name is snapshotted onto every
    // tax invoice, and a seed that "ensured" its own version once left the wrong one behind for every
    // later suite.
    return rows + (await ensureLegalEntity(sql))
  },
}

/**
 * The catalogue: the 32 prices of docs/13 §4, the publication of the 8 services, the price-on-request
 * items.
 *
 * Runs after `premises` because the trading hours are what make a published menu bookable at all, and
 * because `pnpm seed`'s output reads in that order.
 *
 * The compliance lint is assembled here rather than inside the seed, and this loader is the reason the
 * seam exists: `packages/db` may not import `packages/core`, so the term list comes out of
 * `regulatory_profile` through `readCompliancePolicy` and the lexicon comes from `@berelax/core`, and
 * `packages/fixtures` is the only package allowed to hold both. `seedCatalogue` refuses to publish a
 * name without a lint rather than defaulting to one that permits everything.
 */
const catalogueLoader: Loader = {
  name: 'catalogue',
  after: ['premises'],
  async load(sql, salon) {
    void salon
    const policy = await readCompliancePolicy(sql)
    const result = await seedCatalogue(sql, {
      lint: (name) =>
        assertPublicDisplayNameCompliant(name, {
          bannedClaimTerms: policy.bannedClaimTerms,
          permittedPublicTitles: policy.permittedPublicTitles,
          medicalClaimsPermitted: policy.medicalClaimsPermitted,
        }),
    })
    return result.variantsWritten + result.servicesPublished + result.priceOnRequestWritten
  },
}

/**
 * Settings the fixture world assumes.
 *
 * Written through the same store the application uses, so a value seeded here is indistinguishable
 * from one an owner set — including its audit trail. Anything not listed keeps its registry default,
 * which is deliberately the strict one.
 */
const settingsLoader: Loader = {
  name: 'settings',
  after: ['premises'],
  async load(sql, salon) {
    void salon
    // The registry's defaults FIRST, because nothing else creates an `app_setting` row: no migration seeds
    // the table, and `readSetting` deliberately falls back to the declared default for an absent key — so
    // the three UPDATEs below matched zero rows on any database that had not already run
    // `settings-store.itest.ts` or `availability.itest.ts`, while this loader went on reporting three
    // settings written. `seedSettingDefaults` is `on conflict do nothing`, which is what keeps the loader
    // idempotent (the acceptance criterion for every loader here). Found by M-VAT-03, whose two new
    // integration files changed the order vitest runs them in.
    await seedSettingDefaults(sql)
    const values: readonly [string, unknown][] = [
      ['booking.turnaround_minutes_standard', 15],
      ['booking.turnaround_minutes_wet', 30],
      ['packages.default_validity_months', 6],
    ]
    let changed = 0
    for (const [key, value] of values) {
      // `sql.json(value)` rather than `JSON.stringify(value)::jsonb`. postgres.js infers a string
      // parameter destined for jsonb as JSON and encodes it again, so the number 15 lands as the
      // JSON string "15" — which type-checks, stores, reads back, and is wrong.
      // `returning key`, and the count is what this loader reports: it used to return `values.length`
      // whatever it had done, which is a loader that says it seeded three settings while touching none.
      const result = await sql`
        update app_setting
        set value = ${sql.json(value as never)},
            updated_by = 'fixture-seed'
        where key = ${key}
        returning key
      `
      changed += result.length
    }
    return changed
  },
}

/**
 * The trading calendar, over the fixture's own horizon.
 *
 * Every report joins to `business_day`, so a fixture without it has no days to report on. The horizon
 * matches the appointments — history behind, forward book ahead — because a calendar shorter than the
 * data is a join that silently drops rows.
 */
const businessDayLoader: Loader = {
  name: 'business-days',
  after: ['premises'],
  async load(sql, salon) {
    void salon
    const hours = { open: localTime(FIXTURE_OPEN), close: localTime(FIXTURE_CLOSE) }
    const from = shift(FIXTURE_TODAY, -FIXTURE_HISTORY_DAYS)
    const days = FIXTURE_HISTORY_DAYS + FIXTURE_FORWARD_DAYS + 1
    const rows = horizonRows({
      from,
      days,
      hoursFor: hoursFromSchedule({ weekly: Array.from({ length: 7 }, () => hours) }),
    })
    const result = await generateBusinessDays(
      sql,
      rows.map((row) => ({
        tradingDate: row.tradingDate,
        opensAt: row.opensAt,
        closesAt: row.closesAt,
        source: row.source,
      })),
      { from, to: horizonDates(from, days).at(-1) ?? from },
    )
    return result.inserted + result.updated
  },
}

/**
 * The nineteen therapist employment records — the real roster's headcount, from docs/13 §5.
 *
 * Here rather than in migration 0050, and that is B-AVAIL-04's decision kept rather than reversed: an
 * employee row is an employment record, and nineteen of them in every database that has ever had the
 * migration applied is a fabricated person who can be rostered, paid and reported on. A seed is opt-in
 * and a migration is not. B-AVAIL-04 deferred the roster to P-HR for exactly this reason — "P-HR's
 * import would then be the second source for the same nineteen people" — and P-HR-01 is the unit that
 * owns the employment record, so this is where it lands.
 *
 * After `premises` for the ordering `pnpm seed` prints, and because every date comparison against these
 * rows is against a trading date. Nothing here depends on the fixture salon: `salon` is unused, as it is
 * in three of the four loaders above.
 */
const therapistRosterLoader: Loader = {
  name: 'therapists',
  after: ['premises'],
  async load(sql, salon) {
    void salon
    const result = await seedTherapistRoster(sql)
    return result.employeesWritten + result.skillsWritten
  },
}

/**
 * The shipped message templates, as ROWS (B-MSG-03).
 *
 * B-MSG-01 declared them as data and every use so far has rendered one at the call site. A `message` row
 * cannot exist without one: `message.template_id` is a `not null references message_template(id)`, because
 * "a message has to keep pointing at the words and the class it actually left with". A scheduled step
 * resolves its template by key at SEND time, so the row has to be here — and B-MSG-04's own NOTE hands
 * this seed to B-MSG-03 for exactly that reason.
 *
 * This loader is the seam, in the same shape the catalogue loader takes for its compliance lint:
 * `packages/db` may import `@berelax/shared` and `@berelax/config` only, so it cannot reach
 * `DEFAULT_TEMPLATES`, and `packages/fixtures` is the one package that may hold both halves. The seed
 * writes version 1 only and leaves later versions alone, which is what makes a second `pnpm seed` (H03's
 * idempotence criterion) produce the same rows and what stops it reverting an owner's reworded template.
 *
 * After `premises` for the ordering `pnpm seed` prints, and because nothing here depends on the fixture
 * salon: `salon` is unused, as it is in four of the five loaders above.
 */
const messageTemplateLoader: Loader = {
  name: 'message-templates',
  after: ['premises'],
  async load(sql, salon) {
    void salon
    const result = await seedMessageTemplates(sql, DEFAULT_TEMPLATES)
    return result.templatesWritten + result.variantsWritten
  },
}

/**
 * The consent wording versions and the fixture salon's consent states (C-CRM-03).
 *
 * Here rather than in `packages/db`'s own seed for one reason: the CONTACTS. `packages/db` may not import
 * `packages/fixtures`, and the guarantee that a fixture phone number sits on the unallocated `+971 59`
 * prefix and cannot ring anybody lives in `synthetic.ts` and is enforced by `assertSynthetic`. So the
 * numbers are built and checked here and the rows are written by `seedConsent`; a seed that spelled its
 * own numbers inside `packages/db` would be a second, unasserted copy of that rule in the one package
 * with no way to check it.
 *
 * `CONSENT_SEED_INDEXES` are deliberately outside the band `generateSalon` uses for its 140 synthetic
 * customers (1–140) and outside the bands the CRM integration suites hold (4411 upward), because a
 * collision under the phone-first identity rule is not a clash, it is one customer (ADR 0014) — and this
 * loader's contacts would silently become somebody else's probe subject.
 *
 * Every row is stamped with `FIXTURE_NOW_ISO` rather than the wall clock, which is what makes a second
 * `pnpm seed` a no-op: `consent_one_record_per_instant` collapses it. With `now()` the second run would
 * add a differently-timed grant per contact, and two grants at different instants is a log rather than a
 * duplicate, so nothing would report it.
 *
 * After `premises` for the ordering `pnpm seed` prints. It does not read the fixture salon.
 */
export const CONSENT_SEED_INDEXES: Readonly<Record<ConsentSeedState, number>> = Object.freeze({
  granted: 9101,
  withdrawn: 9102,
  never_asked: 9103,
  reconstructed: 9104,
})

/**
 * The four fixture contacts, from ONE builder.
 *
 * Exported because `packages/fixtures/src/consent.itest.ts` re-runs the seed in its own `beforeAll`: the
 * integration suite shares one database and `customer-identity.itest.ts` clears the whole `customer`
 * table between its cases, so a file that assumed the loader's contacts were still there would pass or
 * fail on vitest's file ordering (brief rule 12). Re-seeding is isolation by construction. It has to be
 * the same builder rather than a copy of it, or the file would assert about contacts the fixture does not
 * contain.
 */
export function consentSeedContacts(): readonly ConsentSeedContact[] {
  return CONSENT_SEED_STATES.map((state) => {
    const person = syntheticPerson(CONSENT_SEED_INDEXES[state])
    // Checked at the point of creation, not asserted once in a test somebody may later delete. A consent
    // record is the one row in this schema that says "you may message this number".
    assertSynthetic(person)
    return {
      phoneE164: person.phone,
      // Both locales are represented, because the wording is versioned per language and a fixture where
      // every capture happened in English would never show the Arabic column being used.
      locale: state === 'withdrawn' ? ('ar' as const) : ('en' as const),
      state,
      label: person.label,
    }
  })
}

const consentLoader: Loader = {
  name: 'consent',
  after: ['premises'],
  async load(sql, salon) {
    void salon
    const result = await seedConsent(sql, {
      contacts: consentSeedContacts(),
      recordedAtIso: FIXTURE_NOW_ISO,
    })
    return result.wordingVersions + result.contacts + result.consentRows
  },
}

/**
 * The fixture salon's suppression list (C-CRM-04).
 *
 * `SUPPRESSION_SEED_INDEXES` are outside every band already in use — `generateSalon`'s 1–140, the CRM
 * suites' 4411 upward, the consent loader's 9101–9104 and `consent.itest.ts`'s 9111–9112 — because a
 * collision under the phone-first identity rule is not a clash, it is one customer (ADR 0014), and this
 * loader's numbers would silently become somebody else's probe subject.
 *
 * Five entries, one per `suppression_source`, because a fixture in which every row said `manual` would
 * demonstrate one mechanism and document five. Three of them are about a detail this system has no
 * `customer` row for at all, which is not a gap in the fixture but the case the keying scheme exists for:
 * a hard bounce for an address, and a number on the national register that has never booked, are
 * suppressions with no contact to hang on — and a list keyed on a customer id could not hold either.
 *
 * Two DO name a contact, and they reuse the consent loader's rather than creating more: the
 * `preference_centre` entry is on the contact whose consent the consent loader already withdrew through
 * the preference centre, so the fixture holds the pair a real unsubscribe writes — a withdrawal and a
 * suppression, for one person.
 *
 * Every row is stamped with `FIXTURE_NOW_ISO` rather than the wall clock, which is what makes a second
 * `pnpm seed` a no-op: `suppression_one_record_per_instant` collapses it.
 */
export const SUPPRESSION_SEED_INDEXES = Object.freeze({
  complaint: 9201,
  hard_bounce: 9202,
  dnc_register: 9203,
})

/**
 * The five seeded entries, from ONE builder.
 *
 * Exported because `packages/fixtures/src/suppression.itest.ts` re-runs the seed in its own `beforeAll`:
 * the integration suite shares one database and `customer-identity.itest.ts` clears the whole `customer`
 * table between its cases, so a file that assumed these rows were still there would pass or fail on
 * vitest's file ordering (brief rule 12). `suppression` itself is append-only and nothing removes its
 * rows, but the two entries that name a contact resolve that contact by phone — so the builder takes the
 * ids it is given rather than ones it remembers.
 */
export function suppressionSeedEntries(
  contactIdByPhone: ReadonlyMap<string, string>,
): readonly SuppressionSeedEntry[] {
  const complaint = syntheticPerson(SUPPRESSION_SEED_INDEXES.complaint)
  const bounce = syntheticPerson(SUPPRESSION_SEED_INDEXES.hard_bounce)
  const dnc = syntheticPerson(SUPPRESSION_SEED_INDEXES.dnc_register)
  const manualSubject = syntheticPerson(CONSENT_SEED_INDEXES.never_asked)
  const linkSubject = syntheticPerson(CONSENT_SEED_INDEXES.withdrawn)
  // Checked at the point of creation, not asserted once in a test somebody may later delete. A
  // suppression entry is the one row in this schema that says "never message this number again", and a
  // fixture number that could ring a real handset would be the worst thing to get wrong here.
  for (const person of [complaint, bounce, dnc, manualSubject, linkSubject]) assertSynthetic(person)

  return [
    {
      keyKind: 'phone',
      recipient: manualSubject.phone,
      source: 'manual',
      state: 'suppressed',
      reason: 'Asked the front desk not to be included in offers.',
      actorKind: 'staff',
      actorLabel: 'Receptionist (fixture)',
      contactCustomerId: contactIdByPhone.get(manualSubject.phone) ?? null,
    },
    {
      keyKind: 'phone',
      recipient: complaint.phone,
      source: 'complaint',
      state: 'suppressed',
      reason: 'Complaint reported by the aggregator against this number.',
      actorKind: 'system',
      actorLabel: 'Aggregator feedback (fixture)',
      // No contact: a complaint can arrive about a number this business has no record of, which is
      // exactly why the list is keyed on the number.
      contactCustomerId: null,
    },
    {
      keyKind: 'email',
      recipient: bounce.email,
      source: 'hard_bounce',
      state: 'lifted',
      reason: 'Permanent delivery failure reported for this address.',
      actorKind: 'system',
      actorLabel: 'Mail provider feedback (fixture)',
      // No contact, and it CANNOT have one: `customer` has no email column at all (C-CRM-01's NOTE 3),
      // so no address in this system resolves to a record. The suppression works anyway, which is the
      // half of C-CRM-03's deferred email problem this unit can answer.
      contactCustomerId: null,
    },
    {
      keyKind: 'phone',
      recipient: dnc.phone,
      source: 'dnc_register',
      state: 'suppressed',
      reason: 'Listed on the national do-not-call register.',
      actorKind: 'system',
      actorLabel: 'DNC register import (fixture)',
      contactCustomerId: null,
    },
    {
      keyKind: 'phone',
      recipient: linkSubject.phone,
      source: 'preference_centre',
      state: 'suppressed',
      reason: 'Unsubscribed through the preference centre link.',
      actorKind: 'customer',
      actorLabel: 'Preference centre (link holder)',
      contactCustomerId: contactIdByPhone.get(linkSubject.phone) ?? null,
    },
  ]
}

const suppressionLoader: Loader = {
  name: 'suppression',
  // After `consent`, because two entries name a contact the consent loader creates. A suppression does
  // not NEED a contact — three of the five have none — but the pair a real unsubscribe writes is only in
  // the fixture if both halves are.
  after: ['consent'],
  async load(sql, salon) {
    void salon
    const wanted = [
      syntheticPerson(CONSENT_SEED_INDEXES.never_asked).phone,
      syntheticPerson(CONSENT_SEED_INDEXES.withdrawn).phone,
    ]
    const contacts = await readContactsByPhone(sql, wanted)
    const byPhone = new Map(contacts.map((row) => [row.phoneE164, row.contactId]))
    const result = await seedSuppression(sql, {
      entries: suppressionSeedEntries(byPhone),
      peppers: fixtureSuppressionPeppers(process.env),
      recordedAtIso: FIXTURE_NOW_ISO,
    })
    return result.suppressions + result.lifts
  },
}

function shift(date: string, offsetDays: number) {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + offsetDays)
  return localDate(value.toISOString().slice(0, 10))
}

const LOADERS: Loader[] = [
  premisesLoader,
  catalogueLoader,
  settingsLoader,
  businessDayLoader,
  therapistRosterLoader,
  consentLoader,
  suppressionLoader,
  messageTemplateLoader,
]

/** Registers a loader. Called by the unit that owns the tables it writes. */
export function registerLoader(loader: Loader): void {
  if (LOADERS.some((existing) => existing.name === loader.name)) {
    throw new Error(`A fixture loader named '${loader.name}' is already registered.`)
  }
  LOADERS.push(loader)
}

/** Loaders in dependency order. Throws on a cycle or an unknown dependency rather than guessing. */
export function orderedLoaders(): Loader[] {
  const byName = new Map(LOADERS.map((loader) => [loader.name, loader]))
  const ordered: Loader[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (name: string, trail: readonly string[]): void => {
    const status = state.get(name)
    if (status === 'done') return
    if (status === 'visiting') {
      throw new Error(`Fixture loaders form a cycle: ${[...trail, name].join(' -> ')}`)
    }
    const loader = byName.get(name)
    if (loader === undefined) {
      throw new Error(
        `Fixture loader '${trail.at(-1)}' depends on '${name}', which is not registered.`,
      )
    }
    state.set(name, 'visiting')
    for (const dependency of loader.after) visit(dependency, [...trail, name])
    state.set(name, 'done')
    ordered.push(loader)
  }

  for (const loader of LOADERS) visit(loader.name, [])
  return ordered
}

export interface LoadResult {
  readonly loader: string
  readonly rows: number
}

/** Runs every loader, in order, in one transaction. */
export async function loadSalon(sql: Sql, salon: FixtureSalon): Promise<LoadResult[]> {
  const results: LoadResult[] = []
  for (const loader of orderedLoaders()) {
    const rows = await loader.load(sql, salon)
    results.push({ loader: loader.name, rows })
  }
  return results
}
