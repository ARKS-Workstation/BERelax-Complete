import { AppError, MESSAGE_CHANNELS, SEND_GATING_CONSENT_PURPOSES } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import { readCurrentConsentWording, recordConsent, withdrawConsent } from './consent.ts'
import { mergeSurvivorOf } from './merge.ts'
import {
  recordSuppression,
  SUPPRESSION_AUDIT_ACTIONS,
  type SuppressionKeying,
  unsuppressKey,
} from './suppression.ts'

/**
 * The preference centre's write, per channel × purpose, and the subject read behind it (C-CRM-07).
 *
 * C-CRM-04 built the preference centre's FUNCTIONAL half — a token service, a JSON endpoint, and one
 * coarse action that withdrew or granted the whole grid at once — and deferred the rendered half. A page
 * that draws the grid needs the write to be as fine as the grid is, which is what
 * {@link applyPreferenceSelection} is, and {@link applyPreferenceCentreChange} is now its `everything`
 * case rather than a second implementation of the same rules. That is not tidying: the two would have had
 * to agree about which rows an unsubscribe writes, about the suppression that outlives a later grant, and
 * about the tombstone below — three chances to disagree, in the one place where disagreeing means a
 * message sent to somebody who asked us to stop.
 *
 * ## The tombstone, which is C-CRM-05's NOTE (8b)
 *
 * C-CRM-05 recorded that a preference-centre link minted for a record that is later merged away still
 * verifies, still suppresses the DETAIL — suppression keys on the hashed recipient and beats consent with
 * no exceptions — and writes its PDPL consent withdrawal onto the TOMBSTONE's log rather than the
 * survivor's. C-CRM-06 re-deferred it here by name. Both halves are discharged in this module, and the two
 * actions are deliberately NOT symmetric:
 *
 *   - **A withdrawal follows the chain.** `merge_survivor_of()` resolves the link's contact to the live
 *     record and the withdrawal lands there. The alternative — refusing the request — drops an opt-out on
 *     the floor, and docs/04 §5 makes this link the ONLY functional opt-out this business has, because an
 *     alphanumeric sender ID cannot receive an inbound SMS. A 404 in front of somebody who has finally had
 *     enough is not a safe default; it is the failure the whole unit exists to prevent. It is also not
 *     "applying one person's preference to another record": a merge is an operator-confirmed assertion that
 *     the two records are ONE person (C-CRM-06 ships no unattended auto-merge), so the survivor *is* the
 *     person who tapped the link.
 *   - **A grant does not.** A resubscribe through a link minted for a merged-away record is refused
 *     {@link PREFERENCE_CENTRE_REFUSALS `preference_grant_on_a_tombstone`}, and the asymmetry is the whole
 *     argument. The two errors are not each other's mirror: a withdrawal applied too widely stops messages
 *     nobody will miss, while a grant applied to the wrong record is marketing consent that nobody gave —
 *     the one thing `consent` exists to be evidence of. A merge that was wrong is a data-integrity
 *     incident, and its remedy is not a page that quietly opts a stranger back in on the strength of
 *     somebody else's three-week-old link.
 *
 * `wasTombstone` is on the result rather than only in the log, so the surface can say so. What the surface
 * must NOT do is answer differently for a tombstone on the READ: that would tell a holder of any token
 * whether the contact behind it has been merged, and C-CRM-04's whole refusal design is that a requester
 * learns nothing about anybody's record from the response.
 *
 * ## Why a withdrawal here carries the wording and C-CRM-04's did not
 *
 * `consent_grant_carries_its_wording` (0056) requires a wording version on a GRANT and deliberately not on
 * a withdrawal — a system that refused to record an opt-out until an operator had published a statement
 * would be easier to opt into than out of. That asymmetry is about what is *required*. This module
 * snapshots whatever the caller actually rendered onto every row it writes, withdrawals included, because
 * C-CRM-07's acceptance is that the version shown on the page is the version on the resulting row: the
 * `wording_hash` a withdrawal carries is then evidence of the words somebody was reading when they
 * decided, and `assert_consent_wording_hash()` refuses a snapshot that disagrees with the stored version.
 * A caller with nothing rendered passes `wording: null` and gets 0064's behaviour unchanged.
 */

