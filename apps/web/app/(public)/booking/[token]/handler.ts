import {
  BOOKING_TOKEN_NOT_FOUND,
  type BookingTokenPurpose,
  bookingTokenShape,
  CUSTOMER_LINK_PRINCIPAL,
  cancellationVerdictFor,
  decideAppointmentTransition,
  decideBookingTokenAccess,
  fromLocal,
  type Instant,
  localDate,
  localTime,
  recheckShapeAssignment,
  reminderOffsetsFrom,
  reminderPlanFor,
  rescheduleTradingDate,
} from '@berelax/core'
import {
  type Actor,
  type BookingTokenDecider,
  bookingTokenDigest,
  type CancelDeps,
  type CancellationPolicy,
  cancelBookingTx,
  cancellationRefusalOf,
  type PlannedStep,
  type RescheduleDeps,
  readCancellationWindow,
  readPremisesFacts,
  readReminderOffsets,
  redeemBookingManageToken,
  rescheduleAppointmentTx,
  rescheduleRefusalOf,
  type ScheduledStepMaintainer,
  type ScheduledStepPlanner,
  type SlotRecheck,
  type Sql,
  scheduledStepMaintainer,
  type TradingDateResolver,
  type TransitionActor,
  type TransitionDecider,
  withUnitOfWork,
} from '@berelax/db'
import { isAppError, manageBookingPath } from '@berelax/shared'
import {
  type ManageBookingFacts,
  type ManageLocale,
  type ManageOutcome,
  renderManageBookingHtml,
} from './render.ts'

/**
 * `/booking/{token}` — the self-service manage-booking page (B-UI-05, docs/09 §1).
 *
 * The handler rather than the route binding, so it can be driven directly by
 * `apps/web/src/manage-booking.itest.ts` against a real PostgreSQL. `preferences-route.itest.ts` and
 * `otp-route.itest.ts` do the same and give the reason: what is asserted is the SHAPE of a refusal and the
 * rows a write leaves, and a `next start` in front of it would add a router and a form parser to every case
 * without changing one of them. No port band is taken by that file (brief rule 18), because nothing there
 * starts a server.
 *
 * ## Every refusal is the same 404, byte for byte
 *
 * `BOOKING_TOKEN_NOT_FOUND` in `@berelax/core` is one frozen object, and {@link NOT_FOUND_HTML} below is
 * one module-level constant computed from it with **nothing** from the request reaching it. That is the
 * acceptance criterion — *"altering one character returns 404 with a response body identical to a genuinely
 * unknown token"* — made structural rather than careful: there is no branch that could produce a second
 * body, no database read behind it that could fail differently, and no interpolation of the token.
 *
 * A malformed token is refused without a query and therefore without an audit row. A WELL-FORMED one is
 * looked up and the attempt is recorded whichever way it goes, which is the other half of the same
 * criterion: the `audit_event` row is the only place the reason a link was refused is ever written down,
 * because the response cannot carry one.
 *
 * ## The write path is the staff write path, and it is the same function
 *
 * `rescheduleAppointmentTx` and `cancelBookingTx` — the exports B-LIFE-03 wrote for the front desk — with
 * the same injected rules from `@berelax/core`. Not a second path that behaves similarly: the constraints,
 * the room lock, the slot re-check, the trading-date re-resolution, the cancellation window and the
 * scheduled-step maintenance are all one implementation, so they cannot diverge. `manage-booking.itest.ts`
 * asserts the shared REFERENCE rather than the shared behaviour, because behaviour that agrees today is how
 * two paths come to disagree quietly.
 *
 * The actor is `kind: 'customer'` with no id, because a link proves possession of a link and not an
 * identity (ADR 0014), and the principal is `system:customer_booking_link` —
 * `packages/core/src/access/principals/customer-link.ts` records why that is a principal and not a role,
 * and what the two alternatives would have granted.
 *
 * ## What the page cannot do, stated rather than left to be noticed
 *
 * There is **no slot picker**. The form takes a time and the salon's answer to "is that time free" is the
 * booking transaction's, arriving as a named refusal the page has words for. A picker here would be
 * B-UI-01's availability read rendered a second time, in a second component, over the same rows — and the
 * two would disagree about a slot the moment either changed. It is recorded in this unit's manifest NOTE
 * rather than implied by its absence.
 */

