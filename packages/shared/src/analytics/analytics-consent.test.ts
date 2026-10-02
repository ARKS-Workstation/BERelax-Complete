import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_CONSENT_PURPOSE,
  CONSENT_PURPOSE_VOCABULARY,
  CONSENT_PURPOSES,
} from '../schemas/consent.ts'
import {
  ANALYTICS_CONSENT_COPY_OPEN_QUESTION,
  ANALYTICS_CONSENT_DECISIONS,
  ANALYTICS_CONSENT_PATH,
  ANALYTICS_CONSENT_REFUSALS,
  ANALYTICS_CONSENT_SURFACES,
  ANALYTICS_CONSENT_WORDING,
  analyticsConsentDecisionSchema,
  analyticsConsentShapeRefusal,
} from './analytics-consent.ts'
import { CONSENT_MODE_SIGNALS, grantedConsentSignals } from './consent-signal.ts'

/**
 * The analytics consent wire contract and the banner's words (A-MEAS-02).
 *
 * The two things worth asserting about a constant: that the WORDS are storable by the schema that has to
 * hold them, and that the ENVELOPE refuses the shapes a consent record must never take.
 */

/**
 * Whether a string holds a character from one of the Arabic blocks, by CODE POINT and not by a regex.
 *
 * The blocks are `packages/core/src/text/bidi.ts`'s, restated here because `packages/shared` may import no
 * sibling at all. What holds the restatement honest is the pair of assertions below: the Arabic text must
 * match and the English must not.
 *
 * Code points rather than a character class, and that is not a style choice — it is what two gates
 * between them left as the only spelling. Written as a regex literal with `\uXXXX` escapes,
 * `biome check --write` rewrote the escapes into LITERAL characters, and the top of the Arabic
 * Presentation Forms-B block is U+FEFF: `pnpm invisibles` then refused the file for "literal ZERO WIDTH
 * NO-BREAK SPACE / BOM", correctly, because a reviewed source that differs from the compiled one is
 * CVE-2021-42574's whole subject. Written as `new RegExp('[\\u0600-…]')` to keep the escape inside a
 * string, Biome's `useRegexLiterals` turned it back into a literal. A comparison on
 * `codePointAt` is the one form neither rule has an opinion about, and it is also the clearest: the
 * ranges are numbers a reader can look up.
 */
const ARABIC_BLOCKS: readonly (readonly [number, number])[] = [
  [0x0600, 0x06ff],
  [0x0750, 0x077f],
  [0x08a0, 0x08ff],
  [0xfb50, 0xfdff],
  // Ends at U+FEFC and not U+FEFF: the three above it are unassigned and the last of them is the BOM.
  [0xfe70, 0xfefc],
]

const hasArabicScript = (text: string): boolean =>
  [...text].some((character) => {
    const point = character.codePointAt(0) ?? 0
    return ARABIC_BLOCKS.some(([from, to]) => point >= from && point <= to)
  })

/** Whether a string holds a C0 control character or DEL, by code point for the same two reasons. */
const hasControlCharacter = (text: string): boolean =>
  [...text].some((character) => {
    const point = character.codePointAt(0) ?? 0
    return point < 0x20 || point === 0x7f
  })

describe("the banner's words", () => {
  it('are both languages, and the Arabic really is Arabic script', () => {
    // `consent_wording` has a CHECK requiring at least one Arabic character, which exists because the
    // silent failure is an English paste into the Arabic column: the hash is perfectly valid and the
    // record says the visitor read Arabic. Same blocks `packages/core/src/text/bidi.ts` uses.
    expect(hasArabicScript(ANALYTICS_CONSENT_WORDING.textAr)).toBe(true)
    // The control on the pattern itself: the English text must NOT match it, or the assertion above
    // would be satisfied by a regex that matches anything — which is exactly what the English paste this
    // case exists to catch would look like.
    expect(hasArabicScript(ANALYTICS_CONSENT_WORDING.textEn)).toBe(false)
    // And they differ, which is the other CHECK: one text in both columns is a copy-paste away and
    // nothing else would report it.
    expect(ANALYTICS_CONSENT_WORDING.textEn).not.toBe(ANALYTICS_CONSENT_WORDING.textAr)
  })

  it('carry no control character, because U+001F is the hash separator', () => {
    // `consent_wording_hash` joins the two texts on U+001F, so a text containing one could make two
    // different pairs hash identically — the exact ambiguity the separator exists to remove.
    expect(hasControlCharacter(ANALYTICS_CONSENT_WORDING.textEn)).toBe(false)
    expect(hasControlCharacter(ANALYTICS_CONSENT_WORDING.textAr)).toBe(false)
    // The control on the predicate, because "no control character" is satisfied by a predicate that
    // never says yes. U+001F is the separator the hash function puts between the two texts.
    expect(hasControlCharacter('a\u001fb')).toBe(true)
  })

  it('fit the column and contain no token is_placeholder_text() refuses', () => {
    for (const text of [ANALYTICS_CONSENT_WORDING.textEn, ANALYTICS_CONSENT_WORDING.textAr]) {
      expect(text.length).toBeGreaterThan(0)
      expect(text.length).toBeLessThanOrEqual(4000)
      // The row has to be STORABLE. The visible draft marker is for the person reading it and
      // `is_provisional` plus the OPEN-QUESTIONS id is for the system; a word the function refuses would
      // make the row unwritable and the banner unable to record anything.
      expect(text.toLowerCase()).not.toMatch(/\b(tbc|tbd|todo|pending|unknown|placeholder|xxx)\b/)
    }
    // The marker is nevertheless there, so a reader of the rendered page can see it is a draft.
    expect(ANALYTICS_CONSENT_WORDING.textEn).toContain('DRAFT WORDING')
    expect(ANALYTICS_CONSENT_COPY_OPEN_QUESTION).toMatch(/^Y\d+-/)
  })

  it('are recorded under the purpose the migration seeds, which is in the table and not the four', () => {
    expect(ANALYTICS_CONSENT_WORDING.purpose).toBe(ANALYTICS_CONSENT_PURPOSE)
    expect(ANALYTICS_CONSENT_PATH.startsWith('/api/')).toBe(true)
    /*
     * The distinction that cost a run and is worth asserting. `CONSENT_PURPOSES` is the purposes a
     * CONTACT's consent is recorded for, per channel; `CONSENT_PURPOSE_VOCABULARY` is what the
     * `consent_purpose` table holds. Putting the analytics purpose in the first of those made the fixture
     * salon's (channel x purpose) matrix demand a seeded `sms/analytics_measurement` consent row — a row
     * that could not mean anything, since analytics consent has no channel and no contact.
     */
    expect(CONSENT_PURPOSE_VOCABULARY as readonly string[]).toContain(ANALYTICS_CONSENT_PURPOSE)
    expect(CONSENT_PURPOSES as readonly string[]).not.toContain(ANALYTICS_CONSENT_PURPOSE)
    // And the vocabulary is derived rather than restated, so a fifth contact purpose needs no second edit.
    expect(CONSENT_PURPOSE_VOCABULARY.length).toBe(CONSENT_PURPOSES.length + 1)
  })
})

