'use client'

/**
 * Steps 4 and 5's client island: three fields and a submit button, and nothing else.
 *
 * Everything on this page already works with JavaScript switched off — each step is a `<form method="post">`
 * whose answer is a 303 to the next state (`app/api/v1/book/handler.ts`). So this file adds only what HTML
 * has no way to express, and each of the three is named in docs/09 §3 or in this unit's acceptance:
 *
 *   - **the phone number is normalised to E.164 on blur**, through `normalisePhoneResult` from
 *     `@berelax/core/phone` — the same function the endpoint uses, not a second one.
 *     `packages/core/src/crm/phone.ts` exists because a second normaliser is a second answer to "is this
 *     the same person", and there must not be a third. An input mask that stripped digits by itself would
 *     be exactly that, and it would disagree about `00971` on some Tuesday;
 *   - **the code field autofills** — `autocomplete="one-time-code"` is markup and the server renders it,
 *     but keeping the field to digits as they are typed is not;
 *   - **the resend cooldown counts down.** The server renders the number of seconds; without JavaScript it
 *     is a number that is right when the page was served, which is honest and static. Here it ticks, and
 *     the button enables itself when it reaches zero.
 *
 * Plus one guard that is not a convenience: **the submit button disables itself after the first click**.
 * That is not what makes double submission safe — the idempotency key is, and `createBooking` claims it on
 * a primary key before it locks a room — but "harmless" and "does not happen" are different properties,
 * and the second one is what a reader experiences when their thumb bounces.
 *
 * ## Why this is a second module and not part of the slot picker
 *
 * It could have been added to `slot-picker.client.tsx` to keep the route at one client module, and that
 * would have been the wrong reading of docs/09 §3. *"The booking flow is the one heavy client island"* is a
 * statement about the flow, not about a file: the picker is rendered only when there are times to pick, and
 * these fields only on the steps that have them, so putting both in one module would make every reader
 * download the other half. `book.itest.ts` asserts the route's client modules are exactly these two and
 * that `/treatments` names none, which is the same claim against the build with the right number in it.
 */

// The deep path, not the barrel, and it is load-bearing: `@berelax/core`'s barrel reaches
// `@berelax/shared`'s, which re-exports three zod schema modules — so importing the normaliser
// through it put zod in this client chunk, measured at 484KB before compression against docs/08
// SS8's 110KB gzip budget for a whole route. `@berelax/core/phone` is `identity/normalise-phone.ts`,
// which after B-UI-02 has no runtime dependency at all, and `apps/web/src/book/budget.ts` is the
// number that keeps it that way.
import { normalisePhoneResult } from '@berelax/core/phone'
import { useEffect, useRef, useState } from 'react'
import { RESEND_SECONDS_TOKEN } from '../../src/book/copy.ts'

/**
 * The cooldown sentence for a count.
 *
 * `replaceAll` and not `replace`: a locale may legitimately name the count twice ("another code in 12
 * seconds — 12 seconds"), and a single substitution would leave the second one as a visible placeholder.
 */
function waitingText(
  waiting: { readonly one: string; readonly many: string },
  seconds: number,
): string {
  return seconds === 1
    ? waiting.one
    : waiting.many.replaceAll(RESEND_SECONDS_TOKEN, String(seconds))
}

export interface PhoneFieldProps {
  readonly id: string
  readonly name: string
  readonly label: string
  readonly hint: string
  readonly defaultValue: string
  /** The dial code shown beside the field, from the premises' own country. Never a literal here. */
  readonly dialCode: string
  readonly countryLabel: string
}

/**
 * The phone input, normalised on blur.
 *
 * Normalised only when the one normaliser **accepts** the value. A rejected one is left exactly as typed:
 * rewriting a landline into something that looks like a mobile would hide the refusal the reader is about
 * to be given, and blanking the field would throw away what they typed. The server refuses it by name
 * either way (`phone_not_eligible`).
 *
 * `type="tel"` with `inputMode="tel"`, which is two statements and both are needed: the type summons the
 * telephone keypad on iOS and the input mode is what Android reads. `autoComplete="tel"` so the browser
 * offers the number it already knows, which is the difference between four taps and twelve on a phone.
 */
export function PhoneField({
  id,
  name,
  label,
  hint,
  defaultValue,
  dialCode,
  countryLabel,
}: PhoneFieldProps) {
  const [value, setValue] = useState(defaultValue)
  return (
    <>
      <label className="be-book__note" htmlFor={id}>
        {label}
      </label>
      <div className="be-book__phone">
        {/* The country, as text and not a select: this business takes bookings in one country, and a
            selector with one option is a control that costs a tap and answers nothing. It is `aria-hidden`
            because the number in the field carries its own prefix once normalised, so a screen reader
            would otherwise read the code twice. */}
        <span className="be-book__dial" aria-hidden="true" title={countryLabel}>
          {dialCode}
        </span>
        <input
          id={id}
          className="be-book__input"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          name={name}
          value={value}
          required
          maxLength={32}
          aria-describedby={`${id}-hint`}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => {
            const normalised = normalisePhoneResult(value)
            if (normalised.ok) setValue(normalised.e164)
          }}
        />
      </div>
      <p className="be-book__note" id={`${id}-hint`}>
        {hint}
      </p>
    </>
  )
}

export interface OtpFieldProps {
  readonly id: string
  readonly name: string
  readonly label: string
  readonly hint: string
  readonly digits: number
}

