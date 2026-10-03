import { type AppEnv, parseConfig } from '@berelax/config'
import { fixedClock } from '@berelax/core'
import {
  AppError,
  STAFF_NOTIFICATION_CLASS_REFUSAL,
  STAFF_NOTIFICATION_TEMPLATE_KEY_LIST,
  STAFF_NOTIFICATION_TEMPLATE_KEYS,
} from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { TDRA_PROMOTIONAL_WINDOW } from './gate/index.ts'
import type { DeliveryDeps } from './lifecycle.ts'
import { createInMemoryMessageStore } from './lifecycle-memory.ts'
import { InMemoryOutbox } from './outbox.ts'
import type { MessageId } from './port.ts'
import type { ClassRoutedTransport, SendContext, TransportRequest } from './send.ts'
import { PROMOTIONAL_SENDER_PREFIX, PROVISIONAL_SENDER_IDS } from './sender-identity.ts'
import { assertStaffNotificationClass, deliverStaffNotification } from './staff-notification.ts'
import { DEFAULT_TEMPLATES } from './templates.ts'

/**
 * P-HR-14 — the staff notification route.
 *
 * Four claims, each with the control that must fail:
 *
 *   1. **Every declared staff notification is transactional.** The control is that the corpus contains a
 *      promotional template at all (`review.request`), so "all transactional" is not satisfied by a
 *      corpus with one class in it.
 *   2. **The AD- promotional identity cannot carry one.** Asserted through `resolveSenderIdentity`, which
 *      is the total table the choke point uses, with the control that a promotional message DOES resolve
 *      to it — otherwise the claim would be satisfied by a registry that resolved nothing.
 *   3. **Quiet hours do not suppress one.** A send at 23:30 Dubai, which is outside TDRA's 07:00–21:00
 *      window, reaches the transport. The control is the same send with a promotional class, which is
 *      queued — so the window is alive and the exemption is the class's.
 *   4. **A promotional class on the SAME ROUTE is refused.** By name, through
 *      `deliverStaffNotification`, with a transactional one succeeding beside it.
 */

const RECIPIENT = '+971500000001'
/** 23:30 Dubai on a Tuesday: outside TDRA's 07:00-21:00 window by two and a half hours. */
const LATE_NIGHT_ISO = '2026-09-22T19:30:00.000Z'

const STAFF_SMS = DEFAULT_TEMPLATES.filter(
  (template) =>
    STAFF_NOTIFICATION_TEMPLATE_KEY_LIST.includes(template.key) && template.channel === 'sms',
)

/**
 * A runtime with the real in-memory store, so nothing here is a second implementation of the port.
 *
 * `evaluators` is the one knob. `fail_closed` is what every runtime in this repository actually wires —
 * the three consent, suppression and frequency evaluators THROW, because no store exists yet — and it is
 * the right default here precisely because a staff notice must never reach one: the gate returns `allow`
 * on its first line for a transactional message, so a notice that was promotional by accident arrives as
 * `blocked_unevaluable` rather than going out unevaluated.
 *
 * `permissive` exists for exactly one case, and the case says why: to prove the QUIET HOURS window is
 * alive, a promotional send has to get PAST consent and reach the window. With the fail-closed set it
 * never does, so "the promotional one did not go out" would have been about consent and not about the
 * hour — which is the vacuous control this knob removes.
 */
function runtime(evaluators: 'fail_closed' | 'permissive' = 'fail_closed'): {
  readonly deps: DeliveryDeps
  readonly calls: TransportRequest[]
  readonly store: ReturnType<typeof createInMemoryMessageStore>
} {
  const calls: TransportRequest[] = []
  const transport: ClassRoutedTransport = {
    channel: 'sms',
    async send(request) {
      calls.push(request)
      return {
        kind: 'accepted',
        providerMessageId: `fake-${calls.length}`,
        segments: 1,
        costFils: 9,
      }
    },
  }
  const config = parseConfig({
    APP_ENV: 'production' as AppEnv,
    DATABASE_URL: 'postgres://localhost:5432/x',
  })
  const store = createInMemoryMessageStore()
  const send: SendContext = {
    appEnv: config.APP_ENV,
    outboundAllowlist: [RECIPIENT],
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [transport],
    outbox: new InMemoryOutbox(),
    clock: fixedClock(LATE_NIGHT_ISO),
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      evaluators:
        evaluators === 'permissive'
          ? {
              hasConsent: () => true,
              isSuppressed: () => false,
              frequencyCapReached: () => false,
            }
          : {
              hasConsent: () => {
                throw new Error('No consent store in this runtime. Promotional sends fail closed.')
              },
              isSuppressed: () => {
                throw new Error(
                  'No suppression log in this runtime. Promotional sends fail closed.',
                )
              },
              frequencyCapReached: () => {
                throw new Error(
                  'No frequency store in this runtime. Promotional sends fail closed.',
                )
              },
            },
    },
  }
  const deps: DeliveryDeps = { store, send, waitUntil: async () => {} }
  return { deps, calls, store }
}

