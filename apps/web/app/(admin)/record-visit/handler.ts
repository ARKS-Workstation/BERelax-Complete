import { randomUUID } from 'node:crypto'
import {
  ASIA_DUBAI,
  type BackdatedOutcome,
  backdatedVisitVerdict,
  decideAppointmentTransition,
  formatMoney,
  fromLocal,
  grossMoneyFromFils,
  type Instant,
  type LocalDate,
  localDate,
  localTime,
  normalisePhoneResult,
  recheckShapeAssignment,
  safeText,
  toLocal,
} from '@berelax/core'
import {
  type BookableVariantRow,
  type BookingDeliveryInput,
  type ExclusionReason,
  ensureCustomer,
  periodStatusOn,
  readBackdatedVisitHorizonDays,
  readBookableRooms,
  readBookableVariants,
  readEligibleTherapists,
  readGenderMatching,
  readRequiredSkillForVariant,
  readTherapistLabels,
  recordPastVisit,
  type SlotRecheck,
  type Sql,
  type TransitionActor,
  type TransitionDecider,
  withUnitOfWork,
} from '@berelax/db'
import { AppError, isAppError } from '@berelax/shared'
import type { AdminChrome } from '../../../src/components/admin/google-reauth-banner.ts'
import { type ParsedDelivery, resolveDeliveryInput } from '../../api/v1/bookings/handler.ts'
import { renderRecordVisitHtml } from './render.ts'
import {
  RECORD_VISIT_FIELDS,
  REFUSAL_FOR_VERDICT,
  type RecordVisitChecked,
  type RecordVisitForm,
  type RecordVisitRecorded,
  type RecordVisitRefused,
  type RecordVisitView,
  type RenderDirection,
  recordVisitRefused,
} from './view.ts'

/**
 * `/record-visit` — the treatment that happened and was never entered.
 *
 * ## The gap this closes, stated once
 *
 * There was no way to record a past treatment. `/quick-book` books through `queryAvailability`, which
 * filters every slot against the desk's lead time from *now*, so a past date offers nothing to choose; and
 * the diary only MOVES an appointment, it does not create one. A walk-in served at 19:00 on Friday and not
 * typed in was, on Monday, unrecordable — missing from the diary, from the therapist's utilisation, from
 * commission, and its money missing from the books.
 *
 * ## Four authorities, none of them this file
 *
 * This handler composes and refuses; it decides nothing on its own.
 *
 *   1. **`backdatedVisitVerdict`** (`@berelax/core`) decides whether the instant may be recorded at all:
 *      in the past, finished, within the horizon, inside a trading session. Pure, and the clock and the
 *      trading-date resolution are arguments.
 *   2. **`resolveDeliveryInput`** (the bookings endpoint) resolves the variant's duration, the trading date
 *      and the price — the same three lookups a live booking makes, through the same function, so the two
 *      paths cannot disagree about how long a treatment is or what it cost.
 *   3. **`periodStatusOn`** decides whether the money may land. See `period_closed` below.
 *   4. **`recordPastVisit`** writes it: `createBooking` at `confirmed`, then the lifecycle walked through
 *      `transitionAppointment`, in one transaction. A therapist who was not rostered, or who already has a
 *      treatment at that time, is refused there — by the eligibility read model and by 0024's exclusion
 *      constraint — not by a pre-check here.
 *
 * ## Why the period lock is checked HERE and not left to the posting
 *
 * The database's own guard refuses a `journal_entry` into a closed period, which is the backstop and is
 * correct. But it fires when the money is posted, and the money is posted from the revenue event the
 * completion emits — by the worker, after this transaction has committed. A visit recorded into a closed
 * month would therefore succeed on screen, appear in the diary, and leave an outbox event that can never
 * be posted: a treatment in the book with no entry in the ledger, discovered weeks later by a
 * reconciliation. Refusing the whole entry before anything is written is the only answer that leaves no
 * half-done state, and `period_closed` says so to the person at the desk in those terms.
 *
 * ## What is NOT relaxed
 *
 * The availability SOLVER is not consulted, deliberately: asking whether a therapist *was* free at 19:00
 * yesterday is answered by what they actually did. What is not relaxed is the one rule that is about
 * reality rather than policy — two overlapping treatments for one therapist cannot have happened — and a
 * backdated entry meets 0024's exclusion constraint exactly as a live one does.
 */

