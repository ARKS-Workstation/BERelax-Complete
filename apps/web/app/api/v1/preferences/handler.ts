import {
  type ConsentLog,
  type ConsentState,
  decideOptOutAccess,
  type Instant,
  normaliseBlocklistKey,
  OPT_OUT_NOT_FOUND,
  optOutTokenShape,
  resolveConsent,
  resolveSuppression,
} from '@berelax/core'
import {
  type Actor,
  applyPreferenceCentreChange,
  OPTOUT_VERIFY_MAX_PER_IP,
  PREFERENCE_CENTRE_ACTIONS,
  type PreferenceCentreAction,
  readConsentLog,
  readCurrentConsentWording,
  readSuppressionLogs,
  type Sql,
  type SuppressionKeying,
  verifyOptOutToken,
  withUnitOfWork,
} from '@berelax/db'
import { SEND_GATING_CONSENT_PURPOSES } from '@berelax/shared'

/**
 * `/api/v1/preferences` — the preference centre's functional half (C-CRM-04).
 *
 * C-CRM-03's NOTE (1) recorded that consent capture existed only through the repository and the seed, that
 * no screen published a wording or let anybody change their mind, and that the preference centre a
 * withdrawal really arrives through was this unit's. This endpoint is that, and what it deliberately is
 * NOT is a rendered screen: it answers JSON, and the bilingual page that renders the wording, the
 * direction and the buttons belongs with the rest of the customer-facing surface. The manifest NOTE says
 * which half is deferred and to whom, rather than leaving a reader to infer it from the absence of a
 * `.tsx` file.
 *
 * Why the functional half is the half that had to exist here: docs/04 §5 states that an alphanumeric
 * sender ID cannot receive an SMS, so "reply STOP" is not available to this business at all and the link
 * in a message is the ONLY functional opt-out it has. A token service with nothing to redeem against is
 * the same kind of decoration as a suppression list nothing consults.
 *
 * ## The URL names the contact AS WELL AS carrying the token
 *
 * `?c=<contact id>&t=<token>`, and the token alone would determine the contact. The redundancy is the
 * point and it is the defect it catches that justifies it: the URL is built by a template rendered per
 * recipient, and a loop that paired recipient A's row with recipient B's token would show somebody else's
 * preferences and record B's withdrawal against A's decision — with a token that was perfectly valid, so
 * nothing would report it. With both halves present the mismatch is refused. It is the same argument
 * `obligation_evidence_grant` makes for putting the evidence id in the path beside the token.
 *
 * ## Every refusal is byte-identical
 *
 * `OPT_OUT_NOT_FOUND` in `@berelax/core` is one frozen object and this file has no other refusal body for
 * a token. An unknown token, an expired one, a revoked one and a valid token presented for another
 * contact all answer the same 404. Anything else is an oracle: a 403 for expired and a 404 for unknown
 * tells a caller that a given contact has been sent a promotional message, and a distinguishable
 * "not for this contact" confirms that a contact id exists.
 *
 * The rate limit is the ONE exception and it is deliberate: a 429 with `Retry-After` is not a fact about
 * any token, it is a fact about the caller, and answering 404 to a flood would leave a well-behaved client
 * retrying immediately for ever.
 *
 * ## Why an unattributable request is refused rather than allowed
 *
 * `optout_verification_attempt.request_ip` is NOT NULL, unlike `otp_challenge`'s. The OTP endpoint has a
 * per-number limit that still binds when the proxy supplies no address; this endpoint has one dimension
 * and nothing to fall back on, so a request whose address cannot be read would bypass the only defence
 * there is. It answers 400 by name instead.
 */

/** Every reason this endpoint refuses, as a value. A caller branches on these, never on prose. */
export const PREFERENCE_ENDPOINT_ERRORS = [
  'invalid_request',
  /** The proxy supplied no usable address, so the rate limit cannot be applied. See the header. */
  'unattributable_request',
  'not_found',
  'too_many_requests',
] as const
export type PreferenceEndpointError = (typeof PREFERENCE_ENDPOINT_ERRORS)[number]

export interface PreferenceEndpointDeps {
  readonly sql: Sql
  /** Injected, so the integration suite can freeze it. */
  readonly now: () => string
  readonly keying: SuppressionKeying
}

/**
 * The actor on a preference-centre request.
 *
 * `customer` with no id and a label rather than a name: the request is the customer's own, made on the
 * strength of a capability rather than a session, and the audit trail should say so. It is the same
 * shape the OTP endpoint's `CALLER` has, and for the same reason — this system invents no names for
 * people (ADR 0020).
 */
const CALLER: Actor = { kind: 'customer', label: 'Preference centre (link holder)' }

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })

/** The one refusal body a token ever produces, from the one place it is declared. */
const notFound = (): Response => json(OPT_OUT_NOT_FOUND.status, OPT_OUT_NOT_FOUND.body)