const requestFor = (
  template: (typeof DEFAULT_TEMPLATES)[number],
  overrides: {
    readonly messageClass?: 'transactional' | 'promotional'
    readonly key?: string
  } = {},
) => ({
  templateId: 'template-row-1',
  id: `staff-notice-${template.key}` as MessageId,
  template: {
    key: overrides.key ?? template.key,
    channel: template.channel,
    locale: template.locale,
    body: template.body,
    variables: [...template.variables],
    messageClass: overrides.messageClass ?? template.messageClass,
    approvalState: 'approved' as const,
  },
  values: Object.fromEntries(template.variables.map((name) => [name, '20:00'])),
  recipient: RECIPIENT,
})

describe('the declared staff notification set', () => {
  it('names four notices and every one of them is a shipped template', () => {
    expect(STAFF_NOTIFICATION_TEMPLATE_KEY_LIST).toHaveLength(4)
    for (const key of STAFF_NOTIFICATION_TEMPLATE_KEY_LIST) {
      expect(
        DEFAULT_TEMPLATES.some((template) => template.key === key),
        `${key} is declared and not shipped`,
      ).toBe(true)
    }
    // The non-vacuity floor for every loop in this file.
    expect(STAFF_SMS.length).toBeGreaterThanOrEqual(8)
  })

  it('is transactional throughout, with a promotional template in the corpus as the control', () => {
    for (const template of DEFAULT_TEMPLATES) {
      if (!STAFF_NOTIFICATION_TEMPLATE_KEY_LIST.includes(template.key)) continue
      expect(template.messageClass, `${template.key}/${template.locale}`).toBe('transactional')
    }
    // Without this the claim above is satisfied by a corpus with one class in it, which it was for as
    // long as there was one (see `templates.ts` on `review.request`).
    expect(DEFAULT_TEMPLATES.some((template) => template.messageClass === 'promotional')).toBe(true)
  })

  it('exists in both languages, because no table records which one a member of staff reads', () => {
    for (const key of STAFF_NOTIFICATION_TEMPLATE_KEY_LIST) {
      const locales = DEFAULT_TEMPLATES.filter((template) => template.key === key).map(
        (template) => template.locale,
      )
      expect([...locales].sort(), key).toEqual(['ar', 'en'])
    }
  })

  it('names no colleague, no document type and no decision-maker', () => {
    // docs/06 D2's discretion rule applied to staff rather than to customers: which document somebody
    // holds is a fact about their immigration or professional status, and it arrives on a shared handset.
    for (const template of STAFF_SMS) {
      for (const forbidden of [
        'therapist',
        'passport',
        'visa',
        'licence',
        'license',
        'approved by',
      ]) {
        expect(
          template.body.toLowerCase(),
          `${template.key}/${template.locale} names ${forbidden}`,
        ).not.toContain(forbidden)
      }
    }
  })
})

describe('the AD- promotional identity cannot carry a staff notice', () => {
  it('routes every declared notice to the transactional identity', async () => {
    for (const template of STAFF_SMS.filter((candidate) => candidate.locale === 'en')) {
      const { deps, calls } = runtime()
      const outcome = await deliverStaffNotification(deps, requestFor(template))
      expect(outcome.kind, `${template.key} was not sent`).toBe('sent')
      const call = calls.at(-1)
      expect(
        call?.senderId?.value,
        `staff-notice-must-not-use-the-promotional-identity: ${template.key}`,
      ).toBe(PROVISIONAL_SENDER_IDS.transactional.value)
      expect(
        call?.senderId?.value,
        `staff-notice-must-not-use-the-promotional-identity: ${template.key}`,
      ).not.toContain(PROMOTIONAL_SENDER_PREFIX)
    }
  })

  it('and the AD- identity is reachable at all, which is the control', () => {
    // Without this the claim above is satisfied by a registry that resolves nothing to anything.
    expect(PROVISIONAL_SENDER_IDS.promotional.value).toContain(PROMOTIONAL_SENDER_PREFIX)
    expect(PROVISIONAL_SENDER_IDS.promotional.messageClass).toBe('promotional')
  })
})