/**
 * The code input.
 *
 * `autoComplete="one-time-code"` is what makes iOS and Android offer the code from the SMS itself, and it
 * is the single highest-value attribute on this page: without it a reader switches app, reads six digits,
 * switches back and types them. `inputMode="numeric"` summons the number pad. Both are rendered by the
 * SERVER too — they are markup — and this component exists for the third thing, which is not: non-digits
 * are dropped as they are typed, so a reader who pastes `Your code is 123456` submits `123456`.
 *
 * Deliberately NOT auto-submitting on the sixth digit. An autofilled code that submits itself takes the
 * decision away at the moment a reader is checking they have the right message, and a wrong guess spends
 * one of five attempts before they have looked at it.
 */
export function OtpField({ id, name, label, hint, digits }: OtpFieldProps) {
  const [value, setValue] = useState('')
  return (
    <>
      <label className="be-book__note" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="be-book__input be-book__input--code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        // `[0-9]*` rather than `\d{6}`: the length is enforced by `maxLength` and by the server, and a
        // pattern that also asserted the length would block a partially typed value from being submitted
        // at all — which on a browser that honours it means the form silently does nothing.
        pattern="[0-9]*"
        name={name}
        value={value}
        required
        maxLength={digits}
        aria-describedby={`${id}-hint`}
        onChange={(event) => setValue(event.target.value.replace(/\D/g, '').slice(0, digits))}
      />
      <p className="be-book__note" id={`${id}-hint`}>
        {hint}
      </p>
    </>
  )
}

export interface ResendButtonProps {
  readonly label: string
  /**
   * The cooldown sentence, rendered by the server for one second and for many.
   *
   * Two finished strings rather than a copy function, because Next refuses a function passed to a client
   * component — and is right to: a closure cannot be serialised across the boundary. The plural rule and
   * the word order therefore stay in `src/book/copy-*.ts` where every other sentence on this page lives,
   * and the only thing that happens in the browser is a substitution of
   * {@link RESEND_SECONDS_TOKEN}.
   */
  readonly waiting: { readonly one: string; readonly many: string }
  /** Seconds remaining when the page was served. Zero means a resend is available now. */
  readonly initialSeconds: number
}

/**
 * The resend button, with the cooldown ticking.
 *
 * The server renders the remaining seconds and the disabled state, so a reader with no JavaScript sees a
 * correct number and a button that the endpoint would refuse anyway — the cooldown is enforced by
 * `readOtpResendWindow`'s two clocks in `packages/db`, not by this component. What this adds is that the
 * number goes down and the button enables itself, instead of a reader reloading the page to find out.
 *
 * One second per tick and `setInterval` rather than a per-second `setTimeout` chain, and it is cleared on
 * unmount: an interval left running after a navigation is a timer holding a reference to a dead tree, and
 * on this page it would fire for the whole of a booking.
 */
export function ResendButton({ label, waiting, initialSeconds }: ResendButtonProps) {
  const [seconds, setSeconds] = useState(initialSeconds)
  useEffect(() => {
    if (seconds <= 0) return
    const timer = setInterval(() => {
      setSeconds((remaining) => (remaining <= 1 ? 0 : remaining - 1))
    }, 1000)
    return () => clearInterval(timer)
  }, [seconds])
  return (
    <button
      className="be-action be-action--quiet"
      type="submit"
      name="action"
      value="resend_code"
      disabled={seconds > 0}
      data-resend-seconds={seconds}
    >
      {seconds > 0 ? waitingText(waiting, seconds) : label}
    </button>
  )
}

export interface SubmitOnceProps {
  readonly label: string
  /** What the button says once it has been pressed. Never a spinner with no words. */
  readonly busyLabel: string
  readonly action: string
}

/**
 * A submit button that can be pressed once.
 *
 * The guard is on the **form's submit event**, not on the button's click, and that is the whole of the
 * correctness here. Disabling a submit button from inside its own `click` handler cancels the submission
 * it was supposed to start: React flushes state in a discrete event synchronously, so the button is
 * `disabled` by the time the browser gets to the default action, and a browser does not submit a form from
 * a disabled submitter. The first version of this component did exactly that and the form did nothing at
 * all — a failure that looks like a routing bug.
 *
 * So: the first `submit` is allowed through untouched, the second is prevented, and the label changes in a
 * macrotask once the navigation is already under way. `useRef` rather than state for the flag, because it
 * is read inside the listener and a state update has not landed yet when a double tap's second event
 * arrives one frame later.
 *
 * None of this is what makes double submission SAFE — the idempotency key is, and `createBooking` claims it
 * on a primary key before it locks a room. It is what makes it not happen, which is a different property
 * and the one a reader experiences.
 */
export function SubmitOnce({ label, busyLabel, action }: SubmitOnceProps) {
  const pressed = useRef(false)
  const button = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const form = button.current?.form
    if (form === null || form === undefined) return
    const onSubmit = (event: Event): void => {
      if (pressed.current) {
        event.preventDefault()
        return
      }
      pressed.current = true
      // A macrotask, so the browser has already begun the submission this event belongs to. Disabling
      // synchronously here would abort it, exactly as disabling in `click` does.
      setTimeout(() => setBusy(true), 0)
    }
    form.addEventListener('submit', onSubmit)
    return () => form.removeEventListener('submit', onSubmit)
  }, [])
  return (
    <button
      ref={button}
      className="be-action"
      type="submit"
      name="action"
      value={action}
      disabled={busy}
      data-submit-once={action}
    >
      {busy ? busyLabel : label}
    </button>
  )
}
