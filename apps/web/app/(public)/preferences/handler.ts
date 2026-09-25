import {
  type ConsentLog,
  decideOptOutAccess,
  type Instant,
  optOutTokenShape,
  resolveConsent,
  resolveSuppression,
} from '@berelax/core'
import {
  type Actor,
  applyPreferenceSelection,
  type ConsentWordingRecord,
  PREFERENCE_CENTRE_ACTIONS,
  PREFERENCE_CENTRE_ACTOR_LABEL,
  PREFERENCE_GRID,
  type PreferenceCentreAction,
  type PreferenceScope,
  type PreferenceSubject,
  preferenceCentreRefusalOf,
  readConsentLog,
  readCurrentConsentWording,
  readPreferenceSubject,
  readPremisesFacts,
  readSuppressionLogs,
  type Sql,
  type SuppressionKeying,
  suppressionRefusalOf,
  verifyOptOutToken,
  withUnitOfWork,
} from '@berelax/db'
import { isAppError, preferenceCentrePath } from '@berelax/shared'
import {
  type PreferenceCellView,
  type PreferenceLocale,
  type PreferenceOutcome,
  renderPreferenceCentreHtml,
} from './render.ts'

/**
 * `/preferences` — the preference centre, public, login-free and server-rendered (C-CRM-07).
 *
 * The handler rather than the route binding, so `apps/web/src/preference-centre.itest.ts` can drive it
 * directly against a real PostgreSQL with a frozen clock, exactly as `preferences-route.itest.ts` and
 * `manage-booking.itest.ts` drive theirs. That suite ALSO starts a server, and only for the two claims a
 * direct call cannot make: a document rendered with JavaScript disabled, and a form in it that submits.
 *
 * ## What this adds to C-CRM-04, which built the functional half
 *
 * C-CRM-04's `/api/v1/preferences` answers JSON for the whole grid and takes one coarse action. This is the
 * SCREEN, and it is finer in one way that matters: every channel × purpose pair has its own control, so a
 * reader can stop review requests and keep offers. `applyPreferenceSelection` in
 * `packages/db/src/repositories/preference-centre.ts` is the write, and C-CRM-04's coarse action is now its
 * `everything` case rather than a second implementation.
 *
 * ## Every refusal is the same status and the same shell
 *
 * A malformed token, an unknown one, an expired one, a revoked one and a valid token presented for another
 * contact all answer **200** with the preference centre's own document, whose only difference from a valid
 * one is the words inside `<main>`. Not a 404, and the reason is the URL: the capability is a query field, so
 * `/preferences` names a page that always exists and a 404 would be a lie about the resource as well as an
 * oracle about the contact. A status that differed would tell a caller who guesses a contact id whether it
 * exists, which is precisely what C-CRM-04's one frozen refusal body exists to prevent — the same property,
 * made for a document instead of for JSON.
 *
 * The rate limit is the ONE distinguishable answer and it is deliberate, for C-CRM-04's reason: a 429 with
 * `Retry-After` is a fact about the caller rather than about anybody's data, and answering the ordinary page
 * to a flood would leave a well-behaved client retrying immediately for ever.
 *
 * ## Why an unattributable request is refused rather than allowed
 *
 * `optout_verification_attempt.request_ip` is NOT NULL and the limit has one dimension, so a request whose
 * address cannot be read would bypass the only defence there is. It answers 400 by name, as the JSON
 * endpoint does.
 */

/** What the handler needs from the world. Every one of the three is injected, so a suite can freeze it. */
export interface PreferenceCentreDeps {
  readonly sql: Sql
  /** Injected, so the integration suite can freeze it. Expiry is judged against this and nothing else. */
  readonly now: () => string
  readonly keying: SuppressionKeying
}

/**
 * The actor on a preference-centre request.
 *
 * `customer` with no id and a label rather than a name, from the one constant `@berelax/db` publishes: the
 * request is the customer's own, made on the strength of a capability rather than a session, and this system
 * invents no names for people (ADR 0020). One spelling, because `consent.capture_actor_label` and
 * `suppression.actor_label` are both read as "who did this".
 */
