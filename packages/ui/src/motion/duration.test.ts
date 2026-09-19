import { describe, expect, it } from 'vitest'
import {
  cssDurationForDistance,
  DURATION_CEILING_MS,
  DURATION_FLOOR_MS,
  DURATION_PER_PIXEL_MS,
  durationForDistance,
} from './duration.ts'

describe('acceptance — distance-duration', () => {
  it('matches the four worked examples in docs/08 §5', () => {
    expect(durationForDistance(8)).toBe(125)
    expect(durationForDistance(100)).toBe(180)
    expect(durationForDistance(400)).toBe(360)
    expect(durationForDistance(900)).toBe(480)
  })

  it('clamps to [120, 480]', () => {
    expect(durationForDistance(0)).toBe(DURATION_FLOOR_MS)
    expect(durationForDistance(0.5)).toBe(DURATION_FLOOR_MS)
    expect(durationForDistance(10_000)).toBe(DURATION_CEILING_MS)
    for (const distance of [0, 1, 8, 100, 400, 900, 5000]) {
      expect(durationForDistance(distance)).toBeGreaterThanOrEqual(DURATION_FLOOR_MS)
      expect(durationForDistance(distance)).toBeLessThanOrEqual(DURATION_CEILING_MS)
    }
  })

  it('is monotonic in distance', () => {
    let previous = 0
    for (let distance = 0; distance <= 1200; distance += 37) {
      const current = durationForDistance(distance)
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
    }
  })

  it('gives a mirrored distance the same duration as its twin', () => {
    // The RTL invariant, and the reason this takes a magnitude: an inline offset is multiplied by
    // `--dir`, so the Arabic document computes -32px where the English one computes 32px. An
    // implementation that clamped the negative to the floor would animate the Arabic page in 120ms and
    // the English one in 139ms from the same authored distance — one animation, two directions, two
    // speeds, and nothing in the CSS to explain it.
    for (const distance of [8, 32, 100, 400, 900]) {
      expect(durationForDistance(-distance)).toBe(durationForDistance(distance))
    }
  })

  it('formats as a CSS time', () => {
    expect(cssDurationForDistance(400)).toBe('360ms')
    expect(cssDurationForDistance(-400)).toBe('360ms')
  })
})

describe('the curve is a curve, which is the whole criterion', () => {
  it('does not give everything one duration', () => {
    // The thing docs/08 §5 rejects. Without this, a `return 200` would satisfy every clamp assertion
    // above: 200 is inside [120, 480] and monotonic in the weak sense.
    const durations = [8, 100, 400, 900].map(durationForDistance)
    expect(new Set(durations).size).toBe(durations.length)
    expect(durationForDistance(400) - durationForDistance(8)).toBeGreaterThan(200)
  })

  it('does not scale straight through the origin', () => {
    // The other wrong law: proportional. It would give an 8px chevron 4.8ms, which is not a movement —
    // it is two states with nothing in between. The floor is what stops the smallest and commonest
    // motions on the site from disappearing.
    expect(durationForDistance(8)).toBeGreaterThan(DURATION_PER_PIXEL_MS * 8 * 10)
    // One pixel is 120.6ms before rounding, so the floor is what is in force, not the slope.
    expect(durationForDistance(1)).toBeLessThanOrEqual(DURATION_FLOOR_MS + 1)
  })

  it('lets apparent velocity rise with distance, and bounds it while the affine part is in force', () => {
    // What the 0.6ms/px slope is for. A longer travel is allowed to move faster — a long distance at a
    // short distance's speed feels slow — and while the slope is in force the speed approaches 1/0.6
    // px/ms from below rather than climbing without limit.
    const distances = [8, 100, 200, 400, 600, 900]
    const speeds = distances.map((distance) => distance / durationForDistance(distance))
    for (let index = 1; index < speeds.length; index += 1) {
      expect(speeds[index] ?? 0).toBeGreaterThan(speeds[index - 1] ?? 0)
    }
    const affine = distances
      .filter((distance) => durationForDistance(distance) < DURATION_CEILING_MS)
      .map((distance) => distance / durationForDistance(distance))
    expect(Math.max(...affine)).toBeLessThan(1 / DURATION_PER_PIXEL_MS)

    // The control, and the reason a flat duration is not a system: at 320ms for everything the 900px
    // sheet moves half again as fast as anything this law produces at any distance.
    expect(900 / 320).toBeGreaterThan(Math.max(...speeds))
  })
})
