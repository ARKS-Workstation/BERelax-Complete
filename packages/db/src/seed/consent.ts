import type { Sql } from '../connection.ts'

/**
 * The consent wording versions, and the fixture salon's consent states (C-CRM-03, H03).
 *
 * Two different kinds of thing, in one module because they are seeded together and the second needs the
 * first:
 *
 *   - **the wording versions** — one per purpose, EN and AR, which the schema needs before any grant can
 *     be recorded at all;
 *   - **the demonstrated states** — at least one contact in every (channel × purpose) combination in each
 *     of `granted`, `withdrawn` and never-asked, plus reconstructed contacts carrying no promotional
 *     consent whatsoever.
 *
 * ## The seeded wording is a DRAFT and says so in its own text
 *
 * This is the rule-15 decision in this unit and it is worth being explicit about. A consent statement is
 * legal copy: the real one comes from whoever advises this business, and the build has seen none
 * (`Y9-consent-wording`). A plausible-looking statement seeded here would be indistinguishable from an
 * approved one the moment somebody looked at the table — which is precisely the failure rule 15 names,
 * "blank is visibly unanswered, and plausible is indistinguishable from configured".
 *
 * So each seeded version does three things at once:
 *
 *   1. it opens with `[DRAFT WORDING …]` in both languages, so the text itself cannot be mistaken for
 *      approved copy by anyone who reads it, including a customer who is shown it in the fixture;
 *   2. it carries the provenance trio (`is_provisional`, `open_question_id`, `provisional_note`), so it
 *      appears in the Unconfirmed Assumptions panel through `unconfirmedAssumptionRows` — the same
 *      instrument 0031, 0032 and 0053 use for a provisional value;
 *   3. it is version 1 of an append-only series, so answering the question is an INSERT of version 2
 *      rather than an edit. Nothing has to be corrected in place, which is the whole reason the wording
 *      is versioned.
 *
 * It deliberately does NOT use a marker `is_placeholder_text()` refuses. That function is the right
 * instrument for a TRN or a licence number, where the value must be unusable; a wording that the
 * database refused to store would make every consent path in the build untestable, and an untested
 * consent path is a worse outcome than a visibly-drafted one.
 *
 * ## Why the contacts are an argument
 *
 * `packages/db` may not import `packages/fixtures`, and the guarantee that a fixture phone number is on
 * the unallocated `+971 59` prefix and cannot ring anybody lives there (`assertSynthetic`). So the
 * loader supplies the contacts and this module writes the rows; the alternative is a second, unasserted
 * spelling of the synthetic-number rule inside the package that has no way to check it.
 */

/** What a seeded contact is meant to demonstrate. */
export const CONSENT_SEED_STATES = [
  /** Granted for every (channel × purpose). The contact a campaign may message. */
  'granted',
  /** Granted and then withdrawn, so the log proves a withdrawal is a row and the grant survives it. */
  'withdrawn',
  /** No consent row at all — "never asked", which is the absence of a record and never a row. */
  'never_asked',
  /**
   * A reconstructed contact: `created_via = 'import'`, and zero promotional consent rows, without
   * exception (docs/11 §7, `Y8-customers`).
   */
  'reconstructed',
] as const
export type ConsentSeedState = (typeof CONSENT_SEED_STATES)[number]

export interface ConsentSeedContact {
  readonly phoneE164: string
  readonly locale: 'en' | 'ar'
  readonly state: ConsentSeedState
  /** Label for the capture's actor when the state needs one. Never a person's name (ADR 0020). */
  readonly label: string
}

export interface ConsentSeedInput {
  readonly contacts: readonly ConsentSeedContact[]
  /**
   * The frozen instant every seeded row is stamped with, as ISO-8601.
   *
   * Supplied rather than `now()`, and the reason is idempotence rather than taste: `pnpm seed` run twice
   * from clean has to produce the same rows (H03), and `consent_one_record_per_instant` is what makes the
   * second run a no-op. With `now()` the second run would insert a second, differently-timed grant for
   * every contact — and two grants at different instants is a log, not a duplicate, so nothing would
   * report it.
   */
  readonly recordedAtIso: string
}

