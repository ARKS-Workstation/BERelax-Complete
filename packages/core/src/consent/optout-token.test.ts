import { describe, expect, it } from 'vitest'
import {
  decideOptOutAccess,
  digestDifference,
  digestsEqual,
  OPT_OUT_ATTEMPT_OUTCOMES,
  OPT_OUT_NOT_FOUND,
  OPT_OUT_REFUSALS,
  OPT_OUT_TOKEN_LENGTH,
  OPT_OUT_TOKEN_TTL_SECONDS,
  optOutTokenShape,
  type StoredOptOutGrant,
} from './optout-token.ts'

/**
 * C-CRM-04 — what a presented opt-out token grants, and the comparator that decides it.
 *
 * The thousand forged tokens the acceptance criterion asks for are here rather than in the integration
 * suite, and the split is deliberate: a mutation of one character in a 43-character base64url token is
 * still a well-formed token, so a thousand of them driven through the real query would be a thousand
 * round trips to prove one pure decision. `packages/fixtures/src/suppression.itest.ts` drives the real
 * lookup — including the digest computation, which is `packages/db`'s because `packages/core` imports no
 * Node builtin — and this file proves the decision over every shape of forgery.
 */

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = `${'a'.repeat(63)}b`
const CONTACT = '00000000-0000-7000-8000-00000000c401'
const OTHER_CONTACT = '00000000-0000-7000-8000-00000000c402'
const NOW = 1_800_000_000_000

const grant = (overrides: Partial<StoredOptOutGrant> = {}): StoredOptOutGrant => ({
  grantId: 'grant-1',
  tokenSha256Hex: DIGEST_A,
  contactCustomerId: CONTACT,
  purpose: 'preference_centre',
  channel: 'sms',
  expiresAt: NOW + 1000,
  ...overrides,
})

const decide = (
  args: Partial<Parameters<typeof decideOptOutAccess>[0]> = {},
): ReturnType<typeof decideOptOutAccess> =>
  decideOptOutAccess({
    grant: grant(),
    presentedDigestHex: DIGEST_A,
    requestedContactId: CONTACT,
    expectedPurpose: 'preference_centre',
    at: NOW,
    ...args,
  })

describe('the comparator', () => {
  /**
   * The assertion that pins "no short circuit", and it is the only form of it a unit test can make.
   *
   * The returned value is the bitwise OR of EVERY position's difference. For `'ab'` against `'cd'` that is
   * `(0x61^0x63) | (0x62^0x64)` = `0x02 | 0x06` = 6. A comparator that returned on the first differing
   * character would answer 2, and one that returned a boolean would not answer a number at all — so this
   * one expectation is what the gate's mutant fails against.
   *
   * What it does NOT prove is a constant wall-clock time, which no unit test can, and the function's own
   * note says so rather than implying otherwise.
   */
  it('accumulates every position rather than stopping at the first difference', () => {
    expect(digestDifference('ab', 'cd')).toBe(6)
    // The control on the control: the same two strings differing ONLY in the first position accumulate
    // just that difference, so the 6 above is genuinely the combination of two and not a coincidence.
    expect(digestDifference('ab', 'cb')).toBe(2)
    expect(digestDifference('ab', 'ad')).toBe(6)
  })

  it('answers zero only for identical strings', () => {
    expect(digestDifference(DIGEST_A, DIGEST_A)).toBe(0)
    expect(digestsEqual(DIGEST_A, DIGEST_A)).toBe(true)
    expect(digestsEqual(DIGEST_A, DIGEST_B)).toBe(false)
  })

  it('detects a difference at EVERY position, including the last', () => {
    // A prefix comparison passes at position 0 and fails here, which is the whole reason the loop runs to
    // the end rather than to the length of the shorter string.
    for (const index of [0, 1, 31, 62, 63]) {
      const mutated = `${DIGEST_A.slice(0, index)}b${DIGEST_A.slice(index + 1)}`
      expect(digestsEqual(DIGEST_A, mutated), `position ${index}`).toBe(false)
    }
  })

  it('folds the length in rather than returning early, and reads a short string as zeros', () => {
    // A truncated digest must not equal its own prefix. The length XOR alone would catch it; the zeros
    // past the end are what stop `NaN ^ x` quietly answering `x` for the missing positions.
    expect(digestsEqual('aaa', 'aaaa')).toBe(false)
    expect(digestsEqual('aaaa', 'aaa')).toBe(false)
    expect(digestDifference('', '')).toBe(0)
  })
})

