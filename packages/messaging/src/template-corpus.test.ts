/**
 * C-AUTO-01 — the shipped corpus, and the one question `message_class` and the consent model both answer.
 *
 * ## Why this file exists at all
 *
 * `message_class` says whether a message is promotional. So, from the other direction, does
 * `consent_purpose.is_send_gating` (migration 0056): a purpose that gates a send is a purpose a
 * promotional message needs a grant for, and there is deliberately no purpose for transactional traffic
 * because a booking confirmation must not be stoppable by an unreachable consent store.
 *
 * Two readings of one question is a defect waiting for the day they disagree, and the symptom would be
 * silent in both directions: a promotional template the gate treats as transactional sends with no
 * consent check at all, and a transactional one the gate treats as promotional stops every confirmation
 * the first time the store is slow. Nothing in this build *had* both readings written down together, so
 * this file writes them down together and asserts they agree — over the corpus, not over an example.
 *
 * ## What is asserted, and the control beside each
 *
 *   1. **The gate reads consent for exactly the promotional templates.** Proved with an evaluator that
 *      THROWS: a transactional send still succeeds (the gate returns `allow` on its first line, before
 *      any store is read), and a promotional one comes back `blocked_unevaluable` naming `consent`. The
 *      control is that both halves are reached — a corpus of one class would satisfy either alone.
 *   2. **No consent purpose exists for transactional traffic.** A lexical guard as well as a count,
 *      because the failure is somebody ADDING `service_updates` in good faith: the purpose would look
 *      harmless in the table and would be a value a future gate could be built on.
 *   3. **The corpus carries both classes.** The non-vacuity control for 1, and for every other
 *      corpus-wide claim in this package and in C-AUTO-05's.
 *   4. **Every shipped SMS template is one segment in both languages, promotional included.**
 *      `render.test.ts` asserts this over the transactional subset; a promotional blast is the message
 *      where a second segment costs the most, so the same rule is applied to the other half here.
 */
import { type AppEnv, parseConfig } from '@berelax/config'
import { fixedClock } from '@berelax/core'
import {
  CONSENT_PURPOSES,
  GOOGLE_REAUTH_TEMPLATE_KEY_LIST,
  REAUTH_REASSURANCE_SENTENCE,
  SEND_GATING_CONSENT_PURPOSES,
} from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { costOf } from './encoding.ts'
import { type GateEvaluators, TDRA_PROMOTIONAL_WINDOW } from './gate/index.ts'
import { InMemoryOutbox } from './outbox.ts'
import type { MessageId } from './port.ts'
import { renderTemplate, validateTemplate } from './render.ts'
import {
  type ClassRoutedTransport,
  type SendContext,
  sendMessage,
  type TransportRequest,
} from './send.ts'
import { PROVISIONAL_SENDER_IDS } from './sender-identity.ts'
import { DEFAULT_TEMPLATES, type DefaultTemplate, promotionalDefaults } from './templates.ts'

/** 14:00 Asia/Dubai: trading, inside the promotional window, so the window decides nothing here. */
const AFTERNOON = '2026-09-18T10:00:00.000Z'
const RECIPIENT = '+971528239069'

/** Plausible values for whatever a shipped template declares. Never an empty string: a blank renders. */
const valuesFor = (template: DefaultTemplate): Record<string, string> =>
  Object.fromEntries(
    template.variables.map((name) => [
      name,
      name === 'link'
        ? 'brlx.ae/b/AbCdEf'
        : name === 'date'
          ? '18 Sep'
          : name === 'time'
            ? '20:00'
            : `VALUE-${name}`,
    ]),
  )

function harness(evaluators: GateEvaluators): {
  readonly ctx: SendContext
  readonly calls: TransportRequest[]
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
  return {
    ctx: {
      appEnv: config.APP_ENV,
      outboundAllowlist: [RECIPIENT],
      senderIds: PROVISIONAL_SENDER_IDS,
      transports: [transport],
      outbox: new InMemoryOutbox(),
      clock: fixedClock(AFTERNOON),
      gate: {
        marketingKillSwitch: false,
        promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
        evaluators,
      },
    },
    calls,
  }
}

/** Every evaluator throws. A store that cannot answer is not permission — and is not a refusal either. */
const UNREACHABLE: GateEvaluators = {
  hasConsent: () => {
    throw new Error('the consent store is unreachable')
  },
  isSuppressed: () => {
    throw new Error('the suppression list is unreachable')
  },
  frequencyCapReached: () => {
    throw new Error('the frequency ledger is unreachable')
  },
}