/**
 * What the seed WROTE, not what it found.
 *
 * Counted that way on purpose, so a second `pnpm seed` prints zero rather than repeating the first run's
 * figure. `settingsLoader` had the opposite defect and its comment records it: it reported three settings
 * written whatever it had done, which is a loader that cannot tell you it did nothing.
 */
export interface ConsentSeedResult {
  readonly wordingVersions: number
  readonly contacts: number
  readonly consentRows: number
}

/** The channels consent is recorded per. `message_channel` since 0014; no second list. */
const CHANNELS = ['sms', 'email', 'whatsapp'] as const

/**
 * The drafted wording, one version per purpose.
 *
 * Every string opens with a visible draft marker — see the header. None of them contains a token
 * `is_placeholder_text()` refuses ('tbc', 'pending', 'unknown', 'todo' and the rest), because the row has
 * to be storable; the marker here is for the human reading it, and `is_provisional` is for the system.
 */
export const CONSENT_WORDING_DRAFTS: readonly {
  readonly purpose: string
  readonly textEn: string
  readonly textAr: string
}[] = Object.freeze([
  {
    purpose: 'marketing',
    textEn:
      '[DRAFT WORDING — not approved copy] I agree that BE RELAX may send me offers and news about ' +
      'its treatments by SMS, WhatsApp or email. I can stop this at any time using the link in any ' +
      'message.',
    textAr:
      '[صياغة مسودة — ليست نصًا معتمدًا] أوافق على أن ترسل لي "بي ريلاكس" عروضًا وأخبارًا عن علاجاتها ' +
      'عبر الرسائل القصيرة أو واتساب أو البريد الإلكتروني. يمكنني إيقاف ذلك في أي وقت عبر الرابط ' +
      'الموجود في أي رسالة.',
  },
  {
    purpose: 'review_request',
    textEn:
      '[DRAFT WORDING — not approved copy] I agree that BE RELAX may ask me, after a treatment, to ' +
      'leave a public review. I can stop this at any time using the link in any message.',
    textAr:
      '[صياغة مسودة — ليست نصًا معتمدًا] أوافق على أن تطلب مني "بي ريلاكس" بعد العلاج كتابة تقييم ' +
      'عام. يمكنني إيقاف ذلك في أي وقت عبر الرابط الموجود في أي رسالة.',
  },
  {
    purpose: 'clinical_processing',
    textEn:
      '[DRAFT WORDING — not approved copy] I agree that BE RELAX may record and use the health ' +
      'information I have given on this form so that my treatment is safe for me.',
    textAr:
      '[صياغة مسودة — ليست نصًا معتمدًا] أوافق على أن تسجل "بي ريلاكس" المعلومات الصحية التي ' +
      'قدمتها في هذا النموذج وتستخدمها لكي يكون علاجي آمنًا لي.',
  },
  {
    purpose: 'photography',
    textEn:
      '[DRAFT WORDING — not approved copy] I agree that BE RELAX may take and use photographs of me ' +
      'for its own website and social accounts.',
    textAr:
      '[صياغة مسودة — ليست نصًا معتمدًا] أوافق على أن تأخذ "بي ريلاكس" صورًا لي وتستخدمها على موقعها ' +
      'الإلكتروني وحساباتها على وسائل التواصل.',
  },
])

export const CONSENT_WORDING_OPEN_QUESTION = 'Y9-consent-wording'
export const CONSENT_WORDING_PROVISIONAL_NOTE =
  'Drafted by this build so the consent paths are testable. The consent statement a customer is shown ' +
  'is legal copy and the build has seen none; answering this question publishes version 2 rather than ' +
  'editing version 1, because consent_wording is append-only.'

/** A seeded version, as the consent rows need it: the id to reference and the hash to snapshot. */
export interface SeededWording {
  readonly id: string
  readonly purpose: string
  /** Lower-case hex of `consent_wording.content_hash`, which is GENERATED from the two texts. */
  readonly hashHex: string
}

