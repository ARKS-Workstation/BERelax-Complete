import {
  ACCOUNT_CODE_PATTERN,
  AppError,
  CLINICAL_LINT_QUESTION_COPY_SETTING_KEY,
  CLINICAL_REAL_INTAKE_SETTING_KEY,
  CLINICAL_STEP_UP_WINDOW_MINUTES,
  CLINICAL_STEP_UP_WINDOW_SETTING_KEY,
  CREDENTIAL_EXPIRING_SOON_SETTING_KEY,
  clinicalStepUpWindowSchema,
  credentialExpiringSoonDaysSchema,
  DEFAULT_GOOGLE_REAUTH_REPEAT_CAP,
  DEFAULT_GRATUITY_EXPENSE_ACCOUNT,
  DEFAULT_GRATUITY_LIABILITY_ACCOUNT,
  DEFAULT_GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_OBLIGATION_ESCALATION_OFFSETS_DAYS,
  DEFAULT_OBLIGATION_REMINDER_OFFSETS_DAYS,
  DEFAULT_REMINDER_OFFSETS_HOURS,
  DETECTABLE_REVIEW_LANGUAGES,
  FRONT_DESK_MIN_LEAD_SETTING_KEY,
  GENDER_MATCHING_SETTING_KEY,
  GOOGLE_REAUTH_REPEAT_CAP_SETTING_KEY,
  GOOGLE_REAUTH_SMS_SETTING_KEY,
  GRATUITY_ACCOUNTS_OPEN_QUESTION_ID,
  GRATUITY_EXPENSE_ACCOUNT_SETTING_KEY,
  GRATUITY_LIABILITY_ACCOUNT_SETTING_KEY,
  GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT_SETTING_KEY,
  genderMatchingModeSchema,
  LLM_PROVIDER_SETTING_KEY,
  llmProviderSchema,
  MAX_GOOGLE_REAUTH_LADDER_STEPS,
  MAX_OBLIGATION_NOTICE_OFFSET_DAYS,
  MAX_OBLIGATION_NOTICE_OFFSETS,
  MAX_REMINDER_OFFSET_HOURS,
  MAX_REMINDER_OFFSETS,
  MINIMUM_REVIEW_COOLING_OFF_HOURS,
  OBLIGATION_ESCALATION_OFFSETS_SETTING_KEY,
  OBLIGATION_REMINDER_OFFSETS_SETTING_KEY,
  PLACEHOLDER_WPS_AGENT_ID,
  PLACEHOLDER_WPS_EMPLOYER_ID,
  PROVISIONAL_EXPIRING_SOON_DAYS,
  PROVISIONAL_FRONT_DESK_MIN_LEAD_MINUTES,
  PROVISIONAL_LINT_QUESTION_COPY,
  PROVISIONAL_REAL_INTAKE_PERMITTED,
  PROVISIONAL_RIGHTS_SLA_DAYS,
  PROVISIONAL_SUPERVISORY_AUTHORITY,
  PROVISIONAL_WHATSAPP_REF_EXPECTED,
  PROVISIONAL_WHATSAPP_REF_TTL_DAYS,
  REBUILD_OBLIGATION_NOTICES_JOB,
  REBUILD_SCHEDULED_STEPS_JOB,
  REMINDER_OFFSETS_SETTING_KEY,
  REVIEW_AUTOSEND_DISABLED,
  REVIEW_AUTOSEND_SETTING_KEY,
  REVIEW_COOLING_OFF_SETTING_KEY,
  REVIEW_REPLY_LANGUAGES_SETTING_KEY,
  RIGHTS_SLA_DAYS_SETTING_KEY,
  RIGHTS_SLA_PROVENANCE,
  RIGHTS_SUPERVISORY_AUTHORITY_SETTING_KEY,
  reviewAutosendEnabledSchema,
  reviewCoolingOffHoursSchema,
  reviewReplyLanguagesSchema,
  rightsSlaDaysSchema,
  rightsSupervisoryAuthoritySchema,
  STRICT_GENDER_MATCHING,
  WHATSAPP_REF_EXPECTED_SETTING_KEY,
  WHATSAPP_REF_TTL_SETTING_KEY,
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
/**
 * A compliance-locked setting that is ACCOUNTING policy: the owner, and the accountant.
 *
 * Not a relaxation of the tier, and the manager is still refused. The tier holds two kinds of decision
 * and they are locked to two different people. Customer-safety policy — same-gender matching, the
 * promotional window, review auto-send — is the owner's alone, and `settings:write_compliance` in the F07
 * matrix says so with a test asserting the list is exactly `['owner']`. Revenue recognition is the
 * accountant's: the role the matrix already trusts with `ledger:post`, `period:lock`,
 * `vat_return:prepare` and `invoice:credit_note`. `settings:write_accounting_policy` is that second
 * permission, and `packages/fixtures/src/package.test.ts` holds this list and the matrix equal — the one
 * place `@berelax/config` and `@berelax/core` can both be imported.
 */
const OWNER_ACCOUNTANT = ['owner', 'accountant'] as const

/**
 * Who may hold a compliance-locked setting at all.
 *
 * Spelled as a list rather than as `=== 'owner'` because the tier now covers two locks (see
 * {@link OWNER_ACCOUNTANT}), and a predicate naming one role would have had to be widened to `!== 'manager'`
 * — which permits the receptionist, the therapist and the marketer by omission. An allow-list cannot fail
 * that way.
 */
const COMPLIANCE_LOCKED_EDITORS: readonly string[] = ['owner', 'accountant']

function define<T>(d: SettingDefinition<T>): SettingDefinition<T> {
  if (d.tier !== 'content' && !d.audited) {
    throw new AppError(
      'invariant_violated',
      `Setting "${d.key}" is tier "${d.tier}" and must be audited. Only content-tier settings may be unaudited.`,
    )
  }
  if (
    d.tier === 'compliance_locked' &&
    d.editableBy.some((r) => !COMPLIANCE_LOCKED_EDITORS.includes(r))
  ) {
    throw new AppError(
      'invariant_violated',
      `Setting "${d.key}" is compliance-locked and may only be editable by ` +
        `${COMPLIANCE_LOCKED_EDITORS.join(' or ')}, not ${d.editableBy.join(', ')}.`,
    )
  }
  return d
}

/**
 * The three package-policy setting keys.
 *
 * Spelled here and used in the definitions below, so there is ONE string per key rather than a literal in
 * the registry and another in every reader. `packages/db/src/settings/package.ts` imports these; the
 * obligation ladders one screen up take the same shape for the same reason, and the reason is that a
 * mismatched spelling is a reader that silently falls back to a declared default.
 */
export const PACKAGE_VALIDITY_MONTHS_SETTING_KEY = 'packages.default_validity_months'
export const PACKAGE_TRANSFERABLE_SETTING_KEY = 'packages.default_transferable'
export const PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY = 'packages.unredeemed_balance_policy'

/** All three, for a panel or a test that has to prove none of them was forgotten. */
export const PACKAGE_POLICY_SETTING_KEYS = [
  PACKAGE_VALIDITY_MONTHS_SETTING_KEY,
  PACKAGE_TRANSFERABLE_SETTING_KEY,
  PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY,
] as const

/**
 * Whether the commission module computes anything (P-HR-11, Y9-commission).
 *
 * Spelled once here for the reason the package keys are: the HR commission screen reads it, the run
 * orchestrator takes the answer as an argument, and the gate asserts it is flagged provisional — three
 * readers, and a second spelling is a reader that silently falls back to the declared default.
 */
export const COMMISSION_ENABLED_SETTING_KEY = 'hr.commission_enabled'

/**
 * The deposit policy: whether a deposit may be taken at all, and what share of the gross one is
 * (Y-PAY-06, `Y9-deposits`).
 *
 * Spelled once here for the reason the package keys are: `packages/db/src/settings/payments.ts` reads
 * them, the checkout's apply step reads the first of them, and the Unconfirmed Assumptions panel lists
 * both — and a second spelling is a reader that silently falls back to the declared default, which for
 * the percentage would be invisible because the fallback is a number.
 */
export const DEPOSIT_ENABLED_SETTING_KEY = 'payments.deposit_enabled'
export const DEPOSIT_PERCENT_BP_SETTING_KEY = 'payments.deposit_percent_bp'

/** Both, for a panel or a test that has to prove neither was forgotten. */
export const DEPOSIT_POLICY_SETTING_KEYS = [
  DEPOSIT_ENABLED_SETTING_KEY,
  DEPOSIT_PERCENT_BP_SETTING_KEY,
] as const

/** The open question both deposit settings stand in for. */
export const DEPOSIT_POLICY_OPEN_QUESTION_ID = 'Y9-deposits'

/**
 * Zero basis points, which is `build/manifest.yaml`'s own provisional value for Y-PAY-06 — "no services
 * enrolled, 0% of gross" — and not a rate this build chose.
 *
 * 10,000bp is the whole, as `SHOW_UP_RATE_WHOLE_BP` below also states for its own quantity.
 */
export const PROVISIONAL_DEPOSIT_PERCENT_BP = 0

/**
 * The two identifiers a WPS salary file names, and the one question behind both (`Y8-wps`).
 *
 * Spelled once here because three readers want them: the payroll screen, `exportWpsFile` in `@berelax/hr`,
 * and the Unconfirmed Assumptions panel. A second spelling is a reader that silently falls back to the
 * declared default — which for these two is a placeholder, so the fallback would be invisible.
 */
export const WPS_EMPLOYER_ID_SETTING_KEY = 'hr.wps_employer_id'
export const WPS_AGENT_ID_SETTING_KEY = 'hr.wps_agent_id'

/**
 * The two values the 13-week cash forecast and the seasonality report assume (R-REP-06, ADR 0073).
 *
 * Spelled once here for the reason the package keys are: `apps/worker/src/jobs/cash-forecast.ts` reads
 * them and the Unconfirmed Assumptions panel lists them, and a second spelling is a reader that silently
 * falls back to the declared default — which for the show-up rate would be invisible, because the
 * fallback is a plausible number.
 *
 * The arithmetic in `packages/core` reads NEITHER: both arrive as required arguments, so a figure
 * computed there always names where its rate came from (ADR 0070's rule 4, inherited).
 */
export const FORECAST_SHOW_UP_RATE_BP_SETTING_KEY = 'reporting.forecast_show_up_rate_bp'
export const SEASONALITY_SUMMER_MONTHS_SETTING_KEY = 'reporting.seasonality_summer_months'

/**
 * 10,000 basis points is the whole, as the upper bound on the show-up rate.
 *
 * A THIRD statement of a figure `packages/core` exports twice — `BASIS_POINTS` as a `number` and
 * `WHOLE_IN_BASIS_POINTS` as a `bigint` — and unavoidable here, because `@berelax/config` depends on
 * `@berelax/shared` alone and may not reach `@berelax/core`. It therefore arrives with the check that
 * holds it equal in the same commit: `packages/fixtures/src/cash-forecast.itest.ts` asserts
 * `Number(WHOLE_IN_BASIS_POINTS) === SHOW_UP_RATE_WHOLE_BP`, in a package that may import both.
 */
export const SHOW_UP_RATE_WHOLE_BP = 10_000

/**
 * 9,000 basis points — a 10% no-show rate — which is `build/manifest.yaml`'s own provisional value for
 * R-REP-06 and is owned by `Y9-windows`.
 */
export const PROVISIONAL_SHOW_UP_RATE_BP = 9_000

/** July and August, from docs/06 B6. `Y9-summer-window` owns them; see the setting's own comment. */
export const PROVISIONAL_SUMMER_MONTHS: readonly number[] = Object.freeze([7, 8])

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
    /**
     * The notice the FRONT DESK needs, as distinct from the notice an online booking needs.
     *
     * A setting of its own and not a reuse of `booking.min_lead_minutes`, because Y9-lead's question is
     * "minimum **online** booking lead time" in so many words and the help text above says the same. Two
     * hours at the counter would make B-UI-04's quick-book screen unable to do the one thing it exists for:
     * a walk-in standing at the desk cannot be booked in two hours' time.
     *
     * Zero is the provisional value, and it is the SAFE direction rather than the convenient one. The
     * availability engine still refuses a start with no free therapist and no free room, so a zero desk
     * lead cannot produce a booking the salon cannot deliver — only an imminent one, which is a person at
     * the counter the desk can decline. The other direction is not symmetrical, and that asymmetry is the
     * argument: a two-hour desk lead cannot be found by a test that asserts "a slot is offered", because a
     * slot two hours out IS a slot, so the screen would look exactly right and be useless.
     */
    key: FRONT_DESK_MIN_LEAD_SETTING_KEY,
    tier: 'operational',
    schema: z
      .number()
      .int()
      .min(0)
      .max(60 * 48),
    defaultValue: PROVISIONAL_FRONT_DESK_MIN_LEAD_MINUTES,
    label: 'Minimum notice at the front desk',
    help: 'How soon before a slot the desk may still take a booking. Zero lets the desk seat a walk-in now; the online minimum is separate.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: ['availability'],
    provisional: {
      openQuestionId: 'Y9-lead',
      note:
        'Zero assumed. Y9-lead states a 2-hour minimum for ONLINE booking and says nothing about the ' +
        'counter; a walk-in screen that applied it could not book a walk-in.',
    },
  }),
  define({
    /**
     * Whether the front desk is expected to paste the WhatsApp ref code at all — **Y12-ref-loop**, as a
     * value the code reads.
     *
     * `false` because nobody has said they will. What it controls is one thing and it is NOT the field: the
     * field is present and prominent either way, which is what the unit's acceptance asks for. It controls
     * what a capture RATE is allowed to claim. At `false`, a 0% rate is reported as *the ref loop is
     * unconfirmed* rather than as *the desk is failing to capture*; at `true`, the same 0% is a process
     * failure somebody should be told about. One number, two findings, and only the owner can say which.
     *
     * The consumer is named so this is not a knob nothing consults: `refCaptureRate` in `@berelax/core`
     * takes it as an argument and returns a different `claim`.
     */
    key: WHATSAPP_REF_EXPECTED_SETTING_KEY,
    tier: 'operational',
    schema: z.boolean(),
    defaultValue: PROVISIONAL_WHATSAPP_REF_EXPECTED,
    label: 'Front desk records the WhatsApp ref code',
    help: 'Turn on once the desk is expected to paste the code. Until then a low capture rate is reported as an unanswered question rather than as a failure.',
    editableBy: OWNER_MANAGER,
    audited: true,
    // Nothing about availability or the catalogue changes; what changes is a report's wording, so the
    // content tag is the honest one. It is NOT tagged `availability`, which would purge the slot memo for a
    // change that cannot alter a slot.
    invalidates: ['content'],
    provisional: {
      openQuestionId: 'Y12-ref-loop',
      note:
        'False assumed. Nobody has said the front desk will paste the ref code, so attribution degrades ' +
        'to unknown and the funnel reports the gap rather than inventing the join.',
    },
  }),
  define({
    /**
     * How long a WhatsApp ref code stays claimable — **Y12-ref-ttl**, as a value the issue path reads.
     *
     * ## Why there is an expiry at all, which is the decision rather than the number
     *
     * A code with no expiry is a join key for ever. The four characters sit in the customer's chat
     * history, and a year later the front desk can still type them in and attribute a booking to a
     * conversation nobody remembers — against an analytics session the 90-day retention purge removed
     * months earlier. So the question is not whether to expire but what the window is.
     *
     * Seven days is the provisional answer and it is the direction that fails SAFELY. Too short records
     * `ref_expired`, which keeps the code, takes the booking and shows up as a visible count somebody can
     * act on; too long produces confident attributions nobody can check. The asymmetry is the argument,
     * exactly as it is for `booking.front_desk_min_lead_minutes` above.
     *
     * ## What changing it does and does not do
     *
     * The figure is read ONCE, at issue, and stamped on the row as `whatsapp_ref.expires_at`. Answering
     * this question therefore governs codes issued afterwards and never rewrites the recorded outcome of a
     * booking already taken — which is a property of migration 0127 rather than of this entry, and is why
     * the column is not a recomputation.
     *
     * At least one day, because a zero-day code is dead the instant it is issued and the column's own
     * CHECK (`expires_at > issued_at`) refuses it; at most 90, which is the raw analytics retention window
     * (`analytics.raw_retention_days()`). A code outliving the session it names would be a join key
     * pointing at a row that has been purged, and the ceiling is read off that figure rather than chosen.
     */
    key: WHATSAPP_REF_TTL_SETTING_KEY,
    tier: 'operational',
    schema: z.number().int().min(1).max(90),
    defaultValue: PROVISIONAL_WHATSAPP_REF_TTL_DAYS,
    label: 'WhatsApp ref code lifetime',
    help: 'How many days a reference code from a WhatsApp conversation can still be claimed at the desk. An expired code still takes the booking; the attribution is recorded as expired.',
    editableBy: OWNER_MANAGER,
    audited: true,
    // Nothing about availability or the catalogue changes. What changes is how long a code is claimable,
    // which a report's wording reflects — the same tag `booking.whatsapp_ref_expected` takes, and NOT
    // `availability`, which would purge the slot memo for a change that cannot alter a slot.
    invalidates: ['content'],
    provisional: {
      openQuestionId: 'Y12-ref-ttl',
      note:
        'Seven days assumed. Nobody has measured how long a WhatsApp conversation takes to become a ' +
        'booking, and the alternative to a guessed window is no window — a join key that never dies.',
    },
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
    key: REMINDER_OFFSETS_SETTING_KEY,
    tier: 'operational',
    // Whole hours before the treatment, each between 1 and a week, no repeats, at most four. The bounds
    // are restated as a CHECK in migration 0051, because the database cannot import this registry and a
    // `reminder_9999h` step would schedule a reminder for a year before the booking.
    schema: z
      .array(z.number().int().min(1).max(MAX_REMINDER_OFFSET_HOURS))
      .max(MAX_REMINDER_OFFSETS)
      .refine((hours) => new Set(hours).size === hours.length, {
        message: 'each reminder must be a different number of hours before the treatment',
      }),
    defaultValue: [...DEFAULT_REMINDER_OFFSETS_HOURS],
    label: 'Appointment reminders',
    help: 'How many hours before the treatment each reminder is sent. An empty list turns reminders off. Changing this rebuilds the reminders of every booking already taken, not only the ones made afterwards.',
    editableBy: OWNER_MANAGER,
    audited: true,
    // No cache tag: a reminder is a message rather than a page, so nothing rendered changes. The work is
    // the REBUILD, and `rerunJobs` is what carries it — the field this registry has declared since F09
    // with the comment 'e.g. rebuilding scheduled reminders', and this is the setting it was written for.
    invalidates: [],
    rerunJobs: [REBUILD_SCHEDULED_STEPS_JOB],
    provisional: {
      openQuestionId: 'Y9-windows',
      note: 'No reminder policy supplied; 24 hours and 2 hours before the treatment assumed.',
    },
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
    /**
     * Bounded INSIDE 07:00-21:00, which is C-AUTO-04's half of "the window cannot be switched off".
     *
     * It used to be `min(0).max(23)` / `min(1).max(24)`, so the schema accepted `{startHour: 0, endHour:
     * 24}` — the whole day, which is quiet hours switched off — and the only thing refusing it was
     * `assertPromotionalWindowChange` in `@berelax/messaging`. That is the right refusal and it was the
     * ONLY one, so every route into this row that did not go through that function accepted a widening:
     * a seed, an import, `writeSetting` called from a script, and the admin panel's own validation error
     * message, which said nothing about a ceiling because the schema had none.
     *
     * The same three-layer arrangement C-AUTO-03 gave the frequency cap, for the same reason — the failure
     * is somebody at 2am who wants a campaign out: code refuses it (`assertPromotionalWindowChange`, with
     * the role and the reason), this schema refuses it (so the admin panel does), and
     * `promotional_window_is_a_narrowing()` in migration 0087 refuses it in the database (so a `psql`
     * session does, and so does a restore running with triggers off).
     *
     * `.refine` rather than two more bounds, because "07:00-21:00 is a window and 20:00-08:00 is not" is a
     * relation between the two fields and no per-field bound can express it. An inverted window is how
     * "disable quiet hours" gets spelled by somebody who has read that the hours may only be narrowed.
     */
    schema: z
      .object({
        startHour: z.number().int().min(7).max(20),
        endHour: z.number().int().min(8).max(21),
      })
      .refine((w) => w.startHour < w.endHour, {
        message:
          'The promotional window must open before it closes. A window whose start is at or after its ' +
          'end never opens, which is not a narrowing of quiet hours but a different rule with no hours ' +
          'in it.',
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
    /**
     * `min(1)`, not `min(0)`, and the change is the whole of C-AUTO-03's "the cap cannot be switched off".
     *
     * A cap of 0 looks like the strictest possible setting and is in fact the ambiguous one: in every
     * other `max_` setting anybody has met, 0 ALSO means "no limit", so a reader that treats it as falsy
     * ("no cap configured, so allow") turns the strictest value into the switched-off one. Stopping
     * promotional traffic altogether is the marketing kill switch's job (C-AUTO-05), which says so on its
     * face and records who engaged it. `assertFrequencyCapLimit` in `@berelax/core` and migration 0080's
     * `frequency_cap_value_is_a_cap()` refuse the same three spellings — 0, null and 'unlimited' — so the
     * refusal holds for a `psql` session too.
     */
    schema: z.number().int().min(1).max(14),
    defaultValue: 2,
    label: 'Maximum marketing messages per contact per week',
    help: 'Applies across every flow and campaign combined, not per campaign. It cannot be set to zero or switched off: to stop promotional traffic, engage the marketing kill switch.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y9-frequency-cap',
      note: 'No figure supplied; 2 per rolling 7 days assumed.',
    },
  }),
  define({
    /**
     * The second half of Y9-frequency-cap, and it is not redundant with the weekly one.
     *
     * 2 per week alone permits 8 to 10 in a month, which is a rate nobody would agree to if they were
     * asked in those words; a monthly cap alone permits all 6 in one afternoon. The pair is what makes
     * "not too often" hold at both scales, and the two are counted over ROLLING windows of 7 and 30 days
     * rather than calendar periods — see `packages/core/src/messaging/frequency-cap.ts` for why a
     * calendar week lets four messages leave in twelve hours inside a cap of two.
     */
    key: 'messaging.frequency_cap_per_month',
    tier: 'operational',
    schema: z.number().int().min(1).max(60),
    defaultValue: 6,
    label: 'Maximum marketing messages per contact per 30 days',
    help: 'Counted over a rolling 30 days, across every flow and campaign combined. Like the weekly cap it cannot be set to zero or switched off.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y9-frequency-cap',
      note: 'No figure supplied; 6 per rolling 30 days assumed.',
    },
  }),
  /**
   * The three package-policy settings, all three of them Y9-package-policy's.
   *
   * They are the DEFAULT a new `package_template_version` is created with, and nothing more. Every term a
   * customer actually bought is snapshotted onto `package_sale` and held equal to the immutable version it
   * names by ZG002, so changing any of these can never alter an outstanding balance — which is what makes
   * them safe to be settings at all rather than a migration.
   */
  define({
    key: PACKAGE_VALIDITY_MONTHS_SETTING_KEY,
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
      // The note used to state all three terms at once, which read as one answered question and made the
      // other two invisible on the Unconfirmed Assumptions panel. Each now carries its own row and its own
      // note; this one is about the validity and says so.
      note: '6 months assumed. Short enough that an uncorrected assumption leaves no unbounded liability on the balance sheet.',
    },
  }),
  define({
    key: PACKAGE_TRANSFERABLE_SETTING_KEY,
    /**
     * `operational`, and **owner-only**.
     *
     * Not compliance-locked: transferability is a commercial term, not a legal position, and the tier
     * exists for decisions that cannot be relaxed without a compliance consequence. But not
     * `OWNER_MANAGER` either, which is what `operational` usually carries — a transferable balance can be
     * moved between customers, which is a fraud path and a data-protection question nobody has been
     * asked, and turning it on is a decision about what the business promises rather than about how the
     * floor runs.
     */
    tier: 'operational',
    schema: z.boolean(),
    defaultValue: false,
    label: 'Packages are transferable by default',
    help: 'Whether a new package may be used by someone other than the person who bought it. A package already sold keeps the transferability it was sold under.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: ['catalogue', 'content'],
    provisional: {
      openQuestionId: 'Y9-package-policy',
      note: 'Non-transferable assumed. A movable balance is a fraud path and a data-protection question nobody has been asked, so false is the option that cannot cost the business money.',
    },
  }),
  define({
    key: PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY,
    /**
     * `compliance_locked`, and the accountant may change it.
     *
     * Forfeiting an unredeemed balance writes a liability the customer paid for off to breakage revenue.
     * That is a revenue-recognition decision with a VAT consequence — `4050 Unredeemed voucher breakage`
     * already carries an `[UNVERIFIED] Y11-vat-package` note about whether breakage is a supply at all —
     * and it is the one setting in this file that changes a figure on a filed return. So it is locked, and
     * the lock is `settings:write_accounting_policy`: the owner and the accountant, never the manager.
     */
    tier: 'compliance_locked',
    schema: z.enum(['retained', 'forfeited']),
    defaultValue: 'retained' as const,
    label: 'Unredeemed package balance at expiry',
    help: "Retained leaves the liability on the balance sheet and lets the customer come back. Forfeited writes it off to breakage revenue, which is a revenue-recognition decision with a VAT consequence — the accountant's, not the floor's.",
    editableBy: OWNER_ACCOUNTANT,
    audited: true,
    invalidates: ['catalogue', 'content'],
    provisional: {
      openQuestionId: 'Y9-package-policy',
      note: 'Balance retained, not forfeited. Forfeiting is the aggressive reading, and if the real policy turns out to be retention a forfeited balance has already been written off against a customer who was entitled to it. Retention also posts NOTHING at expiry, so the conservative answer is the one with no journal entry to reverse.',
    },
  }),
  define({
    /**
     * Whether a deposit may be taken at all. **Off**, and no service requires one (Y-PAY-06).
     *
     * `Y9-deposits` asks *"which services require a deposit, what percentage, and whether first-time
     * clients prepay"* and nothing in the handover answers any of the three. So the strictest safe option
     * is OFF: a deposit taken under a policy this build invented is the customer's money held against a
     * rule nobody agreed, and `payments.deposit_percent_bp` below would make the figure look configured.
     *
     * The mechanism is complete behind it — migration 0124, the six refusals, the liability account, the
     * release at checkout and the refund on cancellation are all built and tested — so answering this is
     * ONE audited settings change plus a figure, with no migration and no code change. The engine
     * REFUSES rather than quietly computing zero: `DepositsAreDisabled` in `@berelax/core` names this key
     * and this question, because "no deposit because the module is off" and "no deposit is due" are
     * different facts and Y9-commission records what conflating them costs.
     *
     * `OWNER_ONLY` and `operational`: it is a pricing-and-cash policy, not a floor preference, and it
     * decides whether the business asks a customer for money before a treatment. `invalidates: []`
     * because nothing is prerendered from it — the booking and checkout screens are `dynamic` and read it
     * per request — and `rerunJobs` is absent for a sharper reason: turning it on must NOT go back and
     * ask for deposits on bookings already taken. A deposit is asked for when a booking is made.
     */
    key: DEPOSIT_ENABLED_SETTING_KEY,
    tier: 'operational',
    schema: z.boolean(),
    defaultValue: false,
    label: 'Deposits enabled',
    help: 'Off until somebody says which services require a deposit and how much. While it is off no deposit can be taken at all and the request is refused by name rather than answered with zero. A deposit is a part-payment against ONE booking: it cannot move to another appointment and it cannot become a package.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: DEPOSIT_POLICY_OPEN_QUESTION_ID,
      note: 'Deposits DISABLED and no service requires one, which is the provisional answer already on file in docs/OPEN-QUESTIONS.md. Y9-deposits asks which services require a deposit, what percentage, and whether first-time clients prepay; none of the three is answered anywhere in the handover, and a percentage this build chose would be indistinguishable from a configured one on the money a customer was asked for (brief rule 15). The mechanism is built and tested behind this flag, so answering it is one audited change here plus a figure.',
    },
  }),
  define({
    /**
     * What share of a booking's gross a deposit is, in basis points. **Zero.**
     *
     * Zero is not a guess and it is not a disabled sentinel: it is `build/manifest.yaml`'s own
     * provisional value for Y-PAY-06 — *"no services enrolled, 0% of gross"* — which means "no deposit on
     * anything", the same policy the flag above states from the other end. Both are carried because they
     * fail in different directions: the flag off makes a request refuse by name, and zero makes the
     * figure nothing even if somebody turns the flag on before deciding the rate.
     *
     * **There is no per-service enrolment table and that is deliberate.** The SHAPE of the answer is
     * unknown as well as the figure — a deposit could be a percentage of the service, a flat fee per
     * booking, a first-time-customer rule or a per-service enrolment — and a column for one of those is
     * an invented policy the engine would then apply to the wrong quantity. That is ADR 0057's argument
     * for having no `cap_fils` column on the gratuity rule, and ADR 0066's for leaving a carry-over
     * policy unexpressible: answering this may need a unit rather than a value, and a shape nobody
     * chose is worse than a blank.
     *
     * `compliance_locked` and `OWNER_ACCOUNTANT`, beside the unredeemed-package-balance setting above and
     * for its stated reason: money taken before a supply is a revenue-recognition question with a VAT
     * consequence (`Y11-vat-deposit`), so it is the accountant's and the owner's and never the floor's.
     */
    key: DEPOSIT_PERCENT_BP_SETTING_KEY,
    tier: 'compliance_locked',
    schema: z.number().int().min(0).max(10_000),
    defaultValue: PROVISIONAL_DEPOSIT_PERCENT_BP,
    label: 'Deposit percentage (basis points)',
    help: 'What share of a booking\u2019s gross a deposit is, in basis points \u2014 10,000 is the whole. Zero means no deposit on anything, which is the policy on file. Money taken before a treatment is held as a liability and recognised as revenue only when the invoice is issued; whether receiving it is itself a date of supply is a question for the tax agent (Y11-vat-deposit).',
    editableBy: OWNER_ACCOUNTANT,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: DEPOSIT_POLICY_OPEN_QUESTION_ID,
      note: 'Zero percent, which is this unit\u2019s own provisional value in build/manifest.yaml and not a rate chosen here. Y9-deposits asks what percentage and names no figure, and there is deliberately no per-service enrolment table: the shape of the answer is unknown as well as the figure, and a column for the wrong shape is a policy the engine would apply to the wrong quantity (ADR 0057\u2019s argument for having no cap column).',
    },
  }),
  /**
   * The three chart-of-accounts codes the gratuity posting rule resolves (P-HR-13).
   *
   * Settings and not constants, because `chart_of_accounts` is itself PROVISIONAL against Y8-coa: 0018
   * makes the chart a row rather than a constant precisely so an accountant can map an existing chart, and
   * a code written into a posting rule would be this build deciding that classification — in a journal that
   * cannot be edited (ADR 0017), where changing it later means restating history. The acceptance criterion
   * says so directly: "debit and credit accounts are resolved from the chart of accounts through settings,
   * with a grep test asserting no account code literal in the job".
   *
   * `compliance_locked` and `OWNER_ACCOUNTANT`, for the reason the package-balance setting above records:
   * which account a liability lands in is a revenue-recognition decision that reaches a filed return, so it
   * is the accountant's and the owner's and never the manager's.
   *
   * The schema checks only the SHAPE — four digits, the same pattern `account.code`'s own CHECK uses. Whether
   * the code exists is answered by the foreign key on `journal_line.account_code`, which refuses a posting
   * naming an account the chart does not contain; a chart lookup here would be a second answer to that, and
   * the settings layer cannot see the chart anyway (this package may not import `@berelax/core`).
   */
  define({
    key: GRATUITY_EXPENSE_ACCOUNT_SETTING_KEY,
    tier: 'compliance_locked',
    schema: z.string().regex(ACCOUNT_CODE_PATTERN, 'An account code is exactly four digits'),
    defaultValue: DEFAULT_GRATUITY_EXPENSE_ACCOUNT,
    label: 'Gratuity expense account',
    help: "The expense account a month's end-of-service gratuity accrual is debited to. Four digits, from the chart of accounts.",
    editableBy: OWNER_ACCOUNTANT,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: GRATUITY_ACCOUNTS_OPEN_QUESTION_ID,
      note: "The standard spa chart's 5030 End-of-service gratuity expense. Y8-coa is open: the business has an existing chart nobody has supplied, so this is a mapping waiting to happen rather than an agreed classification.",
    },
  }),
  define({
    key: GRATUITY_LIABILITY_ACCOUNT_SETTING_KEY,
    tier: 'compliance_locked',
    schema: z.string().regex(ACCOUNT_CODE_PATTERN, 'An account code is exactly four digits'),
    defaultValue: DEFAULT_GRATUITY_LIABILITY_ACCOUNT,
    label: 'Gratuity liability account',
    help: 'The balance-sheet liability account the accrual is credited to, and which a leaver\u2019s settlement discharges. Four digits, from the chart of accounts.',
    editableBy: OWNER_ACCOUNTANT,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: GRATUITY_ACCOUNTS_OPEN_QUESTION_ID,
      note: "The standard spa chart's 2070 End-of-service gratuity liability. Y8-coa is open. The migration refuses an accrual whose credit does not land on an account of TYPE liability (ZY173), so a code pointed at a revenue account fails at the posting rather than misstating the balance sheet.",
    },
  }),
  define({
    key: GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT_SETTING_KEY,
    tier: 'compliance_locked',
    schema: z.string().regex(ACCOUNT_CODE_PATTERN, 'An account code is exactly four digits'),
    defaultValue: DEFAULT_GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT,
    label: 'Gratuity settlement payable account',
    help: 'The payable a leaver\u2019s settled gratuity is credited to. A payable and never cash: the money leaves through the payroll run, so crediting cash here would pay it twice.',
    editableBy: OWNER_ACCOUNTANT,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: GRATUITY_ACCOUNTS_OPEN_QUESTION_ID,
      note: "The standard spa chart's 2060 Wages payable. Y8-coa is open, and whether a settled gratuity sits with ordinary wages or in a separate payable is part of what answering it decides.",
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
    /**
     * The date the Business Profile API access application was submitted.
     *
     * docs/10 §4 asks the amber state to carry a **submission date**, and it is the one thing that makes
     * *pending approval* actionable rather than something to wait out: an application submitted last week
     * is normal, and one submitted in March is a chase. Nothing in the system can compute it — Google
     * does not expose the application, and the first refused read is not the day it was filed.
     *
     * So it is recorded by a human, and the default is the **empty string** rather than a plausible date.
     * That is brief rule 15 exactly: blank is visibly unanswered and a plausible date is
     * indistinguishable from a recorded one, on a screen whose whole job is to be trusted. The card says
     * the date has not been recorded, which is a sentence somebody can act on.
     */
    key: 'google.business_profile_application_submitted_on',
    tier: 'operational',
    // A date or nothing. The regex is the constraint rather than `z.string()`, because "March" and
    // "last week" are the two values a free-text box would actually receive.
    schema: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
    defaultValue: '',
    label: 'Business Profile access application submitted on',
    help: 'The date the Google Business Profile API access application was sent, as YYYY-MM-DD. It is shown beside "access pending Google approval" so an application nobody has chased is visible as one. Leave it empty until an application has actually been submitted.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y2-gbp-status',
      note: 'Empty, because no application has been submitted. A placeholder date here would be indistinguishable from a real submission on the one screen that exists to be believed.',
    },
  }),
  define({
    /**
     * The Cloud console page where the Business Profile quota is visible.
     *
     * docs/10 §4 asks the amber state to link to *"the Cloud quota page where 0 to 300 is visible"*, and
     * approval is observable in exactly one place: the quota for this project moving from 0 to 300 QPM.
     * Which URL that is depends on the Cloud project — the console's quota pages are per project and per
     * API — and this build does not know the project. So the link is configured rather than guessed
     * (brief rule 15): a URL written from memory here would be a link that 404s, or worse, one that opens
     * somebody else's project and shows a quota that is not ours.
     *
     * Empty until somebody pastes it, and the card then names the console page in words instead. The
     * words are navigation rather than a URL, which is the one form of this instruction that cannot be
     * wrong.
     */
    key: 'google.cloud_quota_page_url',
    tier: 'operational',
    schema: z.union([z.literal(''), z.string().url().max(500)]),
    defaultValue: '',
    label: 'Cloud console quota page',
    help: 'The Google Cloud console page showing the Business Profile API quota for this project, which is where approval appears as the quota moving from 0 to 300 QPM. Paste the URL from the console; while it is empty the settings card names the page to open instead of linking to it.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y2-gbp-status',
      note: 'Empty, because the Cloud project is not known to this build and a console URL written from memory is a link that opens the wrong project or nothing at all.',
    },
  }),
  define({
    /**
     * How many notices one unresolved re-auth incident may produce before the ladder stops.
     *
     * The setting that stops *escalating* meaning *for ever*. G-CONN-08's ladder is one notice on
     * discovery, one a day later and then daily; this is the total, so five reaches the fourth day.
     *
     * A setting rather than a constant because it is a judgement about one business's habits — how long
     * before the owner reads an email, and how many identical ones before they stop — and the correction
     * should be a screen rather than a deploy. Bounded at both ends, and both bounds are decisions: zero
     * is refused because a dead Google connection nobody is told about is the silent failure docs/10
     * exists to remove, and the ceiling is refused because the sixth identical email teaches the owner
     * that these emails do not need reading, which costs the NEXT incident its attention.
     *
     * The same ceiling is a CHECK constraint on `google_reauth_notice.rung_index` in migration 0075. The
     * duplication is deliberate for 0051's reason: the database cannot import this registry, and a cap
     * that lives only here is a cap one bad row removes.
     */
    key: GOOGLE_REAUTH_REPEAT_CAP_SETTING_KEY,
    tier: 'operational',
    schema: z.number().int().min(1).max(MAX_GOOGLE_REAUTH_LADDER_STEPS),
    defaultValue: DEFAULT_GOOGLE_REAUTH_REPEAT_CAP,
    label: 'Google re-auth reminders per incident',
    help: 'How many times the owner and the manager are emailed about one broken Google connection: one straight away, one a day later, then one a day until this many have been sent. Lower it if the reminders are noise; it cannot be set to zero, because a Google connection that has stopped working fails silently.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
  }),
  define({
    /**
     * Whether a re-auth notice also goes by SMS.
     *
     * Off, and the default is the decision rather than a starting point. Three reasons, in order of
     * weight. It is a message to a member of STAFF about a credential, and docs/04 §5's discretion rule
     * binds a staff message as hard as a customer one — an SMS arrives on a lock screen. It costs money
     * per segment for a fact that is already in an email and on every admin page as a banner. And there
     * is no table in this build that holds a staff phone number, so the honest state of the channel is
     * off rather than configured-and-unreachable.
     *
     * When it IS switched on the message is transactional and cannot be anything else: the template's
     * `message_class` is immutable (0015), so the marketing kill switch cannot suppress it and it cannot
     * leave from the promotional AD- identity. That is the property the acceptance line names, and it is
     * a property of the template rather than of this switch — which is why turning the switch on cannot
     * turn a service message into a marketing one.
     */
    key: GOOGLE_REAUTH_SMS_SETTING_KEY,
    tier: 'operational',
    schema: z.boolean(),
    defaultValue: false,
    label: 'Also send Google re-auth reminders by SMS',
    help: 'Off by default. The email and the banner on every admin page already say it; an SMS adds a per-segment cost and puts a note about a business credential on somebody’s lock screen. If it is switched on the message is transactional, so the marketing kill switch cannot stop it.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
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
  define({
    /**
     * Whether the commission module computes anything at all (P-HR-11).
     *
     * **This is the provisional answer to Y9-commission, and the answer is not a rate.** The handover names
     * no commission structure — flat, tiered and service-dependent are all still open — so the build ships
     * the full engine with NOTHING configured: `commission_rule` (0097) seeds no version, and this flag is
     * `false`. With it off a run produces zero lines and records why (`commission_run.module_enabled`), so
     * "no commission is due" and "the module is switched off" are never the same empty answer.
     *
     * A FLAG and not a missing table, because docs/12 §1.3 is explicit that the switch is flipped by
     * configuration rather than by a code change: turning commission on is one audited settings change plus
     * one published rule version, and neither is a deploy.
     *
     * `OWNER_ONLY` and not `OWNER_MANAGER`, for the reason `ROLE_DEFINITIONS` gives about the manager and
     * `employee.salary`: a commission is pay, and what the business pays its staff is the proprietor's
     * decision. The manager runs the floor.
     *
     * `invalidates: []` is a conclusion rather than an oversight. Nothing is prerendered from this value —
     * the HR commission screen is `dynamic` and reads it per request — and `rerunJobs` is empty for a
     * sharper reason: turning the flag on must NOT retro-compute a period. A commission run is a dated,
     * immutable record of what was computed and when, and a job that swept old months the moment somebody
     * flipped a switch would produce runs nobody asked for over periods that had already been paid.
     */
    key: COMMISSION_ENABLED_SETTING_KEY,
    tier: 'operational',
    schema: z.boolean(),
    defaultValue: false,
    label: 'Commission module enabled',
    help: 'Off until a commission structure is agreed. While it is off, a commission run produces no lines and says on its face that the module is disabled rather than reporting nothing is due. Turning it on also needs a published commission rule version — the rates live in a versioned row, never in code.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y9-commission',
      note: 'No commission structure is configured and none is guessed. docs/OPEN-QUESTIONS.md Y9-commission asks whether the structure is flat, tiered or service-dependent and nothing in the handover answers it, so the strictest safe option is OFF: a rate this build invented would be indistinguishable from a configured one on the payslip that resulted. The engine is complete and is tested against a fixture rule set; answering this is one audited change here plus one published commission_rule version.',
    },
  }),
  define({
    /**
     * The employer identifier a WPS salary file names. **A placeholder, and it fails validation.**
     *
     * docs/04 §7's entire statement about the Wage Protection System is *"salary file, in the format the
     * bank requires"*: no bank is named, no agent code, no establishment id, no layout and no field spec.
     * This is the establishment or MOL number registered to this business, and the build has never seen it.
     *
     * The default is `PLACEHOLDER_WPS_EMPLOYER_ID`, which is chosen to fail `validateWpsFile` twice over —
     * it says what it is in words, and it is not a run of digits — for exactly `PLACEHOLDER_TRN`'s reason.
     * This is brief rule 15 at its sharpest in the build: a plausible thirteen digits would produce a file
     * that passes every check, looks exactly like a configured one, and pays nineteen people against
     * somebody else's registration. A blank field is visibly unanswered.
     *
     * `compliance_locked` and OWNER_ONLY, beside the TRN and the supervisory authority: it is a
     * registration number, not a preference, and nobody on the floor should be able to change who a wage
     * file says it is from. `invalidates: []` because nothing is prerendered from it — the payroll screen
     * is `dynamic` and reads it per request — and `rerunJobs` is absent for a sharper reason: setting this
     * must NOT re-export anything. A file is produced by a person deciding to produce one.
     */
    key: WPS_EMPLOYER_ID_SETTING_KEY,
    tier: 'compliance_locked',
    schema: z.string().min(1).max(64),
    defaultValue: PLACEHOLDER_WPS_EMPLOYER_ID,
    label: 'WPS employer identifier',
    help: 'The establishment or MOL number registered to this business, as it must appear in the salary file. It is a placeholder until somebody enters the real one, and while it is a placeholder no WPS file can be produced at all — the export is refused by name. A plausible-looking number here would produce a file that passes every check and pays staff against another employer\u2019s registration, which is why the default fails rather than being blank.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y8-wps',
      note: 'docs/04 \u00a77 says only "salary file, in the format the bank requires". No bank, no agent code, no establishment id and no layout have been supplied, so the identifier is a placeholder that fails validation rather than a number this build invented. Answering Y8-wps is one audited settings change here, one for the agent, and the bank\u2019s own format specification for the layout.',
    },
  }),
  define({
    /**
     * The agent identifier — the bank or exchange house carrying the file. Same placeholder, same reason.
     *
     * A separate setting from the employer id and not one combined "WPS configuration" value, because the
     * two are issued by different people and will be answered at different times: the establishment id is
     * MOHRE's and the agent id is the bank's. One value would mean confirming one of them required
     * inventing the other.
     */
    key: WPS_AGENT_ID_SETTING_KEY,
    tier: 'compliance_locked',
    schema: z.string().min(1).max(64),
    defaultValue: PLACEHOLDER_WPS_AGENT_ID,
    label: 'WPS agent identifier',
    help: 'The bank or exchange house that carries the salary file, identified as they require. Issued to them, never chosen. A placeholder until somebody enters the real one, and while it is a placeholder the export is refused by name.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y8-wps',
      note: 'Which bank or exchange house carries the file, and under which code, has not been supplied. A separate setting from the employer id because the two are issued by different people and will be answered at different times.',
    },
  }),
  define({
    /**
     * How far ahead of a statutory deadline the compliance calendar sends each reminder (M-VAT-11).
     *
     * `operational` and not `compliance_locked`, and the reason is the one the review-reply languages
     * give: the tier follows what a value can RELAX, not what the subject sounds like. No value here
     * changes whether an obligation BLOCKS — `obligation.is_blocking` is GENERATED from
     * `blocking_effect` and `refuse_obligation_shape_change()` refuses an UPDATE to anything but the due
     * date (0052), so an empty ladder switches the notices off and changes nothing about the consequence
     * of missing the deadline. A therapist with an overdue credential still leaves availability and
     * publishing is still refused, whether or not anybody was reminded.
     *
     * `rerunJobs` is load-bearing rather than tidy, and this is the second setting in the registry that
     * needs it. Changing the ladder changes WHICH NOTICES ARE DUE: the step label carries the offset, so
     * every pending notice built under the old ladder carries a label the new one does not declare. The
     * rebuild supersedes those rows and plans the new set over the occurrences already in the calendar —
     * the twelve months a new default applied at generation time would leave on the old timing.
     */
    key: OBLIGATION_REMINDER_OFFSETS_SETTING_KEY,
    tier: 'operational',
    // Whole days before the due date, each between 1 and a year, no repeats, at most four. The bounds are
    // restated as a CHECK in migration 0060, because the database cannot import this registry and a
    // `reminder_9999d` row would put a renewal notice in the calendar before the previous renewal.
    schema: z
      .array(z.number().int().min(1).max(MAX_OBLIGATION_NOTICE_OFFSET_DAYS))
      .max(MAX_OBLIGATION_NOTICE_OFFSETS)
      .refine((days) => new Set(days).size === days.length, {
        message: 'each reminder must be a different number of days before the deadline',
      }),
    defaultValue: [...DEFAULT_OBLIGATION_REMINDER_OFFSETS_DAYS],
    label: 'Compliance deadline reminders',
    help: 'How many days before a licence renewal, permit, inspection or filing deadline each reminder is sent to the role that owes it. An empty list turns these reminders off; it does not stop an overdue obligation blocking. Changing this re-plans the notices of every occurrence already in the calendar.',
    editableBy: OWNER_MANAGER,
    audited: true,
    // No cache tag: a notice is a message rather than a page, so nothing rendered changes. The work is
    // the REBUILD.
    invalidates: [],
    rerunJobs: [REBUILD_OBLIGATION_NOTICES_JOB],
    provisional: {
      openQuestionId: 'Y1-licence',
      note: 'docs/04 §1 and §7 mark the licence classification and every renewal interval [UNVERIFIED], so how long a renewal actually takes at ADDED, at Abu Dhabi Municipality or at MOHRE is not on file — and the lead time that should precede an unknown interval is unknown with it. 60/30/7 days is the conservative reading: the failure is asymmetric, since a notice too early is noise somebody ignores and a notice too late is a lapsed trade licence that blocks publishing or a lapsed credential that takes a therapist off the rota with a day of bookings to reassign by hand.',
    },
  }),
  define({
    /**
     * How long an unacknowledged deadline waits before it escalates to the role above (M-VAT-11).
     *
     * A second setting rather than a field on the first, because the two answer different questions and
     * are wrong in different directions: a reminder too early is noise, and an escalation too early is a
     * message to the proprietor about something the manager was always going to do on Thursday. One list
     * covering both would also make "turn the escalations off and keep the reminders" unexpressible,
     * which is the first change an owner asks for.
     *
     * Escalation goes to the role ABOVE the declared owner (`escalationRoleFor` in `@berelax/core`), and
     * no value here can choose that role: an escalation addressed to whoever is on shift is decoration,
     * and 0060's trigger refuses one addressed to the owning role at all.
     */
    key: OBLIGATION_ESCALATION_OFFSETS_SETTING_KEY,
    tier: 'operational',
    schema: z
      .array(z.number().int().min(1).max(MAX_OBLIGATION_NOTICE_OFFSET_DAYS))
      .max(MAX_OBLIGATION_NOTICE_OFFSETS)
      .refine((days) => new Set(days).size === days.length, {
        message: 'each escalation must be a different number of days after the deadline',
      }),
    defaultValue: [...DEFAULT_OBLIGATION_ESCALATION_OFFSETS_DAYS],
    label: 'Compliance deadline escalation',
    help: 'How many days after a deadline passes unacknowledged before it is escalated to the role above the one that owes it. An empty list turns escalation off. Acknowledging an occurrence stops the escalations and deliberately not the reminders.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: [],
    rerunJobs: [REBUILD_OBLIGATION_NOTICES_JOB],
    provisional: {
      openQuestionId: 'Y1-licence',
      note: 'An escalation interval is a judgement about how long a renewal can safely sit unacknowledged, which follows from how long the renewal takes — and docs/04 marks every renewal interval [UNVERIFIED]. 7 and 21 days: a week is short enough that the second rung still lands before a month has passed, and the second rung exists because one escalation nobody answers is a notice with nowhere left to go.',
    },
  }),
  define({
    /**
     * Whether a real intake payload may be stored at all (C-CRM-08, OPEN-QUESTIONS Y5-residency).
     *
     * `compliance_locked` and owner-only, which is what the tier test asks: the tier follows what a value
     * can RELAX, and this one relaxes the strictest thing in the system — whether special-category health
     * data may be written to a database that is not in the UAE. Federal Law 2 of 2019 may prohibit it,
     * DigitalOcean has no UAE region, and the licence classification that decides whether the rule
     * applies is unconfirmed (ADR 0010).
     *
     * It is a SETTING rather than a migration, and that is the point of it: answering Y5-residency is
     * then a configuration change made on the Unconfirmed Assumptions panel with a written justification
     * (docs/12 §1.3), not a release. Migration 0082 reads this same row from a trigger, so the refusal
     * holds for a `psql` session too and an absent row reads as false.
     *
     * No cache tag and no job: nothing rendered depends on it, and flipping it does not make the
     * synthetic fixtures real. What it changes is whether the next write is accepted.
     */
    key: CLINICAL_REAL_INTAKE_SETTING_KEY,
    tier: 'compliance_locked',
    schema: z.boolean(),
    defaultValue: PROVISIONAL_REAL_INTAKE_PERMITTED,
    label: 'Real client intake data may be stored',
    help: 'Off until it is confirmed that client intake notes may be held in this database. While it is off, only obviously-synthetic fixture submissions can be written and a real one is refused by name, by the database as well as by the application. Turning it on does not move any data: if the answer is that health data must stay in the UAE, the clinical schema has to be relocated first (ADR 0010).',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y5-residency',
      note: 'Do intake notes count as health data subject to UAE localisation? Unanswered, so the strict reading applies: they do. Being wrong this way costs one setting change; being wrong the other way is a disclosure of special-category data from a jurisdiction it should not have left. Nothing about the clinical boundary has to be rebuilt either way — ADR 0010 built it for relocation — but real data loaded before the answer cannot be un-loaded.',
    },
  }),
  define({
    /**
     * How long a step-up re-authentication is good for (C-CRM-08).
     *
     * Not provisional, and `packages/shared/src/clinical.ts` carries the argument: a provisional marker
     * means the owner has to answer something, and this needs no answer — shorter is unambiguously
     * stricter, five minutes is already short, and nothing about the licence or the entity moves it. The
     * panel is worth reading exactly to the extent that everything on it needs an owner.
     *
     * `compliance_locked` all the same, because widening it is the change that matters: a window nobody
     * notices has grown to eight hours turns step-up into a login. Migration 0082 caps any grant at
     * fifteen minutes whatever this holds, so the setting can only tighten within the ceiling — the same
     * belt-and-braces shape 0043 uses for the KEK, and for the same reason.
     */
    key: CLINICAL_STEP_UP_WINDOW_SETTING_KEY,
    tier: 'compliance_locked',
    schema: clinicalStepUpWindowSchema,
    defaultValue: CLINICAL_STEP_UP_WINDOW_MINUTES,
    label: 'Clinical step-up window (minutes)',
    help: 'How long after re-entering a second factor a member of staff may read clinical records, for the one purpose they stated. Every read inside the window is logged individually with that purpose. The database refuses any window longer than 15 minutes.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
  }),
  define({
    /**
     * Whether intake QUESTION copy is linted as well as the template's assertive copy (Y1-licence).
     *
     * The Y1-licence decision made into one switch. Unconfirmed resolves to the narrower vocabulary, so
     * a question label goes through the publication lexicon for an unpermitted staff title, an
     * unlicensed activity or a treatment style attached to a person. It is never linted for the
     * profile's claim list — asking about medication is not claiming to prescribe it — and that
     * exemption is one rule wide and named in `packages/core/src/clinical/intake.ts`.
     *
     * `compliance_locked`, because what it relaxes is a claim the business makes in front of a client,
     * which is the same subject `regulatory_profile` is locked for.
     */
    key: CLINICAL_LINT_QUESTION_COPY_SETTING_KEY,
    tier: 'compliance_locked',
    schema: z.boolean(),
    defaultValue: PROVISIONAL_LINT_QUESTION_COPY,
    label: 'Lint intake question wording too',
    help: 'On: the wording of every intake question is checked against the vocabulary the regulatory profile permits, as well as the form title and the consent paragraph. Off: only the title and the consent paragraph are checked. Turn it off only once the licence classification is confirmed.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y1-licence',
      note: 'Is the licence a commercial wellness activity or a healthcare one? Unanswered, so the narrower vocabulary applies to everything a client reads on an intake form and not only to what the form asserts. Answering it healthcare widens this twice over: this setting goes off, and regulatory_profile.medical_claims_permitted going true stops the claim list applying to the title and the consent wording as well. Both are configuration changes.',
    },
  }),
  /**
   * The two data-subject rights settings (C-CRM-10). They are a matched pair of OPPOSITE decisions about
   * an unanswered question, which is why they read best together.
   *
   * Both hang off `Y1-entity` — mainland, DIFC or ADGM, which decides which privacy law applies. For the
   * deadline the build CAN choose a strictest-safe answer, so it does, and marks it. For the supervisory
   * authority it cannot, so it refuses, and marks that. docs/12 §2 says a provisional value is always the
   * strictest safe option; this is what that looks like when there is no safe option to pick.
   */
  define({
    /**
     * How many days a rights request must be answered in. Thirty, provisional.
     *
     * The shortest deadline of the regimes this build can see, because answering late is a breach and
     * answering early never is. It is NOT presented as a statutory figure anywhere — `RIGHTS_SLA_PROVENANCE`
     * is the sentence the panel shows, and it says in words that the build chose this because the question
     * that decides it is open, so nobody quotes it as something somebody looked up.
     *
     * `min(1)` and not `min(0)`, for the reason the frequency cap gives: zero looks like the strictest
     * value and is in fact the ambiguous one, and here it is simply incoherent — a request is overdue the
     * instant it is taken. Migration 0085 refuses it too (`rights_request_sla_is_a_deadline`), so the floor
     * holds for a `psql` session as well.
     *
     * Stored ON each request as `sla_days`, so lowering this does not retroactively make an answered
     * request late, and raising it does not make a late one punctual.
     */
    key: RIGHTS_SLA_DAYS_SETTING_KEY,
    tier: 'compliance_locked',
    schema: rightsSlaDaysSchema,
    defaultValue: PROVISIONAL_RIGHTS_SLA_DAYS,
    label: 'Days to answer a data-subject request',
    help: 'Every export, rectification, erasure, objection and withdrawal request gets a due date this many days after it was received, and the overdue list is driven from it. Thirty days is the shortest deadline of the privacy regimes this build can see, chosen because the entity type that decides which regime applies has not been confirmed. It is not a figure this build looked up and must not be quoted as one. It cannot be set to zero.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
    // No `rerunJobs`, and the absence is the decision. A deadline is stored per request precisely so that
    // changing this setting cannot move one, and 0085's `rights_request_guard` freezes `due_at` and
    // `sla_days` (ZY002) so no job could move one even if it were written. An earlier draft named
    // `rebuild-rights-due-dates` here; no worker registered it, which is the defect
    // `send-scheduled-step.test.ts` catches for the reminder settings and nothing catches for this one.
    // Requests taken after the change take the new figure; requests already open keep theirs, which is
    // also the stricter reading whenever the new figure is longer.
    rerunJobs: [],
    provisional: {
      openQuestionId: 'Y1-entity',
      note: RIGHTS_SLA_PROVENANCE,
    },
  }),
  define({
    /**
     * Which supervisory authority a dissatisfied data subject complains to. **Blank, and no default.**
     *
     * The one setting in this build that is deliberately EMPTY rather than provisionally filled, and the
     * distinction is brief rule 15 at its sharpest. Every other unanswered question here has a strictest
     * safe answer that can be chosen and corrected later. This one does not: `Y1-entity` decides whether
     * the regulator is the federal one, DIFC's or ADGM's, and a plausible regulator named in a letter to a
     * data subject is indistinguishable from the right one — it would send somebody with a genuine
     * complaint to an office that cannot hear it, and it would be this build's own invention. docs/04 §8
     * records the question as open in as many words.
     *
     * So while this is empty the engine PERFORMS every right and REFUSES to issue the written response,
     * by name (`rights_response_authority_absent`), and the refusal is recorded on the resolution row. The
     * erasure still happens; the letter that would have to contain a fact this build does not have does
     * not. `google.cloud_quota_page_url` is blank for the same reason and the weaker version of it: a
     * wrong console link opens the wrong project, and a wrong regulator misdirects a complaint.
     */
    key: RIGHTS_SUPERVISORY_AUTHORITY_SETTING_KEY,
    tier: 'compliance_locked',
    schema: rightsSupervisoryAuthoritySchema,
    defaultValue: PROVISIONAL_SUPERVISORY_AUTHORITY,
    label: 'Supervisory authority for privacy complaints',
    help: 'The authority a data subject complains to if they are unhappy with how a request was answered, named exactly as it should appear in a letter. It is blank because the entity type that decides which authority has jurisdiction has not been confirmed, and a plausible-looking authority would send a real complaint to an office that cannot hear it. While it is blank, requests are still carried out in full and the written response is withheld with that reason recorded.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y1-entity',
      note: 'Mainland, DIFC or ADGM? Each has its own authority and the build has not been told which. Deliberately blank rather than assumed: a response naming an invented supervisory authority is worse than no response, because it looks complete.',
    },
  }),
  define({
    /**
     * The share of forward bookings the 13-week cash forecast expects to show up (R-REP-06, ADR 0073).
     *
     * **A setting and not a constant, because it is the one assumption the forecast's inflow rests on.**
     * The forward-booking line is `Σ appointment.gross_price_fils × this rate`, and the rate is the only
     * place in that line where this build has guessed anything — the gross is a snapshot and the trading
     * date is the diary's. Putting it in the registry is what makes it appear on the Unconfirmed
     * Assumptions panel (`provisionalSettings()`), and the forecast ALSO names it on the figure itself,
     * because a panel is a different screen and a reader of a cash figure has to be told there without
     * already suspecting it.
     *
     * Basis points, not a percentage and not a fraction, for `operational-kpis.ts`' reason: a ratio is an
     * integer number of basis points throughout this build — `vat_rate_bp`, `rate_bp`,
     * `promotion.percentage_bp` — and a float rate would put a fraction into an integer-fils figure that
     * has to articulate to the fil.
     *
     * The SHOW-UP rate rather than the no-show rate, although the handover expresses it the other way
     * round: the figure is multiplied by the booked gross, so stating it as the multiplier removes the
     * subtraction a reader would otherwise have to do in their head, and a reader who misreads 9,000 as
     * a no-show rate gets a visibly absurd forecast rather than a plausible one 80% too low.
     *
     * 9,000 — a 10% no-show rate — is the manifest's own provisional value and `Y9-windows` owns it. It
     * is deliberately NOT the strictest safe option in either direction, because there is no safe
     * direction here: too high overstates cash and too low understates it, and the only honest handling
     * is to mark it, which is what the flag and the on-figure assumption do.
     */
    key: FORECAST_SHOW_UP_RATE_BP_SETTING_KEY,
    tier: 'operational',
    schema: z.number().int().min(0).max(SHOW_UP_RATE_WHOLE_BP),
    defaultValue: PROVISIONAL_SHOW_UP_RATE_BP,
    label: 'Forecast show-up rate',
    help: 'The share of already-booked appointments the 13-week cash forecast expects to happen, in basis points — 9,000 is 90%, a 10% no-show rate. It is an assumption, not a measurement: the realised no-show figure is on the operational KPI set, over appointments that have already happened. Every forecast figure it touches is marked as a projection and names this setting.',
    editableBy: OWNER_MANAGER,
    audited: true,
    // No cache tag and no job: the forecast is computed at read time (ADR 0064's argument for the
    // statements, inherited), so a change is visible on the next read and there is nothing to rebuild.
    invalidates: [],
    provisional: {
      openQuestionId: 'Y9-windows',
      note:
        'A 10% no-show rate assumed, so 9,000 basis points show up. No no-show policy has been agreed ' +
        'and no realised no-show rate has been measured over enough trading to be one. There is no safe ' +
        'direction: too high overstates cash and too low understates it, so the figure is marked on ' +
        'every forecast line it reaches rather than chosen conservatively.',
    },
  }),
  define({
    /**
     * Which calendar months the summer exodus covers (R-REP-06, ADR 0073).
     *
     * docs/06 B6 — "Ramadan and the summer exodus change demand materially ... a genuinely quiet
     * July/August" — is the source, and that is an observation in the handover rather than a figure
     * anybody has confirmed against takings. So it is `Y9-summer-window` and it is here rather than in
     * `packages/core`: nothing in the seasonality arithmetic holds a window length (ADR 0070's rule 4),
     * `seasonalityIndex` takes the months as a required argument, and this is the row that says what the
     * build assumed when nobody passed one.
     *
     * A list of months and not a start/end pair, because the window has to be able to be two months that
     * are not adjacent — a quiet August and a quiet Ramadan-shifted July are different sets in different
     * years — and because a pair invites the "does it wrap round December" question this never has to
     * answer.
     *
     * Answering it moves days between the summer bucket and the baseline and changes no arithmetic. What
     * it cannot do is produce an index: the index needs two separated occurrences of the bucket and this
     * business has none, so every bucket reads `no_data` until it has traded through two summers.
     */
    key: SEASONALITY_SUMMER_MONTHS_SETTING_KEY,
    tier: 'operational',
    schema: z
      .array(z.number().int().min(1).max(12))
      .min(1)
      .max(12)
      .refine((months) => new Set(months).size === months.length, {
        message: 'each month may appear once',
      }),
    defaultValue: [...PROVISIONAL_SUMMER_MONTHS],
    label: 'Summer exodus months',
    help: 'Which calendar months the seasonality report treats as the summer exodus. July and August are assumed from the handover; nobody has confirmed them against takings, and the report cannot confirm them either until the salon has traded through two summers.',
    editableBy: OWNER_MANAGER,
    audited: true,
    invalidates: [],
    provisional: {
      openQuestionId: 'Y9-summer-window',
      note:
        'July and August assumed, from docs/06 B6 ("a genuinely quiet July/August"). That is an ' +
        'observation in the handover and not a figure measured from takings, and this build cannot ' +
        'measure it: a seasonality index needs two separated occurrences of the window and there have ' +
        'been none.',
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