/** The shipped SMS templates, approved for the purposes of this file. */
const smsCorpus = (): DefaultTemplate[] => DEFAULT_TEMPLATES.filter((t) => t.channel === 'sms')

describe('message_class and the consent model are one reading of one question', () => {
  it('ships a corpus carrying both classes, so every claim below is about something', () => {
    // Control 3, and the reason `review.request` exists. Until this unit, every corpus-wide claim about
    // promotional traffic was satisfied by an empty set.
    const classes = new Set(DEFAULT_TEMPLATES.map((template) => template.messageClass))
    expect(classes).toEqual(new Set(['transactional', 'promotional']))
  })

  it('reads consent for the promotional templates and for no others', async () => {
    const consulted: { promotional: number; transactional: number } = {
      promotional: 0,
      transactional: 0,
    }

    for (const template of smsCorpus()) {
      const h = harness(UNREACHABLE)
      const result = await sendMessage(h.ctx, {
        id: `cauto01-corpus-${template.key}-${template.locale}` as MessageId,
        // The corpus ships `review.request` in draft on purpose, and an unapproved template is refused
        // before the gate. Approving it HERE, in the test's own copy, is what makes this a test of the
        // gate rather than a second test of the approval rule.
        template: { ...template, approvalState: 'approved' },
        values: valuesFor(template),
        recipient: RECIPIENT,
      })

      if (template.messageClass === 'promotional') {
        consulted.promotional += 1
        // The store threw. The message is blocked and the evaluator is NAMED, which is the difference
        // between "this contact never opted in" and "nobody asked".
        expect(result, `${template.key}/${template.locale}`).toMatchObject({
          kind: 'blocked',
          reason: 'blocked_unevaluable',
          evaluator: 'consent',
        })
        expect(h.calls).toHaveLength(0)
      } else {
        consulted.transactional += 1
        // The same unreachable store, and the confirmation still goes out. That is the whole point of
        // the class: a marketing outage must not become an operational one (ADR 0016).
        expect(result.kind, `${template.key}/${template.locale}`).toBe('sent')
        expect(h.calls).toHaveLength(1)
      }
    }

    // Control 1: both branches were reached. A loop whose `if` never fired would report a clean pass.
    expect(consulted.promotional).toBeGreaterThan(0)
    expect(consulted.transactional).toBeGreaterThan(0)
  })

  it('declares no consent purpose a transactional message could be gated on', () => {
    // Control 2. `SEND_GATING_CONSENT_PURPOSES` is the subset a promotional send may be gated on, and
    // every one of them has to be in the vocabulary — a gating purpose absent from `CONSENT_PURPOSES`
    // would be a grant nobody can record.
    for (const purpose of SEND_GATING_CONSENT_PURPOSES) {
      expect(CONSENT_PURPOSES as readonly string[]).toContain(purpose)
    }
    // And the lexical guard: no purpose that reads like transactional traffic. The failure this catches
    // is somebody adding `service_updates` in good faith — it looks harmless in the table and is a value
    // a future gate can be built on, and the first time that gate fails closed the salon stops
    // confirming bookings. Absent, not disabled; see the header of packages/shared/src/schemas/consent.ts.
    for (const purpose of CONSENT_PURPOSES) {
      expect(purpose, `consent purpose '${purpose}'`).not.toMatch(
        /service|transaction|booking|otp|reminder|confirm|invoice/i,
      )
    }
  })
})

describe('the shipped promotional templates are held to the same rules as the transactional ones', () => {
  it('validates every promotional template against its own declaration', () => {
    const promotional = promotionalDefaults()
    expect(promotional.length).toBeGreaterThan(0)
    for (const template of promotional) validateTemplate(template)
  })

  it('renders every promotional template with no empty substitution', () => {
    for (const template of promotionalDefaults()) {
      const rendered = renderTemplate(template, valuesFor(template))
      expect(rendered).not.toContain('{{')
      for (const name of template.variables) expect(rendered.length).toBeGreaterThan(name.length)
    }
  })

  it('keeps every shipped SMS template inside one segment, in both languages and both classes', () => {
    // `render.test.ts` asserts this over the transactional subset. A promotional blast is where a second
    // segment costs the most — one message times the whole list — so the promotional half is held to it
    // here, over the WHOLE sms corpus rather than only the new half, so the two cannot drift apart.
    for (const template of smsCorpus()) {
      const rendered = renderTemplate(template, valuesFor(template))
      expect(costOf('sms', rendered).segments, `${template.key}/${template.locale}`).toBe(1)
    }
  })

  it('ships every promotional template in a state that is NOT sendable', () => {
    // The honest statement about marketing copy nobody with the authority to approve it has seen. A
    // shipped promotional template that arrived `approved` would be sendable on the day of install.
    for (const template of promotionalDefaults()) {
      expect(template.approvalState, `${template.key}/${template.locale}`).not.toBe('approved')
    }
    // The control, so this is not satisfied by a corpus in which nothing at all is approved: the
    // transactional half IS approved, because those messages have to work out of the box.
    const approved = DEFAULT_TEMPLATES.filter((t) => t.approvalState === 'approved')
    expect(approved.length).toBeGreaterThan(0)
  })
})

