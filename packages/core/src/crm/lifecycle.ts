/**
 * The customer lifecycle, as data (C-CRM-01).
 *
 * Six states, seven events, and a verdict for **every one of the forty-two pairs**. The reducer is a
 * lookup with no policy of its own, for the reason `lifecycle/transitions.ts` states about the
 * appointment machine and which applies twice as strongly here: a state machine written as control flow
 * has one property nobody can check — the set of pairs it accepts is not readable anywhere, and the
 * branch that is missing looks exactly like the branch that was never needed.
 *
 * `Record<CustomerLifecycleState, Record<CustomerLifecycleEvent, …>>` is the coverage assertion. A
 * seventh state or an eighth event makes the table incomplete and `pnpm typecheck` fails naming this
 * file; there is no `default:` to fall through to, because a default in a state machine is a
 * default-allow with better manners. `lifecycle.property.test.ts` walks the whole cross product and
 * asserts the same thing at runtime, so the table cannot be widened by a cast either.
 *
 * ## Never a throw and never `undefined`
 *
 * {@link decideCustomerLifecycle} returns a verdict for every pair. That is a deliberate contract, not
 * a convenience: the two callers are a sweep that walks the whole customer table looking for records
 * that have gone cold, and an admin action. A sweep that throws on the pair nobody thought about stops
 * half way through the table, and the records it did not reach are indistinguishable from the records
 * it decided not to move. So an inapplicable pair is a **named refusal** the caller can count, log and
 * skip.
 *
 * ## The blocked state does not lapse, and that is the security property in here
 *
 * `blocked` refuses every event except an enquiry (which only records that contact happened) and the
 * lift. In particular it refuses both lapse thresholds. A blocked record that could lapse would leave
 * `blocked` on a timer — the sweep would quietly un-block somebody at 03:00 — and the block is the
 * thing this unit exists to make real. The blocklist itself is keyed on the contact detail rather than
 * on this column (`customer_blocklist`, migration 0053) precisely so that the booking path refuses
 * before any lifecycle state is read; this arm is the second fence, not the first.
 *
 * ## Provisional
 *
 * The six state names are this build's, not the business's: nobody has stated a client lifecycle.
 * {@link CUSTOMER_LIFECYCLE_PROVISIONAL} carries the OPEN-QUESTIONS id and the vocabulary lives in a
 * TABLE rather than a Postgres enum (0053) so that the flag, the id and the note can sit on each label
 * and reach the Unconfirmed Assumptions panel. A provisional value that cannot be marked provisional
 * is indistinguishable from a configured one (brief rule 15).
 */

/**
 * The six states, in the order migration 0053 seeds `customer_lifecycle_state.display_order`.
 *
 * The order is load-bearing for review rather than for runtime: `packages/fixtures/src/crm-client-record.itest.ts`
 * asserts this list equals the seeded rows, label for label and position for position. A seventh label
 * in one and not the other is a state the database can hold and this reducer cannot judge.
 */
export const CUSTOMER_LIFECYCLE_STATES = [
  'lead',
  'new',
  'active',
  'lapsing',
  'lapsed',
  'blocked',
] as const

export type CustomerLifecycleState = (typeof CUSTOMER_LIFECYCLE_STATES)[number]

/**
 * Everything that can happen to a client record, as a closed set.
 *
 * Two of them are clock-driven and are named for the **threshold that was crossed** rather than for a
 * duration, because the durations are settings and this module reads none: `packages/core` takes the
 * instant as an argument everywhere, and a reducer that knew "90 days" would be the second place that
 * figure lives.
 */
export const CUSTOMER_LIFECYCLE_EVENTS = [
  /** Somebody made contact and it was recorded. Says nothing about a booking. */
  'enquiry_recorded',
  /** A booking now exists in the diary for this record. */
  'booking_taken',
  /** An appointment reached `completed` — money, and the only event that proves a treatment happened. */
  'treatment_completed',
  /** The first inactivity threshold was crossed: the record is going cold. */
  'inactivity_warning_reached',
  /** The second inactivity threshold was crossed: the record is cold. */
  'inactivity_threshold_reached',
  /** A manager added a blocklist entry covering this record. */
  'blocklisted',
  /** A manager lifted every blocklist entry covering this record. */
  'blocklist_lifted',
] as const

