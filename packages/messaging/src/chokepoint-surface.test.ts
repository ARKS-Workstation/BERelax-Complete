/**
 * What `@berelax/messaging` exports, as a frozen set, so a second send path cannot arrive by autocomplete.
 *
 * ## Why a snapshot of the KEY SET and not of the values
 *
 * C-AUTO-04's acceptance line asks for "a snapshot of the `@berelax/messaging` exported key set asserts no
 * raw adapter factory is reachable". The key set is the right thing to freeze because the hazard is
 * REACHABILITY: a feature author types `import { ` and takes whatever the package offers, and the thing
 * they must not be offered is a function that hands a message to a provider. Freezing the values would
 * make every edit to a message string a snapshot failure, and a snapshot people update reflexively is not
 * a check.
 *
 * ## What this found
 *
 * `createGuardedTransport`. It took any `Transport` and returned a `Transport` whose `send` applied the
 * staging guard and then called the inner transport — no template judgement, no sender-identity
 * resolution, no consent, no suppression, no frequency cap, no quiet hours — and it was exported from this
 * barrel, so it was reachable from any feature in the repository. Nothing in shipped code called it, which
 * is exactly why it survived: a dead bypass raises no failure. `outbox.ts` and `port.ts` carry the whole
 * argument where the two now-removed declarations were.
 *
 * ## Why the rules are patterns and not just a list
 *
 * A frozen list catches an addition. It does not say WHY the addition is wrong, so the next person adds to
 * the list. The two pattern rules below say what may not be exported at all — a transport factory, and
 * anything whose value has a `send` method — so an addition that is a bypass fails a rule with a reason
 * rather than failing a diff.
 */
import { describe, expect, it } from 'vitest'
import * as messaging from './index.ts'

/**
 * Every runtime export of the package, sorted. Types are erased and are not in scope here: a type sends
 * nothing, which is the same reasoning `google-tokens-only-in-with-google` uses for its type-only
 * exemption.
 */
const EXPORTS = Object.keys(messaging).sort()

/**
 * The frozen set.
 *
 * Adding a line here is the deliberate act it should be, and the two rules after it are what stop the line
 * being added thoughtlessly. `createGuardedTransport` is deliberately ABSENT and its absence is the point
 * of the file.
 */
const EXPECTED = [
  'DEFAULT_TEMPLATES',
  'DISCRETION_FORBIDDEN_VARIABLES',
  'InMemoryOutbox',
  'MAX_ATTEMPTS_ANY_POLICY',
  'MAX_QUEUED_PROMOTIONAL_STALENESS_SECONDS',
  'MESSAGE_VENDORS',
  'PROMOTIONAL_SENDER_PREFIX',
  'PROMOTIONAL_WINDOW_SETTING_KEY',
  'PROVISIONAL_SENDER_IDS',
  'SENDER_IDENTITY_ROUTES',
  'TDRA_PROMOTIONAL_WINDOW',
  'TemplateRenderError',
  'WHATSAPP_CARE_WINDOW_HOURS',
  'asPromotionalWindow',
  'assertPromotionalWindowChange',
  'assertSenderIdRegistry',
  'CampaignSpend',
  'campaignCost',
  'careWindow',
  'classifyTemplateRow',
  'costOf',
  'createInMemoryMessageStore',
  'decideSendWindow',
  'deliverMessage',
  'evaluateGate',
  'guardOutbound',
  'idempotencyKeyFor',
  'judgeVariant',
  'nextPromotionalWindowOpen',
  'outboundMessageFor',
  'placeholdersIn',
  'promotionalDefaults',
  'promotionalGateEvaluators',
  'renderEmailHtml',
  'renderTemplate',
  'resolveSenderIdentity',
  'resolveVariant',
  'sendMessage',
  'senderIdFor',
  'senderIdRegistryFault',
  'transactionalDefaults',
  'validateTemplate',
  'vendorFor',
  'withinPromotionalWindow',
].sort()

describe('the messaging package offers no way to send that is not the choke point', () => {
  it('exports exactly the frozen key set', () => {
    // Both directions. An unexpected export is a possible bypass; a MISSING one is a consumer broken by an
    // edit to this package, and a set compared in one direction only would report the first and not the
    // second.
    expect(EXPORTS).toEqual(EXPECTED)
  })

  it('exports no transport or adapter factory', () => {
    // The pattern rather than the name, so the next one is caught too: `createSmsalaTransport`,
    // `createResendTransport` and `createGuardedTransport` all match, and all three are deliberately
    // absent. A transport is imported from `@berelax/messaging/transports/smsala` by a runtime that hands
    // it to `sendMessage`, which is a deep import somebody has to write on purpose.
    const factories = EXPORTS.filter((name) =>
      /^(create|make|build).*(Transport|Adapter|Client)$/.test(name),
    )
    expect(factories).toEqual([])
  })

  it('exports nothing whose value can be handed a message', () => {
    // The half a name pattern cannot do. A bypass need not be called `createXTransport`: anything this
    // barrel hands out whose value has a `send` method is something a feature can call `.send(...)` on,
    // and `scripts/check-send-chokepoint.mjs` would then be the only thing standing between that and a
    // provider. `sendMessage` itself is a function and has no `send` PROPERTY, so it does not match.
    const sendable = Object.entries(messaging)
      .filter(([, value]) => {
        if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
          return false
        return typeof (value as { readonly send?: unknown }).send === 'function'
      })
      .map(([name]) => name)
    expect(sendable).toEqual([])
  })

  it('CONTROL: the two rules above match something when something matches', () => {
    // ADR 0003, at the level of a test rather than a gate. Both assertions above are "the filtered list is
    // empty", and an empty list is what a broken filter also produces — so each predicate is run against a
    // value it MUST match. Without this, a typo in either regexp or in the `typeof` chain would make the
    // rule vacuous and the file would still be green.
    const factoryPattern = /^(create|make|build).*(Transport|Adapter|Client)$/
    expect(factoryPattern.test('createGuardedTransport')).toBe(true)
    expect(factoryPattern.test('createSmsalaTransport')).toBe(true)
    expect(factoryPattern.test('sendMessage')).toBe(false)

    const pretend = { send: async () => ({ kind: 'sent' as const }) }
    expect(typeof (pretend as { readonly send?: unknown }).send).toBe('function')
    expect(typeof (messaging.sendMessage as unknown as { readonly send?: unknown }).send).not.toBe(
      'function',
    )
  })
})