// ------------------------------------------------------------------------------------------------
// Refusals
// ------------------------------------------------------------------------------------------------

/** Every reason a preference-centre selection is refused, as a value. Callers branch on these. */
export const PREFERENCE_CENTRE_REFUSALS = [
  /** A channel or a purpose outside the closed sets. Never defaulted — see {@link pairsFor}. */
  'preference_scope_unknown',
  /**
   * The selection needs a contact DETAIL to suppress and this system holds none for it.
   *
   * Refused rather than half-applied. A consent withdrawal with no suppression is the state a later booking
   * form silently undoes, which is exactly the hole C-CRM-04's NOTE (3) describes.
   *
   * Not reachable from the page today and deliberately kept: `customer.phone_e164` is NOT NULL and IS the
   * identity (ADR 0014), so every contact the page can open has a number. This is the arm that says so out
   * loud for the next caller — the shape a merge participant or an import would arrive in — rather than
   * letting a `recipient: null` write the consent half and quietly skip the other one.
   */
  'preference_contact_unreachable',
  /** A resubscribe through a link minted for a record that has since been merged away. See the header. */
  'preference_grant_on_a_tombstone',
  /**
   * A grant with no published wording to be given under.
   *
   * The same name `applyPreferenceCentreChange` raised from `packages/db/src/repositories/suppression.ts`
   * before this module owned the write, so `suppressionRefusalOf` still recognises it and no caller had to
   * learn a second spelling.
   */
  'preference_centre_wording_absent',
] as const
export type PreferenceCentreRefusal = (typeof PREFERENCE_CENTRE_REFUSALS)[number]

function refuse(
  refusal: PreferenceCentreRefusal,
  message: string,
  details: Record<string, unknown> = {},
): never {
  // `validation` for the one a caller can correct by asking for something else; `conflict` for the three
  // that are facts about the record or about what has been published. The kind is what decides whether a
  // surface may show the message — and no refusal here is `userFacing`, because `render.ts` looks the NAME
  // up in a closed Record and a database string must never reach a reader.
  const validation = refusal === 'preference_scope_unknown'
  throw new AppError(validation ? 'validation' : 'conflict', message, {
    userFacing: false,
    details: { ...details, refusal },
  })
}

/** The named refusal carried on an error this module raised, or null. */
export function preferenceCentreRefusalOf(err: unknown): PreferenceCentreRefusal | null {
  if (!(err instanceof AppError)) return null
  const refusal = (err.details as { refusal?: unknown } | undefined)?.refusal
  return typeof refusal === 'string' &&
    (PREFERENCE_CENTRE_REFUSALS as readonly string[]).includes(refusal)
    ? (refusal as PreferenceCentreRefusal)
    : null
}

// ------------------------------------------------------------------------------------------------
// The grid
// ------------------------------------------------------------------------------------------------

/**
 * Every (channel, purpose) pair the preference centre is about, in a fixed order.
 *
 * `MESSAGE_CHANNELS` and `SEND_GATING_CONSENT_PURPOSES` from `@berelax/shared`, never a literal list: the
 * first is the `message_channel` enum the template, the message row and the transport all use, and the
 * second is pinned to `consent_purpose.is_send_gating` by `packages/messaging/src/template-corpus.test.ts`.
 * A third spelling of either here is a page that offers a toggle the send path does not consult, or omits
 * one it does — and the omission is invisible, because a pair nobody renders resolves perfectly well.
 *
 * The order is channels outer, purposes inner, which is the order the page prints and the order a
 * selection's rows are written in. Fixed so the rendered grid and the written rows can be compared
 * position for position.
 */
export const PREFERENCE_GRID: readonly PreferenceGridCell[] = Object.freeze(
  MESSAGE_CHANNELS.flatMap((channel) =>
    SEND_GATING_CONSENT_PURPOSES.map((purpose) => Object.freeze({ channel, purpose })),
  ),
)

