/**
 * C-AUTO-01 — the (message_class × channel) routing table, as a property over the whole cross product.
 *
 * Two acceptance criteria are stated over that cross product and over the template corpus:
 *
 *   - "Property test over the full (message_class x channel) cross product: each pair resolves to
 *     exactly one registered sender identity, and an unmapped pair returns a typed refusal rather than
 *     falling back to a default";
 *   - "Two distinct SMS sender identities exist: the promotional identity matches /^AD-/ and the
 *     transactional one does not; a test over the whole template corpus asserts no promotional template
 *     can resolve to the transactional identity".
 *
 * ## Why this is a property and not six cases
 *
 * Six cases over six pairs is the same work, and it proves something weaker: that these six pairs answer
 * correctly TODAY. What has to hold is that every pair answers, that no pair answers twice, and that no
 * pair's answer is another pair's identity — and the third is the one a case set cannot see, because a
 * fallback looks exactly like a correct answer when the pair you tested happens to be the one being
 * fallen back to. So the property is stated over `MESSAGE_CLASSES × MESSAGE_CHANNELS` and the table is
 * read for its coverage rather than trusted.
 *
 * ## The controls, because a table that refused everything would satisfy most of this
 *
 * Four:
 *
 *   1. at least one pair really RESOLVES, and at least one really REFUSES — otherwise "every refusal is
 *      typed" is satisfied by a table that answers nothing and "every identity matches its pair" by one
 *      that refuses nothing;
 *   2. the template corpus contains at least one template of EACH class, so "no promotional template
 *      resolves to the transactional identity" is a claim about something that exists (brief rule 3).
 *      It did not, until this unit shipped `review.request`, and the assertion was vacuous;
 *   3. every deliberately-broken registry is REFUSED and never corrected — the swapped pair, the single
 *      identity in both slots, the missing prefix, the prefix on the wrong one;
 *   4. a refusal names the pair it refused, so an operator is not left to guess which of six it was.
 */
import { MESSAGE_CHANNELS, MESSAGE_CLASSES, type MessageClass } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import type { Channel } from './port.ts'
import {
  assertSenderIdRegistry,
  PROMOTIONAL_SENDER_PREFIX,
  PROVISIONAL_SENDER_IDS,
  resolveSenderIdentity,
  SENDER_IDENTITY_ROUTES,
  type SenderIdRegistry,
  senderIdFor,
} from './sender-identity.ts'
import { DEFAULT_TEMPLATES, promotionalDefaults, transactionalDefaults } from './templates.ts'

/** Every ordered pair. Built from the vocabularies, so a fourth channel enters this suite by itself. */
const CROSS_PRODUCT: readonly { messageClass: MessageClass; channel: Channel }[] =
  MESSAGE_CLASSES.flatMap((messageClass) =>
    MESSAGE_CHANNELS.map((channel) => ({ messageClass, channel })),
  )

/** Every value the two registrations hold, for the "never another pair's identity" assertion. */
const REGISTERED_VALUES = [
  PROVISIONAL_SENDER_IDS.transactional.value,
  PROVISIONAL_SENDER_IDS.promotional.value,
]

