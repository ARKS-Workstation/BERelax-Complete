import { describe, expect, it } from 'vitest'
import { DURATION } from '../tokens/scale.ts'
import {
  HERO_ATTACH_IDLE_TIMEOUT_MS,
  HERO_ATTACH_LOAD_DELAY_MS,
  HERO_CONTROLS,
  HERO_HOLD_REASONS,
  HERO_MIN_DOWNLINK_KBPS,
  HERO_MIN_SAMPLE_BYTES,
  HERO_STATES,
  heroAttachDecision,
  MOTION_CHOICES,
  measuredDownlinkKbps,
  motionIsReduced,
  parseMotionChoice,
  type ResourceTimingSample,
  transparencyIsReduced,
} from './attach-video.ts'
import { HERO_CROSS_FADE_MS, HERO_MEDIA_CSS } from './styles.ts'

/**
 * W-SYS-07 — the attach decision, without a browser.
 *
 * Everything the island decides is here, and every case has the control that must fail beside it. Three of
 * the assertions are about a hero that *is* attached, because a gate can be wrong in both directions: a
 * hero that never plays passes every "does it refuse" test ever written.
 */

/** A connection fast enough to carry the 350KB rendition: 8KB in 10ms is about 6.5 Mbit/s. */
const FAST: readonly ResourceTimingSample[] = [{ transferSize: 8192, duration: 10 }]
/** 8KB in 200ms is 327 kbit/s, under docs/08 §6's 600. */
const SLOW: readonly ResourceTimingSample[] = [{ transferSize: 8192, duration: 200 }]

/** A navigator with no `connection` object at all. That is Safari, which is most of this site's phones. */
const SAFARI = {}

const BASE = {
  ambientDuration: '12s',
  videoFlag: '1',
  storedChoice: null,
  samples: FAST,
  declaredSources: 2,
  navigator: SAFARI,
} as const

describe('the reduced-motion answer comes from the token the override zeroes', () => {
  it('reads 0s as reduced and a real duration as not', () => {
    expect(motionIsReduced('0s')).toBe(true)
    expect(motionIsReduced(' 0s ')).toBe(true)
    expect(motionIsReduced('0ms')).toBe(true)
    // The control: the authored value, which is what a reader who has not asked for less motion gets.
    expect(motionIsReduced('12s')).toBe(false)
    expect(motionIsReduced('120ms')).toBe(false)
  })

  it('treats an unreadable value as reduced, which is the fail-safe direction', () => {
    // A stylesheet that never loaded, a `var()` that resolved to nothing, a hand-edited token. Playing
    // motion at a reader who may have asked for none is the harm; showing the poster is not.
    for (const value of ['', '   ', 'auto', 'var(--dur-ambient)', null, undefined]) {
      expect(motionIsReduced(value), String(value)).toBe(true)
    }
  })

  it('is the number the token layer actually publishes', () => {
    // The two halves of "read the token rather than the media query" only agree if the token is the one
    // the override touches. `--dur-ambient` is authored at 12s and zeroed under reduce.
    expect(motionIsReduced('12s')).toBe(false)
    expect(DURATION.slow).toBe('320ms')
  })
})

