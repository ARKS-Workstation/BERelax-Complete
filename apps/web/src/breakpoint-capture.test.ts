import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ANALYTICS_BREAKPOINT_BANDS,
  ANALYTICS_BREAKPOINTS,
  BREAKPOINT_UNKNOWN,
  breakpointFor,
  DEVICE_KINDS,
  deviceKindFor,
} from '@berelax/shared'
import { BREAKPOINTS } from '@berelax/ui'
import { describe, expect, it } from 'vitest'

/**
 * The breakpoint a session is recorded at is the breakpoint the layout actually switched at (A-FIRST-05).
 *
 * ## Why this file exists rather than one statement of the widths
 *
 * `BREAKPOINTS` in `@berelax/ui` is where a breakpoint comes into existence: the token layer emits it into
 * the CSS the page is laid out with (ADR 0012). `analytics.session.breakpoint` is written by
 * `/api/collect`, and the tuple it derives the name from lives in `@berelax/shared` — because `@berelax/db`
 * writes the column and may never import `@berelax/core`, and because `@berelax/ui` is a React package an
 * API route has no business importing. Neither package may import the other, so the widths are stated
 * twice and the agreement is a CHECK.
 *
 * `apps/web` is the only place both are reachable, which is the same reason `crawler-policy.test.ts` is
 * here (A-FIRST-04). What this asserts is set equality in BOTH directions, so editing either list alone
 * fails — and the direction that matters most is a token ramp that moved: the analytics page's device and
 * breakpoint split would then be reporting bands the site does not use, and nothing else in the build would
 * notice, because every figure would still be internally consistent.
 *
 * ## And why a `base` band exists on this side and not in the tokens
 *
 * 360 is a FLOOR and not a target — `scale.ts` says so — so a 320px viewport is a real phone that falls
 * below every declared breakpoint. The layout has nothing to say about it; a measurement must still put it
 * somewhere, and a named bucket is better than whichever branch a comparison fell through to. That one
 * extra band is asserted below as the ONLY difference between the two lists, so it reads as a decision
 * rather than as drift.
 */

/** The one band this side adds, and the only permitted difference between the two lists. */
const BELOW_EVERY_BREAKPOINT = 'base'