export type CustomerLifecycleEvent = (typeof CUSTOMER_LIFECYCLE_EVENTS)[number]

/** Every reason a pair is refused, as a value. Callers branch on these, never on prose. */
export const CUSTOMER_LIFECYCLE_REFUSALS = [
  /**
   * The record is blocked and the event would move it, or would act on a blocked person.
   *
   * Four of the twelve refusals. Both lapse thresholds are here on purpose — see the module note.
   */
  'customer_is_blocked',
  /** A lift arrived for a record that is not blocked. Answering "done" would conceal a mistake. */
  'not_blocked',
  /** A lapse threshold reported for a record that has never had activity to lapse from. */
  'no_activity_to_lapse',
  /** A warning threshold reported for a record that has already passed the later one. */
  'lapse_threshold_already_past',
  /**
   * The pair is not in the table at all, which can only mean a drift.
   *
   * Unreachable while the two unions and {@link TABLE} agree — `Record` over both makes a missing cell
   * a typecheck failure — and it exists because the arguments arrive from a database column in
   * production. A label 0053's vocabulary tables hold and this build has not learned about must be
   * REFUSED by name, not returned as `undefined`, which at a call site is indistinguishable from "no
   * change needed".
   */
  'unknown_lifecycle_pair',
] as const

export type CustomerLifecycleRefusal = (typeof CUSTOMER_LIFECYCLE_REFUSALS)[number]

/**
 * The verdict on one (state, event) pair. Three kinds, and no fourth.
 *
 * `unchanged` is deliberately not a kind of `moved`. A caller that treats them alike writes a
 * lifecycle change for a change that did not happen, and the record's history then reads as activity
 * where nothing occurred — the same distinction `AppointmentTransitionVerdict` draws between `allowed`
 * and `no_op`, and for the same reason.
 */
export type CustomerLifecycleVerdict =
  | {
      readonly kind: 'moved'
      readonly from: CustomerLifecycleState
      readonly to: CustomerLifecycleState
      readonly why: string
    }
  | { readonly kind: 'unchanged'; readonly state: CustomerLifecycleState; readonly why: string }
  | {
      readonly kind: 'refused'
      readonly refusal: CustomerLifecycleRefusal
      /**
       * The label as it ARRIVED, typed `string` rather than as the union.
       *
       * The two narrow arms above are only ever produced after the guards below have recognised both
       * arguments, so their states really are members of the union. A refusal is the one outcome that can
       * carry a label this build has never heard of — see `unknown_lifecycle_pair` — and typing it as the
       * union would be a lie that a caller would print.
       */
      readonly from: string
      readonly why: string
    }

/** One cell of the table: a target state, `null` for "stay", or a refusal. All three are named. */
type Outcome =
  | { readonly to: CustomerLifecycleState; readonly why: string }
  | { readonly stay: true; readonly why: string }
  | { readonly refuse: CustomerLifecycleRefusal; readonly why: string }

/**
 * The whole 6x7 grid, enumerable from here.
 *
 * Every `why` is the record of an argument that could have gone the other way, which is the only reason
 * this is written out rather than generated from a shorter rule. Two are worth reading before changing
 * anything:
 *
 *   - **A booking, not a treatment, ends a lapse.** `lapsing -> active` and `lapsed -> active` fire on
 *     `booking_taken`, before anybody has been on a table. Waiting for `treatment_completed` is how a
 *     client who has already rebooked receives a "we miss you" message on the morning of their
 *     appointment. The cost is that `active` no longer means "has completed a treatment", so any
 *     segment about treatment history must be defined over the appointments and not over this column —
 *     including the win-back segment C-AUTO owns.
 *   - **A lift restores `lapsed`, never the state the record held before the block.** This reducer is a
 *     function of (state, event) and holds no memory, and giving it one would mean an unblock could
 *     reinstate `active` for somebody with no recent treatment. `lapsed` is the coldest non-blocked
 *     state and its own transitions require the customer to act.
 */