describe('the reduced-transparency answer comes from this component’s own flag', () => {
  it('reads 0 as reduced and 1 as not', () => {
    expect(transparencyIsReduced('0')).toBe(true)
    expect(transparencyIsReduced(' 0 ')).toBe(true)
    expect(transparencyIsReduced('1')).toBe(false)
    // Absent means the stylesheet is not there, which is not a statement about transparency: the hero's
    // own CSS declares the flag, so a page without it has no hero to hold.
    expect(transparencyIsReduced(null)).toBe(false)
    expect(transparencyIsReduced('')).toBe(false)
  })

  it('is declared by the stylesheet in exactly one media query', () => {
    const queries = HERO_MEDIA_CSS.match(/@media[^{]+/g) ?? []
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('prefers-reduced-transparency')
    // And the reduced-motion query is NOT here: `pnpm layout` allows it in one authored file, which is the
    // token emitter, and this reads the token instead.
    expect(HERO_MEDIA_CSS).not.toContain('prefers-reduced-motion')
    expect(HERO_MEDIA_CSS).toContain('--hero-video: 0;')
  })

  it('reads the 8px blur maximum from the header’s token rather than restating it', () => {
    // docs/08 §8 states 8px once, in motion/tokens.css, together with its own reduced-transparency
    // override. A literal here would be a second number to keep in step and a blur that survived the
    // setting.
    expect(HERO_MEDIA_CSS).toContain('--hero-control-blur: var(--header-blur)')
    expect(HERO_MEDIA_CSS).not.toMatch(/blur\(\s*\d/)
  })

  it('cross-fades over the duration token docs/08 §6 asks for', () => {
    expect(HERO_CROSS_FADE_MS).toBe(320)
    expect(HERO_MEDIA_CSS).toContain('transition: opacity var(--dur-slow) linear')
    // The control: the number is not written in the stylesheet at all, so it cannot drift from the token.
    expect(HERO_MEDIA_CSS).not.toContain('320ms')
  })
})

describe('the slow-connection gate is a measurement', () => {
  it('computes kbit/s directly from bytes and milliseconds', () => {
    // (8192 * 8) / 10 = 6553.6 kbit/s.
    expect(measuredDownlinkKbps(FAST)).toBeCloseTo(6553.6, 1)
    expect(measuredDownlinkKbps(SLOW)).toBeCloseTo(327.68, 1)
  })

  it('takes the best sample, not the worst, because a duration includes queueing', () => {
    expect(measuredDownlinkKbps([...SLOW, ...FAST])).toBeCloseTo(6553.6, 1)
  })

  it('ignores samples that cannot measure throughput', () => {
    const tiny = { transferSize: HERO_MIN_SAMPLE_BYTES - 1, duration: 500 }
    const cached = { transferSize: 0, duration: 4 }
    const instant = { transferSize: 200_000, duration: 0 }
    expect(measuredDownlinkKbps([tiny, cached, instant])).toBeNull()
    // The control: one byte over the floor is a sample.
    expect(
      measuredDownlinkKbps([{ transferSize: HERO_MIN_SAMPLE_BYTES, duration: 500 }]),
    ).not.toBeNull()
  })

  it('ignores a transferSize an engine did not implement', () => {
    // `NaN < 4096` is false, so a size check alone lets a NaN through and the best observed throughput
    // becomes NaN — which compares false against the floor and would attach the video on every
    // connection. This is that case, written down.
    const unimplemented = { transferSize: Number.NaN, duration: 50 } as ResourceTimingSample
    expect(measuredDownlinkKbps([unimplemented])).toBeNull()
    expect(heroAttachDecision({ ...BASE, samples: [unimplemented] }).attach).toBe(true)
  })

  it('does not depend on navigator.connection, because Safari has none', () => {
    // The acceptance criterion's case. A navigator with no `connection` object at all, twice: the gate's
    // answer comes from the timings both times, and the two answers differ.
    expect(heroAttachDecision({ ...BASE, navigator: SAFARI, samples: FAST }).attach).toBe(true)
    const held = heroAttachDecision({ ...BASE, navigator: SAFARI, samples: SLOW })
    expect(held.attach).toBe(false)
    expect(held.reason).toBe('slow-connection')
    expect(held.downlinkKbps).toBeCloseTo(327.68, 1)
    // And the control that says the timings are what decided it: the same navigator, a connection object
    // that says the link is fine, and the slow timings still win.
    const contradicted = heroAttachDecision({
      ...BASE,
      navigator: { connection: { saveData: false } },
      samples: SLOW,
    })
    expect(contradicted.reason).toBe('slow-connection')
  })

  it('does not hold the video for an empty measurement', () => {
    // Everything served from cache reports `transferSize: 0`. A warm cache is not a slow connection, and
    // refusing the video to the reader who comes back most often would be exactly the wrong way round.
    expect(heroAttachDecision({ ...BASE, samples: [] }).attach).toBe(true)
  })

  it('holds the still for a reader who asked for less data, and names that reason', () => {
    const held = heroAttachDecision({
      ...BASE,
      navigator: { connection: { saveData: true } },
    })
    expect(held.attach).toBe(false)
    expect(held.reason).toBe('data-saver')
    // Offered, rather than hidden: this is a stated preference about bytes, not about motion, and a reader
    // who wants the loop anyway may have it.
    expect(held.control).toBe('play')
  })
})

describe('the order of the gates', () => {
  it('attaches, and shows a pause control, when nothing says otherwise', () => {
    const decision = heroAttachDecision(BASE)
    expect(decision).toMatchObject({ attach: true, reason: null, control: 'pause' })
  })

  it('never attaches under reduced motion, and offers no control', () => {
    const held = heroAttachDecision({ ...BASE, ambientDuration: '0s' })
    expect(held.attach).toBe(false)
    expect(held.reason).toBe('reduced-motion')
    // No control: there is no moving content, so WCAG 2.2.2 asks for nothing, and a play button here asks
    // a reader who set the preference to set it again.
    expect(held.control).toBe('hidden')
  })

  it('does not let a stored choice, a gesture or a fast link past reduced motion', () => {
    for (const extra of [
      { storedChoice: 'playing' },
      { readerAsked: true },
      { samples: FAST },
    ] as const) {
      const held = heroAttachDecision({ ...BASE, ambientDuration: '0s', ...extra })
      expect(held.reason, JSON.stringify(extra)).toBe('reduced-motion')
    }
  })

  it('never attaches under reduced transparency', () => {
    const held = heroAttachDecision({ ...BASE, videoFlag: '0' })
    expect(held.attach).toBe(false)
    expect(held.reason).toBe('reduced-transparency')
    expect(held.control).toBe('hidden')
  })

  it('holds the still when the reader has paused it, and offers play', () => {
    const held = heroAttachDecision({ ...BASE, storedChoice: 'paused' })
    expect(held).toMatchObject({ attach: false, reason: 'reader-paused', control: 'play' })
    // The control: the other stored value, and a value from nowhere.
    expect(heroAttachDecision({ ...BASE, storedChoice: 'playing' }).attach).toBe(true)
    expect(heroAttachDecision({ ...BASE, storedChoice: 'PAUSED' }).attach).toBe(true)
  })

  it('lets a reader’s gesture past the gates about bytes, but not past the token gates', () => {
    expect(heroAttachDecision({ ...BASE, samples: SLOW, readerAsked: true }).attach).toBe(true)
    expect(
      heroAttachDecision({
        ...BASE,
        navigator: { connection: { saveData: true } },
        readerAsked: true,
      }).attach,
    ).toBe(true)
    expect(heroAttachDecision({ ...BASE, storedChoice: 'paused', readerAsked: true }).attach).toBe(
      true,
    )
    expect(heroAttachDecision({ ...BASE, videoFlag: '0', readerAsked: true }).attach).toBe(false)
  })

  it('holds the still when the server declared no rendition for this viewport', () => {
    const held = heroAttachDecision({ ...BASE, declaredSources: 0 })
    expect(held).toMatchObject({
      attach: false,
      reason: 'no-renditions-declared',
      control: 'hidden',
    })
  })

  it('reports the measurement whether or not it attached', () => {
    // A hold nobody can name is a hero that is "sometimes a photograph" in a bug report.
    for (const samples of [FAST, SLOW]) {
      expect(heroAttachDecision({ ...BASE, samples }).downlinkKbps).not.toBeNull()
    }
  })

  it('names a reason exactly when it refuses', () => {
    const cases = [
      BASE,
      { ...BASE, ambientDuration: '0s' },
      { ...BASE, videoFlag: '0' },
      { ...BASE, storedChoice: 'paused' },
      { ...BASE, samples: SLOW },
      { ...BASE, declaredSources: 0 },
      { ...BASE, navigator: { connection: { saveData: true } } },
    ]
    for (const input of cases) {
      const decision = heroAttachDecision(input)
      expect(decision.attach === (decision.reason === null), JSON.stringify(input)).toBe(true)
      if (decision.reason !== null) expect(HERO_HOLD_REASONS).toContain(decision.reason)
      expect(HERO_CONTROLS).toContain(decision.control)
    }
  })
})

describe('the stored choice', () => {
  it('accepts the two values it writes and nothing else', () => {
    for (const choice of MOTION_CHOICES) expect(parseMotionChoice(choice)).toBe(choice)
    for (const junk of ['', 'true', 'Paused', '{}', null, undefined]) {
      expect(parseMotionChoice(junk), String(junk)).toBeNull()
    }
  })
})

describe('the vocabulary is closed', () => {
  it('states every state, control and reason exactly once', () => {
    expect(new Set(HERO_STATES).size).toBe(HERO_STATES.length)
    expect(new Set(HERO_CONTROLS).size).toBe(HERO_CONTROLS.length)
    expect(new Set(HERO_HOLD_REASONS).size).toBe(HERO_HOLD_REASONS.length)
    // The stylesheet only ever selects on states and controls this module declares, so a rule cannot be
    // written for a state that does not exist.
    for (const match of HERO_MEDIA_CSS.matchAll(/data-hero-(state|control)="([a-z-]+)"/g)) {
      const vocabulary: readonly string[] = match[1] === 'state' ? HERO_STATES : HERO_CONTROLS
      expect(vocabulary, match[0]).toContain(match[2])
    }
  })

  it('keeps docs/08 §6’s three numbers', () => {
    expect(HERO_MIN_DOWNLINK_KBPS).toBe(600)
    // "after `requestIdleCallback` (timeout 2500) or `load + 400ms`". Both branches exist because Safari
    // has no `requestIdleCallback` at all, so the timer is the path on every iPhone.
    expect(HERO_ATTACH_IDLE_TIMEOUT_MS).toBe(2500)
    expect(HERO_ATTACH_LOAD_DELAY_MS).toBe(400)
  })
})
