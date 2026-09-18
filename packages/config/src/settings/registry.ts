import { AppError } from '@berelax/shared'
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
    key: 'booking.same_gender_matching',
    tier: 'compliance_locked',
    schema: z.enum(['strict', 'advisory', 'off']),
    defaultValue: 'strict' as const,
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
    key: 'agents.llm_provider',
    tier: 'operational',
    schema: z.enum(['fake', 'deepseek', 'minimax', 'claude']),
    defaultValue: 'fake' as const,
    label: 'LLM provider',
    help: 'Used by both the review autoresponder and the SEO agent. The key is validated against the provider before saving.',
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
    key: 'agents.review_autosend_enabled',
    tier: 'compliance_locked',
    schema: z.boolean(),
    defaultValue: false,
    label: 'Auto-send replies to 5-star reviews with no comment',
    help: 'Only ever applies to 4-5 star reviews with no free text and no named individual, in API mode, after a cooling-off delay. Everything else always needs a human.',
    editableBy: OWNER_ONLY,
    audited: true,
    invalidates: [],
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