/**
 * G-CONN-08 — the re-auth notices keep docs/10 §4's promise, in the words the banner uses.
 *
 * Appended here rather than written as a fourth assertion in `render.test.ts` because the claim is about
 * the CORPUS: it has to hold for every re-auth template that exists, including the one somebody adds next,
 * and it has to fail if the sentence is reworded in either place. `REAUTH_REASSURANCE_SENTENCE` is the
 * single spelling; `CONNECTION_STATE_COPY.broken.detail` in `@berelax/core` carries it too, and
 * `packages/core/src/google/reauth.test.ts` asserts that end.
 */
describe('the Google re-auth notices', () => {
  const reauth = DEFAULT_TEMPLATES.filter((template) =>
    GOOGLE_REAUTH_TEMPLATE_KEY_LIST.includes(template.key),
  )

  it('ships both keys, in both locales, so the claims below are about something', () => {
    expect(reauth.length).toBeGreaterThan(0)
    for (const key of GOOGLE_REAUTH_TEMPLATE_KEY_LIST) {
      const locales = reauth.filter((template) => template.key === key).map((t) => t.locale)
      expect(new Set(locales), key).toEqual(new Set(['en', 'ar']))
    }
  })

  it('carries the reassurance sentence in every English EMAIL body, verbatim', () => {
    // Email only, and the acceptance line says email only: *"every email deep-links to the reconnect
    // screen and contains the reassurance sentence"*. The clause is 79 characters. An SMS is 160 GSM-7
    // characters and 70 in Arabic, so putting it in the SMS body would spend half the English budget and
    // more than the whole Arabic one — a two-segment message about a credential, twice a day, for the
    // length of an incident. The SMS says the connection stopped and where to fix it; the email beside it
    // is where the promise and the link belong.
    const english = reauth.filter(
      (template) => template.locale === 'en' && template.channel === 'email',
    )
    expect(english.length).toBeGreaterThan(0)
    for (const template of english) {
      expect(template.body, `${template.key}/${template.channel}`).toContain(
        REAUTH_REASSURANCE_SENTENCE,
      )
    }
    // The control, so this is not satisfied by a corpus in which every body contains everything: the
    // sentence is absent from the booking templates, which are the ones it would be wrong in.
    const booking = DEFAULT_TEMPLATES.filter((template) => template.key.startsWith('booking.'))
    expect(booking.length).toBeGreaterThan(0)
    for (const template of booking) {
      expect(template.body).not.toContain(REAUTH_REASSURANCE_SENTENCE)
    }
  })

  it('deep-links from every email and from no SMS', () => {
    for (const template of reauth) {
      if (template.channel === 'email') {
        // The variable rather than a URL: the absolute link is built by `reconnectLink` from the
        // validated site origin, because a URL written into a template is a URL nobody can promote.
        expect(template.variables, `${template.key}/${template.locale}`).toContain('link')
        expect(template.body).toContain('{{link}}')
      } else {
        // The SMS has to fit one segment in Arabic at 70 UCS-2 units. A link there would cost half of it.
        expect(template.variables, `${template.key}/${template.locale}`).not.toContain('link')
      }
    }
  })

  it('is transactional on every channel, which is what the marketing kill switch cannot touch', () => {
    for (const template of reauth) {
      expect(template.messageClass, `${template.key}/${template.channel}`).toBe('transactional')
      expect(template.approvalState).toBe('approved')
    }
    // And at least one SMS variant exists, or "it cannot be sent from a promotional sender ID" is a claim
    // about no template at all.
    expect(reauth.filter((template) => template.channel === 'sms').length).toBeGreaterThan(0)
  })

  it('names no scope URL and no Google console address anywhere', () => {
    for (const template of reauth) {
      const text = `${template.subject ?? ''} ${template.body}`
      expect(text, `${template.key}/${template.locale}`).not.toContain('googleapis.com/auth/')
      expect(text).not.toContain('console.cloud.google.com')
      expect(text).not.toContain('https://')
    }
  })
})
