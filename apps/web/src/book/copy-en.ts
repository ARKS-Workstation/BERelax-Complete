/**
 * `/book` in English.
 *
 * Two things in here are decisions rather than wording, and both are recorded where the string is:
 *
 * **The gender question is explained, not asked bare.** `booking.same_gender_matching` is strict by
 * default (B-AVAIL-05) and `queryAvailability` refuses with `requires_client_gender` when nothing was
 * collected — so the page cannot show a single time until it has been answered. A bare "Gender" select on a
 * public booking form reads as data collection; the note says what it is for, which is the only thing that
 * makes it answerable.
 *
 * **No therapist is named.** ADR 0020: a therapist has no display name until an admin sets one and records
 * a photography consent, and none of the nineteen has either. So the list offers "any available therapist"
 * and says why there is nothing else in it, rather than nineteen options all reading the same words.
 */

import type { BookCopy } from './copy.ts'

export const BOOK_COPY_EN: BookCopy = {
  title: 'Book a treatment',
  lede:
    'Choose a treatment, then a day and a time. Nothing is confirmed until the last step, and no ' +
    'account is needed.',

  choose: {
    treatmentLegend: 'Treatment and length',
    treatmentLabel: 'Treatment',
    treatmentPlaceholder: 'Choose a treatment',
    variantOption: (name, minutes, amount) => `${name} — ${minutes} minutes — AED ${amount}`,
    genderLegend: 'Who the treatment is for',
    genderLabel: 'Client',
    genderNote:
      'Treatments are delivered by a therapist of the same gender, so the times we can offer depend ' +
      'on this answer. It is used to work out availability and is not kept after the booking.',
    genderPlaceholder: 'Choose one',
    female: 'A woman',
    male: 'A man',
    therapistLegend: 'Therapist',
    anyTherapist: 'Any available therapist',
    unnamedTherapist: 'Name not yet published',
    noPublishedTherapists:
      'No therapist has a published profile yet, so there is nobody to pick by name. Every treatment ' +
      'is delivered by a therapist qualified for it.',
    chosenTherapist: (label) => `You asked for ${label}.`,
    clearTherapist: 'Any therapist instead',
    submit: 'Show times',
  },

  picker: {
    daysLabel: 'Days',
    timesLabel: (day) => `Start times on ${day}`,
    groups: { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' },
    groupLabel: (group, day) => `${group} start times on ${day}`,
    slotLabel: (time, day, minutes) => `${time} on ${day}, ${minutes} minutes`,
    announceDay: (day) => `Showing times for ${day}.`,
    heading: (day) => `Times on ${day}`,
    count: (count) => (count === 1 ? '1 time free' : `${count} times free`),
  },

  chosen: {
    heading: 'Your choice',
    summary: (time, day, treatment) => `${treatment} at ${time} on ${day}.`,
    next:
      'The next step takes your phone number and sends a code to confirm it. It is not built yet, so ' +
      'nothing has been reserved by choosing a time here.',
    callInstead: (phone) => `Call the desk on ${phone}`,
  },

  needs: {
    treatment: 'Choose a treatment and a length, and the times we can offer will appear here.',
    gender:
      'Tell us who the treatment is for, and the times a same-gender therapist can offer will appear ' +
      'here.',
    noTradingDays:
      'There is no day on the calendar we can take a booking for yet. Please call the desk.',
    noTreatments: 'Nothing on the menu is bookable online at the moment. Please call the desk.',
  },

  none: {
    heading: (day) => `Nothing free on ${day}`,
    lede: 'Every start on that day is taken. Here is what is still open.',
    nearestHeading: 'The nearest days with space',
    nearestEmpty: 'No day within a week of that one has space for this treatment.',
    nearestDay: (day, count, time) =>
      `${day} — ${count === 1 ? '1 time' : `${count} times`} free, from ${time}`,
    therapistsHeading: 'The same treatment with another therapist',
    therapistsEmpty:
      'The day is full for every therapist, not only the one you asked for — so there is nobody else ' +
      'to offer on it.',
    therapistOption: (label, count, time) =>
      `${label} — ${count === 1 ? '1 time' : `${count} times`} free, from ${time}`,
    waitlistHeading: 'Wait for a cancellation',
    waitlistLede:
      'Cancellations happen. Join the list for this day and we will text you if a start opens up.',
    waitlistCta: 'Join the waiting list',
    waitlistReasons: {
      not_a_trading_date: 'The spa is closed that day, so there is nothing to wait for.',
      variant_not_found: 'That treatment is no longer on the menu.',
      shape_not_offered: 'That treatment is not offered in the form you asked for.',
      no_compatible_room_type: 'No room here can take that treatment.',
      requires_client_gender: 'Tell us who the treatment is for first.',
      slots_are_available: 'That day still has space, so there is nothing to wait for.',
    },
    waitlistAlready: 'You are already on the list for this day.',
  },

  waitlistStep: {
    heading: 'Wait for a cancellation',
    lede:
      'We need a phone number to text you on. The step that collects it is not built yet, so nothing ' +
      'has been added to the list — the desk can add you now by phone.',
    back: 'Back to the times',
  },
}
