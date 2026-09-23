import {
  AppError,
  CREDENTIAL_EXPIRING_SOON_SETTING_KEY,
  credentialExpiringSoonDaysSchema,
  DEFAULT_LLM_PROVIDER,
  DETECTABLE_REVIEW_LANGUAGES,
  GENDER_MATCHING_SETTING_KEY,
  genderMatchingModeSchema,
  LLM_PROVIDER_SETTING_KEY,
  llmProviderSchema,
  MINIMUM_REVIEW_COOLING_OFF_HOURS,
  PROVISIONAL_EXPIRING_SOON_DAYS,
  REVIEW_AUTOSEND_DISABLED,
  REVIEW_AUTOSEND_SETTING_KEY,
  REVIEW_COOLING_OFF_SETTING_KEY,
  REVIEW_REPLY_LANGUAGES_SETTING_KEY,
  reviewAutosendEnabledSchema,
  reviewCoolingOffHoursSchema,
  reviewReplyLanguagesSchema,
  STRICT_GENDER_MATCHING,
} from '@berelax/shared'
import { z } from 'zod'

/**
 * The settings registry.
 *
 * The owner's requirement is that everything be tweakable. The qualification (docs/07 §2) is that it
 * be **bounded**: every setting declares its type, its constraint, who may change it, whether the
 * change is audited, and what the change invalidates.
 *
 * Without the declaration, "configurable" means a free-text box that can put an illegible colour on
 * a page, a negative price in a catalogue, or a marketing send inside quiet hours. With it,
 * "configurable" means exactly the set of changes that cannot break the system — which is the version
 * worth having.
 */

export const SETTING_TIERS = [
  'content',
  'operational',
  'brand',
  'structural',
  'compliance_locked',
] as const
export type SettingTier = (typeof SETTING_TIERS)[number]

/** Cache tags a change invalidates. Next.js revalidation keys, so a change propagates without a deploy. */
export type CacheTag =
  | 'premises'
  | 'catalogue'
  | 'therapists'
  | 'content'
  | 'theme'
  | 'schema-jsonld'
  | 'facts'
  | 'availability'

export interface SettingDefinition<T = unknown> {
  readonly key: string
  readonly tier: SettingTier
  readonly schema: z.ZodType<T>
  readonly defaultValue: T
  /** Plain language, shown in the admin panel. */
  readonly label: string
  readonly help: string
  /** Roles permitted to change it. Checked in addition to the tier rule. */
  readonly editableBy: readonly string[]
  /** A change writes an audit row. Always true for operational and above. */
  readonly audited: boolean
  /** Routes/caches to invalidate on change. */
  readonly invalidates: readonly CacheTag[]
  /** Jobs to re-run on change, e.g. rebuilding scheduled reminders. */
  readonly rerunJobs?: readonly string[]
  /** Set when the build chose this value because no answer existed. */
  readonly provisional?: { readonly openQuestionId: string; readonly note: string }
}

const OWNER_ONLY = ['owner'] as const
const OWNER_MANAGER = ['owner', 'manager'] as const

function define<T>(d: SettingDefinition<T>): SettingDefinition<T> {
  if (d.tier !== 'content' && !d.audited) {
    throw new AppError(
      'invariant_violated',
      `Setting "${d.key}" is tier "${d.tier}" and must be audited. Only content-tier settings may be unaudited.`,
    )
  }
  if (d.tier === 'compliance_locked' && d.editableBy.some((r) => r !== 'owner')) {
    throw new AppError(
      'invariant_violated',
      `Setting "${d.key}" is compliance-locked and may only be editable by the owner, not ${d.editableBy.join(', ')}.`,
    )
  }
  return d
}

// --- the registry ------------------------------------------------------------------------------
// Provisional values are the STRICTEST safe option, so an uncorrected assumption leaves the system
// conservative rather than non-compliant. Each carries its OPEN-QUESTIONS id.

