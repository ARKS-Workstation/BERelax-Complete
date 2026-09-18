import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RADIUS } from '../tokens/scale.ts'
import {
  ICON_SIZE,
  ICON_STROKE_WIDTH,
  type IconLabelling,
  MIN_FORM_FONT_SIZE_PX,
  RADIUS_ROLE,
  radiusVarFor,
} from './contract.ts'

/**
 * The primitive set's contract, checked against the document it comes from — and, for the one claim
 * that is about the type system, checked by the type system.
 *
 * Every number here is quoted from docs/08 rather than restated, because a constant that agrees with a
 * hand-typed copy of the document agrees with nothing. `DOCS` is parsed for the radius table and the
 * icon line, so a design decision that moves in the document fails here.
 */
const DOCS = readFileSync(
  new URL('../../../../docs/08-frontend-design.md', import.meta.url),
  'utf8',
)

/** `--radius-2: 8px` (buttons, selects) → `2` ⇒ { size: '8px', wears: 'buttons, selects' }. */
const DOCS_RADII = new Map(
  [...DOCS.matchAll(/`--radius-([\w-]+):\s*([^`]+)`\s*\(([^)]+)\)/g)].map((match) => [
    match[1] ?? '',
    { size: (match[2] ?? '').trim(), wears: (match[3] ?? '').toLowerCase() },
  ]),
)

/**
 * How docs/08 §4 names each role in its radius table.
 *
 * Written out rather than derived from the role name: the document says "bottom sheet" and "sheet
 * handle only" in two different groups, and a stem match on `sheet` would find both and prove nothing.
 */
const DOCS_PHRASE: Record<keyof typeof RADIUS_ROLE, string> = {
  card: 'cards',
  input: 'inputs',
  chip: 'chips',
  button: 'buttons',
  select: 'selects',
  dialog: 'dialog',
  sheet: 'bottom sheet',
  handle: 'sheet handle',
}

describe('the radius roles are the ones docs/08 §4 assigns', () => {
  it('parses four radii out of the document', () => {
    // The guard against the rest of this block evaporating: a document whose table moved would
    // otherwise leave every loop below iterating over nothing and reporting a pass.
    expect([...DOCS_RADII.keys()].sort()).toEqual(['1', '2', '3', 'handle'])
  })

  it('puts every role on the radius the document gives it', () => {
    for (const [role, token] of Object.entries(RADIUS_ROLE)) {
      const entry = DOCS_RADII.get(token)
      expect(entry, `docs/08 §4 has no --radius-${token}`).toBeDefined()
      expect(entry?.wears, `${role} should wear --radius-${token}`).toContain(
        DOCS_PHRASE[role as keyof typeof RADIUS_ROLE],
      )
      // And the token really is the size the document states, so the mapping cannot be right about
      // the name while the scale is wrong about the value.
      expect(RADIUS[token]).toBe(entry?.size)
    }
  })

  it('does not put a button on the card radius', () => {
    // The control. If `wears` matched loosely — an empty string, or a check that always passes — the
    // assertion above would hold for a mapping that had every role on every radius.
    expect(DOCS_RADII.get('1')?.wears).not.toContain(DOCS_PHRASE.button)
    expect(DOCS_RADII.get('2')?.wears).not.toContain(DOCS_PHRASE.card)
  })

  it('emits the custom property rather than the value', () => {
    // A component that inlined `8px` would keep its corners when the token moved.
    expect(radiusVarFor('button')).toBe('var(--radius-2)')
    expect(radiusVarFor('handle')).toBe('var(--radius-handle)')
    expect(radiusVarFor('card')).not.toBe(radiusVarFor('button'))
  })
})

describe('the icon geometry is the one docs/08 §7 states', () => {
  it('takes its stroke width and both sizes from the document', () => {
    const stroke = /`strokeWidth ([\d.]+)`/.exec(DOCS)
    const sizes = /(\d+)px UI \/ (\d+)px nav/.exec(DOCS)
    expect(stroke?.[1], 'docs/08 §7 no longer states a stroke width').toBeDefined()
    expect(sizes?.[1], 'docs/08 §7 no longer states the UI and nav sizes').toBeDefined()

    expect(ICON_STROKE_WIDTH).toBe(Number.parseFloat(stroke?.[1] ?? 'NaN'))
    expect(ICON_SIZE.ui).toBe(Number.parseInt(sizes?.[1] ?? 'NaN', 10))
    expect(ICON_SIZE.nav).toBe(Number.parseInt(sizes?.[2] ?? 'NaN', 10))
    // Lucide's own default is 2, and the difference is the whole reason the wrapper exists.
    expect(ICON_STROKE_WIDTH).not.toBe(2)
  })
})

describe('the iOS zoom guard is a number, not an intention', () => {
  it('is 16px, below which Safari zooms a focused control and does not zoom back', () => {
    expect(MIN_FORM_FONT_SIZE_PX).toBe(16)
    // The body step is 17px, so a form primitive that simply inherits clears the floor. A primitive
    // that reached for `--text-sm` (14px) would not, which is what the route assertion checks.
    expect(MIN_FORM_FONT_SIZE_PX).toBeLessThan(17)
  })
})

/**
 * The type-level half of the acceptance: **an icon-only Button with no `aria-label` is a compile
 * error.**
 *
 * These are `@ts-expect-error` rather than a note in a review checklist because that is the durable
 * form. If the union stops rejecting the bad shape — a widened prop type, an `any`, a `Partial<>` —
 * the directive becomes unused and `pnpm typecheck` fails with `TS2578: Unused '@ts-expect-error'
 * directive`. It was mutation-tested the other way as well: with the first directive deleted,
 * `pnpm typecheck` reports `TS2322: Type '{ icon: "close"; }' is not assignable to type
 * 'ButtonLabelling'`, so the error being suppressed is the error the acceptance line names.
 *
 * The three `const`s below are read by the assertions so the file also fails the linter's unused-local
 * rule if somebody deletes the assertions and leaves the declarations.
 */
type ButtonLabelling = IconLabelling<'close' | 'search', string>

describe('an icon-only button without a label does not compile', () => {
  it('rejects the shape that renders a button a screen reader announces as "button"', () => {
    // @ts-expect-error — `icon` with no `aria-label` and nothing visible to read: the acceptance line.
    const iconOnlyWithoutLabel: ButtonLabelling = { icon: 'close' }
    // @ts-expect-error — a label with neither an icon nor children is a control with nothing in it.
    const labelWithoutAnything: ButtonLabelling = { 'aria-label': 'Close' }
    // @ts-expect-error — the icon registry is closed: a name nothing draws is not a label either.
    const unknownIcon: ButtonLabelling = { icon: 'settings', 'aria-label': 'Settings' }

    expect(iconOnlyWithoutLabel).toBeDefined()
    expect(labelWithoutAnything).toBeDefined()
    expect(unknownIcon).toBeDefined()
  })

  it('accepts the two shapes that do carry a name', () => {
    // The control. A union that rejected everything would satisfy the three directives above while
    // making the component unusable, and these two are what says it did not.
    const iconOnly: ButtonLabelling = { icon: 'close', 'aria-label': 'Close' }
    const labelled: ButtonLabelling = { children: 'Book a treatment' }
    const labelledWithIcon: ButtonLabelling = { icon: 'search', children: 'Search' }

    expect(iconOnly['aria-label']).toBe('Close')
    expect(labelled.children).toBe('Book a treatment')
    expect(labelledWithIcon.icon).toBe('search')
  })
})
