import { describe, expect, it } from 'vitest'
import { CROPS } from '../ladders.ts'
import { CROPPED_SLOTS, MEDIA_SLOTS } from '../url.ts'
import {
  CROPPED_SLOT_NAMES,
  EDITABLE_SLOT_NAMES,
  isMediaSlotName,
  MEDIA_SLOT_LIST,
  MEDIA_SLOT_NAMES,
  mediaSlot,
  ORIGINAL_MIME_TYPES,
  provisionalSlotPlaceholders,
  SLOT_REGISTRY,
  slotAspectRatio,
  slotPlaceholderColour,
  slotRatio,
} from './registry.ts'

/**
 * The registry is the single source, so what is asserted here is mostly *agreement*.
 *
 * Each of these has a way of being wrong that produces no error anywhere: a slot whose stated minimum
 * height does not match its own ratio, a `cropped` flag that disagrees with the URL builder's list, a
 * placeholder for a slot that reserves no box. None of them throws; all of them are visible only on screen.
 */
describe('the declared constraints', () => {
  it('declares all five docs/08 §6 slots with every constraint the acceptance names', () => {
    expect([...EDITABLE_SLOT_NAMES]).toEqual([
      'hero',
      'therapist-portrait',
      'service-card',
      'gallery',
      'testimonial-background',
    ])

    for (const name of EDITABLE_SLOT_NAMES) {
      const slot = SLOT_REGISTRY[name]
      // Aspect ratio, minimum dimensions, maximum bytes, allowed mime types, altRequired: true.
      expect(slot.ratio, name).not.toBeNull()
      expect(slot.minWidth, name).toBeGreaterThan(0)
      expect(slot.minHeight, name).toBeGreaterThan(0)
      expect(slot.maxBytes, name).toBeGreaterThan(0)
      expect(slot.mimeTypes.length, name).toBeGreaterThan(0)
      expect(slot.altRequired, name).toBe(true)
      expect(slot.why.length, name).toBeGreaterThan(40)
    }
  })

  it('requires alt text on every slot, not only the five', () => {
    // The control for the assertion above: `logo` is in the registry and is not one of the five, and it
    // must not be the slot where the alt requirement quietly does not apply. A wordmark needs alt text
    // more than most images do, because it is usually also a link to the home page.
    expect(MEDIA_SLOT_LIST.every((slot) => slot.altRequired)).toBe(true)
    expect(MEDIA_SLOT_NAMES.length).toBe(EDITABLE_SLOT_NAMES.length + 1)
  })

  it('states a minimum height that matches its own ratio', () => {
    for (const slot of MEDIA_SLOT_LIST) {
      if (slot.ratio === null) continue
      const derived = Math.round((slot.minWidth * slot.ratio[1]) / slot.ratio[0])
      expect(slot.minHeight, slot.name).toBe(derived)
    }
  })

  it('declares only ratios the two art-directed ladders actually crop to', () => {
    // A slot declaring 3:2 would validate uploads against a crop the derivative job never takes, and
    // `declaredCropRect` would silently pick the nearer of the two ladders.
    const ladders = new Set([
      `${CROPS.mobile.ratio[0]}:${CROPS.mobile.ratio[1]}`,
      `${CROPS.desktop.ratio[0]}:${CROPS.desktop.ratio[1]}`,
    ])
    for (const slot of MEDIA_SLOT_LIST) {
      if (slot.ratio === null) continue
      expect(ladders, slot.name).toContain(`${slot.ratio[0]}:${slot.ratio[1]}`)
    }
  })

  it('permits decoration on exactly one slot, and it is the one whose content is the text over it', () => {
    const decorative = MEDIA_SLOT_LIST.filter((slot) => slot.decorativePermitted).map((s) => s.name)
    expect(decorative).toEqual(['testimonial-background'])
  })

  it('crops exactly the slots that declare a ratio', () => {
    for (const slot of MEDIA_SLOT_LIST) {
      expect(slot.cropped, slot.name).toBe(slot.ratio !== null)
    }
  })

  it('states a published byte budget only where docs/08 §8 states one', () => {
    // docs/08 §8 gives a figure for the hero poster and for no other slot. A number here that docs/08 does
    // not have would put a bound nobody derived into a refusal message an editor has to act on.
    const budgeted = MEDIA_SLOT_LIST.filter((slot) => slot.publishedBudgetBytes !== null)
    expect(budgeted.map((slot) => slot.name)).toEqual(['hero'])
    expect(budgeted[0]?.publishedBudgetBytes).toEqual({ mobile: 95 * 1024, desktop: 170 * 1024 })
  })

  it('accepts only the two original formats, and refuses the four that look plausible', () => {
    expect([...ORIGINAL_MIME_TYPES]).toEqual(['image/jpeg', 'image/png'])
    for (const mime of ['image/webp', 'image/avif', 'image/svg+xml', 'image/heic']) {
      expect(ORIGINAL_MIME_TYPES as readonly string[], mime).not.toContain(mime)
    }
  })
})