describe('the routing table is total over (message_class x channel)', () => {
  it('covers all six pairs, with no pair covered twice', () => {
    // The `satisfies` in the module is the compile-time half; this is the runtime one, and it is what
    // notices a table written with a duplicated key or a channel spelled twice.
    expect(CROSS_PRODUCT).toHaveLength(6)
    const covered = CROSS_PRODUCT.filter(
      ({ messageClass, channel }) => SENDER_IDENTITY_ROUTES[messageClass][channel] !== undefined,
    )
    expect(covered).toHaveLength(CROSS_PRODUCT.length)
  })

  it('answers every pair exactly once, and an identity always matches the pair that asked', () => {
    for (const pair of CROSS_PRODUCT) {
      const resolved = resolveSenderIdentity(PROVISIONAL_SENDER_IDS, pair)
      expect(['identity', 'delegated', 'refused'], JSON.stringify(pair)).toContain(resolved.kind)
      if (resolved.kind === 'identity') {
        // The class on the identity is the class that asked. A table that answered with the other
        // slot would be caught here and nowhere else — the value alone looks perfectly valid.
        expect(resolved.identity.messageClass, JSON.stringify(pair)).toBe(pair.messageClass)
        expect(SENDER_IDENTITY_ROUTES[pair.messageClass][pair.channel]).toBe('registered')
      }
    }
  })

  it('never falls back: an unregistered pair returns a typed refusal naming the pair', () => {
    const refusals = CROSS_PRODUCT.map((pair) => ({
      pair,
      resolved: resolveSenderIdentity(PROVISIONAL_SENDER_IDS, pair),
    })).filter(({ resolved }) => resolved.kind === 'refused')

    // Control 1a: at least one pair really is refused, so the loop below is over something.
    expect(refusals.length).toBeGreaterThan(0)

    for (const { pair, resolved } of refusals) {
      if (resolved.kind !== 'refused') continue
      expect(resolved.reason).toBe('sender_identity_not_registered')
      expect(resolved.messageClass).toBe(pair.messageClass)
      expect(resolved.channel).toBe(pair.channel)
      // …and the refusal carries no identity at all. The defect this rules out is the one that reads
      // as success: a `whatsapp` send answered with `BERELAX` because it was the nearest thing.
      expect(JSON.stringify(resolved)).not.toContain(REGISTERED_VALUES[0])
      expect(JSON.stringify(resolved)).not.toContain(REGISTERED_VALUES[1])
    }
  })

  it('resolves at least one pair, so the assertions above are not satisfied by a table that answers nothing', () => {
    // Control 1b. Without this, "every identity matches its pair" holds perfectly for a table with no
    // identities in it, which is the shape a refactor that broke the registry lookup would produce.
    const identities = CROSS_PRODUCT.map((pair) =>
      resolveSenderIdentity(PROVISIONAL_SENDER_IDS, pair),
    ).filter((resolved) => resolved.kind === 'identity')
    expect(identities.length).toBeGreaterThan(0)
  })

  it('delegates a channel whose identity is its transport, without naming another channel identity', () => {
    const resolved = resolveSenderIdentity(PROVISIONAL_SENDER_IDS, {
      messageClass: 'transactional',
      channel: 'email',
    })
    expect(resolved.kind).toBe('delegated')
    // The distinction that matters: `delegated` is a declared answer about email, not a borrowed SMS
    // identity. Before this unit, the same call answered `BERELAX` and `deliverMessage` wrote an SMS
    // alphanumeric into an email row's `sender_id`.
    expect(JSON.stringify(resolved)).not.toContain('BERELAX')
  })
})

