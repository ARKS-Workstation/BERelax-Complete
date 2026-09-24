/**
 * The suppression contract: the closed source set, the two record kinds, and the zod schema that refuses
 * an incomplete entry at the edge (C-CRM-04).
 *
 * It lives in `shared` for the reason `schemas/consent.ts` states about itself: three packages need the
 * same statement of it and no two of them may import each other. `@berelax/core` resolves a log into a
 * state (`consent/sendability.ts`), `@berelax/db` writes the rows
 * (`repositories/suppression.ts`), and the preference-centre route validates what a person clicked before
 * either sees it. A vocabulary declared in `db` would pull the schema mirror into `core`, which the
 * boundary rules forbid.
 *
 * Every constraint here has a counterpart in `packages/db/migrations/0064_suppression.sql`, and the
 * duplication is the point — the same point 0056 and `schemas/consent.ts` make about each other: zod
 * refuses a bad entry at the edge with a message a person can read, and the database refuses it at the
 * last possible moment with no way round it. Either alone is a gap, because a route is bypassable from
 * psql and a CHECK violation reaches a customer as a 500.
 *
 * ## Why the source set is a Postgres enum here and a TABLE for consent purposes
 *
 * `consent_purpose` is a table because every label in it is this build's guess at a business vocabulary
 * and a provisional value must carry `is_provisional`, an OPEN-QUESTIONS id and a note, which an enum
 * label cannot (brief rule 15). These five sources are not a guess: each names a MECHANISM that exists —
 * a member of staff typing, a recipient complaining, a mail provider rejecting an address, the national
 * register, the preference centre — and a sixth would be new code rather than a new opinion. So the
 * closed set is enforced by a type in the database and by `z.enum` here, and there is no vocabulary row
 * for a seed to fail to write.
 */
import { z } from 'zod'
import { PLACEHOLDER_MARKERS } from './consent.ts'

/**
 * Where a suppression came from. Closed, and mirrored by the `suppression_source` enum in 0064.
 *
 * `dnc_register` carries this unit's one provisional READING rather than a provisional label: the
 * national do-not-call register is treated as binding on this business as well as on the aggregator,
 * which is the stricter of the two available interpretations. That is recorded on the unit's manifest
 * entry, not as a flag on a label, because it is a decision about how the list is USED and not a doubt
 * about what the label means.
 */
export const SUPPRESSION_SOURCES = [
  'manual',
  'complaint',
  'hard_bounce',
  'dnc_register',
  'preference_centre',
] as const
export type SuppressionSource = (typeof SUPPRESSION_SOURCES)[number]

/**
 * The two kinds of record, and there are only two.
 *
 * "Never suppressed" is the **absence** of a row and is never stored, exactly as `CONSENT_KINDS` treats
 * "never asked": a row saying nothing happened is a row a later reader treats as a decision. Removing
 * somebody from the list is a new row with `kind: 'unsuppressed'`; the suppressing row is left as it was,
 * because `suppression` revokes UPDATE and DELETE for every role including the owner.
 */
export const SUPPRESSION_KINDS = ['suppressed', 'unsuppressed'] as const
export type SuppressionKind = (typeof SUPPRESSION_KINDS)[number]

/**
 * The sources an UNSUPPRESSION may carry.
 *
 * A complaint and a hard bounce are **events**: they happened, and they cannot un-happen. A bounce that
 * stopped bouncing is a new deliverability fact and somebody has to take responsibility for acting on it,
 * which is what `manual` is for. The three that remain are the ones with a decision behind them — a
 * member of staff, the recipient themselves, or the register being re-read. Mirrored by
 * `suppression_unsuppression_has_a_decision_behind_it` in 0064.
 */
export const UNSUPPRESSION_SOURCES = ['manual', 'preference_centre', 'dnc_register'] as const
export type UnsuppressionSource = (typeof UNSUPPRESSION_SOURCES)[number]

export const isUnsuppressionSource = (source: string): source is UnsuppressionSource =>
  (UNSUPPRESSION_SOURCES as readonly string[]).includes(source)