/**
 * One cell of the grid, with both halves narrowed.
 *
 * The narrow types are load-bearing rather than decorative: `consentRecordSchema`'s channel and purpose are
 * unions, so a cell that carried `string` would need a cast at the write — and a cast is exactly where a
 * channel the send path does not know would get through. A request's channel and purpose stay `string` in
 * {@link PreferenceScope}, because that is what arrives, and {@link pairsFor} is the one place the two meet.
 */
export interface PreferenceGridCell {
  readonly channel: (typeof MESSAGE_CHANNELS)[number]
  readonly purpose: (typeof SEND_GATING_CONSENT_PURPOSES)[number]
}

/**
 * The channels a message to a PHONE goes out on.
 *
 * Suppression keys on a contact DETAIL and not on a channel (C-CRM-04's NOTE 2), so the list a
 * suppression covers is the list of channels that reach the same detail — and both of these reach the
 * handset. A page that suppressed the number when somebody turned off SMS and claimed WhatsApp was
 * unaffected would be making a promise the key cannot keep.
 */
export const PHONE_CHANNELS: readonly string[] = Object.freeze(['sms', 'whatsapp'])

/**
 * What the page is allowed to change in one submission.
 *
 * `pair` is one cell of the grid, which is what a toggle is. `everything` is the whole grid, which is what
 * "stop messaging me" means and what C-CRM-04's coarse action was. Two shapes and no third: a list of
 * arbitrary pairs would let one submission write a state no button on the page can produce.
 */
export type PreferenceScope =
  | { readonly kind: 'pair'; readonly channel: string; readonly purpose: string }
  | { readonly kind: 'everything' }

/** The pairs a scope names, validated against the grid rather than against a regex. */
function pairsFor(scope: PreferenceScope): readonly PreferenceGridCell[] {
  if (scope.kind === 'everything') return PREFERENCE_GRID
  const pair = PREFERENCE_GRID.find(
    (cell) => cell.channel === scope.channel && cell.purpose === scope.purpose,
  )
  if (pair === undefined) {
    refuse(
      'preference_scope_unknown',
      `'${scope.channel}' × '${scope.purpose}' is not a pair the preference centre has. The grid is ` +
        'built from MESSAGE_CHANNELS and SEND_GATING_CONSENT_PURPOSES, so a pair outside it is either a ' +
        'channel the send path does not know or a purpose that gates no send — and recording a decision ' +
        'against either would be a decision nothing ever reads.',
      { channel: scope.channel, purpose: scope.purpose },
    )
  }
  return [pair]
}

// ------------------------------------------------------------------------------------------------
// The subject
// ------------------------------------------------------------------------------------------------

/** The live record behind a link, and the one detail this system can suppress for it. */
export interface PreferenceSubject {
  /** The id the link named, exactly as it named it. */
  readonly linkContactCustomerId: string
  /** The live record it resolves to, following `merge_record` to the end of the chain. */
  readonly contactCustomerId: string
  /** True when the link's record has been merged away, so the two ids above differ. */
  readonly wasTombstone: boolean
  /**
   * The survivor's phone number, raw from the column.
   *
   * Raw rather than normalised here, because `recordSuppression` and `readSuppressionLogs` both put a
   * recipient through the injected normaliser before hashing it. Normalising a second time in this module
   * would be a second spelling of "canonical", which is how two keys for one number come about — and
   * because the plaintext never reaches a column there is no constraint that could catch it.
   */
  readonly phoneE164: string | null
  /** `customer.locale` (0019). The language the reminder carrying the link was sent in. */
  readonly locale: 'en' | 'ar'
}

/**
 * The record a preference-centre link is about, resolved through the merge chain.
 *
 * Returns null when nothing is behind the resolved id, which the surface must answer exactly as it
 * answers an unknown token: a distinguishable "the contact is gone" would tell a token holder that the
 * record has been erased, and `customer` rows really are erased (docs/04 §4).
 */