/** The purpose a token must have been minted for to open this page. One value; see the core module. */
const PURPOSE: BookingTokenPurpose = 'manage_booking'

/**
 * The actor, and the principal the policy layer sees.
 *
 * `customer` with no id and a label rather than a name, exactly as `/api/v1/book`'s caller is: the request
 * is made on a customer's behalf and the audit trail should say so, and this system invents no names for
 * people. `role` carries the PRINCIPAL id — `decideAppointmentTransition` resolves a role or a declared
 * principal through the one `principalCan`, so this is a kind of caller rather than a second policy.
 */
const SURFACE = `Manage-booking link (${CUSTOMER_LINK_PRINCIPAL})`
const CALLER: Actor = { kind: 'customer', label: SURFACE }
const ACTOR: TransitionActor = {
  kind: 'customer',
  // The ROLE stored on the history row, and the PRINCIPAL the permission check consults — two fields,
  // because `appointment_status_history_actor_role_known` (0046) accepts exactly the eight F07 roles and
  // `system` is the honest one for a surface with no interactive login. `TransitionActor.principal`
  // records why the two are separate; the label carries the principal so the row names it.
  role: 'system',
  principal: CUSTOMER_LINK_PRINCIPAL,
  label: SURFACE,
}

/** The reason recorded against a customer's own move. `rescheduled` declares one mandatory. */
const RESCHEDULE_REASON = 'The customer moved it from the manage-booking page'
const CANCEL_REASON = 'The customer cancelled it from the manage-booking page'

/**
 * Core's rules, as the write paths' injected seams. `satisfies` and not a cast, every one.
 *
 * Each pair of declarations describes one seam across a boundary neither package may cross, which is what
 * makes a field added on one side and not the other a `pnpm typecheck` failure here rather than a rule that
 * silently stopped being applied. `packages/fixtures/src/appointment-reschedule.itest.ts` composes the same
 * five for the staff path, and that they are the same five is the point.
 */
const decide = decideAppointmentTransition satisfies TransitionDecider
const recheck = recheckShapeAssignment satisfies SlotRecheck
const resolveTradingDate = rescheduleTradingDate satisfies TradingDateResolver
const classify = cancellationVerdictFor satisfies CancellationPolicy
const decideToken = ((input) =>
  decideBookingTokenAccess({
    grant: input.grant,
    presentedDigestHex: input.presentedDigestHex,
    expectedPurpose: input.expectedPurpose,
    at: input.at,
  })) satisfies BookingTokenDecider

/**
 * The write paths and the rules this surface uses, as references.
 *
 * Exported for one assertion and it is an acceptance criterion: *"customer-initiated reschedule calls the
 * same exported function as staff reschedule (asserted by a shared-reference test, not by behavioural
 * similarity)"*. `manage-booking.itest.ts` compares each of these with `toBe` against the export
 * `@berelax/db` and `@berelax/core` publish, which is a claim a behavioural test cannot make: two
 * implementations that agree today are how two implementations come to disagree quietly, and a wrapper
 * around the right function passes every behavioural test and fails this.
 *
 * It is a record rather than five separate exports so that a rule added to the write path has somewhere to
 * be declared, and so the test enumerates rather than naming what somebody remembered.
 */
export const MANAGE_BOOKING_WRITE_PATHS = {
  reschedule: rescheduleAppointmentTx,
  cancel: cancelBookingTx,
  decide,
  recheck,
  classify,
  resolveTradingDate,
} as const

export interface ManageBookingDeps {
  readonly sql: Sql
  /** Injected, so the integration suite can freeze it. Expiry is judged against this and nothing else. */
  readonly now: () => Instant
}

/**
 * The plan, bound to whatever the reminder-timing setting says right now.
 *
 * A twin of `plannerFrom` in `apps/worker/src/jobs/send-scheduled-step.ts`, and it is a twin rather than an
 * import because `.dependency-cruiser.cjs`'s `nothing-imports-an-app` forbids reaching into the worker and
 * the composition cannot live in a package: it needs `readReminderOffsets` from `@berelax/db` and
 * `reminderPlanFor` from `@berelax/core`, and only an app may import both. Four lines duplicated with the
 * reason written down is better than a fifth package, and `manage-booking.itest.ts` asserts the steps this
 * produces against the offsets the setting holds — so a drift between the two shows up as a failing
 * assertion rather than as a customer with no reminders.
 */
