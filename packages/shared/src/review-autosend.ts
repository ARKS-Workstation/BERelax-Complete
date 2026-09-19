import { z } from 'zod'

/**
 * The four settings that bear on auto-sending a review reply, and the normalisers that make
 * **escalate** the answer no argument is needed for.
 *
 * ## Why the vocabulary is here and not in the module that applies the rule
 *
 * The same boundary `gender-matching.ts` describes. Three packages that may not import one another
 * read these values: `@berelax/config` declares the settings and validates what may be *written*,
 * `@berelax/db` reads the stored rows, and `@berelax/core` holds the routing rule. `packages/db` must
 * never import `packages/core`, so a floor spelled in core would be re-spelled in db and a third time
 * in the registry's `z` schema — and on the day one of them changes, two learn about it and one does
 * not.
 *
 * ## Every normaliser is total over `unknown`, and biased to refusal
 *
 * docs/07 §4 permits an auto-sent reply in exactly one case: a 4–5 star review with no free text and
 * no named individual, **in API mode, after a cooling-off delay, and only when the owner has
 * explicitly enabled it. Default off.** Four conditions, four stored values, and each one of them can
 * be absent, `null`, a leftover from a schema that has since narrowed, or an object a half-finished
 * migration left behind. A `safeParse` that falls back to the caller's value — or a truthiness test —
 * turns any of those into *permission to publish a reply in the business's name with nobody reading
 * it*, which is the failure this whole unit exists to make impossible.
 *
 * So:
 *
 *   - {@link reviewAutosendEnabled} answers `true` for exactly the boolean `true`. Not `'true'`, not
 *     `1`, not `'yes'`, not a non-empty object.
 *   - {@link reviewReplyMode} answers `'api'` for exactly the boolean `true` on
 *     `google.business_profile_access_granted`. Everything else is `'draft'`, which is the launch-day
 *     normal (docs/10 §6) and cannot auto-send because there is no API to send through.
 *   - {@link reviewCoolingOffHours} never returns less than
 *     {@link MINIMUM_REVIEW_COOLING_OFF_HOURS}. A longer delay is the conservative direction, so a
 *     value above the floor is honoured and everything else — 0, a negative, a fraction, a string, an
 *     absent row — **is** the floor.
 *   - {@link configuredReviewLanguages} returns only the languages this build can actually identify.
 *     A code nobody wrote a detector for cannot be answered in, so storing it must not make a review
 *     in that language auto-sendable; intersecting here is what makes widening the setting incapable
 *     of relaxing the rule.
 *
 * None of these throws. A compliance floor that throws on an unreadable value is a floor that takes
 * the review queue down with it, and the pressure that follows is to catch and continue — which is the
 * permissive reading arriving by a longer route.
 */

/** `agents.review_autosend_enabled`. One spelling for the registry, the reader and the tests. */
export const REVIEW_AUTOSEND_SETTING_KEY = 'agents.review_autosend_enabled'

/** `agents.review_autosend_cooling_off_hours`. */
export const REVIEW_COOLING_OFF_SETTING_KEY = 'agents.review_autosend_cooling_off_hours'

/** `agents.review_reply_languages`. */
export const REVIEW_REPLY_LANGUAGES_SETTING_KEY = 'agents.review_reply_languages'

/** `google.business_profile_access_granted` — the setting that decides whether API mode exists. */
export const BUSINESS_PROFILE_ACCESS_SETTING_KEY = 'google.business_profile_access_granted'

/**
 * Every setting that can bear on an auto-send, in one list.
 *
 * Exported so the "compliance-locked, not settings" test iterates *this* rather than a list of keys
 * retyped in the test. A setting added to the registry and forgotten here would be a fifth input the
 * combination test never varies, which is precisely the hole that makes such a test reassuring and
 * worthless.
 */
export const REVIEW_AUTOSEND_SETTING_KEYS = [
  REVIEW_AUTOSEND_SETTING_KEY,
  REVIEW_COOLING_OFF_SETTING_KEY,
  REVIEW_REPLY_LANGUAGES_SETTING_KEY,
  BUSINESS_PROFILE_ACCESS_SETTING_KEY,
] as const
export type ReviewAutosendSettingKey = (typeof REVIEW_AUTOSEND_SETTING_KEYS)[number]

/**
 * The shortest cooling-off this build will ever apply, whatever the setting holds.
 *
 * 24 hours, and it is a **floor rather than a figure**: docs/07 §4 says "after a cooling-off delay"
 * and names no number, so `Y9-cooling-off` is open and this is the strictest safe reading of an
 * unanswered question. The delay exists because a reviewer edits or deletes a review within the first
 * day far more often than after it, and a reply published under the business's name against a review
 * that no longer says what it said is not retractable.
 */