export async function readPreferenceSubject(
  sql: Sql,
  linkContactCustomerId: string,
): Promise<PreferenceSubject | null> {
  const contactCustomerId = await mergeSurvivorOf(sql, linkContactCustomerId)
  const rows = await sql<{ phone_e164: string | null; locale: string }[]>`
    select phone_e164, locale from customer where id = ${contactCustomerId}::uuid
  `
  const row = rows[0]
  if (row === undefined) return null
  return {
    linkContactCustomerId,
    contactCustomerId,
    wasTombstone: contactCustomerId !== linkContactCustomerId,
    phoneE164: row.phone_e164,
    locale: row.locale === 'ar' ? 'ar' : 'en',
  }
}

// ------------------------------------------------------------------------------------------------
// The write
// ------------------------------------------------------------------------------------------------

/** What the preference centre can do. Two actions, and they are exact opposites. */
export const PREFERENCE_CENTRE_ACTIONS = ['unsubscribe', 'resubscribe'] as const
export type PreferenceCentreAction = (typeof PREFERENCE_CENTRE_ACTIONS)[number]

/**
 * One wording version a surface actually rendered, to be snapshotted onto the rows of ITS purpose.
 *
 * The purpose is on the shape and it is load-bearing. A page showing the marketing statement and recording
 * a `review_request` GRANT against it would be storing proof of an agreement to words that say nothing
 * about review requests — and nothing in the database would refuse it: `assert_consent_wording_hash()`
 * checks the hash against the version it names and `consent_grant_carries_its_wording` only requires that
 * there IS one. So the match is made here, by purpose, and a purpose the surface rendered nothing for falls
 * back to the published version for a grant (which the surface then owes the reader) and to nothing for a
 * withdrawal.
 */
export interface RenderedWording {
  /** Which purpose this statement was published for. `consent_wording.purpose`. */
  readonly purpose: string
  readonly id: string
  /** Lower-case hex of `consent_wording.content_hash`. Handed through unchanged. */
  readonly contentHashHex: string
}

export interface PreferenceSelection {
  /** The contact the LINK names. Resolved through the merge chain inside the transaction. */
  readonly contactCustomerId: string
  readonly action: PreferenceCentreAction
  readonly scope: PreferenceScope
  /**
   * The recipient the link was reached through, raw, or null when this system holds none.
   *
   * Null is a real state and not an error on its own: `customer` has no email column at all (C-CRM-01's
   * NOTE 3), so an email-only selection has no detail to suppress and says so. A selection that DOES need
   * the phone and has none is refused rather than half-applied.
   */
  readonly recipient: string | null
  readonly keyKind: string
  /** The locale the wording was shown in, which is part of the consent capture context (0056). */
  readonly locale: 'en' | 'ar'
  /**
   * The versions the surface rendered, one per purpose. Empty or null for a caller that rendered none.
   *
   * A LIST rather than one version, because the grid covers two send-gating purposes and each has its own
   * published statement. See {@link RenderedWording} for what goes wrong when one stands in for the other.
   */
  readonly wording: readonly RenderedWording[] | null
  readonly decidedAtIso: string
  /** Who is acting, for the capture context. The link holder, never a name (ADR 0020). */
  readonly actorLabel: string
}

export interface PreferenceSelectionResult {
  readonly action: PreferenceCentreAction
  readonly scope: PreferenceScope
  /** The live record the rows landed on. Differs from the link's id exactly when it was a tombstone. */
  readonly contactCustomerId: string
  readonly wasTombstone: boolean
  /** The pairs written, in grid order. */
  readonly pairs: readonly PreferenceGridCell[]
  /** How many consent rows the change actually wrote. Zero on a replay at the same instant. */
  readonly consentRows: number
  readonly suppressionRecorded: boolean
  /** Null exactly when the scope reaches no detail this system holds. */
  readonly suppressionId: string | null
}