describe('the analytics breakpoint bands and the design tokens', () => {
  it('holds the same names, in both directions, apart from the one named band below the floor', () => {
    const tokenNames = Object.keys(BREAKPOINTS).sort()
    const analyticsNames = ANALYTICS_BREAKPOINT_BANDS.map((band) => band.name)
      .filter((name) => name !== BELOW_EVERY_BREAKPOINT)
      .sort()
    expect(
      analyticsNames,
      'a breakpoint the tokens declare and the analytics bands do not means a session is recorded in a ' +
        'band the site never lays out in, and the other direction means a real layout switch is invisible ' +
        'in the device split',
    ).toEqual(tokenNames)
    // The control: the lists are not both empty, which would satisfy the assertion above perfectly.
    expect(tokenNames.length).toBeGreaterThan(4)
  })

  it('holds the same widths for every shared name', () => {
    for (const band of ANALYTICS_BREAKPOINT_BANDS) {
      if (band.name === BELOW_EVERY_BREAKPOINT) continue
      expect(
        (BREAKPOINTS as Readonly<Record<string, number>>)[band.name],
        `${band.name} must be the token layer's width`,
      ).toBe(band.minWidth)
    }
  })

  it('orders the bands widest first, so the first match is the right one', () => {
    // `breakpointFor` returns on the first band whose minimum the width reaches, which is only correct for
    // a descending table. An ascending one would answer `base` for every width — a function that compiles,
    // never throws, and is wrong for every input.
    const widths = ANALYTICS_BREAKPOINT_BANDS.map((band) => band.minWidth)
    expect(widths).toEqual([...widths].sort((a, b) => b - a))
    expect(ANALYTICS_BREAKPOINT_BANDS.at(-1)?.minWidth).toBe(0)
  })

  it('classifies a width into the band the tokens would, at the boundary and either side of it', () => {
    for (const [name, width] of Object.entries(BREAKPOINTS)) {
      expect(breakpointFor(width), `${width} is exactly ${name}`).toBe(name)
      // One pixel below a breakpoint is the band BELOW it, which is what a min-width media query does.
      expect(breakpointFor(width - 1), `${width - 1} is below ${name}`).not.toBe(name)
    }
    expect(breakpointFor(320)).toBe(BELOW_EVERY_BREAKPOINT)
    expect(breakpointFor(null)).toBe(BREAKPOINT_UNKNOWN)
    // A width that cannot be one. A zero or a negative viewport is a client reporting nonsense, and the
    // honest answer is the same as reporting nothing rather than a band it happens to fall into.
    expect(breakpointFor(0)).toBe(BREAKPOINT_UNKNOWN)
    expect(breakpointFor(-1)).toBe(BREAKPOINT_UNKNOWN)
    expect(breakpointFor(Number.NaN)).toBe(BREAKPOINT_UNKNOWN)
  })

  it('splits devices on the same two breakpoints and nowhere else', () => {
    expect(deviceKindFor(320)).toBe('mobile')
    expect(deviceKindFor(BREAKPOINTS.md - 1)).toBe('mobile')
    expect(deviceKindFor(BREAKPOINTS.md)).toBe('tablet')
    expect(deviceKindFor(BREAKPOINTS.lg - 1)).toBe('tablet')
    expect(deviceKindFor(BREAKPOINTS.lg)).toBe('desktop')
    expect(deviceKindFor(BREAKPOINTS.xxl)).toBe('desktop')
    expect(deviceKindFor(null)).toBe('unknown')
    // Every answer is one the database's CHECK admits, which is the claim that matters: a fifth device kind
    // here would be a 23514 from an INSERT rather than a type error.
    for (const width of [null, 0, 320, 480, 768, 1024, 1280, 1600, 4000]) {
      expect(DEVICE_KINDS).toContain(deviceKindFor(width))
    }
  })

  it('offers exactly the breakpoints the two functions can produce', () => {
    // Both directions over the exported list: a name in it nothing produces is a value a reader of the
    // analytics page would look for and never see, and a name produced that is not in it is a value a
    // downstream `switch` would fall through.
    const produced = new Set<string>([BREAKPOINT_UNKNOWN])
    for (let width = 1; width <= 2000; width += 1) produced.add(breakpointFor(width))
    expect([...produced].sort()).toEqual([...ANALYTICS_BREAKPOINTS].sort())
  })
})

/**
 * The third statement of the device vocabulary is in SQL, and this is what holds it to the other two.
 *
 * Migration 0096 declares `session_device_kind_known` and the Drizzle mirror restates it because
 * `pnpm db:drift` compares the two; `DEVICE_KINDS` in `@berelax/shared` is what the route writes from. SQL
 * cannot import, so there is no derivation available — only a scan, which is the arrangement A-FIRST-03
 * recorded for `attribution_basis_known` and A-FIRST-01 for the funnel enum.
 */
describe('the device vocabulary, in all three places it is written', () => {
  const REPO_ROOT = new URL('../../../', import.meta.url).pathname
  const MIGRATIONS = join(REPO_ROOT, 'packages', 'db', 'migrations')

  /** Every word inside the `in (...)` list of a named CHECK, from whichever migration declares it. */
  const checkVocabulary = (constraint: string): readonly string[] => {
    const found: string[] = []
    for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'))) {
      const text = readFileSync(join(MIGRATIONS, file), 'utf8')
      const match = new RegExp(`${constraint}[\\s\\S]{0,200}?in \\(([^)]*)\\)`).exec(text)
      if (match?.[1] === undefined) continue
      for (const word of match[1].matchAll(/'([a-z_]+)'/g)) found.push(word[1] as string)
    }
    return found.sort()
  }

  it('has one device vocabulary, not three', () => {
    const inSql = checkVocabulary('session_device_kind_known')
    expect(
      inSql,
      'the migration and the Drizzle mirror both declare session_device_kind_known, and DEVICE_KINDS is ' +
        'what the route writes from. A word in one and not the others is an INSERT the database refuses ' +
        'with a 23514 that names a constraint rather than the vocabulary that disagreed',
    ).toEqual([...DEVICE_KINDS].sort())
    // The control: the scan found something. An `in (...)` that stopped matching would return [] and the
    // assertion above would fail rather than pass, but it would fail about the wrong thing.
    expect(inSql.length).toBe(DEVICE_KINDS.length)
  })
})