/**
 * Publishes version 1 of every purpose's wording, if it is not already there.
 *
 * `on conflict (purpose, version) do nothing` and an explicit version 1, rather than
 * `publishConsentWording`'s `max(version) + 1`: a seed that computed the next version would publish
 * version 2 on its second run, and "seeding twice from clean is byte-identical" is the acceptance
 * criterion H03 is measured by. The repository's version arithmetic is right for an operator publishing a
 * correction and wrong for a seed.
 */
export async function seedConsentWording(
  sql: Sql,
  publishedAtIso: string,
): Promise<{ readonly versions: readonly SeededWording[]; readonly written: number }> {
  let written = 0
  for (const draft of CONSENT_WORDING_DRAFTS) {
    const inserted = await sql`
      insert into consent_wording
        (purpose, version, text_en, text_ar, published_at, is_provisional, open_question_id,
         provisional_note)
      values (
        ${draft.purpose}, 1, ${draft.textEn}, ${draft.textAr}, ${publishedAtIso}::timestamptz,
        true, ${CONSENT_WORDING_OPEN_QUESTION}, ${CONSENT_WORDING_PROVISIONAL_NOTE}
      )
      on conflict (purpose, version) do nothing
      returning id
    `
    written += inserted.length
  }
  const rows = await sql<{ id: string; purpose: string; hash_hex: string }[]>`
    select id, purpose, encode(content_hash, 'hex') as hash_hex
      from consent_wording where version = 1 order by purpose
  `
  return {
    versions: rows.map((row) => ({ id: row.id, purpose: row.purpose, hashHex: row.hash_hex })),
    written,
  }
}

/**
 * Seeds the wording, the fixture contacts and their consent rows. Idempotent.
 *
 * The consent rows are written with a direct INSERT rather than through `recordConsent`, for the reason
 * `seedCatalogue` and `seedTherapistRoster` write theirs directly: a seed has no actor and no request, so
 * a unit of work would have to invent one, and the audit row it wrote would claim a person made a
 * decision that a migration made. The zod contract is still honoured — every field it requires is
 * supplied below — and the database's own CHECKs and the hash trigger apply to these rows exactly as they
 * apply to a real capture, which is what makes the seed a test of the schema rather than a way round it.
 */
export async function seedConsent(sql: Sql, input: ConsentSeedInput): Promise<ConsentSeedResult> {
  const wording = await seedConsentWording(sql, input.recordedAtIso)
  const wordingByPurpose = new Map(wording.versions.map((row) => [row.purpose, row]))

  let contacts = 0
  let consentRows = 0

  for (const contact of input.contacts) {
    const ensured = await ensureSeedContact(sql, contact)
    if (ensured.created) contacts += 1
    consentRows += await seedContactConsent(sql, {
      contactId: ensured.id,
      contact,
      wordingByPurpose,
      recordedAtIso: input.recordedAtIso,
    })
  }

  return { wordingVersions: wording.written, contacts, consentRows }
}

/**
 * Finds or creates the fixture contact, and returns its id.
 *
 * `on conflict (phone_e164) do nothing` followed by a read, rather than `on conflict do update`: the row
 * IS the customer's identity (ADR 0014), and a seed has no business rewriting a locale or an origin that
 * somebody may have corrected since. `created_via = 'import'` for a reconstructed contact is the fact the
 * zero-promotional-consent rule is asserted against.
 */