describe('quiet hours do not suppress a staff notice', () => {
  const rota = STAFF_SMS.find(
    (template) =>
      template.key === STAFF_NOTIFICATION_TEMPLATE_KEYS.rotaPublished && template.locale === 'en',
  )

  it('sends at 23:30 Dubai, outside the promotional window', async () => {
    expect(rota).toBeDefined()
    if (rota === undefined) return
    const { deps, calls } = runtime()
    const outcome = await deliverStaffNotification(deps, requestFor(rota))
    expect(
      outcome.kind,
      'quiet-hours-must-not-suppress-a-staff-notice: a transactional notice at 23:30 Dubai must reach ' +
        'the transport',
    ).toBe('sent')
    expect(calls).toHaveLength(1)
  })

  it('and the same send with a PROMOTIONAL class is HELD, so the window is alive', async () => {
    /*
      The control, and it is the one that makes the case above mean something: a window that had stopped
      being applied would send both, and "the notice went out at 23:30" would prove nothing.

      Two things about how it is driven, and both are the difference between a control and a decoration.
      It goes through `deliverMessage` rather than the staff route, because the staff route refuses a
      promotional class before the gate ever sees it — that is the next describe block. And it uses the
      PERMISSIVE evaluators, because with the fail-closed set the send is refused as
      `blocked_unevaluable` by the consent evaluator and never reaches the window at all: the first draft
      of this case asserted `held`, got `not_sent`, and would have been "fixed" into a case about consent
      wearing a case about quiet hours' clothes.
    */
    expect(rota).toBeDefined()
    if (rota === undefined) return
    const { deps, calls } = runtime('permissive')
    const { deliverMessage } = await import('./lifecycle.ts')
    const outcome = await deliverMessage(
      deps,
      requestFor(rota, { messageClass: 'promotional' }) as never,
    )
    expect(outcome.kind).toBe('held')
    expect(calls).toHaveLength(0)
  })

  it('and a promotional send FAILS CLOSED under the shipped evaluators', async () => {
    // The other half of the same fact, asserted because it is what the runtime actually does: there is no
    // consent store, so a promotional message through a real runtime is refused rather than sent
    // unevaluated. A staff notice never reaches this branch, which is the point of its class.
    expect(rota).toBeDefined()
    if (rota === undefined) return
    const { deps, calls } = runtime()
    const { deliverMessage } = await import('./lifecycle.ts')
    const outcome = await deliverMessage(
      deps,
      requestFor(rota, { messageClass: 'promotional' }) as never,
    )
    expect(outcome.kind).toBe('not_sent')
    expect(calls).toHaveLength(0)
  })
})

describe('a promotional class on the same route is refused by name', () => {
  it('refuses it, and the sentence names the rule', () => {
    expect(() =>
      assertStaffNotificationClass({
        key: STAFF_NOTIFICATION_TEMPLATE_KEYS.leaveDecided,
        messageClass: 'promotional',
      }),
    ).toThrow(STAFF_NOTIFICATION_CLASS_REFUSAL)
  })

  it('refuses it at the route, before the gate or the transport sees anything', async () => {
    const rota = STAFF_SMS.find(
      (template) =>
        template.key === STAFF_NOTIFICATION_TEMPLATE_KEYS.rotaPublished && template.locale === 'en',
    )
    expect(rota).toBeDefined()
    if (rota === undefined) return
    const { deps, calls, store } = runtime()
    await expect(
      deliverStaffNotification(deps, requestFor(rota, { messageClass: 'promotional' }) as never),
    ).rejects.toThrow(STAFF_NOTIFICATION_CLASS_REFUSAL)
    // Nothing recorded and nothing attempted: the fence is in front of the choke point, not inside it.
    expect(store.all()).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('accepts the transactional one, which is the control', async () => {
    expect(() =>
      assertStaffNotificationClass({
        key: STAFF_NOTIFICATION_TEMPLATE_KEYS.leaveDecided,
        messageClass: 'transactional',
      }),
    ).not.toThrow()
  })

  it('refuses a transactional template that is not one of the declared four', () => {
    // A booking confirmation addressed at a therapist would pass a class fence and be the wrong message
    // from the wrong route, which is why the key is checked as well as the class.
    let thrown: unknown
    try {
      assertStaffNotificationClass({ key: 'booking.confirmed', messageClass: 'transactional' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).details['refusal']).toBe('staff_notification_key_not_declared')
  })
})