async function plannerFor(sql: Sql): Promise<ScheduledStepPlanner> {
  const offsetsHours = reminderOffsetsFrom(await readReminderOffsets(sql))
  return (input): readonly PlannedStep[] =>
    reminderPlanFor({
      appointmentId: input.appointmentId,
      period: input.period,
      offsetsHours,
    })
}

const maintainerFor = async (sql: Sql): Promise<ScheduledStepMaintainer> =>
  scheduledStepMaintainer({ plan: await plannerFor(sql) })

/**
 * The one response every refusal produces, computed once at module load.
 *
 * Both languages in one document, because a refused token names no customer and therefore no locale — and
 * a page that guessed one from `Accept-Language` would be a page whose bytes differed per reader, which is
 * the equality this constant exists to guarantee. The machine-readable code is `BOOKING_TOKEN_NOT_FOUND`'s
 * own, so there is one spelling of it.
 *
 * No desk telephone number, and that is the one thing about this document a reader will want to change. It
 * would have to be read from the `premises` row, and a read is a thing that can fail differently for two
 * requests — which is exactly how two refusals come to have two bodies. The number is on the page a valid
 * link opens, and on `/contact`.
 */
const NOT_FOUND_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="robots" content="noindex, nofollow, noarchive">',
  '<meta name="referrer" content="no-referrer">',
  `<meta name="berelax-error" content="${BOOKING_TOKEN_NOT_FOUND.body.error}">`,
  '<title>This link is not available</title>',
  '</head>',
  '<body>',
  '<main>',
  '<h1>This link is not available</h1>',
  '<p>It may have expired, or the booking it was for may have been cancelled. Our booking pages are at ' +
    'berelaxmassage.com.</p>',
  '<p lang="ar" dir="rtl">هذا الرابط غير متاح. قد تكون مدته انتهت أو أن الحجز قد أُلغي.</p>',
  '</main>',
  '</body>',
  '</html>',
].join('')

/** The refusal, as a response. Identical bytes and identical headers for every reason. */
function notFound(): Response {
  return new Response(NOT_FOUND_HTML, {
    status: BOOKING_TOKEN_NOT_FOUND.status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cached and never stored: the URL carries a credential, so a shared cache holding this
      // response would hold the answer for whoever asks next.
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'referrer-policy': 'no-referrer',
    },
  })
}

function page(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      // The token is in the path, so every outbound link on this page would carry it in a Referer. The
      // `<meta>` in the document says the same thing; the header is the half that survives a proxy.
      'referrer-policy': 'no-referrer',
    },
  })
}

/** What a resolved token opened onto. `null` when nothing this page can render is behind it. */
interface ManagedBooking {
  readonly bookingId: string
  readonly locale: ManageLocale
  /** The appointment the page is about: the earliest one still holding its resources, or the latest. */
  readonly appointmentId: string
  readonly facts: ManageBookingFacts
  readonly changeable: boolean
}

interface BookingRow {
  readonly appointment_id: string
  readonly booking_id: string
  readonly locale: string
  readonly trading_date: string
  readonly starts_at: Date
  readonly ends_at: Date
  readonly service_name: string
  readonly status: string
  readonly holds_resources: boolean
}

/**
 * The booking, as the allowlist needs it — and as nothing more than the allowlist needs.
 *
 * A projection written for this page rather than a row handed to it, which is the first half of *"the page
 * renders only fields on a declared allowlist"*: the clinical columns are not in this `select`, so there is
 * nothing for a renderer to leak even if somebody interpolated the whole object. The second half is
 * structural, in `render.ts`.
 *
 * Ordered so the row the page is about is the one a customer would mean: an appointment that still holds
 * its resources, soonest first; failing that the most recent, which is what a completed or cancelled
 * booking leaves. `distinct` is not needed — a Four Hands is two appointment rows over one delivery and the
 * page is about the TREATMENT, so the first row of the ordering is the right one and the second carries the
 * same period.
 */
