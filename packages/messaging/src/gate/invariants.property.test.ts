/**
 * The domain invariant, over the cross product, through the real choke point.
 *
 * docs/14 §3 lists it among the non-negotiables that run on every unit: **"a send is impossible without
 * valid consent, inside quiet hours, or to a suppressed contact"**. C-AUTO-04's first acceptance line is
 * the same sentence as a cross product of (consent state × suppression state × clock instant ×
 * message_class), with "zero exceptions".
 *
 * ## Why this drives `sendMessage` and not `evaluateGate`
 *
 * `evaluateGate` returning `refuse` proves the gate decided. It does not prove the message did not leave,
 * and those are different claims: the gate could refuse and a caller could carry on. So every case here
 * goes through the real `sendMessage` with a COUNTING transport, and the assertion is that the transport
 * was never called — a claim about zero calls, made against something that counts every one.
 *
 * ## Why the evaluators are the real ones
 *
 * C-AUTO-03 stubbed `hasConsent` and `isSuppressed` permissive in its own itest, deliberately and for a
 * good reason: a send refused for a second reason would have made every frequency-cap assertion pass for
 * the wrong reason. This is the file that owes the other half. Consent goes through
 * `consentGateEvaluator` over real `ConsentLog` rows, suppression through `suppressionGateEvaluator` over
 * real `SuppressionLog` rows, and the frequency cap through `frequencyCapGateEvaluator` over a real
 * ledger map — all three assembled by `promotionalGateEvaluators`, which is the wiring this unit owns.
 *
 * The ledger is deliberately EMPTY of counted sends for every contact here, and that is not a stub: it is
 * a present, read, zero-row answer, which is what the map must contain for a contact who has never been
 * messaged. What it is not is *absent* — an absent entry throws, and the absent case is asserted in
 * `wire.test.ts` where it is the subject rather than a distraction.
 *
 * ## Why the cross product is enumerated AND sampled
 *
 * The product is finite — 4 consent states × 2 suppression states × 5 instant strata × 2 classes = 80 —
 * so enumerating it is strictly stronger than sampling it: there is no generator to mis-weight and no
 * arm that can go unvisited (brief rule 22 is about exactly that failure, and the surest way to avoid it
 * is to have no distribution at all). The property test after it exists for what enumeration cannot
 * cover: the instants BETWEEN the strata, drawn across a whole year, where a boundary a hand-picked
 * fixture straddled by luck would show up. Its arm counts are measured and asserted.
 */
import {
  type ConsentLog,
  type ConsentRecord,
  fixedClock,
  frequencyLedgerHorizonSeconds,
  type Instant,
  instantFromIso,
  instantToIso,
  PROVISIONAL_FREQUENCY_CAPS,
  type SuppressionLog,
} from '@berelax/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { InMemoryOutbox } from '../outbox.ts'
import type { MessageId } from '../port.ts'
import {
  type ClassifiedTemplate,
  type ClassRoutedTransport,
  type SendContext,
  type SendResult,
  sendMessage,
  type TransportRequest,
} from '../send.ts'
import { PROVISIONAL_SENDER_IDS } from '../sender-identity.ts'
import { TDRA_PROMOTIONAL_WINDOW } from './index.ts'
import { promotionalGateEvaluators } from './wire.ts'

const RECIPIENT = '+971528239069'
const PURPOSE = 'marketing'

/**
 * The promotional body, and it deliberately makes NO opt-out claim.
 *
 * C-AUTO-03's fixture body said "Reply STOP to opt out" and `unreachableOptOutPhrasesIn` in
 * `@berelax/core` forbids exactly that, for a reason that is not style: every SMS leaves from a
 * TDRA-registered ALPHANUMERIC sender ID which cannot receive an inbound message, so the phrase tells
 * somebody who wants the messages to stop that they have a way to stop them, sends them into a void, and
 * leaves the business able to say it offered an opt-out while having offered none. The working opt-out is
 * C-CRM-07's preference-centre link. Nothing here is persisted, but the phrase is wrong wherever it is
 * written, and a fixture is where a convention gets copied from.
 */
