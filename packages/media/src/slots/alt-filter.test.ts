import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  ALT_MIN_LENGTH,
  type AltViolationRule,
  altViolations,
  assertAltAcceptable,
  isJunkAlt,
} from './alt-filter.ts'
import { EDITABLE_SLOT_NAMES, MEDIA_SLOT_LIST, mediaSlot } from './registry.ts'

const PORTRAIT = mediaSlot('therapist-portrait')
const BACKGROUND = mediaSlot('testimonial-background')

const rulesFor = (alt: string | null | undefined, extra: Record<string, unknown> = {}) =>
  altViolations({ slot: PORTRAIT, alt, ...extra }).map((violation) => violation.rule)

/**
 * The twenty good strings.
 *
 * Real descriptions of photographs this library could plausibly hold, and no invented names of people
 * (the brief's rule 10, and `assets/media/README.md`: nineteen portraits, zero names).
 *
 * Three of them are deliberately awkward for the filter, and they are the reason it is not docs/08 §6's
 * anchored regular expression: #7 begins with "Photograph of", #12 contains "banner" as a real noun and
 * #17 contains "image" in "mirror image". `/^(image|photo|…)/i` rejects two of those outright, and a
 * filter that rejects correct alt text is one an editor learns to defeat with a word of padding.
 *
 * #20 is Arabic, because the site is bilingual and both the fifteen-character floor and the ten-letter
 * floor have to count code points and Unicode letters rather than ASCII.
 */
const GOOD_ALT: readonly string[] = [
  'Therapist warming aromatherapy oil between her palms before a back massage',
  'Treatment room with a linen-draped bed, a stone basin and a single orchid stem',
  'Hands pressing into the shoulders of a guest lying face down under a towel',
  'Folded white towels stacked beside a brass bowl of warm water',
  'Reception desk in pale oak with the wordmark lit from behind',
  'Steam rising from a copper kettle poured into a ceramic foot bath',
  'Photograph of a massage bed made up with fresh white linen, seen from above',
  'Bamboo screen filtering afternoon light across an empty massage bed',
  'Guest in a robe waiting in the arrival lounge with a glass of water',
  'Foot soak bowl with floating frangipani petals on a slate tray',
  'Thumbs kneading the sole of a foot, the heel cupped in one hand',
  'Fabric banner above the arrival desk, printed and lit from the side',
  'Single candle burning in a frosted glass holder on a stone ledge',
  'Corridor lined with pale linen curtains leading to the treatment rooms',
  'Bottle of unscented carrier oil beside three small amber dropper bottles',
  'Warm towel covering a guest’s shoulders during a scalp massage',
  'Mirror image of the treatment room reflected in the polished stone basin',
  'Potted olive tree in the window of the arrival lounge at dusk',
  'Tray of warm compresses wrapped in muslin, ready for a back treatment',
  'معالجة تدفئ زيت العلاج بين كفيها قبل جلسة تدليك الظهر',
]

/**
 * The nine junk strings the acceptance names, each paired with a padded variant.
 *
 * The padded variant is the load-bearing half. Every bare one of these is under fifteen characters, so a
 * filter that was *only* the length floor would reject all nine and report a working junk filter. The
 * padded variant clears the length floor and the letter floor, so the rule named beside it is the only
 * thing that can reject it — which is what makes the filter a filter rather than a `length >= 15`.
 */
const NAMED_JUNK: readonly {
  readonly bare: string
  readonly padded: string
  readonly rule: AltViolationRule
}[] = [
  { bare: 'image', padded: 'image image image', rule: 'alt-is-boilerplate' },
  { bare: 'photo', padded: 'the photo of the image', rule: 'alt-is-boilerplate' },
  { bare: 'picture', padded: 'picture picture picture', rule: 'alt-is-boilerplate' },
  { bare: 'img', padded: 'img img img img img', rule: 'alt-is-boilerplate' },
  { bare: 'hero', padded: 'hero banner picture', rule: 'alt-is-boilerplate' },
  { bare: 'banner', padded: 'banner graphic final', rule: 'alt-is-boilerplate' },
  { bare: 'untitled', padded: 'untitled untitled', rule: 'alt-is-boilerplate' },
  { bare: 'DSC_0031', padded: 'DSC_0031.jpg original', rule: 'alt-is-a-filename' },
  { bare: 'IMG-2044', padded: 'IMG-2044 IMG-2045 crop', rule: 'alt-is-a-filename' },
]

