import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { masterViolations } from './ladder.ts'
import { readY4mHeader } from './probe.ts'
import {
  MAX_STAND_IN_BYTES,
  rgbToYuv420,
  STAND_IN_MARKER,
  STAND_IN_ZOOM,
  standInMasterY4m,
  y4mHeaderLine,
} from './stand-in.ts'

/** The real committed hero photograph. Nothing here generates an image; it scales one. */
const HERO = new URL('../../../../assets/media/photos/hero-team.jpg', import.meta.url).pathname

/**
 * Small on purpose.
 *
 * A y4m is uncompressed, so the 1920×1080 default is 3.11MB per frame. These dimensions keep the suite fast
 * and change nothing being asserted: the colour conversion, the header, the frame count and the determinism
 * are all independent of size, and the one property that is not — the byte ceiling — has its own case.
 */
const SMALL = { width: 160, height: 90, frames: 4, frameRate: 25 } as const

describe('the colour conversion', () => {
  it('lands white on 235, black on 16 and grey on neutral chroma', () => {
    // BT.709 studio swing, as the specification states it. Limited range and not full: y4m has no
    // colour-range tag and ffmpeg reads C420mpeg2 as limited, so full-range samples here would be
    // re-interpreted and every rendition would come out with crushed blacks — on pastel photography, which
    // is the one subject where that is obvious.
    const white = rgbToYuv420(new Uint8Array(2 * 2 * 3).fill(255), 2, 2)
    expect([...white.y]).toEqual([235, 235, 235, 235])
    expect([...white.u]).toEqual([128])
    expect([...white.v]).toEqual([128])

    const black = rgbToYuv420(new Uint8Array(2 * 2 * 3).fill(0), 2, 2)
    expect([...black.y]).toEqual([16, 16, 16, 16])
    expect([...black.u]).toEqual([128])
    expect([...black.v]).toEqual([128])
  })

  it('puts pure red on the Cr ceiling the specification declares', () => {
    // 240 is BT.709's limited-range chroma maximum, and it falls out of the coefficients rather than being
    // clamped to. A transposed coefficient would not reach it, which is what makes this a check.
    const red = new Uint8Array(2 * 2 * 3)
    for (let pixel = 0; pixel < 4; pixel += 1) red[pixel * 3] = 255
    const converted = rgbToYuv420(red, 2, 2)
    expect(converted.v[0]).toBe(240)
    expect(converted.u[0]).toBeLessThan(128)
    expect(converted.y[0]).toBeGreaterThan(16)
    expect(converted.y[0]).toBeLessThan(120)
  })

  it('box-averages chroma rather than point-sampling it', () => {
    // Two red pixels and two black ones in one 2x2 block average to a chroma between the two. Point-sampling
    // would return whichever pixel happened to be first, which aliases a fine pattern into a shimmer the
    // encoder then spends bits on.
    const mixed = new Uint8Array(2 * 2 * 3)
    mixed[0] = 255
    mixed[3] = 255
    const converted = rgbToYuv420(mixed, 2, 2)
    expect(converted.v[0]).toBeGreaterThan(128)
    expect(converted.v[0]).toBeLessThan(240)
  })

  it('refuses odd dimensions, which 4:2:0 cannot represent', () => {
    expect(() => rgbToYuv420(new Uint8Array(3 * 3 * 3), 3, 3)).toThrow(
      /\[stand-in-odd-dimensions\]/,
    )
  })
})

describe('the header, which is how the stand-in declares itself', () => {
  it('carries the marker and the open-question id as an extension parameter', () => {
    const line = y4mHeaderLine({ width: 1920, height: 1080, frameRate: 25 })
    expect(line.startsWith('YUV4MPEG2 ')).toBe(true)
    expect(line).toContain(`X${STAND_IN_MARKER}`)
    expect(STAND_IN_MARKER).toContain('Y12-hero-video')
    expect(STAND_IN_MARKER).toContain('NOT-REAL-FOOTAGE')
    // Limited range stated explicitly, so a reader of the file does not have to know the C420mpeg2 default.
    expect(line).toContain('XCOLORRANGE=LIMITED')
    expect(line.endsWith('\n')).toBe(true)
  })
})

describe('the stand-in master', () => {
  it('is a readable y4m whose marker survives a round trip', async () => {
    const master = await standInMasterY4m({ source: readFileSync(HERO), ...SMALL })
    const header = readY4mHeader(master)
    expect(header?.width).toBe(SMALL.width)
    expect(header?.height).toBe(SMALL.height)
    expect(header?.frameRate).toBe(SMALL.frameRate)
    expect(header?.extensions.some((extra) => extra.includes(STAND_IN_MARKER))).toBe(true)

    // Exactly the declared number of frames, each `FRAME\n` plus three planes. The length is the evidence:
    // a generator that emitted one frame short would still produce a file ffmpeg reads.
    const headerLength = master.indexOf(0x0a) + 1
    const frameBytes = (SMALL.width * SMALL.height * 3) / 2
    expect(master.length).toBe(headerLength + SMALL.frames * (frameBytes + 'FRAME\n'.length))
  })

  it('is deterministic, so a rebuild is not a new content address', async () => {
    // The rendition paths are content-addressed on the master's bytes. A generator that varied would move all
    // four URLs on every run and make a year of `immutable` meaningless.
    const source = readFileSync(HERO)
    const first = await standInMasterY4m({ source, ...SMALL })
    const second = await standInMasterY4m({ source, ...SMALL })
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
  })

  it('actually moves, and moves by the amount docs/08 §8 names', async () => {
    // The control that keeps this from being a still repeated N times: the last frame must differ from the
    // first. `scale(1.0 → 1.06)` is docs/08 §8's cut order #6, which is where the ramp comes from.
    expect(STAND_IN_ZOOM).toBe(1.06)
    const master = await standInMasterY4m({ source: readFileSync(HERO), ...SMALL })
    const headerLength = master.indexOf(0x0a) + 1
    const frameBytes = (SMALL.width * SMALL.height * 3) / 2
    const frameAt = (index: number): Uint8Array => {
      const start = headerLength + index * (frameBytes + 6) + 6
      return master.subarray(start, start + frameBytes)
    }
    expect(Buffer.from(frameAt(0)).equals(Buffer.from(frameAt(SMALL.frames - 1)))).toBe(false)
  })

  it('produces a master the pipeline accepts at its default geometry', () => {
    // Asserted against the declared defaults rather than by generating 233MB: the point is that the default
    // stand-in is 1920x1080 at 16:9, which is what `masterViolations` requires, so the stand-in is not a
    // shape only the tests accept.
    expect(
      masterViolations({
        mimeType: 'video/x-yuv4mpegpipe',
        byteLength: 75 * ((1920 * 1080 * 3) / 2),
        durationSeconds: 3,
        width: 1920,
        height: 1080,
      }),
    ).toEqual([])
  })

  it('refuses a request too large to hold in one buffer', async () => {
    // Uncompressed: 1920x1080 in 4:2:0 is 3.11MB a frame, so the ceiling is about 84 frames. docs/08 §8's cut
    // order already shortens a hero loop to four seconds, and the ping-pong doubles whatever this produces,
    // so the ceiling costs nothing real — and a caller over it is refused by name rather than by the OOM
    // killer part-way through rendition three, which looks exactly like a flaky job.
    await expect(standInMasterY4m({ source: readFileSync(HERO), frames: 200 })).rejects.toThrow(
      /\[stand-in-master-too-large\]/,
    )
    expect(MAX_STAND_IN_BYTES).toBe(256 * 1024 * 1024)
  })
})