const OFFER: ClassifiedTemplate = {
  key: 'campaign.offer',
  messageClass: 'promotional',
  approvalState: 'approved',
  channel: 'sms',
  locale: 'en',
  body: 'Two treatments for the price of one at BE RELAX this week.',
  variables: [],
}

const CONFIRMATION: ClassifiedTemplate = {
  key: 'booking.confirmed',
  messageClass: 'transactional',
  approvalState: 'approved',
  channel: 'sms',
  locale: 'en',
  body: 'Booking confirmed for {{date}} at {{time}}. Details or changes: {{link}}',
  variables: ['date', 'time', 'link'],
}

const VALUES = { date: '19 Sep', time: '21:00', link: 'https://be.relax/b/7' } as const

// --- the four consent states, as real rows -------------------------------------------------------

const WORDING = {
  id: 'wording-1',
  purpose: PURPOSE,
  version: 3,
  contentHashHex: 'a'.repeat(64),
} as const

/** Well before every instant under test, so the record applies rather than being in the future. */
const DECIDED_AT = instantFromIso('2026-01-05T08:00:00.000Z')

const CONSENT_STATES = ['granted', 'withdrawn', 'no_record', 'wording_unresolvable'] as const
type ConsentArm = (typeof CONSENT_STATES)[number]

function consentLogFor(arm: ConsentArm): ConsentLog {
  const record = (kind: 'granted' | 'withdrawn', wordingId: string | null): ConsentRecord => ({
    id: `consent-${kind}`,
    channel: 'sms',
    purpose: PURPOSE,
    kind,
    recordedAt: DECIDED_AT,
    wordingId,
  })
  switch (arm) {
    case 'granted':
      return {
        contactId: 'c1',
        records: [record('granted', WORDING.id)],
        wordingVersions: [WORDING],
      }
    case 'withdrawn':
      return {
        contactId: 'c1',
        records: [record('withdrawn', null)],
        wordingVersions: [WORDING],
      }
    case 'no_record':
      // Read, and empty. Not absent: an absent entry is `blocked_unevaluable`, which is a different claim.
      return { contactId: 'c1', records: [], wordingVersions: [WORDING] }
    case 'wording_unresolvable':
      // A grant naming a wording version the caller cannot produce. `unknown`, not `granted` with a gap —
      // and the arm that a resolver reading only `kind` would get wrong while passing every other case.
      return {
        contactId: 'c1',
        records: [record('granted', 'wording-missing')],
        wordingVersions: [],
      }
  }
}

const SUPPRESSION_STATES = ['clear', 'suppressed'] as const
type SuppressionArm = (typeof SUPPRESSION_STATES)[number]

function suppressionLogFor(arm: SuppressionArm): SuppressionLog {
  return {
    key: 'hmac-of-the-recipient',
    records:
      arm === 'clear'
        ? []
        : [
            {
              id: 'sup-1',
              kind: 'phone',
              source: 'preference_centre',
              recordedAt: DECIDED_AT,
            },
          ],
  }
}

// --- the instants ------------------------------------------------------------------------------

/**
 * Five strata, and each one is a different reason to be inside or outside the window.
 *
 * `after_close` and `before_open` are the two ends, `overnight` is the 01:30 case that is inside trading
 * hours and outside the promotional window, and `open` and `late_open` are two instants comfortably
 * inside — two rather than one, so a rule that only worked in the afternoon would show.
 */
const INSTANTS = {
  open: '2026-09-18T10:00:00.000Z', // 14:00 Dubai
  late_open: '2026-09-18T16:30:00.000Z', // 20:30 Dubai
  after_close: '2026-09-18T19:30:00.000Z', // 23:30 Dubai
  overnight: '2026-09-18T21:30:00.000Z', // 01:30 Dubai the next day
  before_open: '2026-09-19T02:30:00.000Z', // 06:30 Dubai
} as const
type InstantArm = keyof typeof INSTANTS
const WITHIN_WINDOW: ReadonlySet<InstantArm> = new Set<InstantArm>(['open', 'late_open'])