async function ensureSeedContact(
  sql: Sql,
  contact: ConsentSeedContact,
): Promise<{ readonly id: string; readonly created: boolean }> {
  const [created] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, locale, created_via, display_name, name_match_key)
    values (
      ${contact.phoneE164}, ${contact.locale},
      ${contact.state === 'reconstructed' ? 'import' : 'front_desk'}, null, null
    )
    on conflict (phone_e164) do nothing
    returning id
  `
  if (created !== undefined) return { id: created.id, created: true }
  const [existing] = await sql<{ id: string }[]>`
    select id from customer where phone_e164 = ${contact.phoneE164}
  `
  if (existing === undefined) {
    throw new Error(
      `The consent seed could not find or create the contact ${contact.phoneE164}. Nothing deletes ` +
        'from customer inside this function, so the row must be there.',
    )
  }
  return { id: existing.id, created: false }
}

/** The rows one contact's state calls for, across every channel and purpose. Returns how many landed. */
async function seedContactConsent(
  sql: Sql,
  args: {
    readonly contactId: string
    readonly contact: ConsentSeedContact
    readonly wordingByPurpose: ReadonlyMap<string, SeededWording>
    readonly recordedAtIso: string
  },
): Promise<number> {
  // `never_asked` and `reconstructed` both get NO rows, for different reasons that happen to have the
  // same shape. Never-asked is the absence of a record by definition. A reconstructed contact is the
  // rule docs/11 §7 states without exception: the business's existing customer list arrives with
  // marketing_consent = false, which in an append-only model means no promotional row at all rather than
  // a row saying `withdrawn` — nobody withdrew anything, and nobody was ever asked.
  if (args.contact.state === 'never_asked' || args.contact.state === 'reconstructed') return 0

  let written = 0
  for (const channel of CHANNELS) {
    for (const draft of CONSENT_WORDING_DRAFTS) {
      const version = args.wordingByPurpose.get(draft.purpose)
      if (version === undefined) {
        throw new Error(
          `No version 1 wording for '${draft.purpose}' after seeding it. The insert uses ` +
            '`on conflict do nothing`, so an absent row means the purpose is not in the vocabulary.',
        )
      }
      written += await insertSeedConsent(sql, {
        contactId: args.contactId,
        channel,
        purpose: draft.purpose,
        kind: 'granted',
        recordedAtIso: args.recordedAtIso,
        wordingId: version.id,
        wordingHashHex: version.hashHex,
        locale: args.contact.locale,
        actorLabel: args.contact.label,
      })

      if (args.contact.state !== 'withdrawn') continue
      // A SECOND row, one minute later, and the grant above is left exactly as it is. That ordering is
      // the whole point: a withdrawn contact's log still contains the grant, which is what proves the
      // withdrawal was a new record rather than an edit.
      written += await insertSeedConsent(sql, {
        contactId: args.contactId,
        channel,
        purpose: draft.purpose,
        kind: 'withdrawn',
        recordedAtIso: oneMinuteAfter(args.recordedAtIso),
        // No wording on the withdrawal: `preference_centre` is where a real one comes from and the
        // statement shown there is C-CRM-04's. The schema allows it and says why.
        wordingId: null,
        wordingHashHex: null,
        locale: args.contact.locale,
        actorLabel: args.contact.label,
      })
    }
  }
  return written
}

async function insertSeedConsent(
  sql: Sql,
  args: {
    readonly contactId: string
    readonly channel: string
    readonly purpose: string
    readonly kind: 'granted' | 'withdrawn'
    readonly recordedAtIso: string
    readonly wordingId: string | null
    readonly wordingHashHex: string | null
    readonly locale: 'en' | 'ar'
    readonly actorLabel: string
  },
): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    insert into consent
      (contact_customer_id, channel, purpose, kind, recorded_at, consent_wording_id, wording_hash,
       capture_source, capture_actor_kind, capture_actor_label, capture_locale)
    values (
      ${args.contactId}, ${args.channel}::message_channel, ${args.purpose},
      ${args.kind}::consent_kind, ${args.recordedAtIso}::timestamptz, ${args.wordingId},
      decode(${args.wordingHashHex}, 'hex'),
      ${args.kind === 'granted' ? 'booking_form' : 'preference_centre'},
      'customer', ${args.actorLabel}, ${args.locale}
    )
    on conflict (contact_customer_id, channel, purpose, kind, recorded_at) do nothing
    returning id
  `
  return rows.length
}

/** One minute later, as ISO. Enough to order the withdrawal after the grant with no ambiguity. */
function oneMinuteAfter(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new Error(`The consent seed was given an unparseable instant: ${iso}`)
  }
  return new Date(ms + 60_000).toISOString()
}