const CALLER: Actor = { kind: 'customer', label: PREFERENCE_CENTRE_ACTOR_LABEL }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What the page was asked for: the capability, the language, and what just happened. */
export interface PreferenceRequest {
  readonly contactId: string | null
  readonly token: string | null
  readonly locale: PreferenceLocale
  readonly outcome: PreferenceOutcome
  readonly requestIp: string | null
}

/** The shape every refusal name in this domain has. Bounded, so a query field cannot be a paragraph. */
const REFUSAL_NAME = /^[a-z_]{1,64}$/

/**
 * Reads the request. Nothing here can refuse: a malformed contact id is the same page as an unknown token.
 *
 * `c` is NOT validated into a 400 and that is the point. A 400 for a value that is not a uuid against a 200
 * for a uuid that is not known is the start of the oracle this page is built to avoid, so a malformed id is
 * carried through as "no contact" and answered exactly as a forged token is.
 *
 * The locale comes from `lang` and defaults to English. Never from `customer.locale`: the language of the
 * response would then be a fact about the record readable by anybody holding the link, and the shell of a
 * valid page would differ from the shell of a refused one. The sender puts the locale in the link
 * (`preferenceCentrePath`) and the page offers the other one as a link.
 */
export function readPreferenceRequest(
  url: URL,
  headers: Headers,
  callerAddress: (headers: Headers) => string | null,
): PreferenceRequest {
  const contactId = url.searchParams.get('c')
  const done = url.searchParams.get('done')
  const refused = url.searchParams.get('refused')
  return {
    contactId: contactId !== null && UUID.test(contactId) ? contactId : null,
    token: url.searchParams.get('t'),
    locale: url.searchParams.get('lang') === 'ar' ? 'ar' : 'en',
    outcome: outcomeFrom(done, refused),
    requestIp: callerAddress(headers),
  }
}

/**
 * The outcome a `?done=` or `?refused=` field names.
 *
 * Echoed through the query string because a write REDIRECTS: a 200 rendered from a POST leaves the form
 * resubmittable on reload, and "we have stopped it" shown twice reads as two decisions. The refusal's SHAPE
 * is checked here rather than trusted — `render.ts` looks the name up in a closed `Record` and falls back to
 * words that claim nothing, so a value somebody types into the URL could never put a sentence on the page,
 * but it would reach a `data-` attribute.
 */
function outcomeFrom(done: string | null, refused: string | null): PreferenceOutcome {
  if (done === 'stopped') return { kind: 'stopped' }
  if (done === 'started') return { kind: 'started' }
  if (refused !== null && REFUSAL_NAME.test(refused)) return { kind: 'refused', refusal: refused }
  return { kind: 'none' }
}

function page(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cached and never stored: the URL carries a credential, so a shared cache holding this
      // response would hold the answer for whoever asks next.
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      // The token is a query field, which is exactly what a Referer header carries in full. The `<meta>` in
      // the document says the same thing; this is the half that survives a proxy.
      'referrer-policy': 'no-referrer',
    },
  })
}

/**
 * The page a refused link opens onto: the same shell, the same status, the words inside `<main>` changed.
 *
 * Built from the request's LOCALE and the `premises` singleton, and from nothing else — no interpolation of
 * the token, and no read that a valid page does not also make, so two callers cannot be told apart by a
 * failure. That is the acceptance criterion made structural rather than careful, and the one thing it needs
 * from `render.ts` is that the language switch sits inside `<main>`: it is the only element whose href
 * carries the capability, and a shell holding it would differ per request.
 */
function unavailablePage(request: PreferenceRequest, deskPhoneE164: string): Response {
  return page(
    renderPreferenceCentreHtml({
      locale: request.locale,
      cells: null,
      suppressed: false,
      suppressionSource: null,
      wording: [],
      linkExpiresAtIso: null,
      outcome: request.outcome,
      deskPhoneE164,
      // The language link WITHOUT the capability, which is the one place this document differs from the
      // valid one's construction. Carrying it would make two refusals differ from each other — a malformed
      // token and an absent one echo different values — and a set of refusal documents that differ is a set
      // somebody can compare. There is nothing to preserve: the link did not open anything, so the other
      // language of it opens nothing either.
      otherLocaleHref: preferenceCentrePath({
        contactId: '',
        token: '',
        locale: request.locale === 'ar' ? 'en' : 'ar',
      }),
      emailDetailHeld: false,
    }),
  )
}