async function readManagedBooking(
  sql: Sql,
  bookingId: string,
  linkExpiresAtIso: string,
  nowMs: number,
): Promise<ManagedBooking | null> {
  const rows = await sql<BookingRow[]>`
    select a.id::text          as appointment_id,
           a.booking_id::text  as booking_id,
           c.locale            as locale,
           a.trading_date::text as trading_date,
           lower(a.period)     as starts_at,
           upper(a.period)     as ends_at,
           s.public_display_name as service_name,
           a.status::text      as status,
           a.holds_resources   as holds_resources
      from appointment a
      join booking b          on b.id = a.booking_id
      join customer c         on c.id = b.customer_id
      join service_variant v  on v.id = a.service_variant_id
      join service s          on s.id = v.service_id
     where a.booking_id = ${bookingId}::uuid
     order by a.holds_resources desc, lower(a.period) asc
     limit 1
  `
  const row = rows[0]
  if (row === undefined) return null
  const windowHours = await readCancellationWindow(sql)
  const verdict = classify({
    startsAtMs: row.starts_at.getTime(),
    atMs: nowMs,
    windowHours,
  })
  return {
    bookingId: row.booking_id,
    locale: row.locale === 'ar' ? 'ar' : 'en',
    appointmentId: row.appointment_id,
    // `changeable` is the row's own answer and not a policy: an appointment that no longer holds its
    // resources is cancelled, superseded or a no-show, and the lifecycle would refuse every move from
    // there. Offering the forms anyway would be a page whose buttons are known to fail.
    changeable: row.holds_resources && row.status !== 'completed',
    facts: {
      // The LAST eight characters of the uuid, and the end rather than the start is the whole point.
      // `booking.id` is `uuid_generate_v7()`, whose first twelve hex digits are a millisecond timestamp —
      // so two bookings taken in the same second share their leading characters, and a reference built from
      // the front is the same string for both. This file's own itest caught it: two bookings, one
      // "reference", and the assertion that each page names only its own booking failed. The tail is the
      // random half. Eight characters and not the whole id, because the page is a screenshot somebody may
      // send to a friend, and a reference is for a telephone call rather than for a lookup key.
      bookingReference: row.booking_id.replace(/-/g, '').slice(-8),
      tradingDate: row.trading_date,
      startsAtIso: row.starts_at.toISOString(),
      endsAtIso: row.ends_at.toISOString(),
      serviceName: row.service_name,
      durationMinutes: Math.round((row.ends_at.getTime() - row.starts_at.getTime()) / 60_000),
      status: row.status,
      insideCancellationWindow: verdict.late,
      cancellationWindowHours: verdict.windowHours,
      linkExpiresAtIso,
    },
  }
}

/** The desk telephone number, from the `premises` row. Never a literal (`pnpm secrets`, ADR 0019). */
async function deskPhone(sql: Sql): Promise<string> {
  const facts = await readPremisesFacts(sql)
  // An empty string rather than an invented number when the singleton is absent, which means `pnpm seed`
  // has not run. A plausible-looking telephone number is worse than a blank one (brief rule 15): blank is
  // visibly unanswered and plausible is indistinguishable from configured.
  return facts?.premises.phoneLandline ?? facts?.premises.phoneMobile ?? ''
}

/**
 * Resolves a presented token, recording the attempt.
 *
 * One function for the read and the write, so the audit row and the refusal cannot be written twice or
 * skipped once. `null` means the caller must answer {@link notFound} and has nothing else to decide.
 */
async function resolve(
  token: string | null,
  deps: ManageBookingDeps,
): Promise<{ readonly bookingId: string; readonly expiresAtIso: string } | null> {
  const shape = bookingTokenShape(token)
  // No query and no audit row for a malformed token: it costs one regex, and a flood of rubbish must not
  // become a flood of writes to an append-only table. `token_absent` and `token_malformed` are the two
  // refusals the core module decides without I/O, and this is why.
  if (!shape.ok) return null
  const digestHex = bookingTokenDigest(shape.token)
  const atIso = new Date(deps.now()).toISOString()
  const outcome = await withUnitOfWork(deps.sql, CALLER, (uow) =>
    redeemBookingManageToken(uow, { digestHex, atIso, purpose: PURPOSE }, { decide: decideToken }),
  )
  if (outcome.kind === 'refused') return null
  const [row] = await deps.sql<{ expires_at: Date }[]>`
    select expires_at from booking_manage_grant where id = ${outcome.grantId}::uuid
  `
  return {
    bookingId: outcome.bookingId,
    expiresAtIso: (row?.expires_at ?? new Date(deps.now())).toISOString(),
  }
}

