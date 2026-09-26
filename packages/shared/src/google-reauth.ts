/**
 * The Google re-auth banner and the escalating notification ladder: the constants five packages need to
 * agree on exactly.
 *
 * Here for the reason `compliance-notices.ts` and `reminders.ts` next door are here. Five things that may
 * not import each other need these values to be the same characters: the ladder itself
 * (`packages/core/src/google/reauth.ts`), the F09 settings registry (`packages/config`), the shipped
 * templates (`packages/messaging`), the table that records what was sent (`packages/db`, migration 0075)
 * and the pass that sends it (`apps/worker`). `packages/shared` is the leaf every one of them may import,
 * so each string is written once and a mismatch is not expressible.
 *
 * ## Why the reassurance sentence is a constant and not a phrase in a template
 *
 * docs/10 §4 asks that every re-auth message carry *"review replies will keep being drafted for you to
 * post by hand; nothing is lost"*, and it is already in `CONNECTION_STATE_COPY.broken.detail` — the
 * sentence the settings card and the banner print. An email that reworded it would be a second promise
 * about the same fact, and the owner reading both would have to decide which one is true. So there is one
 * spelling, asserted to appear in the banner copy AND in every shipped re-auth template body.
 *
 * It is the sentence that stops the red banner being a phone call, which is why it is load-bearing rather
 * than decoration: the owner's first question on seeing it is whether work has been lost.
 */

/**
 * The one spelling of the promise every re-auth surface makes.
 *
 * Lower case and no full stop, because it is a clause: it ends `CONNECTION_STATE_COPY.broken.detail`'s
 * second sentence and it ends each template body, and a constant carrying its own terminal punctuation
 * cannot do both.
 */
export const REAUTH_REASSURANCE_SENTENCE =
  'review replies will keep being drafted for you to post by hand; nothing is lost'

/** Whether a re-auth notice may also go by SMS. Off, and the default is the decision — see the registry. */
export const GOOGLE_REAUTH_SMS_SETTING_KEY = 'google.reauth_sms_enabled'

/** How many notices one unresolved re-auth incident may produce in total, reactive ladder included. */
export const GOOGLE_REAUTH_REPEAT_CAP_SETTING_KEY = 'google.reauth_notice_repeat_cap'

/**
 * Five: the first notice, one a day later, then three more daily.
 *
 * Chosen from the asymmetry rather than from a round number. A dead Google grant stops review replies
 * being posted and Search Console being read, and every one of those failures is silent — so stopping
 * after one notice risks an owner who deleted it on a Friday. Going on for ever is the other failure, and
 * it is worse in a way that is easy to underrate: the sixth identical email teaches the owner that these
 * emails do not need reading, and the next incident then gets no attention at all. Five reaches day four.
 *
 * It is a setting rather than a constant because it is a judgement about one business's habits, and the
 * correction should be a screen rather than a deploy.
 */
export const DEFAULT_GOOGLE_REAUTH_REPEAT_CAP = 5

/**
 * The hard ceiling on the cap, restated as a CHECK in migration 0075.
 *
 * The duplication is deliberate, for 0051's and 0060's reason: the database cannot import a TypeScript
 * module, and a row claiming rung 900 would be a ladder nobody declared. Eight because it is comfortably
 * above the default and still a week — beyond a week of daily emails about one connection, the problem is
 * that nobody is reading them.
 */
export const MAX_GOOGLE_REAUTH_LADDER_STEPS = 8

/**
 * The two template keys, per notice kind.
 *
 * Two rather than one with a variable, because they report different facts: one says the connection has
 * stopped working, the other says it is about to. A single template would have to hedge, and a hedged
 * subject line is the one that does not get opened.
 */
export const GOOGLE_REAUTH_TEMPLATE_KEYS = {
  reactive: 'google.reauth_required',
  predictive: 'google.reauth_expiring',
} as const satisfies Readonly<Record<'reactive' | 'predictive', string>>

/** Every shipped re-auth template key, for a corpus test that must not miss one. */
export const GOOGLE_REAUTH_TEMPLATE_KEY_LIST: readonly string[] = Object.freeze(
  Object.values(GOOGLE_REAUTH_TEMPLATE_KEYS),
)