// --- the harness -------------------------------------------------------------------------------

function countingTransport(): ClassRoutedTransport & { readonly calls: TransportRequest[] } {
  const calls: TransportRequest[] = []
  return {
    channel: 'sms',
    calls,
    async send(request: TransportRequest) {
      calls.push(request)
      return {
        kind: 'accepted',
        providerMessageId: `stub-${calls.length}`,
        segments: 1,
        costFils: 9,
      }
    },
  }
}

let sequence = 0

async function attempt(args: {
  readonly consent: ConsentArm
  readonly suppression: SuppressionArm
  readonly atIso: string
  readonly promotional: boolean
}): Promise<{ readonly result: SendResult; readonly providerCalls: number }> {
  const transport = countingTransport()
  const at = instantFromIso(args.atIso)
  const horizonSeconds = frequencyLedgerHorizonSeconds(PROVISIONAL_FREQUENCY_CAPS)
  const ctx: SendContext = {
    // Production, so nothing here can pass or fail because the staging guard moved first.
    appEnv: 'production',
    outboundAllowlist: [],
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [transport],
    outbox: new InMemoryOutbox(),
    clock: fixedClock(args.atIso),
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      evaluators: promotionalGateEvaluators({
        purpose: PURPOSE,
        at,
        reads: {
          consentLogs: new Map([[RECIPIENT, consentLogFor(args.consent)]]),
          suppressionLogs: new Map([[RECIPIENT, suppressionLogFor(args.suppression)]]),
          // Present, read, and empty: a contact who has never been messaged. Absent is a different claim.
          ledgerCountedAt: new Map<string, readonly Instant[]>([[RECIPIENT, []]]),
          ledgerReadFrom: (at - horizonSeconds * 1000) as Instant,
        },
      }),
    },
  }

  sequence += 1
  const result = await sendMessage(ctx, {
    id: `inv-${sequence}` as MessageId,
    template: args.promotional ? OFFER : CONFIRMATION,
    values: VALUES,
    recipient: RECIPIENT,
  })
  return { result, providerCalls: transport.calls.length }
}

// --- the enumerated cross product ----------------------------------------------------------------