/**
 * Applies one preference-centre submission: the consent rows and the suppression, in one transaction.
 *
 * ## Why both halves, always
 *
 * C-CRM-04 states it and it is restated here because this module is where the two halves now meet:
 *
 *   - the **consent row** is the record that this person changed their mind about this channel and this
 *     purpose, carrying the wording and the capture context PDPL asks for. It is what `resolveConsent`
 *     reads and what a regulator would want to see;
 *   - the **suppression** is the instruction that outlives a later grant. Somebody who unsubscribes and
 *     then fills in a booking form again has a NEW consent row, newer than the withdrawal, and consent
 *     alone would start messaging them. "Suppression beats consent with no exceptions" is what makes that
 *     not happen.
 *
 * Dropping either leaves a hole somebody walks through, so a scope that cannot write both is refused
 * rather than recorded in half.
 *
 * ## Why one toggle suppresses the whole handset, and why the page has to say so
 *
 * A suppression names a hashed DETAIL and there is no per-purpose suppression — deliberately, because the
 * send path consults the list at one choke point and a per-purpose list would be a second consent model
 * wearing a blocklist's clothes. So turning off `sms` × `marketing` adds the NUMBER to the list, which
 * stops every promotional message to that number, WhatsApp included. That is broader than the toggle and
 * it is broad in the safe direction; what is not acceptable is for the page to imply otherwise, so
 * `render.ts` prints the consequence next to the grid rather than leaving a reader to discover it.
 */
export async function applyPreferenceSelection(
  uow: UnitOfWork,
  keying: SuppressionKeying,
  selection: PreferenceSelection,
): Promise<PreferenceSelectionResult> {
  const pairs = pairsFor(selection.scope)

  // Inside the transaction and before anything is written, so a merge committing between the page render
  // and this submission cannot land half the rows on the tombstone and half on the survivor.
  const contactCustomerId = await mergeSurvivorOf(uow.sql, selection.contactCustomerId)
  const wasTombstone = contactCustomerId !== selection.contactCustomerId
  if (wasTombstone && selection.action === 'resubscribe') {
    refuse(
      'preference_grant_on_a_tombstone',
      `The link names customer ${selection.contactCustomerId}, which has been merged into ` +
        `${contactCustomerId}. A withdrawal follows that chain and a GRANT does not: a consent record is ` +
        'evidence that a named person agreed, and writing one onto a record the link was not minted for ' +
        'would be evidence of something nobody did. The withdrawal path is unaffected, which is the half ' +
        'that matters — this link is the only functional opt-out this business has.',
      { linkContactCustomerId: selection.contactCustomerId, survivorCustomerId: contactCustomerId },
    )
  }

  const capture = {
    source: 'preference_centre',
    actorKind: 'customer',
    actorLabel: selection.actorLabel,
    locale: selection.locale,
  } as const

  /** The version the surface rendered for one purpose, or null. Matched by purpose, never positionally. */
  const rendered = (purpose: string): RenderedWording | null =>
    selection.wording?.find((version) => version.purpose === purpose) ?? null

  // One read per PURPOSE at most, not one per pair: the grid is three channels by two purposes, and a
  // resubscribe that read the published wording inside the channel loop would issue the same query three
  // times for each of them.
  const published = new Map<string, RenderedWording>()
  const publishedFor = async (purpose: string): Promise<RenderedWording> => {
    const held = published.get(purpose)
    if (held !== undefined) return held
    const read = await currentWording(uow, purpose)
    published.set(purpose, read)
    return read
  }

  let consentRows = 0
  for (const pair of pairs) {
    const shown = rendered(pair.purpose)
    if (selection.action === 'unsubscribe') {
      const written = await withdrawConsent(uow, {
        contactCustomerId,
        channel: pair.channel,
        purpose: pair.purpose,
        // The version SHOWN for this purpose, or nothing — never another purpose's, and never the published
        // one the reader did not see. 0056 calls this column "the version shown", and on a withdrawal that
        // is the whole of its meaning: what somebody was reading when they decided.
        // `consent_wording_reference_is_whole` makes the id and the hash one fact said twice, so they are
        // supplied together or not at all.
        wordingId: shown?.id ?? null,
        wordingHashHex: shown?.contentHashHex ?? null,
        recordedAtIso: selection.decidedAtIso,
        capture,
      })
      if (written.recorded) consentRows += 1
      continue
    }
    const wording = shown ?? (await publishedFor(pair.purpose))
    const written = await recordConsent(uow, {
      contactCustomerId,
      channel: pair.channel,
      purpose: pair.purpose,
      kind: 'granted',
      recordedAtIso: selection.decidedAtIso,
      wordingId: wording.id,
      wordingHashHex: wording.contentHashHex,
      capture,
    })
    if (written.recorded) consentRows += 1
  }

  const suppression = await applyDetail(uow, keying, selection, pairs, contactCustomerId)

  await uow.audit.record({
    action: SUPPRESSION_AUDIT_ACTIONS.preferenceChanged,
    // The suppression when there is one, the contact otherwise. An email-only selection writes consent
    // rows and no suppression, and an audit row naming an entity that does not exist is worse than one
    // naming the record the decision was about.
    entityType: suppression === null ? 'customer' : 'suppression',
    entityId: suppression?.id ?? contactCustomerId,
    operation: 'create',
    // No recipient. The key kind says which detail was acted on and the suppression row holds its HMAC.
    after: {
      contact_customer_id: contactCustomerId,
      link_contact_customer_id: selection.contactCustomerId,
      was_tombstone: wasTombstone,
      action: selection.action,
      scope:
        selection.scope.kind === 'everything'
          ? 'everything'
          : `${selection.scope.channel}:${selection.scope.purpose}`,
      key_kind: suppression === null ? null : selection.keyKind,
      locale: selection.locale,
      // The versions shown, by purpose, so the trail says which words were on the screen — and says it for
      // each purpose separately, because a page showing one statement for both would be the defect
      // `RenderedWording` exists to refuse.
      consent_wording_ids: Object.fromEntries(
        (selection.wording ?? []).map((version) => [version.purpose, version.id]),
      ),
      decided_at: selection.decidedAtIso,
    },
  })

  return {
    action: selection.action,
    scope: selection.scope,
    contactCustomerId,
    wasTombstone,
    pairs,
    consentRows,
    suppressionRecorded: suppression?.recorded ?? false,
    suppressionId: suppression?.id ?? null,
  }
}