/**
 * Reads the caller address from the proxy headers, or returns null.
 *
 * Deliberately the same function the OTP handler exports, imported rather than copied — a second
 * spelling of "which header is the client address" is how one endpoint ends up rate-limiting the proxy.
 */
export { callerAddress } from '../otp/handler.ts'

import { callerAddress as readCallerAddress } from '../otp/handler.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ParsedRequest {
  readonly contactId: string
  readonly token: string | null
  readonly requestIp: string
}

type Parsed =
  | { readonly ok: true; readonly request: ParsedRequest }
  | { readonly ok: false; readonly response: Response }

/**
 * Reads the two query parameters and the address, refusing anything unexpected.
 *
 * A malformed contact id answers the SAME 404 as an unknown token rather than a 400, because a 400 for a
 * non-uuid and a 404 for a uuid that does not exist is the start of the oracle this endpoint is built to
 * avoid. The absent-address case is a 400 and is the exception: it is a fact about the request rather than
 * about anybody's data.
 */
function parse(request: Request): Parsed {
  const requestIp = readCallerAddress(request.headers)
  if (requestIp === null) {
    return {
      ok: false,
      response: json(400, {
        error: 'unattributable_request' satisfies PreferenceEndpointError,
        reason:
          'No client address could be read from the proxy headers. This endpoint is rate-limited by ' +
          'address and has no second dimension to fall back on, so a request it cannot attribute would ' +
          'bypass the only limit there is.',
      }),
    }
  }
  const url = new URL(request.url)
  const contactId = url.searchParams.get('c') ?? ''
  if (!UUID.test(contactId)) return { ok: false, response: notFound() }
  return { ok: true, request: { contactId, token: url.searchParams.get('t'), requestIp } }
}

/** One channel × purpose pair, as the page has to render it. */
export interface PreferenceState {
  readonly channel: string
  readonly purpose: string
  readonly consent: ConsentState
}

/** What a successful GET answers. Enough for a screen to render, and no contact detail in it. */
export interface PreferenceView {
  readonly contactId: string
  readonly states: readonly PreferenceState[]
  readonly suppressed: boolean
  /** Which mechanism suppressed them, when one did. Null otherwise. */
  readonly suppressionSource: string | null
  /**
   * The current marketing wording, in BOTH languages, so the page can render either without a second
   * request and so the version it showed is the version a resubscribe is recorded against.
   */
  readonly wording: {
    readonly id: string
    readonly version: number
    readonly textEn: string
    readonly textAr: string
    readonly isProvisional: boolean
  } | null
  readonly expiresAtIso: string
}

/**
 * GET — what this contact's preferences currently are.
 *
 * The fold from the log to a state happens HERE rather than in `@berelax/db`, because `resolveConsent` and
 * `resolveSuppression` are `packages/core`'s and `packages/db` may not import them. The repository reads
 * rows and this composes; it is the same seam `decideOptOutAccess` arrives through below.
 */
export async function handlePreferenceRead(
  deps: PreferenceEndpointDeps,
  request: Request,
): Promise<Response> {
  const parsed = parse(request)
  if (!parsed.ok) return parsed.response
  const nowIso = deps.now()
  const at = Date.parse(nowIso) as Instant

  const verified = await withUnitOfWork(
    deps.sql,
    CALLER,
    (uow) =>
      verifyOptOutToken(
        uow,
        { decide: decideOptOutAccess, shape: optOutTokenShape },
        {
          token: parsed.request.token,
          requestedContactId: parsed.request.contactId,
          requestIp: parsed.request.requestIp,
          atIso: nowIso,
        },
      ),
    { ipAddress: parsed.request.requestIp },
  )
  if (verified.kind === 'rate_limited') return tooManyRequests(verified.retryAfterSeconds)
  if (verified.kind === 'refused') return notFound()

  const contactId = verified.contactCustomerId
  const log = await readConsentLog(deps.sql, contactId)
  const asLog: ConsentLog = {
    contactId: log.contactId,
    records: log.records.map((record) => ({ ...record, recordedAt: record.recordedAt as Instant })),
    wordingVersions: log.wordingVersions,
  }

  const phone = await contactPhone(deps.sql, contactId)
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

  const wording = await readCurrentConsentWording(deps.sql, 'marketing')
  const view: PreferenceView = {
    contactId,
    states: CHANNELS.flatMap((channel) =>
      SEND_GATING_CONSENT_PURPOSES.map((purpose) => ({
        channel,
        purpose,
        consent: resolveConsent(asLog, channel, purpose, at).state,
      })),
    ),
    suppressed: resolved?.state === 'suppressed',
    suppressionSource: resolved?.source ?? null,
    wording:
      wording === null
        ? null
        : {
            id: wording.id,
            version: wording.version,
            textEn: wording.textEn,
            textAr: wording.textAr,
            // Surfaced rather than hidden: the seeded statement is this build's draft and says so in its
            // own text (`Y9-consent-wording`), and a page that presented it as approved copy would be
            // doing exactly what brief rule 15 is about.
            isProvisional: wording.isProvisional,
          },
    expiresAtIso: verified.expiresAtIso,
  }
  return json(200, view)
}