describe('a promotional send is impossible without consent, when suppressed, or outside the window', () => {
  it('holds over the whole enumerated cross product, with every arm visited', async () => {
    const outcomes = new Map<string, number>()
    const tally = (key: string) => outcomes.set(key, (outcomes.get(key) ?? 0) + 1)
    let cases = 0

    for (const consent of CONSENT_STATES) {
      for (const suppression of SUPPRESSION_STATES) {
        for (const instantArm of Object.keys(INSTANTS) as InstantArm[]) {
          for (const promotional of [true, false]) {
            cases += 1
            const label = `${promotional ? 'promotional' : 'transactional'}/${consent}/${suppression}/${instantArm}`
            const { result, providerCalls } = await attempt({
              consent,
              suppression,
              atIso: INSTANTS[instantArm],
              promotional,
            })
            tally(`${promotional ? 'promotional' : 'transactional'}:${result.kind}`)

            if (!promotional) {
              // Transactional traffic is unaffected by every one of the three, which is the containment
              // ADR 0016 is about: a marketing problem must not stop a booking confirmation.
              expect(result.kind, label).toBe('sent')
              expect(providerCalls, label).toBe(1)
              continue
            }

            const permitted =
              consent === 'granted' && suppression === 'clear' && WITHIN_WINDOW.has(instantArm)

            if (permitted) {
              // The control that makes every refusal above non-vacuous. Without it, a gate that refused
              // everything would satisfy this whole file.
              expect(result.kind, label).toBe('sent')
              expect(providerCalls, label).toBe(1)
            } else {
              expect(result.kind, label).not.toBe('sent')
              expect(providerCalls, label).toBe(0)
            }
          }
        }
      }
    }

    expect(cases).toBe(
      CONSENT_STATES.length * SUPPRESSION_STATES.length * Object.keys(INSTANTS).length * 2,
    )
    expect(cases).toBe(80)

    // Every arm visited, asserted rather than assumed: a product enumerated over an empty list is empty,
    // and every assertion above would hold over it.
    expect(outcomes.get('transactional:sent')).toBe(40)
    expect(outcomes.get('promotional:sent')).toBe(2) // granted x clear x the two open instants
    expect(outcomes.get('promotional:blocked')).toBe(35) // 7 refusing (consent,suppression) pairs x 5
    expect(outcomes.get('promotional:queued')).toBe(3) // granted x clear x the three closed instants
  }, 30_000) // 80 real sends against vitest's undeclared 5,000 ms default (brief rule 21).

  it('names the reason it refused, and names consent before suppression when both refuse', async () => {
    // The order the gate reads in is asserted, not merely the answer: a recipient who is both
    // un-consented and suppressed is refused at the first gate it reaches. `resolveSendability` in
    // `@berelax/core` reports the other way round on purpose (suppression beats consent outright) and the
    // two agreeing about the ANSWER while differing about which of two true reasons they name is
    // documented there. This case is what stops that difference drifting into a disagreement.
    const both = await attempt({
      consent: 'no_record',
      suppression: 'suppressed',
      atIso: INSTANTS.open,
      promotional: true,
    })
    expect(both.result).toMatchObject({ kind: 'blocked', reason: 'refused_no_consent' })

    const onlySuppressed = await attempt({
      consent: 'granted',
      suppression: 'suppressed',
      atIso: INSTANTS.open,
      promotional: true,
    })
    expect(onlySuppressed.result).toMatchObject({ kind: 'blocked', reason: 'refused_suppressed' })

    const onlyClosed = await attempt({
      consent: 'granted',
      suppression: 'clear',
      atIso: INSTANTS.after_close,
      promotional: true,
    })
    expect(onlyClosed.result).toMatchObject({ kind: 'queued', reason: 'queued_for_window' })
  })

  it('refuses a withdrawn grant and an unresolvable wording, not merely an empty log', async () => {
    // The two arms an implementation reading only "is there a row" would get wrong. A withdrawal IS a row,
    // and a grant naming a wording version nobody can produce is a row that looks like permission.
    for (const consent of ['withdrawn', 'wording_unresolvable'] as const) {
      const { result, providerCalls } = await attempt({
        consent,
        suppression: 'clear',
        atIso: INSTANTS.open,
        promotional: true,
      })
      expect(result, consent).toMatchObject({ kind: 'blocked', reason: 'refused_no_consent' })
      expect(providerCalls, consent).toBe(0)
    }
  })
})

// --- the sampled instants ------------------------------------------------------------------------