/** The current wording for a purpose, refused by name when none is published. */
async function currentWording(uow: UnitOfWork, purpose: string): Promise<RenderedWording> {
  const wording = await readCurrentConsentWording(uow.sql, purpose)
  if (wording === null) {
    refuse(
      'preference_centre_wording_absent',
      `No consent wording is published for '${purpose}', so there is nothing to grant against. A grant ` +
        'with no record of the words shown is not an opt-in proof, and the database refuses one.',
      { purpose },
    )
  }
  return { purpose, id: wording.id, contentHashHex: wording.contentHashHex }
}

/**
 * The suppression half: one row on the detail the scope reaches, or none.
 *
 * Null means the scope reaches no detail this system holds, which today is exactly an email-only
 * selection. It is a reported state rather than a refusal because the consent half IS the whole of what
 * can be recorded about email: `customer` has no email column, so promotional email already fails closed
 * as `blocked_unevaluable` (C-CRM-04's NOTE 4) and there is no address to put on the list.
 */
async function applyDetail(
  uow: UnitOfWork,
  keying: SuppressionKeying,
  selection: PreferenceSelection,
  pairs: readonly PreferenceGridCell[],
  contactCustomerId: string,
): Promise<{ readonly id: string; readonly recorded: boolean } | null> {
  const reachesPhone = pairs.some((pair) => PHONE_CHANNELS.includes(pair.channel))
  if (!reachesPhone) return null
  if (selection.recipient === null) {
    refuse(
      'preference_contact_unreachable',
      'This selection covers a channel that reaches the handset and no phone number is held for the ' +
        'contact, so there is no detail to suppress. Refused rather than recorded in half: a consent ' +
        'withdrawal with no suppression is the state a later booking form silently undoes.',
      { contactCustomerId, keyKind: selection.keyKind },
    )
  }
  const entry = {
    keyKind: selection.keyKind,
    recipient: selection.recipient,
    source: 'preference_centre',
    reason:
      selection.action === 'unsubscribe'
        ? 'Unsubscribed through the preference centre link.'
        : 'Resubscribed through the preference centre link.',
    actorKind: 'customer',
    actorLabel: selection.actorLabel,
    recordedAtIso: selection.decidedAtIso,
    contactCustomerId,
  } as const
  const written =
    selection.action === 'unsubscribe'
      ? await recordSuppression(uow, keying, entry)
      : await unsuppressKey(uow, keying, entry)
  return { id: written.row.id, recorded: written.recorded }
}

