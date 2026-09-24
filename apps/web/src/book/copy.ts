/**
 * The shape of `/book`'s copy, and the labels that are a function of data rather than a string.
 *
 * One interface, two implementations, the same arrangement `src/cms/content.ts` has: the structure of the
 * page is one thing and the language of it is another, and a second copy of the page for Arabic would be a
 * second place every layout decision could drift — with the RTL half of every assertion then testing a
 * different component from the LTR half.
 *
 * Every label that interpolates a value is a **function**, not a template the caller fills. A duration, a
 * count, a date and a therapist reference each carry a plural rule and a word order that differ between the
 * two languages, and a page that concatenated them would read correctly in one of the two.
 */

import type { BookingEdgeState } from '@berelax/core'
import type { WaitlistIneligibility } from '@berelax/db'
import type { BookFlowError, SlotGroupName } from './state.ts'

/**
 * The placeholder a cooldown sentence carries in place of a count.
 *
 * Declared here rather than in `./flow.ts`, and that is load-bearing: the island imports it, and
 * `flow.ts` imports `node:crypto` for the idempotency key. This module's every import is `import type`, so
 * it compiles to nothing and costs a browser bundle nothing.
 */
export const RESEND_SECONDS_TOKEN = '{seconds}'

/** The part of a day, in this locale. Total over the group names, so a fourth one needs copy to compile. */
export type SlotGroupLabels = Readonly<Record<SlotGroupName, string>>

/**
 * Why a waitlist join is not on offer, in this locale.
 *
 * Total over `WAITLIST_INELIGIBILITY`, which is what makes a reason added to `@berelax/db` a type error
 * here rather than a blank space on the page. `slots_are_available` is in the list and is not a refusal:
 * a day with space is not a day to wait for, and the copy says so instead of hiding the region.
 */
export type WaitlistReasonLabels = Readonly<Record<WaitlistIneligibility, string>>

export interface BookCopy {
  /** The document title's own heading. */
  readonly title: string
  readonly lede: string

  readonly choose: {
    /** The legend of the first fieldset: treatment and duration. */
    readonly treatmentLegend: string
    readonly treatmentLabel: string
    /** The one option that is not a treatment: nothing chosen yet. */
    readonly treatmentPlaceholder: string
    /** `Normal Massage (Asian) — 60 minutes — AED 200.00`, assembled per locale. */
    readonly variantOption: (name: string, minutes: number, amount: string) => string
    readonly genderLegend: string
    readonly genderLabel: string
    /** Why the question is asked at all. Never omitted: an unexplained gender question is worse. */
    readonly genderNote: string
    readonly genderPlaceholder: string
    readonly female: string
    readonly male: string
    readonly therapistLegend: string
    /** The default: the house assigns a qualified therapist. */
    readonly anyTherapist: string
    /** What a therapist with no published name is called. Never a placeholder to fill in later. */
    readonly unnamedTherapist: string
    /** Why no therapist can be offered by name yet, said plainly rather than left as an empty list. */
    readonly noPublishedTherapists: string
    /** The therapist a reader arrived with, as a summary line. */
    readonly chosenTherapist: (label: string) => string
    readonly clearTherapist: string
    readonly submit: string
  }

  readonly picker: {
    /** The accessible name of the day strip. */
    readonly daysLabel: string
    /** The accessible name of the whole slot listbox, naming the day it is about. */
    readonly timesLabel: (day: string) => string
    readonly groups: SlotGroupLabels
    /** The accessible name of one group's grid. */
    readonly groupLabel: (group: string, day: string) => string
    /** A slot's accessible name: the time, the day and the duration in one sentence. */
    readonly slotLabel: (time: string, day: string, minutes: number) => string
    /** What the live region announces when the day changes. */
    readonly announceDay: (day: string) => string
    /** The heading above the times, naming the day. */
    readonly heading: (day: string) => string
    /** How many times are free, so the heading is not the only signal. */
    readonly count: (count: number) => string
  }

  readonly chosen: {
    readonly heading: string
    readonly summary: (time: string, day: string, treatment: string) => string
    /** What happens next, and what is not built yet. Never a dead button. */
    readonly next: string
    readonly callInstead: (phone: string) => string
  }

  readonly needs: {
    /** No treatment chosen yet: the page's own first step, as a designed state. */
    readonly treatment: string
    /** Strict same-gender matching, and nothing has been said yet. */
    readonly gender: string
    /** The premises trades on no date this page can offer. */
    readonly noTradingDays: string
    /** The catalogue publishes nothing bookable. */
    readonly noTreatments: string
  }

  readonly none: {
    readonly heading: (day: string) => string
    readonly lede: string
    readonly nearestHeading: string
    readonly nearestEmpty: string
    /** `Thursday 24 September — 6 times free, from 19:45`. */
    readonly nearestDay: (day: string, count: number, time: string) => string
    readonly therapistsHeading: string
    readonly therapistsEmpty: string
    readonly therapistOption: (label: string, count: number, time: string) => string
    readonly waitlistHeading: string
    readonly waitlistLede: string
    readonly waitlistCta: string
    readonly waitlistReasons: WaitlistReasonLabels
    readonly waitlistAlready: string
  }