describe('the token shape', () => {
  it('accepts exactly 43 base64url characters', () => {
    const token = 'A'.repeat(OPT_OUT_TOKEN_LENGTH)
    expect(optOutTokenShape(token)).toEqual({ ok: true, token })
    expect(optOutTokenShape(`${'-_'.repeat(21)}A`)).toEqual({
      ok: true,
      token: `${'-_'.repeat(21)}A`,
    })
  })

  it('refuses an absent token by its own name', () => {
    for (const absent of [null, undefined, '', '   ']) {
      expect(optOutTokenShape(absent)).toEqual({ ok: false, reason: 'token_absent' })
    }
  })

  it('refuses every near miss, including one that is one character short', () => {
    const base = 'A'.repeat(OPT_OUT_TOKEN_LENGTH)
    for (const bad of [
      base.slice(1),
      `${base}A`,
      // base64 rather than base64url: `+` and `/` are the two characters the alphabet swaps out.
      `${base.slice(1)}+`,
      `${base.slice(1)}/`,
      `${base.slice(1)}=`,
      ` ${base.slice(1)}`,
      `${base.slice(1)} `,
    ]) {
      expect(optOutTokenShape(bad), JSON.stringify(bad)).toEqual({
        ok: false,
        reason: 'token_malformed',
      })
    }
  })

  it('does not trim before testing the shape', () => {
    // A token with a space in it is not a token with a space trimmed off: the URL that produced it is
    // wrong, and accepting the trimmed version would hide that for ever behind a link that works.
    const token = 'A'.repeat(OPT_OUT_TOKEN_LENGTH)
    expect(optOutTokenShape(` ${token}`)).toEqual({ ok: false, reason: 'token_malformed' })
  })
})