export interface RecordVisitDeps {
  readonly sql: Sql
  /** Injected, so `record-visit.itest.ts` can freeze the clock the horizon is measured from. */
  readonly now: () => number
}

export interface RecordVisitRequest {
  readonly searchParams: URLSearchParams
  readonly chrome: AdminChrome
  /** The form body, or `null` on a GET. */
  readonly body: URLSearchParams | null
  readonly requestId: string | null
}

/**
 * The label every row records: the SURFACE, not a person.
 *
 * Quick-book's arrangement and for its reason — the one thing an audit label must never do is claim that a
 * particular named person said a treatment happened, when the record of who was signed in lives in the
 * session table rather than in this string. The ROLE is a separate field and is the reader's own; see
 * below.
 */
const ACTOR_LABEL = 'Record a missed visit (front desk)'

/**
 * The actor, with the reader's OWN role rather than a constant.
 *
 * The label is the surface and the role is the person's, and the split is not cosmetic: the label is what
 * the audit row shows a reader, while the role is what `decideAppointmentTransition` consults to decide
 * whether the move is permitted at all. A hard-coded `manager` would record the wrong role for an owner,
 * and — worse the other way round — would authorise `no_show`, which `receptionist` may not make, for a
 * caller whose role could not make it. The route already refuses anybody without
 * `booking:override_constraints`; this makes the history row say which of them it was.
 *
 * `AdminChrome.role` is optional for the reason that field documents, and absent means the session read
 * failed rather than that the reader has no role — so this throws and the route's `catch` answers 503,
 * which is the honest reading of "the check could not be made".
 */
function actorFor(chrome: AdminChrome): TransitionActor {
  const role = chrome.role
  if (role === undefined) {
    throw new AppError(
      'invariant_violated',
      'The session carries no role, so no appointment history row could name who recorded this visit.',
    )
  }
  return { kind: 'staff', label: ACTOR_LABEL, role }
}

/** `satisfies` and not a cast: the seam core and db declare separately, checked in one place. */
const decide = decideAppointmentTransition satisfies TransitionDecider
const recheck = recheckShapeAssignment satisfies SlotRecheck

const page = (html: string, status = 200): Response =>
  new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cached. The confirmation panel names one customer's booking, and a CDN with a default policy
      // would serve it to the next person at the desk.
      'cache-control': 'no-store',
    },
    status,
  })

const fieldOf = (body: URLSearchParams | null, name: string): string =>
  body?.get(name)?.trim() ?? ''

function formOf(body: URLSearchParams | null): RecordVisitForm {
  const f = RECORD_VISIT_FIELDS
  return {
    step: fieldOf(body, f.step),
    phone: fieldOf(body, f.phone),
    variant: fieldOf(body, f.variant),
    gender: fieldOf(body, f.gender),
    date: fieldOf(body, f.date),
    // `<input type="time">` may submit seconds. The seconds of a start nobody wrote down are noise, and a
    // `HH:MM:SS` value would fail `localTime` and be refused as unreadable for a form that was filled in
    // correctly.
    time: fieldOf(body, f.time).slice(0, 5),
    outcome: fieldOf(body, f.outcome),
    reason: fieldOf(body, f.reason).slice(0, 500),
    notes: fieldOf(body, f.notes).slice(0, 2_000),
    therapist: fieldOf(body, f.therapist),
    room: fieldOf(body, f.room),
  }
}