describe('the corpus the acceptance names', () => {
  it.each(NAMED_JUNK)('rejects “$bare”', ({ bare }) => {
    expect(isJunkAlt({ slot: PORTRAIT, alt: bare })).toBe(true)
  })

  it.each(NAMED_JUNK)('rejects “$bare” in every case', ({ bare }) => {
    for (const spelling of [bare.toUpperCase(), bare.toLowerCase(), bare]) {
      expect(isJunkAlt({ slot: PORTRAIT, alt: spelling }), spelling).toBe(true)
    }
  })

  it.each(NAMED_JUNK)(
    'rejects “$padded” by $rule, not merely for being short',
    ({ padded, rule }) => {
      const rules = rulesFor(padded)
      expect(rules, padded).toContain(rule)
      // The point of the padded variant: the length floor is not what rejected it.
      expect(rules, padded).not.toContain('alt-too-short')
      expect([...padded].length).toBeGreaterThanOrEqual(ALT_MIN_LENGTH)
    },
  )

  it('rejects every one of them in every slot, because no slot waives alt text', () => {
    for (const slot of MEDIA_SLOT_LIST) {
      for (const { bare, padded } of NAMED_JUNK) {
        expect(isJunkAlt({ slot, alt: bare }), `${slot.name} / ${bare}`).toBe(true)
        expect(isJunkAlt({ slot, alt: padded }), `${slot.name} / ${padded}`).toBe(true)
      }
    }
  })
})

describe('the twenty good strings', () => {
  it.each(GOOD_ALT)('accepts “%s” with no violation at all', (alt) => {
    expect(altViolations({ slot: PORTRAIT, alt })).toEqual([])
  })

  it('accepts all twenty in every slot — zero false positives', () => {
    for (const slot of MEDIA_SLOT_LIST) {
      for (const alt of GOOD_ALT) {
        expect(altViolations({ slot, alt }), `${slot.name} / ${alt}`).toEqual([])
      }
    }
    expect(GOOD_ALT.length).toBe(20)
  })

  it('accepts a good string that begins with a boilerplate word', () => {
    // docs/08 §6's anchored `/^(image|photo|…)/i` rejects both of these. They are correct alt text, and a
    // rule that rejects correct alt text is one an editor defeats with a word of padding — at which point
    // the field holds "the photo of the therapist", which the rule then accepts.
    expect(altViolations({ slot: PORTRAIT, alt: GOOD_ALT[6] })).toEqual([])
    expect(altViolations({ slot: PORTRAIT, alt: GOOD_ALT[16] })).toEqual([])
  })
})

describe('presence and length', () => {
  it('rejects missing alt text by name', () => {
    expect(rulesFor(undefined)).toEqual(['alt-missing'])
    expect(rulesFor(null)).toEqual(['alt-missing'])
    expect(rulesFor('')).toEqual(['alt-missing'])
  })

  it('rejects whitespace, including the whitespace a form field hides', () => {
    expect(rulesFor(' ')).toEqual(['alt-whitespace-only'])
    expect(rulesFor('\t\n ')).toEqual(['alt-whitespace-only'])
    // A non-breaking space and a zero-width space. Both satisfy a required field and both look empty.
    // Built from code points rather than written as escapes: Biome rewrites `\u200B` into the literal
    // character, which would put a zero-width space in this file and fail `pnpm invisibles`.
    expect(rulesFor(String.fromCodePoint(0x00a0, 0x00a0))).toEqual(['alt-whitespace-only'])
    expect(rulesFor(String.fromCodePoint(0x200b))).toEqual(['alt-whitespace-only'])
  })

  it('rejects anything under fifteen characters, counted in code points', () => {
    expect(rulesFor('Towels on oak')).toContain('alt-too-short')
    expect([...'Towels on oak'].length).toBeLessThan(ALT_MIN_LENGTH)
    // The control, one character longer than the floor.
    expect(altViolations({ slot: PORTRAIT, alt: 'Towels on pale oak' })).toEqual([])
  })

  it('rejects digits used as padding', () => {
    expect(rulesFor('0123456789012345')).toContain('alt-has-too-few-letters')
    expect(rulesFor('2024-01-02 11:30:00')).toContain('alt-has-too-few-letters')
  })
})