/**
 * This page's URL in the other language, carrying the same capability.
 *
 * Through `preferenceCentrePath` so `/preferences` and its three field names are spelled once — the registry
 * declares the path, `packages/shared` builds the instance, and the absolute link a message carries is the
 * same builder with an origin in front. A second spelling here is the one that would be missed if any of
 * them moved. An absent contact or token produces a link to the page with an empty capability, which lands
 * on this same refusal rather than on a 500.
 */
function otherLocaleHref(request: PreferenceRequest): string {
  return preferenceCentrePath({
    contactId: request.contactId ?? '',
    token: request.token ?? '',
    locale: request.locale === 'ar' ? 'en' : 'ar',
  })
}

const tooManyRequests = (retryAfterSeconds: number): Response =>
  new Response(null, {
    status: 429,
    headers: {
      'retry-after': String(retryAfterSeconds),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  })

/** The desk telephone number, from the `premises` row. Never a literal (`pnpm secrets`, ADR 0019). */
async function deskPhone(sql: Sql): Promise<string> {
  const facts = await readPremisesFacts(sql)
  // An empty string rather than an invented number when the singleton is absent, which means `pnpm seed`
  // has not run. A plausible-looking telephone number is worse than a blank one (brief rule 15): blank is
  // visibly unanswered and plausible is indistinguishable from configured.
  return facts?.premises.phoneLandline ?? facts?.premises.phoneMobile ?? ''
}

type Resolved =
  | {
      readonly kind: 'granted'
      readonly subject: PreferenceSubject
      readonly expiresAtIso: string
    }
  | { readonly kind: 'refused' }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number }

/**
 * Verifies the presented token and resolves what it opens onto, recording the attempt.
 *
 * One function for the read and the write, so the `optout_verification_attempt` row and the refusal cannot
 * be written twice or skipped once — which is also what makes the visit provable: every verification leaves
 * a row whichever way it went, and a granted one leaves an `optout_grant.redeemed` audit row as well, so
 * "was this customer able to opt out" is answerable from the database rather than from a log file.
 *
 * The contact is resolved through `merge_survivor_of()` here (C-CRM-05's NOTE 8b): the page a merged-away
 * link opens shows the SURVIVOR's preferences, because that is the record the person now has. The token
 * check itself is left exactly as C-CRM-04 wrote it — raw grant id against raw requested id — so this
 * widens nothing about which links verify.
 */
async function resolve(request: PreferenceRequest, deps: PreferenceCentreDeps): Promise<Resolved> {
  if (request.contactId === null) return { kind: 'refused' }
  const nowIso = deps.now()
  const verified = await withUnitOfWork(
    deps.sql,
    CALLER,
    (uow) =>
      verifyOptOutToken(
        uow,
        { decide: decideOptOutAccess, shape: optOutTokenShape },
        {
          token: request.token,
          requestedContactId: request.contactId as string,
          requestIp: request.requestIp as string,
          atIso: nowIso,
        },
      ),
    { ipAddress: request.requestIp as string },
  )
  if (verified.kind === 'rate_limited') {
    return { kind: 'rate_limited', retryAfterSeconds: verified.retryAfterSeconds }
  }
  if (verified.kind === 'refused') return { kind: 'refused' }
  const subject = await readPreferenceSubject(deps.sql, verified.contactCustomerId)
  // A grant whose survivor has been erased answers exactly as an unknown token does. A distinguishable
  // "the contact is gone" would tell a token holder that the record was deleted, and `customer` rows really
  // are erased (docs/04 §4, §8).
  if (subject === null) return { kind: 'refused' }
  return { kind: 'granted', subject, expiresAtIso: verified.expiresAtIso }
}

/**
 * The published statement for every purpose the grid covers, in grid order.
 *
 * Both of them, not just marketing, and the reason is what the resulting consent row MEANS: a page showing
 * one statement while recording a `review_request` grant would be storing proof of an agreement to words
 * that say nothing about review requests, and nothing in the database refuses that —
 * `consent_grant_carries_its_wording` requires only that there IS a version. A purpose with nothing
 * published is simply absent, and the write refuses a GRANT for it by name.
 */