  readonly waitlistStep: {
    readonly heading: string
    readonly lede: string
    readonly back: string
  }

  /** Step 4a: the phone number. */
  readonly details: {
    readonly heading: string
    readonly lede: string
    readonly phoneLabel: string
    /** What a reader may type. Never a made-up example number — see {@link BookCopy.details.phoneHint}. */
    readonly phoneHint: string
    readonly countryLabel: string
    /** Why a number is needed at all, said before it is asked for. */
    readonly why: string
    readonly submit: string
    readonly back: string
  }

  /** Step 4b: the code. */
  readonly otp: {
    readonly heading: string
    /** Names the number the code went to, so a mistyped digit is visible before six more are typed. */
    readonly lede: (phone: string) => string
    readonly codeLabel: string
    readonly codeHint: (digits: number) => string
    readonly submit: string
    readonly resend: string
    /**
     * The cooldown, as a sentence, for a **string** number of seconds.
     *
     * A string rather than a number, so the caller may pass either a real count or
     * {@link RESEND_SECONDS_TOKEN}. That is what lets the island tick the number down without a copy
     * function crossing the client boundary — Next refuses a function passed to a client component, and it
     * is right to: a closure cannot be serialised. The plural rule and the word order stay here, which is
     * the whole point of this file; only the substitution happens in the browser.
     */
    readonly resendIn: (seconds: string) => string
    /** The way out when the message does not arrive, which docs/09 §3 asks for by name. */
    readonly notArrived: string
    /** A way back to the number itself, for the reader who mistyped a digit rather than missed a message. */
    readonly changeNumber: string
  }

  /** Step 5: what is about to be booked, and the consent question. */
  readonly confirm: {
    readonly heading: string
    readonly summary: (time: string, day: string, treatment: string, minutes: number) => string
    readonly priceLine: (amount: string) => string
    readonly phoneLine: (phone: string) => string
    readonly submit: string
    readonly back: string
    readonly consentHeading: string
    /** Says what ticking the box does and what leaving it does not. */
    readonly consentLede: string
    /** The version a grant is recorded under, shown because the record names it. */
    readonly consentVersion: (purpose: string, version: number) => string
    /** Said when a purpose has no published wording, so the box is absent rather than unexplained. */
    readonly consentUnavailable: string
    /** The recovery link for a submission whose outcome the browser never learned. */
    readonly checkInstead: string
  }

  /** The confirmation. */
  readonly booked: {
    readonly heading: string
    readonly lede: string
    readonly reference: (id: string) => string
    readonly summary: (time: string, day: string) => string
    readonly addToCalendar: string
    /** Why the calendar entry says so little. docs/06 D2, stated rather than left to look like a bug. */
    readonly calendarNote: string
    readonly manageHeading: string
    /** What a reader does to change the booking while the manage page does not exist. */
    readonly manageLede: string
    readonly bookAnother: string
  }

  /** The waitlist join, which B-UI-01 deferred here. */
  readonly waitlistJoin: {
    readonly heading: string
    readonly lede: (day: string) => string
    readonly submit: string
    readonly back: string
  }

  readonly waitlisted: {
    readonly heading: string
    readonly lede: (day: string) => string
    readonly back: string
  }

  /**
   * The nine edge states docs/09 §3 enumerates, each with a heading, a sentence and a way forward.
   *
   * Total over `BookingEdgeState`, which is what makes a tenth state added in `@berelax/core` a
   * compilation failure here rather than a designed panel with no words in it. `action` is the label of
   * the control the page offers; `null` where the only remedy is the desk telephone, and that is a
   * decision per state rather than a fallback — a "try again" button on a booking that already exists is
   * an invitation to take a second slot.
   */
  readonly edge: Readonly<
    Record<
      BookingEdgeState,
      { readonly heading: string; readonly body: string; readonly action: string | null }
    >
  >

  /**
   * What the last submission did wrong, in this locale.
   *
   * Total over `BOOK_FLOW_ERRORS`. Distinct from {@link BookCopy.edge} for the reason `flow.ts` gives: an
   * edge state is the situation a reader is in, and these are what one submission got wrong.
   */
  readonly flowErrors: Readonly<Record<BookFlowError, string>>

  /**
   * What a reader with JavaScript switched off is told, on the one step that has a reason to say anything.
   *
   * Steps 4 and 5 work without JavaScript — every one of them is a POST that answers 303 — so this is not
   * an apology for a blank screen. It says which conveniences are absent and gives the desk number, which
   * is what docs/09 §3's *"a visible path when the message does not arrive"* amounts to for a reader whose
   * browser will not run the cooldown timer.
   */
  readonly noJs: {
    readonly heading: string
    readonly body: string
  }
}