const TABLE: Readonly<
  Record<CustomerLifecycleState, Readonly<Record<CustomerLifecycleEvent, Outcome>>>
> = Object.freeze({
  lead: {
    enquiry_recorded: {
      stay: true,
      why: "A second enquiry from a prospect is not a change of state. It is a reason to follow up, which is the pipeline's job rather than the lifecycle's.",
    },
    booking_taken: {
      to: 'new',
      why: 'The moment a prospect books they are a client of the business, whether or not they arrive.',
    },
    treatment_completed: {
      to: 'active',
      why: 'A walk-in recorded after the fact: the enquiry was logged, the treatment happened, and no booking was ever taken. Refusing this pair would leave the record a lead forever.',
    },
    inactivity_warning_reached: {
      refuse: 'no_activity_to_lapse',
      why: 'A lead has had no activity to go cold from. Moving one to `lapsing` would put prospects into a win-back flow written for former clients.',
    },
    inactivity_threshold_reached: {
      refuse: 'no_activity_to_lapse',
      why: 'The same fact as the warning, at the later threshold.',
    },
    blocklisted: {
      to: 'blocked',
      why: 'A prospect can be blocked before ever booking, which is the case the blocklist is most often used for.',
    },
    blocklist_lifted: {
      refuse: 'not_blocked',
      why: 'Nothing to lift. Answering "done" would conceal an actor acting on the wrong record.',
    },
  },
  new: {
    enquiry_recorded: {
      stay: true,
      why: 'A client with a booking in the diary asking a question is not a state change.',
    },
    booking_taken: {
      stay: true,
      why: 'A second booking before the first is delivered. The record is already `new`; the booking count is not this column.',
    },
    treatment_completed: {
      to: 'active',
      why: 'The first completed treatment is what makes a booking a client relationship. The till knows the truth (docs/03 SS2).',
    },
    inactivity_warning_reached: {
      to: 'lapsing',
      why: 'A record created and never turned into a treatment is still going cold, and the recovery conversation is the same one.',
    },
    inactivity_threshold_reached: {
      to: 'lapsed',
      why: 'Both thresholds can be crossed between two runs of the sweep, so the later one must be reachable from here directly.',
    },
    blocklisted: { to: 'blocked', why: 'A block applies whatever the record was doing.' },
    blocklist_lifted: {
      refuse: 'not_blocked',
      why: 'Nothing to lift: this record is not blocked. Answering "done" would conceal an actor acting on the wrong record.',
    },
  },
  active: {
    enquiry_recorded: { stay: true, why: 'An active client asking a question changes nothing.' },
    booking_taken: {
      stay: true,
      why: 'The ordinary case: a client who books again is already active.',
    },
    treatment_completed: {
      stay: true,
      why: 'Every subsequent treatment. The visit count and the last-visit date are facts about the appointments, not about this column.',
    },
    inactivity_warning_reached: {
      to: 'lapsing',
      why: 'The first threshold. `lapsing` exists as a separate state so a win-back can be attempted while the relationship is still warm.',
    },
    inactivity_threshold_reached: {
      to: 'lapsed',
      why: 'A gap long enough to cross both thresholds between two sweeps must not leave the record active.',
    },
    blocklisted: { to: 'blocked', why: 'A block applies whatever the record was doing.' },
    blocklist_lifted: {
      refuse: 'not_blocked',
      why: 'Nothing to lift: this record is not blocked. Answering "done" would conceal an actor acting on the wrong record.',
    },
  },
  lapsing: {
    enquiry_recorded: {
      stay: true,
      why: 'An enquiry is a sign of life and not a booking. Treating it as one would clear the win-back list on the strength of a question.',
    },
    booking_taken: {
      to: 'active',
      why: 'See the table note: the booking ends the lapse, because a client with an appointment must stop receiving win-back messages that morning.',
    },
    treatment_completed: {
      to: 'active',
      why: 'A walk-in from a cooling client, with no booking in between.',
    },
    inactivity_warning_reached: {
      stay: true,
      why: 'The sweep reporting the same threshold again. Already true, and nothing downstream counts the asking.',
    },
    inactivity_threshold_reached: { to: 'lapsed', why: 'The second threshold, in order.' },
    blocklisted: { to: 'blocked', why: 'A block applies whatever the record was doing.' },
    blocklist_lifted: {
      refuse: 'not_blocked',
      why: 'Nothing to lift: this record is not blocked. Answering "done" would conceal an actor acting on the wrong record.',
    },
  },
  lapsed: {
    enquiry_recorded: {
      stay: true,
      why: 'A lapsed client making contact is a lead for the front desk to follow up, and the record is already theirs.',
    },
    booking_taken: { to: 'active', why: 'The win-back succeeded. See the table note.' },
    treatment_completed: { to: 'active', why: 'The win-back succeeded without a booking first.' },
    inactivity_warning_reached: {
      refuse: 'lapse_threshold_already_past',
      why: 'A warning for a record that has already crossed the later threshold is the sweep asking to move the record BACKWARDS. Accepting it would make a lapsed client re-enter the win-back flow every time the sweep ran.',
    },
    inactivity_threshold_reached: {
      stay: true,
      why: 'Already lapsed. The sweep may report this every night and must write nothing.',
    },
    blocklisted: { to: 'blocked', why: 'A block applies whatever the record was doing.' },
    blocklist_lifted: {
      refuse: 'not_blocked',
      why: 'Nothing to lift: this record is not blocked. Answering "done" would conceal an actor acting on the wrong record.',
    },
  },
  blocked: {
    enquiry_recorded: {
      stay: true,
      why: 'The contact is recorded — a blocked person still telephones, and the record of that call is what a manager needs. The state does not move.',
    },
    booking_taken: {
      refuse: 'customer_is_blocked',
      why: 'The second fence. The booking path refuses a blocklisted contact before it reaches this reducer (0053, apps/web/app/api/v1/bookings/handler.ts); if a booking ever arrives here for a blocked record, something upstream did not check.',
    },
    treatment_completed: {
      refuse: 'customer_is_blocked',
      why: 'A completed treatment for a blocked record means the block was bypassed, and marking the record `active` would hide that.',
    },
    inactivity_warning_reached: {
      refuse: 'customer_is_blocked',
      why: 'A blocked record must not lapse. Leaving `blocked` on a timer is the block expiring at 03:00 with nobody deciding it should.',
    },
    inactivity_threshold_reached: {
      refuse: 'customer_is_blocked',
      why: 'The same fact at the later threshold, and the same reason it is refused rather than ignored: a caller that counts refusals can see the sweep skipping blocked records.',
    },
    blocklisted: {
      stay: true,
      why: 'A second entry for an already blocked record — a manager blocking the email of somebody whose phone is already blocked. Idempotent here; the ENTRY is still written and audited.',
    },
    blocklist_lifted: {
      to: 'lapsed',
      why: 'See the table note: the coldest non-blocked state, because this reducer holds no memory of what the record was before and an unblock must not reinstate `active`.',
    },
  },
} as const)