/**
 * The instants BETWEEN the strata, across a whole year.
 *
 * ## What this adds over the enumeration above
 *
 * The enumeration is complete over five hand-picked instants, and a hand-picked instant is where a
 * boundary gets straddled by luck: 14:00 and 20:30 are both comfortably inside, so an off-by-an-hour in
 * either direction survives them. This draws a minute at random from a whole year, which visits 06:59,
 * 07:00, 20:59 and 21:00 as a matter of course, and it draws the consent and suppression arms with it so
 * the three inputs are exercised together rather than one at a time.
 *
 * ## The arm counts, and why they are asserted rather than hoped for
 *
 * The window is 14 of 24 hours, so a uniform minute-of-the-year generator puts about 58% of cases inside
 * it. The interesting cases are the ones where the answer could differ — inside the window, with consent
 * and no suppression, is the only combination that may send, and that is 1 of 8 consent×suppression pairs
 * times 58%, so about 7% of a run.
 *
 * MEASURED over ten runs of 400 against this exact send path, not estimated:
 *
 *     sendable   min 11   mean 23.7    floor 8
 *     held       min 14   mean 19.0    floor 9
 *     refused    min 344  mean 357.3   floor 178
 *
 * The first version of this comment carried floors of 14, 10 and 165 that had been REASONED rather than
 * run, and 14 is above the observed minimum of 11 — so the suite would have failed about one run in ten,
 * on a machine and a day nobody could tie to a change. That is brief rule 22's trap arriving in the very
 * file written to avoid it, and it is why the numbers above are printed from ten real runs. `sendable`'s
 * floor is a third of its mean rather than a half, because half its mean is 11 and that is exactly the
 * observed minimum — a floor set at the minimum becomes its own flake.
 *
 * `refused` dominating is correct and is not the rule 22 failure: the arm that proves the least here is
 * the refusal, and the two arms that prove the most are floored well above what a mis-weighted generator
 * would produce. A run that put everything in `refused` would fail the other two floors.
 *
 * `refused` dominating is correct and is not the rule 22 failure: the arm that proves the least here is
 * the refusal, and the two arms that prove the most are floored well above what a mis-weighted generator
 * would produce. A run that put everything in `refused` would fail the other two floors.
 */
describe('the invariant holds for instants no fixture picked', () => {
  it('never sends outside the window or without consent, over 400 sampled minutes', async () => {
    const YEAR_START = instantFromIso('2026-01-01T00:00:00.000Z')
    const MINUTES_IN_A_YEAR = 365 * 24 * 60

    const arms = { sendable: 0, held: 0, refused: 0 }
    let sends = 0

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: MINUTES_IN_A_YEAR - 1 }),
        fc.constantFrom(...CONSENT_STATES),
        fc.constantFrom(...SUPPRESSION_STATES),
        async (minute, consent, suppression) => {
          const atIso = instantToIso((YEAR_START + minute * 60_000) as Instant)
          const { result, providerCalls } = await attempt({
            consent,
            suppression,
            atIso,
            promotional: true,
          })

          if (result.kind === 'sent') {
            sends += 1
            // The whole claim, from the other direction: whatever the generator produced, a send that
            // happened must have had consent, no suppression, and been inside the window. This is the
            // assertion that a permissive bug fails, and it does not depend on classifying the case first.
            expect(consent).toBe('granted')
            expect(suppression).toBe('clear')
            expect(result.senderId).toBe('AD-BERELAX')
            expect(providerCalls).toBe(1)
            arms.sendable += 1
            return
          }

          expect(providerCalls).toBe(0)
          if (result.kind === 'queued') {
            // Held, never dropped, and only ever for a message that would otherwise have been sendable:
            // a refusal takes precedence over a hold, because the gate reads consent first.
            expect(consent).toBe('granted')
            expect(suppression).toBe('clear')
            arms.held += 1
            return
          }
          expect(result.kind).toBe('blocked')
          arms.refused += 1
        },
      ),
      { numRuns: 400 },
    )

    // MEASURED floors over ten real runs of 400 — see the block comment for the numbers and for the
    // guessed set that would have flaked one run in ten.
    expect(arms.sendable, `sendable arm: ${JSON.stringify(arms)}`).toBeGreaterThanOrEqual(8)
    expect(arms.held, `held arm: ${JSON.stringify(arms)}`).toBeGreaterThanOrEqual(9)
    expect(arms.refused, `refused arm: ${JSON.stringify(arms)}`).toBeGreaterThanOrEqual(178)
    expect(arms.sendable + arms.held + arms.refused).toBe(400)
    // And the property ran at all: `fc.assert` over a property that threw before its first assertion
    // would leave every counter at zero and every floor above would fail, but a run of zero cases would
    // not — so the total is asserted too.
    expect(sends).toBe(arms.sendable)
  }, 60_000) // 400 real sends, each building three evaluators (brief rule 21).
})