// ------------------------------------------------------------------------------------------------
// C-CRM-04's coarse action, as the `everything` case
// ------------------------------------------------------------------------------------------------

export interface PreferenceCentreChange {
  readonly contactCustomerId: string
  readonly action: PreferenceCentreAction
  /** The recipient the link was reached through, raw. The only detail that can be suppressed. */
  readonly recipient: string
  readonly keyKind: string
  /** The locale the wording was shown in, which is part of the consent capture context. */
  readonly locale: 'en' | 'ar'
  readonly decidedAtIso: string
}

export interface PreferenceCentreResult {
  readonly action: PreferenceCentreAction
  /** How many consent rows the change wrote. Every send-gating purpose × every channel. */
  readonly consentRows: number
  readonly suppressionRecorded: boolean
  readonly suppressionId: string
}

/**
 * "Stop messaging me", over the whole grid. C-CRM-04's action, now one call into the scoped write.
 *
 * Kept as its own export because `/api/v1/preferences` is a published contract with a `PreferenceCentreAction`
 * in its body and a `PreferenceCentreResult` in its answer, and because "the whole grid" is a real domain
 * operation rather than a convenience: a withdrawal narrower than every channel and every send-gating
 * purpose would be this system deciding that somebody who said stop only meant SMS.
 *
 * It passes `wording: null`, so its rows are byte-for-byte what 0064's implementation wrote — a withdrawal
 * with no wording reference, a grant under the current version read per purpose. What it gains by
 * delegating is the tombstone resolution, which is the half of C-CRM-05's NOTE (8b) that had to reach this
 * surface too: the JSON endpoint is the one a customer's link actually opens today, so fixing only the
 * page would have left the deferral discharged on the surface nobody uses yet.
 *
 * `suppressionId` is non-null here where the scoped result allows null, and that is sound rather than a
 * cast: `everything` covers `sms`, so the phone is always reached, and a `recipient` is mandatory on this
 * shape. A null would mean {@link applyDetail} had returned early for a scope containing `sms`, which is
 * an invariant failure rather than a state to paper over.
 */
export async function applyPreferenceCentreChange(
  uow: UnitOfWork,
  keying: SuppressionKeying,
  change: PreferenceCentreChange,
): Promise<PreferenceCentreResult> {
  const result = await applyPreferenceSelection(uow, keying, {
    contactCustomerId: change.contactCustomerId,
    action: change.action,
    scope: { kind: 'everything' },
    recipient: change.recipient,
    keyKind: change.keyKind,
    locale: change.locale,
    wording: null,
    decidedAtIso: change.decidedAtIso,
    actorLabel: PREFERENCE_CENTRE_ACTOR_LABEL,
  })
  if (result.suppressionId === null) {
    throw new AppError(
      'invariant_violated',
      'A preference-centre change over the whole grid wrote no suppression row. The grid contains `sms`, ' +
        'so the handset is always reached and a recipient is mandatory on this shape — a null here means ' +
        'the detail half was skipped for a scope that requires it.',
      { details: { contactCustomerId: result.contactCustomerId } },
    )
  }
  return {
    action: result.action,
    consentRows: result.consentRows,
    suppressionRecorded: result.suppressionRecorded,
    suppressionId: result.suppressionId,
  }
}

/**
 * The label every preference-centre row records as its actor.
 *
 * A label and not a name: the request is the customer's own, made on the strength of a capability rather
 * than a session, and this system invents no names for people (ADR 0020). One constant, because
 * `consent.capture_actor_label` and `suppression.actor_label` are both read as "who did this" and two
 * spellings would read as two actors.
 */
export const PREFERENCE_CENTRE_ACTOR_LABEL = 'Preference centre (link holder)'