/**
 * The verdict for one (state, event) pair. Total, and never throws.
 *
 * Membership is checked against the two lists before the table is indexed, because the arguments come
 * from a database column and a caller's string in production. A value outside either union is a drift
 * between 0053's vocabulary tables and these lists, and it must not read as `undefined` — which at a call
 * site is indistinguishable from "no change needed". Checking membership also keeps `__proto__` and
 * `constructor` out: a bare index read answers those from the prototype chain, which would be a "known
 * pair" the table never declared.
 */
export function decideCustomerLifecycle(from: string, event: string): CustomerLifecycleVerdict {
  // `string` in, exactly as `decideAppointmentTransition` takes `string`: the arguments arrive from a
  // database column and a caller, and a signature that promised the union would only be moving the
  // narrowing to a cast at the call site. The guards below are the narrowing, and they answer by name.
  const known =
    (CUSTOMER_LIFECYCLE_STATES as readonly string[]).includes(from) &&
    (CUSTOMER_LIFECYCLE_EVENTS as readonly string[]).includes(event)
  const state = from as CustomerLifecycleState
  const outcome = known ? TABLE[state][event as CustomerLifecycleEvent] : undefined
  if (outcome === undefined) {
    // Deliberately a refusal and not a throw. See the module note: the sweep must be able to walk the
    // whole table, and an unknown label is a deploy-time drift rather than a reason to stop.
    return {
      kind: 'refused',
      refusal: 'unknown_lifecycle_pair',
      from,
      why:
        `"${from}" x "${event}" is not a pair this build knows. CUSTOMER_LIFECYCLE_STATES and ` +
        "CUSTOMER_LIFECYCLE_EVENTS have drifted from migration 0053's vocabulary tables.",
    }
  }
  if ('refuse' in outcome) {
    return { kind: 'refused', refusal: outcome.refuse, from, why: outcome.why }
  }
  if ('stay' in outcome) return { kind: 'unchanged', state, why: outcome.why }
  return { kind: 'moved', from: state, to: outcome.to, why: outcome.why }
}