export const MINIMUM_REVIEW_COOLING_OFF_HOURS = 24

/** The value `agents.review_autosend_enabled` holds until an owner deliberately changes it. */
export const REVIEW_AUTOSEND_DISABLED = false

/**
 * The languages a review can be identified as, and therefore the only ones a reply may be drafted in.
 *
 * Two, because the site serves two (`apps/web/src/i18n/locales.ts`) and because identification is the
 * binding constraint rather than translation: a language nothing can *recognise* cannot be matched by
 * a reply, so it escalates. Spelled here rather than imported from `@berelax/ui`'s `Locale` on
 * purpose — `packages/shared` is the leaf and may import no sibling — and the pair is asserted equal
 * by `apps/web`'s own test rather than assumed.
 */
export const DETECTABLE_REVIEW_LANGUAGES = ['en', 'ar'] as const
export type DetectableReviewLanguage = (typeof DETECTABLE_REVIEW_LANGUAGES)[number]

/** Whether a reply can be sent through the API at all, or only drafted for a human to post. */
export const REVIEW_REPLY_MODES = ['api', 'draft'] as const
export type ReviewReplyMode = (typeof REVIEW_REPLY_MODES)[number]

/** What may be WRITTEN into `agents.review_autosend_enabled`. Narrower than what may be read. */
export const reviewAutosendEnabledSchema = z.boolean()

/**
 * What may be WRITTEN into `agents.review_autosend_cooling_off_hours`.
 *
 * `.min(MINIMUM_REVIEW_COOLING_OFF_HOURS)` so the admin screen refuses a shorter delay with a message
 * instead of accepting it and having {@link reviewCoolingOffHours} silently overrule it. Both halves
 * are needed: the schema is the explanation, the normaliser is the guarantee, and a row written before
 * the schema existed is why the guarantee cannot be left to the schema.
 */
export const reviewCoolingOffHoursSchema = z
  .number()
  .int()
  .min(MINIMUM_REVIEW_COOLING_OFF_HOURS)
  .max(720)

/**
 * What may be WRITTEN into `agents.review_reply_languages`.
 *
 * An enum of the detectable languages rather than free BCP-47 text: a code this build cannot identify
 * is not a configuration option, it is a request for a feature. Non-empty, because an empty array is a
 * configuration that escalates every review with any text in it, and an owner who wants that has asked
 * for the autoresponder to be switched off instead.
 */
export const reviewReplyLanguagesSchema = z.array(z.enum(DETECTABLE_REVIEW_LANGUAGES)).min(1)

/**
 * `agents.review_autosend_enabled`, as a boolean. Total, and `false` for everything but `true`.
 *
 * `=== true` rather than `Boolean(value)` or a `z.boolean()` parse with a fall-back: the permissive
 * answer has to be asked for exactly, in the type the registry declares. The strings `'false'` and
 * `'0'` are both truthy, and either of them is what arrives from a form post that skipped validation.
 */
export function reviewAutosendEnabled(value: unknown): boolean {
  return value === true
}

/**
 * `google.business_profile_access_granted`, as a reply mode.
 *
 * `'draft'` is the launch mode, not an error state (docs/10 §6): Google grants Business Profile API
 * access by reviewing an application, quota sits at 0 QPM until it is approved, and that is the state
 * this system ships in. Nothing auto-sends in draft mode, because there is no API to send through.
 */
export function reviewReplyMode(value: unknown): ReviewReplyMode {
  return value === true ? 'api' : 'draft'
}

/**
 * `agents.review_autosend_cooling_off_hours`, as a number of hours, never below the floor.
 *
 * The `Number.isInteger` test comes first rather than relying on the comparison, because the
 * comparison alone answers wrongly at both ends: `NaN >= 24` is `false` and would land on the floor by
 * luck rather than by rule, and `Infinity >= 24` is `true` and would be honoured as a delay no clock
 * ever satisfies — a silent "never auto-send" nobody could explain from the setting.
 */
export function reviewCoolingOffHours(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return MINIMUM_REVIEW_COOLING_OFF_HOURS
  return Math.max(value, MINIMUM_REVIEW_COOLING_OFF_HOURS)
}

/**
 * `agents.review_reply_languages`, as the set actually in force.
 *
 * Intersected with {@link DETECTABLE_REVIEW_LANGUAGES}, deduplicated, and returned in the declared
 * order so two equal sets compare equal. A value that is not an array of strings yields the empty set,
 * which escalates every review carrying text — the conservative direction, and the one that makes an
 * unreadable row visible as a queue full of escalations rather than as a quietly wider policy.
 */
export function configuredReviewLanguages(value: unknown): readonly DetectableReviewLanguage[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const stored = new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim()),
  )
  return Object.freeze(DETECTABLE_REVIEW_LANGUAGES.filter((language) => stored.has(language)))
}