/**
 * The two kinds of key, spelled exactly as `customer_blocklist.key_kind` spells them (0053).
 *
 * The same two labels on purpose. A blocklist and a suppression list answer different questions at
 * different choke points — "we will not serve this person" against "we will not market to this person" —
 * but a KEY is the same thing in both, and a second vocabulary for it is how the two lists come to
 * disagree about what a normalised phone number is.
 */
export const SUPPRESSION_KEY_KINDS = ['phone', 'email'] as const
export type SuppressionKeyKind = (typeof SUPPRESSION_KEY_KINDS)[number]

/** Who recorded it. `system` is a sweep or an import, and it must say so rather than borrow a name. */
export const SUPPRESSION_ACTOR_KINDS = ['customer', 'staff', 'system'] as const
export type SuppressionActorKind = (typeof SUPPRESSION_ACTOR_KINDS)[number]

/** A uuid in any version, lower or upper case. Same shape `schemas/consent.ts` accepts. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Lower-case hex, 64 characters. HMAC-SHA256 and sha256 are both 32 bytes. */
const HEX_256 = /^[0-9a-f]{64}$/

/**
 * A suppression entry as it is captured.
 *
 * `keyHmacHex` and never a phone number or an address: the caller has already hashed the recipient under
 * the server-side pepper, and this schema refuses anything that is not 64 lower-case hex characters.
 * That is the edge's half of the guarantee migration 0064 makes with `suppression_key_is_hmac_hex`, and
 * it is the one field where the two halves are not merely belt-and-braces — a plaintext number reaching
 * the column is the failure the whole keying scheme exists to prevent, and a caller that passed one would
 * otherwise find out from a CHECK violation rendered as a 500.
 *
 * `.strict()` so an unexpected key is an error rather than data silently dropped on the way to a column
 * that does not exist.
 */
export const suppressionEntrySchema = z
  .object({
    keyKind: z.enum(SUPPRESSION_KEY_KINDS),
    keyHmacHex: z
      .string()
      .regex(
        HEX_256,
        'A suppression key is 64 lower-case hex characters: the HMAC-SHA256 of the normalised ' +
          'recipient under the server-side pepper. A phone number or an address here is the one thing ' +
          'this table must never hold.',
      ),
    pepperVersion: z.string().trim().min(1).max(64),
    kind: z.enum(SUPPRESSION_KINDS),
    source: z.enum(SUPPRESSION_SOURCES),
    reason: z
      .string()
      .trim()
      .min(1, 'A suppression must say why. An entry with no stated reason cannot be reviewed.')
      .max(500)
      .refine((value) => !PLACEHOLDER_MARKERS.test(value), {
        message:
          'The reason may not be a placeholder: "TBC" answers nothing a review asks, and 0026 refuses ' +
          'it at the database as well.',
      }),
    actorKind: z.enum(SUPPRESSION_ACTOR_KINDS),
    actorLabel: z
      .string()
      .trim()
      .min(1, 'A suppression must name who recorded it.')
      .max(200)
      .refine((value) => !PLACEHOLDER_MARKERS.test(value), {
        message: 'The actor label may not be a placeholder.',
      }),
    /** The instant the decision was made, supplied by the caller's clock — never `now()` in SQL. */
    recordedAtIso: z.string().datetime({ offset: true }),
    /** Which record this is about, when one is known. Never matched on. */
    contactCustomerId: z.string().regex(UUID, 'A contact id is a uuid.').nullable(),
  })
  .strict()
  .refine((value) => value.kind !== 'unsuppressed' || isUnsuppressionSource(value.source), {
    message:
      'An unsuppression must have a decision behind it. A complaint and a hard bounce are events that ' +
      'happened and cannot un-happen; lifting one is a manual act somebody is accountable for.',
    path: ['source'],
  })
  .refine((value) => value.source !== 'preference_centre' || value.actorKind === 'customer', {
    message:
      'A preference-centre entry is the CUSTOMER speaking. Attributed to staff or to the system it ' +
      'would be a withdrawal nobody made, recorded as though somebody had.',
    path: ['actorKind'],
  })

export type SuppressionEntryInput = z.infer<typeof suppressionEntrySchema>