async function currentWordings(sql: Sql): Promise<readonly ConsentWordingRecord[]> {
  const purposes = [...new Set(PREFERENCE_GRID.map((cell) => cell.purpose))]
  const read = await Promise.all(purposes.map((purpose) => readCurrentConsentWording(sql, purpose)))
  return read.filter((wording): wording is ConsentWordingRecord => wording !== null)
}

/** The grid's current state, folded from the log. The fold is here because `packages/db` may not import core. */
async function gridFor(
  deps: PreferenceCentreDeps,
  subject: PreferenceSubject,
  at: Instant,
): Promise<{
  readonly cells: readonly PreferenceCellView[]
  readonly suppressed: boolean
  readonly suppressionSource: string | null
}> {
  const log = await readConsentLog(deps.sql, subject.contactCustomerId)
  const asLog: ConsentLog = {
    contactId: log.contactId,
    records: log.records.map((record) => ({ ...record, recordedAt: record.recordedAt as Instant })),
    wordingVersions: log.wordingVersions,
  }
  const phone = subject.phoneE164
  const suppression =
    phone === null
      ? null
      : ((
          await readSuppressionLogs(deps.sql, deps.keying, [{ keyKind: 'phone', recipient: phone }])
        ).get(phone) ?? null)
  const resolved =
    suppression === null
      ? null
      : resolveSuppression(
          {
            key: suppression.key,
            records: suppression.records.map((record) => ({
              ...record,
              recordedAt: record.recordedAt as Instant,
            })),
          },
          at,
        )
  return {
    cells: PREFERENCE_GRID.map((cell) => ({
      channel: cell.channel,
      purpose: cell.purpose,
      consent: resolveConsent(asLog, cell.channel, cell.purpose, at).state,
    })),
    suppressed: resolved?.state === 'suppressed',
    suppressionSource: resolved?.source ?? null,
  }
}

export async function handlePreferenceCentreRead(
  request: PreferenceRequest,
  deps: PreferenceCentreDeps,
): Promise<Response> {
  if (request.requestIp === null) return unattributable()
  const desk = await deskPhone(deps.sql)
  const resolved = await resolve(request, deps)
  if (resolved.kind === 'rate_limited') return tooManyRequests(resolved.retryAfterSeconds)
  if (resolved.kind === 'refused') return unavailablePage(request, desk)

  const at = Date.parse(deps.now()) as Instant
  const state = await gridFor(deps, resolved.subject, at)
  const published = await currentWordings(deps.sql)
  return page(
    renderPreferenceCentreHtml({
      locale: request.locale,
      cells: state.cells,
      suppressed: state.suppressed,
      suppressionSource: state.suppressionSource,
      wording: published.map((wording) => ({
        purpose: wording.purpose,
        version: wording.version,
        text: request.locale === 'ar' ? wording.textAr : wording.textEn,
        // Surfaced rather than hidden: the seeded statement is this build's draft and says so in its own
        // text (`Y9-consent-wording`), and a page presenting it as approved copy is what brief rule 15 is
        // about.
        isProvisional: wording.isProvisional,
      })),
      linkExpiresAtIso: resolved.expiresAtIso,
      outcome: request.outcome,
      deskPhoneE164: desk,
      otherLocaleHref: otherLocaleHref(request),
      // `customer` has no email column at all (C-CRM-01's NOTE 3), so this is `false` by construction
      // rather than by a read. It is a field rather than a literal in `render.ts` so the day an email
      // column lands, one line changes here and the note comes off the page.
      emailDetailHeld: false,
    }),
  )
}

/**
 * The address could not be read, so the rate limit cannot be applied.
 *
 * A 400 and the ONE refusal that is not the page, because it is a fact about the REQUEST rather than about
 * anybody's data — the same exception `/api/v1/preferences` makes, with the same reasoning. No body: a
 * document here would be a second shell to keep identical for no gain.
 */
const unattributable = (): Response =>
  new Response(null, {
    status: 400,
    headers: {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'berelax-error': 'unattributable_request',
    },
  })