export const SETTINGS = [
  define({
    key: 'booking.turnaround_minutes_standard',
    tier: 'operational',
    schema: z.number().int().min(0).max(120),
    defaultValue: 20,
    label: 'Room turnaround (standard rooms)',
    help: 'Minutes a room is unavailable after a treatment for linen change, cleaning and airing. This occupies the ROOM, not the therapist.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: ['availability', 'catalogue'],
    provisional: {
      openQuestionId: 'Y9-turnaround',
      note: 'No real figure supplied; 20 minutes assumed.',
    },
  }),
  define({
    key: 'booking.turnaround_minutes_wet',
    tier: 'operational',
    schema: z.number().int().min(0).max(180),
    defaultValue: 30,
    label: 'Room turnaround (wet room)',
    help: 'The wet room almost certainly needs longer than a standard room. It is also the scarcest resource on the floor.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: ['availability'],
    provisional: {
      openQuestionId: 'Y9-turnaround',
      note: 'Assumed 50% longer than a standard room.',
    },
  }),
  define({
    key: 'booking.therapist_buffer_minutes',
    tier: 'operational',
    schema: z.number().int().min(0).max(60),
    defaultValue: 10,
    label: 'Therapist buffer each side',
    help: 'Protects the therapist between treatments. Distinct from room turnaround — different resource, different duration.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: ['availability'],
    provisional: { openQuestionId: 'Y9-buffer', note: '10 minutes each side assumed.' },
  }),
  define({
    key: 'booking.min_lead_minutes',
    tier: 'operational',
    schema: z
      .number()
      .int()
      .min(0)
      .max(60 * 48),
    defaultValue: 120,
    label: 'Minimum booking notice',
    help: 'How soon before a slot an online booking may still be made.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: ['availability'],
    provisional: { openQuestionId: 'Y9-lead', note: '2 hours assumed.' },
  }),
  define({
    key: 'booking.max_advance_days',
    tier: 'operational',
    schema: z.number().int().min(1).max(365),
    defaultValue: 90,
    label: 'How far ahead clients may book',
    help: 'Bookings beyond this horizon are refused online.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: ['availability'],
    provisional: { openQuestionId: 'Y9-lead', note: '90 days assumed.' },
  }),
  define({
    key: 'booking.cancellation_window_hours',
    tier: 'operational',
    schema: z.number().int().min(0).max(168),
    defaultValue: 24,
    label: 'Cancellation window',
    help: 'Cancellations inside this window are flagged as late. No fee is charged until a fee policy is agreed.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: ['content'],
    provisional: { openQuestionId: 'Y9-windows', note: '24 hours, flagged only, no fee.' },
  }),
  define({
    key: GENDER_MATCHING_SETTING_KEY,
    tier: 'compliance_locked',
    // `z.enum(GENDER_MATCHING_MODES)` and not a literal list: the same two labels are read by the rule
    // in `@berelax/core` and by the SQL in `@berelax/db`, neither of which may import the other, so the
    // set is spelled once in `@berelax/shared`. It previously read `['strict', 'advisory', 'off']`, and
    // `'off'` is gone deliberately — ADR 0020 and docs/01 decision 19 permit relaxing this constraint
    // to advisory and nothing further, so a stored value that switches it off entirely is a compliance
    // position no document supports. A row an older build left at `'off'` now READS as strict
    // (`genderMatchingMode`) rather than failing validation on the read path.
    schema: genderMatchingModeSchema,
    defaultValue: STRICT_GENDER_MATCHING,
    label: 'Same-gender therapist matching',
    help: "Strongly indicated by UAE municipal practice. A non-compliant appointment found at inspection is a licence risk, not a scheduling annoyance. Changing this requires the licensing authority's answer in writing.",
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: ['availability'],
    provisional: {
      openQuestionId: 'Y9-gender',
      note: 'Defaulted to strict, the safe position, pending written confirmation.',
    },
  }),
  define({
    key: 'messaging.promotional_window',
    tier: 'compliance_locked',
    schema: z.object({
      startHour: z.number().int().min(0).max(23),
      endHour: z.number().int().min(1).max(24),
    }),
    defaultValue: { startHour: 7, endHour: 21 },
    label: 'Promotional send window (Asia/Dubai)',
    help: 'TDRA restricts promotional SMS. This narrows the window only — it can never be widened beyond 07:00-21:00, and it cannot be switched off.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
  }),
  define({
    key: 'messaging.frequency_cap_per_week',
    tier: 'operational',
    schema: z.number().int().min(0).max(14),
    defaultValue: 2,
    label: 'Maximum marketing messages per contact per week',
    help: 'Applies across every flow and campaign combined, not per campaign.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y9-frequency-cap',
      note: 'No figure supplied; 2 per week assumed.',
    },
  }),
  define({
    key: 'packages.default_validity_months',
    tier: 'operational',
    schema: z.number().int().min(1).max(60),
    defaultValue: 6,
    label: 'Default package validity',
    help: 'Months from purchase. An existing package keeps the validity it was sold under — changing this never alters an outstanding balance.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: ['catalogue', 'content'],
    provisional: {
      openQuestionId: 'Y9-package-policy',
      note: '6 months, non-transferable, balance retained at expiry.',
    },
  }),
  define({
    key: 'theme.accent',
    tier: 'brand',
    schema: z.enum(['gold', 'green', 'teal']),
    defaultValue: 'gold' as const,
    label: 'Accent colour',
    help: 'Chosen from three curated pairings, each pre-validated for AA contrast in both light and dark mode. There is deliberately no free-form colour picker for text-bearing surfaces.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: ['theme'],
  }),
  define({
    key: 'theme.density',
    tier: 'brand',
    schema: z.enum(['comfortable', 'compact']),
    defaultValue: 'comfortable' as const,
    label: 'Interface density',
    help: 'Compact fits more rows on the front-desk screen.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: ['theme'],
  }),
  define({
    // Bound to `@berelax/shared`'s vocabulary rather than spelling the enum again, the same way the
    // four auto-send settings are. `packages/providers` turns the stored name into an adapter and
    // `packages/db` reads the row; three copies of one list is two chances to disagree.
    key: LLM_PROVIDER_SETTING_KEY,
    tier: 'operational',
    schema: llmProviderSchema,
    defaultValue: DEFAULT_LLM_PROVIDER,
    label: 'LLM provider',
    help: 'Used by both the review autoresponder and the SEO agent. The key is validated against the provider before saving: an invalid key is refused with the reason rather than stored and discovered by a silent agent.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
  }),
  define({
    key: 'agents.monthly_token_budget',
    tier: 'operational',
    schema: z.number().int().min(0).max(100_000_000),
    defaultValue: 2_000_000,
    label: 'Monthly LLM token budget',
    help: 'A hard cap. Agents stop rather than overspend, and the console shows cost to date against it.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
  }),
  define({
    /**
     * The OAuth consent screen's publishing status, and therefore whether every grant carries a fuse.
     *
     * A setting rather than an environment variable because it is a fact about the **Google Cloud
     * project**, not about this deployment: the owner (or whoever holds the Cloud project) publishes the
     * consent screen once, and every environment's grants stop expiring at the same moment. An env var
     * would have to be changed per environment by whoever happened to deploy next, and the tripwire
     * would go on telling the owner about a deadline that no longer exists — which is worse than no
     * tripwire, because a warning that turns out to be false teaches them to ignore the next one.
     *
     * The default is the strict answer and the reason is in docs/10 §3: **Testing is the default state
     * of every Cloud project**, so assuming Production is the same thing as not deciding, and it
     * silences the one check that catches the launch blocker.
     */
    key: 'google.consent_screen_publishing_status',
    tier: 'operational',
    schema: z.enum(['testing', 'production']),
    defaultValue: 'testing' as const,
    label: 'Google OAuth consent screen status',
    help: 'While this says Testing, the Google connection stops working seven days after it was authorised and the settings page shows the date it will happen. Change it to Production only once the consent screen has actually been published in the Google Cloud console.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y4-token-test',
      note: 'Testing assumed, which is the strictest safe answer: it is the default state of every Cloud project, and assuming otherwise would silence the seven-day tripwire. The nine-day experiment in docs/10 §8 settles it.',
    },
  }),
  define({
    /**
     * Whether Google has approved Basic API Access for the Cloud project.
     *
     * It changes what a refused Business Profile read *means*, which is why it has to be recorded
     * somewhere rather than inferred. While access is pending, quota sits at 0 QPM and every GBP call
     * fails however valid the token is — the launch-day normal for weeks, which the panel shows as
     * *Business Profile access pending Google approval* rather than as a fault (docs/10 §1). Once
     * approved, the identical refusal is a genuine permission problem the owner has to act on.
     *
     * Deriving it from the failures themselves is the obvious alternative and it is circular: the check
     * would conclude "not approved" from the very refusal it is trying to classify, so a real permission
     * problem would read as the launch-day normal for ever. The observable fact is quota moving 0 → 300
     * in the Cloud console, and a human is the only thing that can see it.
     */
    key: 'google.business_profile_access_granted',
    tier: 'operational',
    schema: z.boolean(),
    defaultValue: false,
    label: 'Google Business Profile API access approved',
    help: 'Google grants Business Profile API access by reviewing an application, not by enabling an API. Leave this off until the quota in the Cloud console moves from 0 to 300 QPM; while it is off, failing Business Profile checks are reported as waiting for Google rather than as a fault.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y2-gbp-status',
      note: 'Not approved assumed, because no application has been submitted yet. The conservative answer: it reports a pending approval rather than raising a fault the owner cannot fix.',
    },
  }),
  define({
    key: REVIEW_AUTOSEND_SETTING_KEY,
    tier: 'compliance_locked',
    /**
     * `reviewAutosendEnabledSchema`, not a local `z.boolean()`.
     *
     * The schema here says what may be *written*; `reviewAutosendEnabled` in `@berelax/shared` says what
     * a stored value *means*, and answers `false` for everything that is not the boolean `true`. A second
     * spelling of the type in this file is a second place for the two to disagree, which is the shape of
     * defect B-AVAIL-05 found in `booking.same_gender_matching`: the registry accepted a third value that
     * no document supported and nothing downstream had been taught to refuse.
     */
    schema: reviewAutosendEnabledSchema,
    defaultValue: REVIEW_AUTOSEND_DISABLED,
    label: 'Auto-send replies to 5-star reviews with no comment',
    help: 'Only ever applies to 4-5 star reviews with no free text and no named individual, in API mode, after a cooling-off delay. Everything else always needs a human.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
  }),
  define({
    /**
     * How long after a review is left before a reply may be auto-sent.
     *
     * `compliance_locked` and owner-only, for the same reason the switch above is: shortening it is the
     * only way to make an auto-send *happen sooner*, and the risk it exists to hold back is a reply
     * published under the business's name to a review the reviewer has since edited or deleted — which is
     * far more common in the first day than after it, and is not retractable through the API.
     *
     * The registry refuses a value below `MINIMUM_REVIEW_COOLING_OFF_HOURS` so the admin screen explains
     * itself, and `reviewCoolingOffHours` refuses one below the floor again when the value is *read*,
     * because a row written before this schema existed is not validated by it.
     */
    key: REVIEW_COOLING_OFF_SETTING_KEY,
    tier: 'compliance_locked',
    schema: reviewCoolingOffHoursSchema,
    defaultValue: MINIMUM_REVIEW_COOLING_OFF_HOURS,
    label: 'Review auto-send cooling-off delay (hours)',
    help: 'How long a 4-5 star review with no comment must sit before a reply may be sent without a human. Can be lengthened; cannot be set below 24 hours, because a reviewer editing or deleting a review in the first day is common and a published reply cannot be taken back.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y9-cooling-off',
      note: 'docs/07 §4 says "after a cooling-off delay" and names no number. 24 hours is the floor, not a figure somebody chose: it is the shortest delay this build will apply, and the owner has not been asked what it should be.',
    },
  }),
  define({
    /**
     * The languages a reply may be written in — docs/07 §4's "configured set".
     *
     * `operational` rather than `compliance_locked`, and that is not a relaxation. Widening this setting
     * cannot widen what auto-sends, because the enum is
     * `DETECTABLE_REVIEW_LANGUAGES`: a language this build cannot *identify* in a review cannot be in the
     * set, so a review in it is `'unknown'` and escalates however the row is written. Narrowing it only
     * escalates more. There is therefore no value here that relaxes the rule below its floor, which is
     * what decides the tier rather than the subject matter sounding compliance-shaped.
     */
    key: REVIEW_REPLY_LANGUAGES_SETTING_KEY,
    tier: 'operational',
    schema: reviewReplyLanguagesSchema,
    defaultValue: [...DETECTABLE_REVIEW_LANGUAGES],
    label: 'Languages review replies may be written in',
    help: 'A review in any other language — or in none this system can identify — is always escalated to a human. Adding a language here does not make replies in it possible; it has to be one the review router can recognise.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: [],
  }),
  define({
    /**
     * How long before a credential expires the registry starts warning about it (P-HR-02).
     *
     * `operational` and not `compliance_locked`, and the reason is the same one the review-reply
     * languages give: the tier follows what a value can RELAX, not what the subject sounds like.
     * EXPIRING_SOON is a warning and never a refusal — an employee whose every mandatory document is
     * expiring soon is still eligible (`packages/core/src/hr/credentials.ts`) — so no value here can make
     * anybody bookable who would otherwise not be. What removes a therapist from availability is EXPIRED,
     * and that is decided by the date on the document against the Asia/Dubai calendar, which no setting
     * touches.
     *
     * `credentialExpiringSoonDaysSchema` from `@berelax/shared` rather than a local `z.number()`, and
     * `PROVISIONAL_EXPIRING_SOON_DAYS` rather than the literal 60. Three packages that may not import one
     * another read this number — this registry, the `@berelax/db` reader and the `@berelax/core`
     * evaluator — and a second spelling is a second place for them to disagree.
     *
     * `invalidates: []` is a conclusion and not an oversight: nothing is prerendered from this value. It
     * is read per request by the HR credentials screen, and the notice job that will also read it is
     * P-HR-10's — when that job exists it belongs in `rerunJobs`, because changing the window changes
     * which notices are due.
     */
    key: CREDENTIAL_EXPIRING_SOON_SETTING_KEY,
    tier: 'operational',
    schema: credentialExpiringSoonDaysSchema,
    defaultValue: PROVISIONAL_EXPIRING_SOON_DAYS,
    label: 'Credential expiry warning window (days)',
    help: 'How far ahead of its expiry date a labour card, visa, health card or certificate is flagged as expiring soon. A warning only — a document is not refused until the day after it expires, judged on the Asia/Dubai calendar.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y1-licence',
      note: 'docs/04 §7 lists the therapist screening requirements and their renewal intervals as [UNVERIFIED], so the interval is unknown and the warning window that should precede it is unknown with it. 60 days is the longest of the three obvious candidates (30/60/90) and therefore the conservative one: a warning too early is noise, a warning too late is a therapist off the rota with a day of bookings to reassign by hand.',
    },
  }),
] as const