describe('the rules the acceptance list does not name, and the reasons they exist', () => {
  it('rejects alt text that is the uploaded file’s own name', () => {
    // No extension survives here, and it is not a camera-roll pattern. What catches it is the filename
    // itself: the most common way a required alt field gets filled is that the filename is already on
    // screen. `team-05` is a real name in assets/media/.
    const rules = rulesFor('team-05 final version two', { filename: 'team/team-05.jpg' })
    expect(rules).toContain('alt-is-a-filename')
    // The control: the same description with the filename not matching is fine.
    expect(
      altViolations({
        slot: PORTRAIT,
        alt: 'Therapist adjusting the headrest of a massage bed',
        filename: 'team/team-05.jpg',
      }),
    ).toEqual([])
  })

  it('rejects a pasted URL', () => {
    expect(rulesFor('https://berelax.example/m/hero-desktop-2560.avif')).toContain('alt-is-a-url')
    expect(
      rulesFor('/m/0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f/9f86d081884c7d65/hero-mobile-828.avif'),
    ).toContain('alt-is-a-url')
  })

  it('rejects the surrounding heading repeated verbatim, and accepts it used inside a description', () => {
    const context = ['Hot Stone Massage']
    expect(rulesFor('Hot Stone Massage', { context })).toContain('alt-repeats-the-context')
    expect(rulesFor('Hot Stone Massage photo', { context })).toContain('alt-repeats-the-context')
    expect(rulesFor('photo of Hot Stone Massage', { context })).toContain('alt-repeats-the-context')
    // The control, and the reason the rule is an equality rather than a containment: naming the treatment
    // inside a real description is exactly what good alt text does.
    expect(
      altViolations({
        slot: PORTRAIT,
        alt: 'Hot basalt stones resting on a rolled linen cloth beside the bed',
        context,
      }),
    ).toEqual([])
  })

  it('rejects a keyword list and accepts a sentence with commas in it', () => {
    expect(rulesFor('massage, spa, abu dhabi, aromatherapy, deep tissue')).toContain(
      'alt-is-a-keyword-list',
    )
    // The control. Three commas, and it is prose — which is what the connecting-word test is for.
    expect(
      altViolations({
        slot: PORTRAIT,
        alt: 'Linen, stone, water and wood in the treatment room, seen from the doorway',
      }),
    ).toEqual([])
  })
})

describe('decorative images', () => {
  it('accepts empty alt on the one slot that may hold decoration', () => {
    expect(altViolations({ slot: BACKGROUND, alt: '', decorative: true })).toEqual([])
    expect(altViolations({ slot: BACKGROUND, alt: null, decorative: true })).toEqual([])
  })

  it('refuses decoration in a slot whose images are content', () => {
    // A photograph of a member of staff is never decoration. This is the rule that makes "required alt
    // text" survive the existence of a legitimate empty-alt case: the waiver is per image and per slot,
    // not a way to turn the requirement off.
    expect(
      altViolations({ slot: PORTRAIT, alt: '', decorative: true }).map((v) => v.rule),
    ).toContain('alt-decorative-not-permitted-in-slot')
  })

  it('refuses a decorative image that also carries text', () => {
    const rules = altViolations({
      slot: BACKGROUND,
      alt: 'Linen curtains behind the quote',
      decorative: true,
    }).map((violation) => violation.rule)
    expect(rules).toEqual(['alt-decorative-must-be-empty'])
  })

  it('still requires alt text on that slot when the image is not declared decorative', () => {
    // The control for the whole decorative mechanism. Without this, `decorativePermitted: true` would be
    // indistinguishable from `altRequired: false`.
    expect(altViolations({ slot: BACKGROUND, alt: '' }).map((v) => v.rule)).toEqual(['alt-missing'])
    expect(isJunkAlt({ slot: BACKGROUND, alt: 'image' })).toBe(true)
  })
})

describe('the messages', () => {
  it('names the rule, the constraint and what was supplied', () => {
    const [violation] = altViolations({ slot: PORTRAIT, alt: 'photo' })
    expect(violation?.rule).toBe('alt-too-short')
    expect(violation?.field).toBe('alt')
    expect(violation?.message).toContain('[alt-too-short]')
    expect(violation?.message).toContain(String(ALT_MIN_LENGTH))
    expect(violation?.message).toContain('photo')
    expect(violation?.message).toContain('5 characters')
  })

  it('reports every rule a string breaks, not only the first', () => {
    const rules = rulesFor('IMG_2044')
    expect(rules).toContain('alt-too-short')
    expect(rules).toContain('alt-is-a-filename')
    expect(rules.length).toBeGreaterThan(1)
  })

  it('throws one user-facing error carrying every rule', () => {
    try {
      assertAltAcceptable({ slot: PORTRAIT, alt: 'IMG_2044' })
      expect.unreachable('a filename must not be accepted as alt text')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      const app = error as AppError
      expect(app.userFacing).toBe(true)
      expect(app.details?.['rules']).toContain('alt-is-a-filename')
      expect(app.details?.['slot']).toBe('therapist-portrait')
    }
  })

  it('accepts good alt text without throwing, on every slot', () => {
    for (const name of EDITABLE_SLOT_NAMES) {
      expect(() => assertAltAcceptable({ slot: mediaSlot(name), alt: GOOD_ALT[0] })).not.toThrow()
    }
  })
})
