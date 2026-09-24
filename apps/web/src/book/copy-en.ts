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
      'Nothing is reserved yet. The next step takes your phone number and texts you a code to confirm ' +
      'it, and then you choose whether to book.',
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
      'We need a phone number to text you on. Confirm one below and we will add you to the list for ' +
      'this day.',
    back: 'Back to the times',
  },

  details: {
    heading: 'Your phone number',
    lede:
      'We text you a code to confirm the number, then show you what you are about to book. No account ' +
      'and no password.',
    phoneLabel: 'Mobile number',
    // No example number. A plausible-looking one is a number somebody owns, and a reader who copies it
    // sends our code to a stranger (brief rule 15, and the same reason the fixtures use an unallocated
    // prefix). The hint says what the field accepts instead.
    phoneHint: 'A UAE mobile, written any way you like. We will tidy it up.',
    countryLabel: 'Country',
    why:
      'The number is how we recognise you, how we text the confirmation, and how the desk reaches you ' +
      'if anything changes. It is not used for marketing unless you ask for that on the next step.',
    submit: 'Text me a code',
    back: 'Back to the times',
  },

  otp: {
    heading: 'Enter the code',
    lede: (phone) => `We sent a code to ${phone}.`,
    codeLabel: 'Code',
    codeHint: (digits) => `${digits} digits, from the text message.`,
    submit: 'Confirm the number',
    resend: 'Send another code',
    resendIn: (seconds) =>
      seconds === '1' ? 'Another code in 1 second' : `Another code in ${seconds} seconds`,
    notArrived: 'The code has not arrived',
    changeNumber: 'Use a different number',
  },

  confirm: {
    heading: 'Confirm your booking',
    summary: (time, day, treatment, minutes) =>
      `${treatment}, ${minutes} minutes, at ${time} on ${day}.`,
    priceLine: (amount) => `AED ${amount}, including VAT.`,
    phoneLine: (phone) => `Confirmed number: ${phone}`,
    submit: 'Book this time',
    back: 'Change the time',
    consentHeading: 'Offers and news',
    consentLede:
      'Optional, and nothing here affects your booking. Leave it unticked and we will only text you ' +
      'about this appointment.',
    consentVersion: (purpose, version) => `${purpose} — wording version ${version}`,
    consentUnavailable:
      'We have no approved wording for this yet, so we are not asking. You can opt in later at the desk.',
    checkInstead: 'Not sure whether it went through?',
  },

  booked: {
    heading: 'Booked',
    lede: 'We have texted you a confirmation. Please arrive ten minutes before your time.',
    reference: (id) => `Reference ${id}`,
    summary: (time, day) => `${time} on ${day}.`,
    addToCalendar: 'Add to calendar',
    calendarNote:
      'The calendar entry says only the time and the place. Anything more would show on a lock screen ' +
      'to whoever is holding your phone.',
    manageHeading: 'Changing or cancelling',
    manageLede:
      'The self-service page is not built yet, so a change goes through the desk. Quote the reference ' +
      'above and we will move it.',
    bookAnother: 'Book another treatment',
  },

  waitlistJoin: {
    heading: 'Join the waiting list',
    lede: (day) =>
      `We will text you if a start opens up on ${day}. Joining reserves nothing and costs nothing.`,
    submit: 'Add me to the list',
    back: 'Back to the times',
  },

  waitlisted: {
    heading: 'You are on the list',
    lede: (day) =>
      `If a start opens up on ${day} we will text you. You are free to book another day in the ` +
      'meantime — joining the list holds nothing.',
    back: 'Back to the times',
  },

  edge: {
    slot_taken: {
      heading: 'That time has gone',
      body:
        'Somebody booked it while you were deciding. Nothing has been charged and nothing has been ' +
        'reserved. The times below are the ones still open.',
      action: 'Choose another time',
    },
    otp_not_arrived: {
      heading: 'The code has not arrived',
      body:
        'A text can take a minute, and it will not arrive at all if the number has a digit wrong. You ' +
        'can send another code, correct the number, or let the desk take the booking over the phone.',
      action: 'Use a different number',
    },
    network_drop: {
      heading: 'We do not know whether that went through',
      body:
        'Your connection dropped while the booking was being taken, so it may or may not exist. Check ' +
        'rather than book again — the check is safe, and booking again is what produces two ' +
        'appointments for one evening.',
      action: 'Check whether it went through',
    },
    double_submission: {
      heading: 'Already booked',
      body:
        'That was the same booking arriving twice — the second one did nothing. You have one ' +
        'appointment, and this is it.',
      action: null,
    },
    therapist_became_unavailable: {
      heading: 'That therapist is no longer free',
      body:
        'Their shift changed after you chose. The time itself may still be available with somebody ' +
        'else, and every therapist here is qualified for this treatment.',
      action: 'Any available therapist',
    },
    required_room_taken: {
      heading: 'The room this treatment needs is taken',
      body:
        'This treatment can only be delivered in a particular room, and it is now booked for that ' +
        'time. Another therapist will not help — another time or another day will.',
      action: 'Choose another time',
    },
    duration_no_longer_fits: {
      heading: 'That treatment no longer finishes before we close',
      body:
        'The closing time for that day changed after you chose, and this treatment would run past it. ' +
        'An earlier start on the same day, or a shorter treatment, will fit.',
      action: 'Choose an earlier time',
    },
    session_expired: {
      heading: 'Your confirmed number has expired',
      body:
        'We only keep a confirmed number for a few minutes. Nothing was booked and nothing was ' +
        'charged. Confirm the number again and your choice of time is still here.',
      action: 'Confirm the number again',
    },
    back_after_confirm: {
      heading: 'This booking is already made',
      body:
        'You came back to the form after booking. Filling it in again would take a second appointment, ' +
        'so here is the one you have.',
      action: null,
    },
  },

  flowErrors: {
    already_booked: 'That booking was already made — this is it, and nothing was taken twice.',
    phone_not_eligible:
      'That does not look like a mobile number that can receive a text. A landline cannot, so the code ' +
      'would never arrive.',
    wrong_code: 'That code is not right. Check the message and try again.',
    code_expired: 'That code has expired. Send another one.',
    no_live_challenge: 'There is no code waiting to be used. Send a new one.',
    locked:
      'Too many wrong codes, so this number is locked for a short while. The desk can take the booking ' +
      'by phone in the meantime.',
    rate_limited: 'You have asked for several codes. Please wait before asking for another.',
    send_failed: 'The text could not be sent. That is us, not you — try again, or call the desk.',
    nothing_chosen: 'Choose a treatment, a day and a time first.',
    not_available: 'That time is not available any more.',
    waitlist_unavailable: 'The waiting list is not open for that day.',
    invalid_request: 'Something in that submission could not be read. Please try again.',
  },

  noJs: {
    heading: 'JavaScript is switched off',
    body:
      'Every step here still works: each button is a form the server answers. What is missing is the ' +
      'small conveniences — the number is tidied up when you submit rather than as you leave the field, ' +
      'and the wait before another code can be sent is a number rather than a countdown.',
  },
}
