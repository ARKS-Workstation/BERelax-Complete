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

import type { WaitlistIneligibility } from '@berelax/db'
import type { SlotGroupName } from './state.ts'

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
}
