/**
 * C-AUTO-01 — "the send call cannot carry a class", as a claim about the TYPES rather than about a call.
 *
 * The acceptance line is: *"The send call cannot carry a class: a type-level test asserts no exported
 * send API accepts a messageClass argument, and a known-bad fixture adding one fails typecheck."* This
 * file is the first half; case 78 in `scripts/test-gates.mjs` writes the fixture and asserts `tsc`
 * rejects it, because a type-level assertion that has never been seen to fail may not be one (ADR 0003).
 *
 * ## Why `?: never` and not simply leaving the field out
 *
 * An absent field is already refused for an object **literal**, by TypeScript's excess-property check.
 * It is NOT refused for a variable:
 *
 *     const request = { ...base, messageClass: 'promotional' }   // inferred, wider
 *     await sendMessage(ctx, request)                            // compiled. No error.
 *
 * Assignability, unlike the excess-property check, permits extra keys. So the two-line spelling of the
 * mistake compiled while the one-line spelling did not — and a flow builder, which is where docs/03 §5
 * says somebody will try, assembles its request exactly the two-line way. Declaring `messageClass?:
 * never` makes the property's only inhabitant `undefined`, so any object carrying a real value for it is
 * unassignable however it was built. Both spellings are probed below.
 *
 * ## Why the list of send APIs is derived from the barrel and not written down
 *
 * "No exported send API accepts a messageClass argument" is a claim about ALL of them, and a hand-written
 * list is a claim about the ones somebody remembered. So the exported names are read out of the barrel at
 * runtime, filtered to the send entry points, and compared with the list this file probes. A third send
 * function added to `@berelax/messaging` fails this test until somebody probes it.
 */
import { describe, expect, it } from 'vitest'
import * as barrel from './index.ts'
import type { RecordedSendRequest } from './lifecycle.ts'
import type { MessageId } from './port.ts'
import type { ClassifiedTemplate, SendRequest } from './send.ts'

const TEMPLATE: ClassifiedTemplate = {
  key: 'cauto01.shape',
  messageClass: 'transactional',
  approvalState: 'approved',
  channel: 'sms',
  locale: 'en',
  body: 'Booking confirmed.',
  variables: [],
}

const BASE: SendRequest = {
  id: 'cauto01-shape-1' as MessageId,
  template: TEMPLATE,
  values: {},
  recipient: '+971528239069',
}

const RECORDED: RecordedSendRequest = {
  ...BASE,
  templateId: '00000000-0000-7000-8000-00000000c101',
}

/**
 * True when `T` has a routing property somebody could actually supply a value for.
 *
 * `undefined` on its own is not "accepting an argument": `messageClass?: never` leaves the key present
 * and its only inhabitant `undefined`, which is the fence. A key that admits `'promotional'` is the hole.
 */
type AcceptsRouting<T, K extends string> = K extends keyof T
  ? [T[K]] extends [undefined]
    ? false
    : true
  : false

// The type-level assertions themselves. `satisfies false` is checked by `tsc` and by nothing else, which
// is exactly why case 78 exists to watch it fail.
const SEND_REQUEST_ACCEPTS_CLASS = false satisfies AcceptsRouting<SendRequest, 'messageClass'>
const SEND_REQUEST_ACCEPTS_SENDER = false satisfies AcceptsRouting<SendRequest, 'senderId'>
const SEND_REQUEST_ACCEPTS_CHANNEL = false satisfies AcceptsRouting<SendRequest, 'channel'>
const RECORDED_ACCEPTS_CLASS = false satisfies AcceptsRouting<RecordedSendRequest, 'messageClass'>
const RECORDED_ACCEPTS_SENDER = false satisfies AcceptsRouting<RecordedSendRequest, 'senderId'>

/** The send entry points this file probes. Compared with the barrel below rather than trusted. */
const PROBED_SEND_APIS = ['sendMessage', 'deliverMessage'] as const

describe('no exported send API accepts a routing argument', () => {
  it('probes every send entry point the barrel exports', () => {
    // `send`/`deliver` followed by a CAPITAL, so `senderIdFor` and `senderIdRegistryFault` — which are
    // lookups over the registry and not send calls — are not swept in. Naming is the only signal the
    // barrel offers at runtime, so the rule is stated here rather than inferred loosely.
    const exported = Object.keys(barrel)
      .filter((name) => /^(?:send|deliver)[A-Z]/.test(name))
      .sort()
    // A third send function added to the package fails here until it is probed, which is what makes
    // "no exported send API" a claim about all of them rather than about the two somebody recalled.
    expect(exported).toEqual([...PROBED_SEND_APIS].sort())
  })

  it('refuses a class, a sender identity and a channel on SendRequest', () => {
    expect(SEND_REQUEST_ACCEPTS_CLASS).toBe(false)
    expect(SEND_REQUEST_ACCEPTS_SENDER).toBe(false)
    expect(SEND_REQUEST_ACCEPTS_CHANNEL).toBe(false)
  })

  it('refuses them on the recorded request deliverMessage takes, too', () => {
    // `RecordedSendRequest extends SendRequest`, so this would follow — except that "it extends it" is
    // the kind of thing a refactor quietly changes, and `deliverMessage` is the API a worker calls.
    expect(RECORDED_ACCEPTS_CLASS).toBe(false)
    expect(RECORDED_ACCEPTS_SENDER).toBe(false)
  })

  it('rejects both spellings of the override, as a literal and through a variable', () => {
    // @ts-expect-error — the literal spelling. Refused by the excess-property check even without the
    // fence, and probed so the fence's removal is not the only thing this file would notice.
    const literal: SendRequest = { ...BASE, messageClass: 'promotional' }

    // The variable spelling, which is the one that used to compile. `asWritten` is deliberately given
    // no annotation, so its type is inferred wide exactly as a flow builder's assembled object would be.
    const asWritten = { ...BASE, messageClass: 'promotional' as const }
    // @ts-expect-error — and it is unassignable, because `messageClass?: never` admits only undefined.
    const viaVariable: SendRequest = asWritten

    // @ts-expect-error — a sender identity on the call is the hole this unit exists to close.
    const withSenderId: SendRequest = { ...BASE, senderId: 'AD-BERELAX' }

    // @ts-expect-error — and a channel, which would let a caller send an SMS body down WhatsApp.
    const withChannel: SendRequest = { ...BASE, channel: 'whatsapp' }

    // @ts-expect-error — the same fence on the recorded request.
    const recorded: RecordedSendRequest = { ...RECORDED, messageClass: 'promotional' }

    // Read, so nothing above is removed as dead code by a future tidy-up.
    expect(
      [literal, viaVariable, withSenderId, withChannel, recorded].every((r) => r.id === BASE.id),
    ).toBe(true)
  })

  it('still accepts a legitimate request, so the fences are not refusing everything', () => {
    // The control. Five `@ts-expect-error`s and no positive case would be satisfied by a `SendRequest`
    // that nothing at all is assignable to — and `@ts-expect-error` would then report the errors it
    // wanted, on a type nobody could construct.
    const legitimate: SendRequest = { ...BASE }
    expect(legitimate.template.messageClass).toBe('transactional')
    // The class is readable FROM the template, which is where it lives. Fencing it off the request is
    // not hiding it; it is refusing to let a call site restate it.
    expect(TEMPLATE.messageClass).toBe('transactional')
  })
})