/** The shape every refusal name in this domain has. Bounded, so a query parameter cannot be a paragraph. */
const REFUSAL_NAME = /^[a-z_]{1,64}$/

/** The outcome a `?done=` or `?refused=` parameter names, as a state the page renders. */
function outcomeFrom(params: URLSearchParams): ManageOutcome {
  const done = params.get('done')
  if (done === 'rescheduled') return { kind: 'rescheduled' }
  const refused = params.get('refused')
  // The refusal is echoed through the query string because a reschedule REDIRECTS on success and must
  // redirect on failure too: a 200 rendered from a POST leaves the form resubmittable on reload, and "your
  // booking moved" shown twice is a customer who thinks it moved twice.
  //
  // The value is a refusal NAME, and the SHAPE is checked here rather than trusted: `render.ts` looks it up
  // in a closed `Record` and falls back to words that claim nothing, so a value somebody types into the URL
  // could never put a sentence on the page — but it would reach a `data-` attribute, and an unbounded
  // string in an attribute is a page somebody can make ugly with a link. Lower-case and underscores only,
  // which is what every name in `RESCHEDULE_REFUSALS` and `CANCELLATION_REFUSALS` is.
  if (refused !== null && REFUSAL_NAME.test(refused)) return { kind: 'refused', refusal: refused }
  return { kind: 'none' }
}

export async function handleManageBookingRead(
  input: { readonly token: string | null; readonly searchParams: URLSearchParams },
  deps: ManageBookingDeps,
): Promise<Response> {
  const resolved = await resolve(input.token, deps)
  if (resolved === null) return notFound()
  const booking = await readManagedBooking(
    deps.sql,
    resolved.bookingId,
    resolved.expiresAtIso,
    deps.now(),
  )
  if (booking === null) return notFound()
  return page(
    renderManageBookingHtml({
      locale: booking.locale,
      facts: booking.facts,
      outcome: outcomeFrom(input.searchParams),
      deskPhoneE164: await deskPhone(deps.sql),
      changeable: booking.changeable,
    }),
  )
}

/**
 * A `datetime-local` value as an instant in the business zone.
 *
 * `2099-03-04T19:00` carries no offset, and the reader typed it while standing in Abu Dhabi. Parsed
 * through `fromLocal` from `@berelax/core` rather than `new Date(value)`, which would read it as the
 * SERVER's local time — correct on a container set to Asia/Dubai and four hours wrong on one set to UTC,
 * which is what CI runs. That mistake does not fail: it books a real slot, at the wrong time.
 */
function instantFromLocalInput(value: string | null): Instant | null {
  if (value === null) return null
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/.exec(value.trim())
  if (match === null) return null
  const [, date, time] = match
  if (date === undefined || time === undefined) return null
  try {
    return fromLocal(localDate(date), localTime(time))
  } catch {
    // `localDate` and `localTime` refuse an impossible value — month 13, minute 61 — and a refusal here is
    // a form field the reader can correct, not an exception the route should raise.
    return null
  }
}

/**
 * Where the page sends a reader back to, carrying what happened. The token stays in the path.
 *
 * Through `manageBookingPath` rather than a template literal, so `/booking/` is spelled once: the registry
 * declares the PATTERN, `packages/shared/src/site-origin.ts` builds the instance, and the reminder's
 * absolute link is the same builder with an origin in front. A second spelling here is the one that would
 * be missed if the prefix ever moved.
 */