/** The three channels consent is recorded per. `message_channel` since 0014; no second list. */
const CHANNELS = ['sms', 'email', 'whatsapp'] as const

/**
 * POST — unsubscribe or resubscribe.
 *
 * The suppression is keyed on the PHONE, because that is the only detail this system holds for a contact:
 * `customer` has no email column (C-CRM-01's NOTE 3). A contact with no phone number cannot be suppressed
 * at all and the request is refused rather than half-applied — a consent withdrawal with no suppression is
 * the state a later booking form silently undoes.
 */
export async function handlePreferenceWrite(
  deps: PreferenceEndpointDeps,
  request: Request,
): Promise<Response> {
  const parsed = parse(request)
  if (!parsed.ok) return parsed.response

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json(400, { error: 'invalid_request' satisfies PreferenceEndpointError })
  }
  const body = readBody(raw)
  if (body === null)
    return json(400, { error: 'invalid_request' satisfies PreferenceEndpointError })

  const nowIso = deps.now()
  const verified = await withUnitOfWork(
    deps.sql,
    CALLER,
    (uow) =>
      verifyOptOutToken(
        uow,
        { decide: decideOptOutAccess, shape: optOutTokenShape },
        {
          token: parsed.request.token,
          requestedContactId: parsed.request.contactId,
          requestIp: parsed.request.requestIp,
          atIso: nowIso,
        },
      ),
    { ipAddress: parsed.request.requestIp },
  )
  if (verified.kind === 'rate_limited') return tooManyRequests(verified.retryAfterSeconds)
  if (verified.kind === 'refused') return notFound()

  const phone = await contactPhone(deps.sql, verified.contactCustomerId)
  if (phone === null) {
    // Not a 404: the token was good. A contact with no phone number is a state this schema does not
    // currently produce — `customer.phone_e164` IS the identity (ADR 0014) — so this is the arm that
    // says so out loud rather than writing half the change.
    return json(409, {
      error: 'invalid_request' satisfies PreferenceEndpointError,
      reason:
        'This contact has no phone number, so there is no contact detail to suppress. A consent ' +
        'withdrawal with no suppression is the state a later booking form silently undoes.',
    })
  }

  const result = await withUnitOfWork(
    deps.sql,
    CALLER,
    (uow) =>
      applyPreferenceCentreChange(uow, deps.keying, {
        contactCustomerId: verified.contactCustomerId,
        action: body.action,
        recipient: phone,
        keyKind: 'phone',
        locale: body.locale,
        decidedAtIso: nowIso,
      }),
    { ipAddress: parsed.request.requestIp },
  )

  return json(200, {
    status: 'recorded',
    action: result.action,
    consentRows: result.consentRows,
    suppressionRecorded: result.suppressionRecorded,
  })
}

const tooManyRequests = (retryAfterSeconds: number): Response =>
  json(
    429,
    {
      error: 'too_many_requests' satisfies PreferenceEndpointError,
      // The ONE distinguishable refusal, and it is a fact about the caller rather than about any token.
      // See the header: answering 404 to a flood would leave a well-behaved client retrying for ever.
      limit: `${OPTOUT_VERIFY_MAX_PER_IP} verifications per minute per address`,
      retryAfterSeconds,
    },
    { 'retry-after': String(retryAfterSeconds) },
  )

interface PreferenceBody {
  readonly action?: unknown
  readonly locale?: unknown
}

/** Reads the body, refusing an unrecognised action rather than defaulting it. */
function readBody(
  body: unknown,
): { readonly action: PreferenceCentreAction; readonly locale: 'en' | 'ar' } | null {
  if (typeof body !== 'object' || body === null) return null
  const { action, locale } = body as PreferenceBody
  if (!(PREFERENCE_CENTRE_ACTIONS as readonly string[]).includes(String(action))) return null
  if (locale !== undefined && locale !== 'en' && locale !== 'ar') return null
  return { action: action as PreferenceCentreAction, locale: locale === 'ar' ? 'ar' : 'en' }
}

/**
 * The contact's phone number, normalised through the one normaliser this system has.
 *
 * `customer.phone_e164` is already canonical (0019's CHECK), and it is still put through
 * `normaliseBlocklistKey` rather than used raw — so the key this endpoint computes is the key
 * `recordSuppression` would compute for the same number, whatever either of them is handed. A key built
 * two ways is a key that matches nothing, and because the plaintext never reaches a column there is no
 * constraint that could notice.
 */
async function contactPhone(sql: Sql, contactId: string): Promise<string | null> {
  const rows = await sql<{ phone_e164: string }[]>`
    select phone_e164 from customer where id = ${contactId}::uuid
  `
  const raw = rows[0]?.phone_e164
  if (raw === undefined) return null
  const key = normaliseBlocklistKey('phone', raw)
  return key.ok ? key.key.value : null
}