describe('the decision envelope', () => {
  const body = {
    decision: 'granted',
    granted: ['analytics_storage'],
    locale: 'en',
    surface: 'consent_banner',
  }

  it('accepts a real decision and refuses an unknown extra property', () => {
    expect(analyticsConsentDecisionSchema.safeParse(body).success).toBe(true)
    // `strictObject`: a field the server silently dropped would be a consent qualification the visitor
    // expressed and nobody recorded.
    expect(analyticsConsentDecisionSchema.safeParse({ ...body, remember: true }).success).toBe(
      false,
    )
  })

  it('refuses a signal name nobody defined and a decision nobody defined', () => {
    expect(
      analyticsConsentDecisionSchema.safeParse({ ...body, granted: ['ad_tracking'] }).success,
    ).toBe(false)
    expect(analyticsConsentDecisionSchema.safeParse({ ...body, decision: 'maybe' }).success).toBe(
      false,
    )
    expect(analyticsConsentDecisionSchema.safeParse({ ...body, surface: 'email' }).success).toBe(
      false,
    )
  })

  it('refuses a grant of nothing and a refusal that keeps a signal, by name', () => {
    expect(analyticsConsentShapeRefusal({ ...body, granted: [] } as never)).toBe(
      'granted_without_a_signal',
    )
    expect(
      analyticsConsentShapeRefusal({
        ...body,
        decision: 'denied',
        granted: ['ad_storage'],
      } as never),
    ).toBe('refusal_claiming_a_signal')
    expect(
      analyticsConsentShapeRefusal({
        ...body,
        decision: 'withdrawn',
        granted: ['analytics_storage'],
      } as never),
    ).toBe('refusal_claiming_a_signal')
    // And the shapes that ARE allowed, so the three above are about refusal and not about a function
    // that refuses everything.
    expect(analyticsConsentShapeRefusal(body as never)).toBeNull()
    expect(
      analyticsConsentShapeRefusal({ ...body, decision: 'denied', granted: [] } as never),
    ).toBeNull()
    expect(
      analyticsConsentShapeRefusal({ ...body, decision: 'withdrawn', granted: [] } as never),
    ).toBeNull()
    // Every named refusal this contract can produce is in the vocabulary a caller branches on.
    for (const refusal of ['granted_without_a_signal', 'refusal_claiming_a_signal']) {
      expect(ANALYTICS_CONSENT_REFUSALS as readonly string[]).toContain(refusal)
    }
  })

  it('has one surface and three decisions, and both vocabularies are closed', () => {
    expect([...ANALYTICS_CONSENT_DECISIONS]).toEqual(['granted', 'denied', 'withdrawn'])
    expect([...ANALYTICS_CONSENT_SURFACES]).toEqual(['consent_banner'])
  })

  it('cannot express a grant of a signal the shared vocabulary does not hold', () => {
    // The envelope's `granted` is keyed on `CONSENT_MODE_SIGNALS` itself rather than on a second list, so
    // this is the assertion that the two are one list. A fifth name would be a signal this build invented
    // and no outbound tag would be keyed on it.
    const all = analyticsConsentDecisionSchema.safeParse({
      ...body,
      granted: [...CONSENT_MODE_SIGNALS],
    })
    expect(all.success).toBe(true)
    expect(
      analyticsConsentDecisionSchema.safeParse({
        ...body,
        granted: [...CONSENT_MODE_SIGNALS, 'ad_storage'],
      }).success,
      'the array cap is the vocabulary size, so a repeated signal cannot pad past it',
    ).toBe(false)
  })
})

describe('a decision that grants nothing', () => {
  it('cannot be spelled in a way the cookie parse reads as a grant', () => {
    // The control that makes the banner's `none` token safe. The gate reads the cookie through
    // `grantedConsentSignals`, which discards an unrecognised entry — so the token has to be a name that
    // is NOT a signal, and this is the assertion that it is not one.
    expect(grantedConsentSignals('berelax_consent=none').size).toBe(0)
    expect((CONSENT_MODE_SIGNALS as readonly string[]).includes('none')).toBe(false)
    // And the direction that proves the parse is working rather than returning nothing for everything.
    expect(grantedConsentSignals('berelax_consent=analytics_storage').size).toBe(1)
  })
})