describe('what a presented token grants', () => {
  it('grants a valid, unexpired token presented for its own contact', () => {
    const decision = decide()
    expect(decision.kind).toBe('granted')
    if (decision.kind !== 'granted') return
    expect(decision.contactCustomerId).toBe(CONTACT)
    expect(decision.channel).toBe('sms')
  })

  it('refuses an absent grant as unknown', () => {
    expect(decide({ grant: null })).toMatchObject({ kind: 'refused', reason: 'token_unknown' })
  })

  it('refuses a grant whose stored digest is not the one presented', () => {
    expect(decide({ presentedDigestHex: DIGEST_B })).toMatchObject({
      kind: 'refused',
      reason: 'token_unknown',
    })
  })

  it('refuses an expired grant, inclusive of the boundary instant', () => {
    expect(decide({ grant: grant({ expiresAt: NOW - 1 }) })).toMatchObject({
      kind: 'refused',
      reason: 'token_expired',
    })
    // Inclusive: a link is dead AT its expiry, not one millisecond after it.
    expect(decide({ grant: grant({ expiresAt: NOW }) })).toMatchObject({
      kind: 'refused',
      reason: 'token_expired',
    })
    expect(decide({ grant: grant({ expiresAt: NOW + 1 }) }).kind).toBe('granted')
  })

  it('refuses a valid grant presented for a DIFFERENT contact', () => {
    expect(decide({ requestedContactId: OTHER_CONTACT })).toMatchObject({
      kind: 'refused',
      reason: 'token_not_for_this_contact',
    })
  })

  it('refuses a grant minted for another purpose', () => {
    expect(decide({ grant: grant({ purpose: 'data_export' }) })).toMatchObject({
      kind: 'refused',
      reason: 'token_not_for_this_purpose',
    })
  })

  /**
   * The acceptance criterion's thousand, over every shape of forgery a forger has.
   *
   * Deterministic rather than random: the index walks the token, so every position is mutated exactly
   * once across the first 43 and the rest cycle — which is stronger than a thousand random draws, where a
   * position can go untouched. The control at the end is what stops the whole loop passing vacuously:
   * the UNMUTATED token is granted, so "everything is refused" cannot be the reason the loop is green.
   */
  it('refuses a thousand forged or mutated tokens', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    let refused = 0
    for (let i = 0; i < 1000; i += 1) {
      const position = i % OPT_OUT_TOKEN_LENGTH
      const replacement = alphabet[(i * 7 + 1) % alphabet.length] as string
      const forged =
        i % 4 === 0
          ? // One character of the stored digest flipped, at a position that walks the whole 64. `b`
            // rather than `replacement`, because `replacement` is drawn from the base64url alphabet and
            // an `a` drawn at position n would reproduce the digest exactly — which is how a loop of a
            // thousand forgeries comes to contain the genuine token and pass anyway.
            `${DIGEST_A.slice(0, position)}b${DIGEST_A.slice(position + 1)}`
          : i % 4 === 1
            ? // The right length, one character outside hex: what a forger guessing an encoding produces.
              `${'0'.repeat(63)}${replacement}`
            : i % 4 === 2
              ? // The right digest, for the wrong contact. The one forgery that is not a forged token at
                // all — it is a valid link, pointed at somebody else's page.
                DIGEST_A
              : // A digest one character short.
                DIGEST_A.slice(1)

      const decision = decideOptOutAccess({
        grant: grant(),
        presentedDigestHex: forged,
        requestedContactId: i % 4 === 2 ? OTHER_CONTACT : CONTACT,
        expectedPurpose: 'preference_centre',
        at: NOW,
      })
      expect(decision.kind, `forgery ${i}: ${forged.slice(0, 8)}…`).toBe('refused')
      if (decision.kind === 'refused') {
        expect(
          (OPT_OUT_REFUSALS as readonly string[]).includes(decision.reason),
          `forgery ${i} was refused with an unnamed reason: ${decision.reason}`,
        ).toBe(true)
        refused += 1
      }
    }
    expect(refused).toBe(1000)
    // The control. Without it, a decider that refused everything — including the genuine token — would
    // satisfy every one of the thousand above.
    expect(decide().kind).toBe('granted')
    // An explicit timeout for the reason `sendability.property.test.ts` states about its own: the default
    // is 5,000 ms and this loop pays for a thousand decisions under coverage instrumentation on a machine
    // that may be running several other suites.
  }, 30_000)
})

describe('the vocabularies and the constants', () => {
  it('records every refusal as an attempt outcome, plus the two the attempts add', () => {
    // The pin the migration's CHECK is asserted against by the integration suite. A refusal added to
    // OPT_OUT_REFUSALS without widening the CHECK would fail there; this is the half that can be checked
    // without a database.
    for (const refusal of OPT_OUT_REFUSALS) {
      expect(OPT_OUT_ATTEMPT_OUTCOMES as readonly string[]).toContain(refusal)
    }
    expect(OPT_OUT_ATTEMPT_OUTCOMES).toContain('granted')
    expect(OPT_OUT_ATTEMPT_OUTCOMES).toContain('rate_limited')
    // `rate_limited` is NOT a verdict on a token: the limit is refused before anything is verified.
    expect(OPT_OUT_REFUSALS as readonly string[]).not.toContain('rate_limited')
  })

  it('has one refusal body and it is frozen', () => {
    expect(OPT_OUT_NOT_FOUND.status).toBe(404)
    expect(OPT_OUT_NOT_FOUND.body).toEqual({ error: 'not_found' })
    expect(Object.isFrozen(OPT_OUT_NOT_FOUND)).toBe(true)
    expect(Object.isFrozen(OPT_OUT_NOT_FOUND.body)).toBe(true)
  })

  it('lives thirty days, which is the one figure not copied from the evidence grant', () => {
    expect(OPT_OUT_TOKEN_TTL_SECONDS).toBe(30 * 24 * 60 * 60)
  })
})