describe('the registry drives the URL builder', () => {
  it('is the same slot list the derivative path uses', () => {
    expect([...MEDIA_SLOTS]).toEqual([...MEDIA_SLOT_NAMES])
  })

  it('is the same cropped-slot list', () => {
    expect([...CROPPED_SLOTS]).toEqual([...CROPPED_SLOT_NAMES])
    // The control: the derived list is not simply everything.
    expect(CROPPED_SLOT_NAMES).not.toContain('logo')
    expect(CROPPED_SLOT_NAMES.length).toBe(MEDIA_SLOT_NAMES.length - 1)
  })
})

describe('lookups', () => {
  it('resolves a declared slot and refuses one it has never heard of, by rule name', () => {
    expect(mediaSlot('gallery').label).toBe('Gallery')
    expect(isMediaSlotName('gallery')).toBe(true)
    expect(isMediaSlotName('carousel')).toBe(false)
    expect(() => mediaSlot('carousel')).toThrow(/\[unknown-slot\]/)
  })

  it('renders an aspect ratio for a cropped slot and refuses one for the wordmark', () => {
    expect(slotAspectRatio('therapist-portrait')).toBe('4 / 5')
    expect(slotAspectRatio('hero')).toBe('16 / 9')
    expect(slotRatio('hero')).toBeCloseTo(16 / 9, 10)
    expect(slotRatio('logo')).toBeNull()
    expect(() => slotAspectRatio('logo')).toThrow(/\[slot-declares-no-ratio\]/)
  })

  it('paints a placeholder from a palette token, never a literal colour', () => {
    expect(slotPlaceholderColour('hero')).toBe('var(--color-surface-clay)')
    expect(slotPlaceholderColour('gallery')).toBe('var(--color-surface-sand)')
    // A literal would be rejected by `pnpm colours`, and would also not follow the dark theme.
    for (const name of EDITABLE_SLOT_NAMES) {
      expect(slotPlaceholderColour(name), name).toMatch(/^var\(--color-[a-z-]+\)$/)
    }
    expect(() => slotPlaceholderColour('logo')).toThrow(/\[slot-declares-no-placeholder\]/)
  })
})

describe('the provisional placeholders', () => {
  it('lists one per slot that reserves a box, each naming Y12-photos', () => {
    const provisional = provisionalSlotPlaceholders()
    expect(provisional.map((entry) => entry.slot)).toEqual([...EDITABLE_SLOT_NAMES])
    for (const entry of provisional) {
      expect(entry.openQuestionId, entry.slot).toMatch(/^Y\d+[a-z]?-[a-z-]+$/)
      expect(entry.openQuestionId, entry.slot).toBe('Y12-photos')
      expect(entry.note.length, entry.slot).toBeGreaterThan(20)
      expect(entry.key, entry.slot).toBe(`media.slot.${entry.slot}.placeholder`)
    }
  })

  it('does not list the one slot with no placeholder', () => {
    // The control. A list that returned every slot would be a list nobody had to build, and the
    // Unconfirmed Assumptions panel would carry a row for a rectangle that is never drawn.
    expect(provisionalSlotPlaceholders().map((entry) => entry.slot)).not.toContain('logo')
  })
})