function backTo(token: string, query: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: `${manageBookingPath(token)}${query}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  })
}

export async function handleManageBookingWrite(
  input: { readonly token: string | null; readonly form: URLSearchParams },
  deps: ManageBookingDeps,
): Promise<Response> {
  const resolved = await resolve(input.token, deps)
  if (resolved === null) return notFound()
  const token = input.token ?? ''
  const booking = await readManagedBooking(
    deps.sql,
    resolved.bookingId,
    resolved.expiresAtIso,
    deps.now(),
  )
  if (booking === null) return notFound()

  const intent = input.form.get('intent')
  if (intent !== 'reschedule' && intent !== 'cancel') {
    // A body this page did not produce. Answered as the page itself rather than as an error, because the
    // reader has done nothing wrong and the forms are right there.
    return backTo(token, '?refused=unknown_intent')
  }
  if (!booking.changeable) {
    return backTo(token, '?refused=illegal_transition')
  }

  if (intent === 'cancel') {
    const cancelDeps: CancelDeps = {
      decide,
      classify,
      steps: await maintainerFor(deps.sql),
    }
    try {
      await cancelBookingTx(
        deps.sql,
        {
          bookingId: booking.bookingId,
          // The STATE names who requested it and the actor names who recorded it — two facts, and
          // `transitions.ts` states the distinction for the receptionist taking a telephone call. This is
          // the customer's own decision, so the state is theirs.
          to: 'cancelled_by_customer',
          actor: ACTOR,
          reason: CANCEL_REASON,
          nowMs: deps.now(),
        },
        cancelDeps,
      )
    } catch (error) {
      return backTo(token, `?refused=${refusalOf(error)}`)
    }
    /*
      Rendered, not redirected, and this is the one place the POST-redirect-GET rule is broken on purpose:
      `cancelAppointment` revokes every live grant on the booking, so the link in the `Location` header is
      already dead. A 303 back to it would answer the 404 above — a customer who has just cancelled being
      told their link is not available, which reads as the salon having lost the cancellation.

      The facts are the ones read BEFORE the cancellation, which is correct for the same reason: the row is
      now `cancelled_by_customer` and re-reading it would need a link that no longer resolves.
    */
    return page(
      renderManageBookingHtml({
        locale: booking.locale,
        facts: booking.facts,
        outcome: { kind: 'cancelled' },
        deskPhoneE164: await deskPhone(deps.sql),
        changeable: false,
      }),
    )
  }

  const startsAt = instantFromLocalInput(input.form.get('startsAt'))
  if (startsAt === null) return backTo(token, '?refused=new_period_invalid')
  const endsAt = (startsAt + booking.facts.durationMinutes * 60_000) as Instant
  const rescheduleDeps: RescheduleDeps = {
    decide,
    recheck,
    resolveTradingDate,
    steps: await maintainerFor(deps.sql),
  }
  try {
    await rescheduleAppointmentTx(
      deps.sql,
      {
        appointmentId: booking.appointmentId,
        actor: ACTOR,
        reason: RESCHEDULE_REASON,
        // The treatment period only. Turnaround and the therapist buffer are the repository's to apply, and
        // a page that added them would be a second copy of a footprint rule.
        treatment: { startsAt, endsAt },
      },
      rescheduleDeps,
    )
  } catch (error) {
    return backTo(token, `?refused=${refusalOf(error)}`)
  }
  // The token survives a reschedule: the grant names the BOOKING, and a successor appointment is a new row
  // in the same booking. So the reader goes back to the same URL and sees the new period.
  return backTo(token, '?done=rescheduled')
}

/**
 * The refusal name an error carries, or `unknown`.
 *
 * Both translators are consulted because both write paths are reachable from here, and neither is allowed
 * to leak a message: `render.ts` looks the NAME up in a closed `Record`, so an error whose refusal neither
 * translator recognises reaches the reader as words that claim nothing rather than as a database string.
 */
function refusalOf(error: unknown): string {
  const named = rescheduleRefusalOf(error) ?? cancellationRefusalOf(error)
  if (named !== null) return named
  // The reader is told nothing useful — `render.ts` falls back to words that claim nothing — so the SERVER
  // has to say something, or a refusal nobody named is a refusal nobody can find. It is `console.error`
  // rather than a throw for the reason the page exists: a 500 in front of a customer holding a link is
  // worse than a page offering the telephone number, and the incident is the same either way.
  console.error(
    '[manage-booking] a write refused with a name neither translator recognises:',
    isAppError(error) ? `${error.kind}: ${error.message}` : String(error),
  )
  return 'unknown'
}