export type SettingKey = (typeof SETTINGS)[number]['key']

const BY_KEY = new Map<string, SettingDefinition>(
  SETTINGS.map((s) => [s.key, s as unknown as SettingDefinition]),
)

export function getDefinition(key: string): SettingDefinition {
  const def = BY_KEY.get(key)
  if (!def) {
    throw new AppError(
      'not_found',
      `Unknown setting "${key}". Settings must be declared in the registry.`,
    )
  }
  return def
}

/** Validates a proposed value, with a message the admin panel can show verbatim. */
export function validateSetting(key: string, value: unknown): unknown {
  const def = getDefinition(key)
  const result = def.schema.safeParse(value)
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ')
    throw new AppError('validation', `${def.label} — ${detail}`, {
      userFacing: true,
      details: { key, value },
    })
  }
  return result.data
}

export function assertRoleMayEdit(key: string, role: string): void {
  const def = getDefinition(key)
  if (!def.editableBy.includes(role)) {
    throw new AppError(
      'forbidden',
      `Role "${role}" may not change "${def.label}" (${def.tier} tier)`,
      { details: { key, role, tier: def.tier } },
    )
  }
}

/** Everything a change must invalidate, so no caller has to remember. */
export function invalidationsFor(key: string): {
  readonly cacheTags: readonly CacheTag[]
  readonly jobs: readonly string[]
} {
  const def = getDefinition(key)
  return { cacheTags: def.invalidates, jobs: def.rerunJobs ?? [] }
}

/** The Unconfirmed Assumptions panel. One screen, every value the build guessed. */
export function provisionalSettings(): readonly {
  key: string
  label: string
  openQuestionId: string
  note: string
  defaultValue: unknown
}[] {
  return SETTINGS.filter((s) => s.provisional !== undefined).map((s) => ({
    key: s.key,
    label: s.label,
    openQuestionId: s.provisional?.openQuestionId ?? '',
    note: s.provisional?.note ?? '',
    defaultValue: s.defaultValue,
  }))
}

export function defaultsForSeeding(): readonly {
  key: string
  tier: SettingTier
  value: unknown
  isProvisional: boolean
  openQuestionId: string | null
  provisionalNote: string | null
}[] {
  return SETTINGS.map((s) => ({
    key: s.key,
    tier: s.tier,
    value: s.defaultValue,
    isProvisional: s.provisional !== undefined,
    openQuestionId: s.provisional?.openQuestionId ?? null,
    provisionalNote: s.provisional?.note ?? null,
  }))
}