describe('the two SMS identities are two identities', () => {
  it('registers a promotional identity that matches /^AD-/ and a transactional one that does not', () => {
    expect(PROVISIONAL_SENDER_IDS.promotional.value).toMatch(/^AD-/)
    expect(PROVISIONAL_SENDER_IDS.transactional.value).not.toMatch(/^AD-/)
    expect(PROVISIONAL_SENDER_IDS.promotional.value).not.toBe(
      PROVISIONAL_SENDER_IDS.transactional.value,
    )
    // The prefix is a constant rather than a literal in four places, and the constant is the one the
    // SQL constraint `message_sms_identity_matches_its_class` restates.
    expect(PROMOTIONAL_SENDER_PREFIX).toBe('AD-')
  })

  for (const broken of [
    {
      name: 'a swapped pair',
      registry: {
        transactional: { value: 'AD-BERELAX', messageClass: 'promotional' },
        promotional: { value: 'BERELAX', messageClass: 'transactional' },
      },
      says: /registered as promotional/,
    },
    {
      name: 'one identity in both slots',
      registry: {
        transactional: { value: 'BERELAX', messageClass: 'transactional' },
        promotional: { value: 'BERELAX', messageClass: 'promotional' },
      },
      says: /Both classes are registered to/,
    },
    {
      name: 'a promotional identity with no AD- prefix',
      registry: {
        transactional: { value: 'BERELAX', messageClass: 'transactional' },
        promotional: { value: 'BERELAX-OFFERS', messageClass: 'promotional' },
      },
      says: /must carry the 'AD-' prefix/,
    },
    {
      name: 'a transactional identity carrying the AD- prefix',
      registry: {
        transactional: { value: 'AD-BERELAX-TX', messageClass: 'transactional' },
        promotional: { value: 'AD-BERELAX', messageClass: 'promotional' },
      },
      says: /must not carry the 'AD-' prefix/,
    },
  ] satisfies readonly { name: string; registry: SenderIdRegistry; says: RegExp }[]) {
    it(`refuses ${broken.name} rather than correcting it`, () => {
      // Control 3. Each of these is what a swapped pair of environment variables, a half-finished
      // registration or a copy-pasted value produces, and every one of them is constructible by hand.
      expect(() => assertSenderIdRegistry(broken.registry)).toThrow(broken.says)

      // …and the SEND path refuses too, rather than throwing, because a choke point that throws makes
      // every caller invent its own answer to "did that message go out?".
      const resolved = resolveSenderIdentity(broken.registry, {
        messageClass: 'promotional',
        channel: 'sms',
      })
      expect(resolved.kind).toBe('refused')
      if (resolved.kind !== 'refused') return
      expect(resolved.reason).toBe('sender_id_class_mismatch')
    })
  }

  it('accepts the shipped registry, so the four refusals above are about the fault', () => {
    // Control: four refusals and no acceptance would be satisfied by a checker that refuses everything.
    expect(() => assertSenderIdRegistry(PROVISIONAL_SENDER_IDS)).not.toThrow()
    expect(senderIdFor(PROVISIONAL_SENDER_IDS, 'transactional').value).toBe('BERELAX')
    expect(senderIdFor(PROVISIONAL_SENDER_IDS, 'promotional').value).toBe('AD-BERELAX')
  })
})

describe('over the whole template corpus, no promotional template reaches the transactional identity', () => {
  it('ships at least one template of each class, so the claim below is about something', () => {
    // Control 2, and the reason this unit added `review.request`. An all-transactional corpus satisfies
    // "no promotional template resolves to the transactional identity" perfectly and proves nothing.
    expect(promotionalDefaults().length).toBeGreaterThan(0)
    expect(transactionalDefaults().length).toBeGreaterThan(0)
  })

  it('resolves every shipped template to an identity registered for its own class', () => {
    for (const template of DEFAULT_TEMPLATES) {
      const resolved = resolveSenderIdentity(PROVISIONAL_SENDER_IDS, template)
      const label = `${template.key}/${template.channel}/${template.locale}`

      if (resolved.kind === 'identity') {
        expect(resolved.identity.messageClass, label).toBe(template.messageClass)
        // The assertion the criterion actually asks for, stated as the thing that must not happen.
        if (template.messageClass === 'promotional') {
          expect(resolved.identity.value, label).not.toBe(
            PROVISIONAL_SENDER_IDS.transactional.value,
          )
          expect(resolved.identity.value, label).toMatch(/^AD-/)
        } else {
          expect(resolved.identity.value, label).not.toBe(PROVISIONAL_SENDER_IDS.promotional.value)
          expect(resolved.identity.value, label).not.toMatch(/^AD-/)
        }
      } else {
        // Email delegates. Whatever it answers, it must not be an SMS registration.
        expect(JSON.stringify(resolved), label).not.toContain('BERELAX')
      }
    }
  })

  it('reaches the promotional branch of the loop above at least once', () => {
    // The loop is an `if` on the class, so a corpus whose promotional half stopped resolving to an
    // identity would take the `else` and pass. Counted here rather than trusted.
    const promotional = promotionalDefaults().filter(
      (template) => resolveSenderIdentity(PROVISIONAL_SENDER_IDS, template).kind === 'identity',
    )
    expect(promotional.length).toBeGreaterThan(0)
  })
})