export function directionFrom(params: URLSearchParams): RenderDirection {
  return params.get('dir') === 'rtl' ? 'rtl' : 'ltr'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The all-zero uuid, which `uuid_generate_v7()` cannot produce, so it names no row and never will. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/** The wall clock in Asia/Dubai, as `HH:MM`. Through core, so no locale or ICU build can move it. */
const clockLabel = (ms: number): string => toLocal(ms as Instant, ASIA_DUBAI).time

interface Shell {
  readonly variants: readonly BookableVariantRow[]
  readonly horizonDays: number
}

async function readShell(deps: RecordVisitDeps): Promise<Shell> {
  const [variants, horizonDays] = await Promise.all([
    readBookableVariants(deps.sql),
    readBackdatedVisitHorizonDays(deps.sql),
  ])
  return { variants, horizonDays }
}

interface ViewArgs {
  readonly request: RecordVisitRequest
  readonly shell: Shell
  readonly form: RecordVisitForm
  readonly announcement: string
  readonly refusal?: RecordVisitRefused
  readonly checked?: RecordVisitChecked
  readonly recorded?: RecordVisitRecorded
}

function viewFor(args: ViewArgs): RecordVisitView {
  return {
    direction: directionFrom(args.request.searchParams),
    chrome: args.request.chrome,
    form: args.form,
    variants: args.shell.variants.map((variant) => ({
      serviceVariantId: variant.serviceVariantId,
      label: variant.publicDisplayName,
      durationMinutes: variant.durationMinutes,
    })),
    horizonDays: args.shell.horizonDays,
    announcement: args.announcement,
    refusal: args.refusal ?? null,
    checked: args.checked ?? null,
    recorded: args.recorded ?? null,
  }
}

const refuse = (args: ViewArgs & { readonly refusal: RecordVisitRefused }): Response =>
  // 200 and not 4xx: this is a form being handed back to the person who filled it in, with a sentence
  // saying what to change. A 422 here would make the browser's own "resubmit this form?" dialogue the
  // next thing they see.
  page(renderRecordVisitHtml(viewFor(args)))

// --- the entry ---------------------------------------------------------------------------------

interface ParsedEntry {
  readonly phoneE164: string
  readonly variant: BookableVariantRow
  readonly gender: 'female' | 'male'
  readonly startsAt: Instant
  readonly outcome: BackdatedOutcome
  readonly reason: string
  readonly notes: string
}

/**
 * The submitted entry, or the refusal that stops it.
 *
 * Shape errors first and in the order a reader needs them: the phone, the treatment, who it was for, the
 * instant, the outcome. Nothing here touches the database except the variant, which was already read for
 * the form.
 */
function parseEntry(
  form: RecordVisitForm,
  shell: Shell,
): ParsedEntry | { readonly refusal: RecordVisitRefused } {
  const normalised = normalisePhoneResult(form.phone)
  if (!normalised.ok) return { refusal: recordVisitRefused('phone_not_eligible') }
  const variant = shell.variants.find((row) => row.serviceVariantId === form.variant)
  if (variant === undefined) return { refusal: recordVisitRefused('unknown_treatment') }
  if (form.gender !== 'female' && form.gender !== 'male') {
    return { refusal: recordVisitRefused('requires_client_gender') }
  }
  if (form.outcome !== 'completed' && form.outcome !== 'no_show') {
    return { refusal: recordVisitRefused('unknown_outcome') }
  }
  /*
   * The wall clock in Asia/Dubai, through `fromLocal` rather than `Date.parse`.
   *
   * `Date.parse('2026-11-06T19:00')` reads the string in the SERVER's zone, which in a container is UTC —
   * so a 19:00 visit would be recorded at 23:00 Dubai, four hours later, on a screen that looked right.
   * `fromLocal` resolves the offset at the instant itself, which is also why nothing here assumes +04:00.
   */
  let startsAt: Instant
  try {
    startsAt = fromLocal(localDate(form.date), localTime(form.time))
  } catch {
    return { refusal: recordVisitRefused('start_unreadable') }
  }
  return {
    phoneE164: normalised.e164,
    variant,
    gender: form.gender,
    startsAt,
    outcome: form.outcome,
    reason: form.reason,
    notes: form.notes,
  }
}

/** The delivery as the booking path spells one. Solo only — see the note on `handleRecordVisitWrite`. */
const deliveryOf = (parsed: ParsedEntry, roomId: string, therapistId: string): ParsedDelivery => ({
  serviceVariantId: parsed.variant.serviceVariantId,
  shape: 'solo',
  roomId,
  therapistIds: [therapistId],
  startsAt: parsed.startsAt,
})

/**
 * The three lookups, the policy gate and the period lock, in that order.
 *
 * The order is the answer's quality: a reader is told what they typed wrongly before they are told the
 * salon was closed, and told the salon was closed before they are told the month is shut. Each step's
 * refusal is the one whose remedy is nearest to hand.
 *
 * `roomId` and `therapistId` are placeholders on the CHECK, because neither has been chosen yet and
 * `resolveDeliveryInput` reads neither — it answers about the variant, the calendar and the price. The
 * `record` step passes the real pair.
 */
async function resolveAndGate(
  deps: RecordVisitDeps,
  shell: Shell,
  parsed: ParsedEntry,
  roomId: string,
  therapistId: string,
): Promise<
  { readonly delivery: BookingDeliveryInput; readonly tradingDate: LocalDate } | RecordVisitRefused
> {
  const resolved = await resolveDeliveryInput(deps.sql, deliveryOf(parsed, roomId, therapistId))
  if (resolved.kind === 'unknown_service_variant') {
    return recordVisitRefused('unknown_treatment')
  }
  if (resolved.kind === 'outside_trading_hours') {
    return recordVisitRefused('outside_trading_hours', resolved.reason)
  }
  if (resolved.kind === 'no_applicable_price') return recordVisitRefused('no_applicable_price')
  const delivery = resolved.delivery
  const tradingDate = localDate(delivery.tradingDate)

  /*
   * The gate, with the trading date the lookup above already resolved.
   *
   * `outside_a_trading_session` is unreachable from here, and that is honest rather than dead: the same
   * question was asked one step earlier by `resolveTradingDate` inside `resolveDeliveryInput`, which
   * refuses with the day's own reason — a better sentence than this gate can produce, because it knows
   * whether the premises was shut or the instant fell in a gap. The gate keeps the branch because it has
   * callers that resolve the date themselves.
   */
  const verdict = backdatedVisitVerdict(
    {
      startsAt: parsed.startsAt,
      endsAt: delivery.treatment.endsAt as Instant,
      outcome: parsed.outcome,
      now: deps.now() as Instant,
      // The figure the form told the reader, and the one that decides. Read once, in `readShell`, so the
      // hint under the date field and the refusal cannot be two different answers in one request.
      horizonDays: shell.horizonDays,
    },
    () => tradingDate,
  )
  if (verdict.kind === 'refused') return recordVisitRefused(REFUSAL_FOR_VERDICT[verdict.refusal])

  /*
   * The money half. Checked for BOTH outcomes, although only `completed` emits revenue.
   *
   * A no-show posts nothing today, and a fee policy that charges for one is an open question (Y9-windows)
   * — so a no-show written into a closed month is a row that a later policy could attach money to, in a
   * period nothing may be posted into. Refusing both is one rule rather than two, and the one that does
   * not have to be revisited when that question is answered.
   */
  const period = await periodStatusOn(deps.sql, tradingDate)
  if (period.closed) {
    return recordVisitRefused(
      'period_closed',
      `${tradingDate} is inside a closed period. The earliest date still open is ${period.earliestOpenDate}.`,
    )
  }
  return { delivery, tradingDate }
}

// --- step=check --------------------------------------------------------------------------------

/** Who was on shift that day, and the rooms, as the two lists the desk picks from. */
type CheckedOptions = Omit<
  RecordVisitChecked,
  'tradingDate' | 'startLabel' | 'endLabel' | 'priceLabel'
>

async function optionsFor(
  deps: RecordVisitDeps,
  parsed: ParsedEntry,
  tradingDate: string,
): Promise<CheckedOptions | RecordVisitRefused> {
  const requiredSkill = await readRequiredSkillForVariant(deps.sql, parsed.variant.serviceVariantId)
  if (requiredSkill === null) return recordVisitRefused('no_required_skill')

  const [pool, rooms, genderMatching] = await Promise.all([
    readEligibleTherapists(deps.sql, { tradingDate, requiredSkill }),
    readBookableRooms(deps.sql),
    readGenderMatching(deps.sql),
  ])

  /*
   * The same-gender rule applied to the LIST, and re-applied by the write.
   *
   * Filtering here is about the screen, not about safety: `createBooking` re-reads the mode through the
   * same reader and refuses `therapist_not_eligible` whatever this list offered, so a bug here cannot
   * produce a mismatched treatment. What it would produce is a select full of people the write refuses,
   * which is a screen that wastes a shift. Absent or unreadable is strict, by `readGenderMatching`.
   */
  const matched =
    genderMatching === 'strict'
      ? pool.therapists.filter((row) => row.gender === parsed.gender)
      : pool.therapists

  const labels = await readTherapistLabels(deps.sql, [
    ...matched.map((row) => row.therapistId),
    ...pool.excluded.map((row) => row.therapistId),
  ])
  const referenceOf = (id: string): string =>
    labels.find((label) => label.therapistId === id)?.staffReference ?? id

  return {
    outcome: parsed.outcome,
    therapists: matched
      .map((row) => ({ therapistId: row.therapistId, reference: referenceOf(row.therapistId) }))
      .sort((a, b) => a.reference.localeCompare(b.reference)),
    excluded: pool.excluded
      .map((row) => ({
        reference: referenceOf(row.therapistId),
        // The read model's own vocabulary, shown verbatim. A sentence per reason would be a fourth place
        // `ExclusionReason` is spelled, and "not rostered" is already the answer the desk needs.
        reason: row.reason as ExclusionReason,
      }))
      .sort((a, b) => a.reference.localeCompare(b.reference)),
    rooms: rooms.map((room) => ({
      roomId: room.roomId,
      label: `${room.name} (${room.code})`,
      capacity: room.capacity,
    })),
  }
}

// --- the two steps -----------------------------------------------------------------------------

export async function handleRecordVisitRead(
  request: RecordVisitRequest,
  deps: RecordVisitDeps,
): Promise<Response> {
  const shell = await readShell(deps)
  return page(
    renderRecordVisitHtml(
      viewFor({
        request,
        shell,
        form: formOf(null),
        announcement: 'Ready. Type the mobile number, then the day and the time of the visit.',
      }),
    ),
  )
}

/**
 * The two POSTs: `check` resolves and shows, `record` writes what was shown.
 *
 * **Solo entries only**, stated rather than discovered. Quick-book's own note gives the reason and it holds
 * here: a couples booking needs two clients' genders, and a four-hands treatment is unassignable against
 * the seeded room inventory. A screen for correcting an oversight at the desk is not the place to solve
 * that, and `recordPastVisit` already walks every appointment of a delivery, so the restriction is this
 * screen's and not the unit's.
 */
export async function handleRecordVisitWrite(
  request: RecordVisitRequest,
  deps: RecordVisitDeps,
): Promise<Response> {
  const form = formOf(request.body)
  const shell = await readShell(deps)
  if (form.step !== 'check' && form.step !== 'record') {
    return refuse({
      request,
      shell,
      form,
      announcement: 'Nothing was recorded.',
      refusal: recordVisitRefused('unreadable_request'),
    })
  }

  const parsed = parseEntry(form, shell)
  if ('refusal' in parsed) {
    return refuse({
      request,
      shell,
      form,
      announcement: 'Nothing was recorded.',
      refusal: parsed.refusal,
    })
  }

  if (form.step === 'check') return await check(request, deps, shell, form, parsed)
  return await record(request, deps, shell, form, parsed)
}

async function check(
  request: RecordVisitRequest,
  deps: RecordVisitDeps,
  shell: Shell,
  form: RecordVisitForm,
  parsed: ParsedEntry,
): Promise<Response> {
  /*
   * A room and a therapist that exist, for a question that reads neither.
   *
   * `resolveDeliveryInput` answers about the variant, the calendar and the price; the pair reaches it only
   * because `ParsedDelivery` is the booking path's own shape and this reuses it whole rather than
   * declaring a near-copy. The first room and nobody is enough, and the `record` step passes the pair the
   * desk actually chose.
   */
  const gated = await resolveAndGate(deps, shell, parsed, NIL_UUID, NIL_UUID)
  if ('name' in gated) {
    return refuse({
      request,
      shell,
      form,
      announcement: 'Nothing was recorded.',
      refusal: gated,
    })
  }
  const options = await optionsFor(deps, parsed, gated.tradingDate)
  if ('name' in options) {
    return refuse({
      request,
      shell,
      form,
      announcement: 'Nothing was recorded.',
      refusal: options,
    })
  }
  return page(
    renderRecordVisitHtml(
      viewFor({
        request,
        shell,
        form,
        announcement:
          options.therapists.length === 0
            ? 'Nobody who could have given that treatment was on shift that day. Check the date.'
            : 'Check the trading date and the figure, then say who gave the treatment and where.',
        checked: {
          tradingDate: gated.tradingDate,
          startLabel: clockLabel(gated.delivery.treatment.startsAt),
          endLabel: clockLabel(gated.delivery.treatment.endsAt),
          priceLabel: formatMoney(grossMoneyFromFils(String(gated.delivery.price.grossFils))),
          ...options,
        },
      }),
    ),
  )
}

async function record(
  request: RecordVisitRequest,
  deps: RecordVisitDeps,
  shell: Shell,
  form: RecordVisitForm,
  parsed: ParsedEntry,
): Promise<Response> {
  const fail = (refusal: RecordVisitRefused): Response =>
    refuse({ request, shell, form, announcement: 'Nothing was recorded.', refusal })

  if (!UUID.test(form.therapist)) return fail(recordVisitRefused('therapist_not_chosen'))
  if (!UUID.test(form.room)) return fail(recordVisitRefused('room_not_chosen'))

  /*
   * Re-gated on the write, with the real pair, and never trusted from the check.
   *
   * The two POSTs are seconds apart and everything in between can have moved: the clock crosses the
   * horizon, a manager narrows it, the accounts team closes the month. A confirm that replayed the check's
   * verdict would be a screen whose answer was correct when it was rendered, which is the one thing a
   * correction to the books must not be.
   */
  const gated = await resolveAndGate(deps, shell, parsed, form.room, form.therapist)
  if ('name' in gated) return fail(gated)

  // Built BEFORE the transaction, so an absent role is answered by the route's 503 rather than by this
  // function's `catch` — which would report a session that could not be read as "the entry was refused".
  const actor = actorFor(request.chrome)
  const enteredAtIso = new Date(deps.now()).toISOString()
  try {
    const written = await withUnitOfWork(
      deps.sql,
      { kind: 'staff', label: ACTOR_LABEL },
      async (uow) => {
        // The customer, through the one chokepoint (0019, ADR 0014): the phone is the identity, and a
        // visit entered late is the same person as a visit entered on the day.
        const customer = await ensureCustomer(uow, {
          phoneE164: parsed.phoneE164,
          displayName: null,
          nameMatchKey: null,
          locale: 'en',
          createdVia: 'guest_booking',
        })
        return await recordPastVisit(
          uow,
          {
            booking: {
              /*
               * A fresh key per attempt, deliberately NOT derived from the entry.
               *
               * A derived key would make a second submission a replay — and here the second submission is
               * usually a correction, not a retry: the desk notices the therapist was wrong and sends it
               * again. A replay would hand back the first booking and report success for the entry nobody
               * wanted. The protection against a double-tap is the exclusion constraint on
               * `(therapist_id, period)`, which refuses the duplicate by name.
               */
              idempotencyKey: randomUUID(),
              customerId: customer.customer.id,
              source: 'walk_in',
              clientGender: parsed.gender,
              genderMatching: await readGenderMatching(deps.sql),
              ...(parsed.notes === '' ? {} : { notes: parsed.notes }),
              deliveries: [gated.delivery],
            },
            outcome: parsed.outcome,
            actor,
            enteredAtIso,
            ...(parsed.reason === '' ? {} : { reason: parsed.reason }),
          },
          { recheck, decide },
        )
      },
      request.requestId === null ? {} : { requestId: request.requestId },
    )

    const appointmentIds = written.booking.deliveries.flatMap((delivery) => delivery.appointmentIds)
    return page(
      renderRecordVisitHtml(
        viewFor({
          request,
          shell,
          form: formOf(null),
          announcement:
            parsed.outcome === 'completed'
              ? 'Recorded. The treatment is in the diary and its money is in the day’s takings.'
              : 'Recorded. The no-show is in the diary and in the commission run.',
          recorded: {
            bookingId: written.booking.bookingId,
            appointmentIds,
            tradingDate: gated.tradingDate,
            outcome: parsed.outcome,
            startLabel: clockLabel(gated.delivery.treatment.startsAt),
            priceLabel: formatMoney(grossMoneyFromFils(String(gated.delivery.price.grossFils))),
            /*
             * The walk as it actually went, starting from where `createBooking` left the row.
             *
             * A `no_op` step is shown as the status it was already in rather than skipped: `recordPastVisit`
             * keeps those deliberately — a repeated `no_show` is declared idempotent by the transition
             * table — and a list that quietly dropped one would claim a move the history has no row for.
             */
            walked: [
              'confirmed',
              ...written.steps.map((step) => (step.kind === 'no_op' ? step.status : step.to)),
            ],
          },
        }),
      ),
    )
  } catch (error) {
    /*
     * ONE catch for the whole transaction, and the reason is carried rather than classified.
     *
     * `createBooking` refuses by name (`therapist_not_eligible`, `slot_taken`, `room_not_found`) and
     * `transitionAppointment` throws on a refused move; both roll the transaction back, so there is no
     * half-walked appointment to reason about. Re-spelling that list here would be a third copy of it
     * that goes stale, and the person at the desk needs the sentence rather than the taxonomy — so
     * `write_refused` says what to do and the database's own words are shown beneath it.
     */
    const detail = isAppError(error) || error instanceof Error ? error.message : 'Unexpected'
    return fail(recordVisitRefused('write_refused', safeText(detail).slice(0, 400)))
  }
}
