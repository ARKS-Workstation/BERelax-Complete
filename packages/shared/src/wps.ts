/**
 * The two WPS identifiers nobody has supplied, and the placeholders that stand in for them.
 *
 * ## Why they are here and not in the module that validates them
 *
 * The boundary `./credential-window.ts` describes, for the same reason and with the same three readers.
 * `@berelax/config` declares the settings and their defaults; `@berelax/db` stores whatever is written into
 * them; `@berelax/core` is the validator that refuses a file naming one of these. `packages/config` depends
 * on this package alone — it may not import `@berelax/core` — so a string spelled in core would have to be
 * re-spelled in the registry's `defaultValue`, and the day somebody changes one the other keeps refusing a
 * value that is no longer the placeholder. A placeholder the validator does not recognise is worse than
 * none, because it reads as configured: that is `PLACEHOLDER_TRN`'s own recorded lesson, one estate along.
 *
 * ## What they are, and why the default is a marker rather than a blank
 *
 * docs/04 §7's entire statement about the Wage Protection System is *"salary file, in the format the bank
 * requires"*. No bank is named, no agent code, no establishment or MOL id, no record layout and no field
 * spec appears anywhere in the eleven handover documents. `docs/OPEN-QUESTIONS.md` **Y8-wps** is the
 * question.
 *
 * Both strings are chosen to fail validation TWICE over, which is `PLACEHOLDER_TRN`'s technique: each says
 * what it is in words, and neither is a run of digits. That matters more here than anywhere else in the
 * build — brief rule 15's sharpest instance — because a plausible thirteen digits would produce a wage file
 * that passes every check, looks exactly like a configured one, and pays nineteen people against somebody
 * else's registration.
 *
 * A marker rather than an empty string, unlike `google.cloud_quota_page_url`, because this value is
 * *printed into a file*: an empty field in a fixed-shape record is the one a downstream reader pads and
 * accepts, while `WPS-EMPLOYER-ID-PENDING-Y8-WPS` cannot be mistaken for anything by anybody, including a
 * human reading the file in a text editor.
 */

/** The employer's establishment or MOL identifier, while nobody has supplied one. */
export const PLACEHOLDER_WPS_EMPLOYER_ID = 'WPS-EMPLOYER-ID-PENDING-Y8-WPS'

/** The agent's (bank or exchange house) identifier, while nobody has supplied one. */
export const PLACEHOLDER_WPS_AGENT_ID = 'WPS-AGENT-ID-PENDING-Y8-WPS'

/** The `OPEN-QUESTIONS.md` id both stand on, so a reader of either is one grep from the question. */
export const WPS_OPEN_QUESTION_ID = 'Y8-wps'