/** The state a verdict leaves the record in. `null` for a refusal: nothing is written. */
export function lifecycleStateAfter(
  verdict: CustomerLifecycleVerdict,
): CustomerLifecycleState | null {
  if (verdict.kind === 'moved') return verdict.to
  if (verdict.kind === 'unchanged') return verdict.state
  return null
}

/**
 * The six acquisition sources, in the order 0053 seeds them.
 *
 * `unknown` is a member and it is the DEFAULT, because it is true of every record the business already
 * has: nobody recorded where those customers came from, and choosing `walk_in` for them would be this
 * build inventing a marketing attribution (brief rule 15). `whatsapp` and `phone` are separate from
 * `walk_in` because docs/13 shows the business taking bookings on all three.
 */
export const CUSTOMER_ACQUISITION_SOURCES = [
  'walk_in',
  'whatsapp',
  'phone',
  'web',
  'referral',
  'unknown',
] as const

export type CustomerAcquisitionSource = (typeof CUSTOMER_ACQUISITION_SOURCES)[number]

/** The source a record carries until somebody records a better answer. */
export const DEFAULT_ACQUISITION_SOURCE: CustomerAcquisitionSource = 'unknown'

/** The state a record is born in: it exists because somebody made contact, not because they booked. */
export const DEFAULT_LIFECYCLE_STATE: CustomerLifecycleState = 'lead'

/**
 * Both vocabularies are this build's guess, and each carries its OPEN-QUESTIONS id.
 *
 * Read by the seed in 0053, which stamps `is_provisional`, `open_question_id` and `provisional_note`
 * onto every label so the Unconfirmed Assumptions panel lists them and a settings change can clear
 * them one at a time. Stated here as well as in the migration so the two cannot disagree about which
 * question the vocabulary belongs to: `packages/fixtures/src/crm-client-record.itest.ts` compares them.
 */
export const CUSTOMER_LIFECYCLE_PROVISIONAL = Object.freeze({
  openQuestionId: 'Y9-crm-lifecycle',
  note:
    'Six states chosen by this build. No client lifecycle has been stated by the business, so the ' +
    'set is the smallest one that supports a win-back flow and a block that does not expire.',
} as const)

/** The acquisition vocabulary's own id, separate because the two can be answered separately. */
export const CUSTOMER_ACQUISITION_PROVISIONAL = Object.freeze({
  openQuestionId: 'Y9-crm-source',
  note:
    'Six sources chosen by this build from the channels docs/13 shows in use. `unknown` is the ' +
    'default so no record carries an invented attribution.',
} as const)