/** Where a write sends the reader back to, carrying what happened. The capability stays in the query. */
function backTo(request: PreferenceRequest, result: string): Response {
  const path = preferenceCentrePath({
    contactId: request.contactId ?? '',
    token: request.token ?? '',
    locale: request.locale,
  })
  return new Response(null, {
    status: 303,
    headers: {
      location: `${path}&${result}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  })
}

/** The scope a submitted form names, or null when the body is not one this page produces. */
function scopeFrom(form: URLSearchParams): PreferenceScope | null {
  const intent = form.get('intent')
  if (intent === 'everything') return { kind: 'everything' }
  if (intent !== 'pair') return null
  const channel = form.get('channel')
  const purpose = form.get('purpose')
  if (channel === null || purpose === null) return null
  // Not validated against the grid here: `applyPreferenceSelection` does that against the real
  // `MESSAGE_CHANNELS` × `SEND_GATING_CONSENT_PURPOSES`, and a second copy of the closed sets in this file
  // would be the one that stops matching. What IS checked here is that both fields are present, because a
  // missing field is a body this page did not produce rather than a pair it does not have.
  return { kind: 'pair', channel, purpose }
}

const actionFrom = (form: URLSearchParams): PreferenceCentreAction | null => {
  const action = form.get('action')
  return (PREFERENCE_CENTRE_ACTIONS as readonly string[]).includes(String(action))
    ? (action as PreferenceCentreAction)
    : null
}

export async function handlePreferenceCentreWrite(
  request: PreferenceRequest,
  form: URLSearchParams,
  deps: PreferenceCentreDeps,
): Promise<Response> {
  if (request.requestIp === null) return unattributable()
  const desk = await deskPhone(deps.sql)
  const resolved = await resolve(request, deps)
  if (resolved.kind === 'rate_limited') return tooManyRequests(resolved.retryAfterSeconds)
  if (resolved.kind === 'refused') return unavailablePage(request, desk)

  const scope = scopeFrom(form)
  const action = actionFrom(form)
  if (scope === null || action === null) {
    // A body this page did not produce. Answered as the page itself rather than as an error: the reader has
    // done nothing wrong and the buttons are right there.
    return backTo(request, 'refused=unknown_intent')
  }

  const nowIso = deps.now()
  // The versions the READER was looking at, re-read at the write and snapshotted onto the rows of their own
  // purposes. The hash goes on the consent row, and `assert_consent_wording_hash()` (0056) refuses a
  // snapshot that disagrees with the stored version — so a wording edited between the render and this write
  // is a named refusal rather than a record of words nobody showed.
  const published = await currentWordings(deps.sql)

  try {
    await withUnitOfWork(
      deps.sql,
      CALLER,
      (uow) =>
        applyPreferenceSelection(uow, deps.keying, {
          contactCustomerId: resolved.subject.contactCustomerId,
          action,
          scope,
          recipient: resolved.subject.phoneE164,
          keyKind: 'phone',
          locale: request.locale,
          wording: published.map((wording) => ({
            purpose: wording.purpose,
            id: wording.id,
            contentHashHex: wording.contentHashHex,
          })),
          decidedAtIso: nowIso,
          actorLabel: PREFERENCE_CENTRE_ACTOR_LABEL,
        }),
      { ipAddress: request.requestIp },
    )
  } catch (error) {
    return backTo(request, `refused=${refusalOf(error)}`)
  }
  return backTo(request, `done=${action === 'unsubscribe' ? 'stopped' : 'started'}`)
}

/**
 * The refusal name an error carries, or `unknown`.
 *
 * Both translators are consulted because both modules are reachable from here, and neither is allowed to
 * leak a message: `render.ts` looks the NAME up in a closed `Record`, so a refusal neither translator
 * recognises reaches the reader as words that claim nothing rather than as a database string.
 */
function refusalOf(error: unknown): string {
  const named = preferenceCentreRefusalOf(error) ?? suppressionRefusalOf(error)
  if (named !== null) return named
  // The reader is told nothing useful, so the SERVER has to say something or a refusal nobody named is a
  // refusal nobody can find. `console.error` rather than a throw for the reason the page exists: a 500 in
  // front of somebody trying to opt out is worse than a page offering the telephone number, and this link
  // is the only functional opt-out this business has.
  console.error(
    '[preference-centre] a write refused with a name neither translator recognises:',
    isAppError(error) ? `${error.kind}: ${error.message}` : String(error),
  )
  return 'unknown'
}
