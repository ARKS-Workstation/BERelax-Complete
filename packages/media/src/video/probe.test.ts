import { describe, expect, it } from 'vitest'
import {
  assertCodecTag,
  assertFaststart,
  assertPingPongDuration,
  compareFrames,
  findBoxPath,
  probeMp4,
  readBoxes,
  readCodecTag,
  readDuration,
  readFaststart,
  readTrackSummary,
  readY4mHeader,
  topLevelBoxOrder,
} from './probe.ts'
import { STAND_IN_MARKER, standInMp4 } from './testing.ts'

/**
 * The parser, against files built to be wrong.
 *
 * Every assertion here has a control that must fail, because the two facts this file reads are exactly the
 * two that a successful ffmpeg run and a green log line will not reveal: `-movflags +faststart` is a request
 * that can go unhonoured, and an HEVC track tagged `hev1` is legal ISO BMFF that Safari ignores without
 * firing an error. A parser nobody has seen reject a file is not a check.
 */
describe('box order, which is what faststart actually means', () => {
  it('reads the top-level boxes in file order', () => {
    const order = topLevelBoxOrder(standInMp4())
    expect(order).toEqual(['ftyp', 'free', 'moov', 'mdat'])
    expect(order.indexOf('moov')).toBeLessThan(order.indexOf('mdat'))
  })

  it('accepts moov before mdat and refuses moov after it', () => {
    expect(() => assertFaststart(standInMp4(), 'desktop/h264')).not.toThrow()
    expect(readFaststart(standInMp4()).faststart).toBe(true)

    // The known-bad file: exactly what ffmpeg writes when the faststart rewrite does not run. The flag was
    // passed, the exit status was zero, and playback cannot begin until the whole download has finished.
    const late = standInMp4({ faststart: false })
    expect(topLevelBoxOrder(late)).toEqual(['ftyp', 'free', 'mdat', 'moov'])
    expect(readFaststart(late).faststart).toBe(false)
    expect(() => assertFaststart(late, 'desktop/h264')).toThrow(/\[mp4-moov-after-mdat\]/)
    // The label reaches the message, so a four-rendition build says which one.
    expect(() => assertFaststart(late, 'desktop/h264')).toThrow(/desktop\/h264/)
  })

  it('separates "no index" from "index in the wrong place"', () => {
    // Two different causes — a fragmented muxer output, and a rewrite that did not happen — so two rules.
    // A well-formed box sequence carrying neither index: cut at the end of the `free` box, so every box in
    // it is complete and the only thing missing is the pair.
    const bytes = standInMp4()
    const free = readBoxes(bytes).find((box) => box.type === 'free')
    if (free === undefined) throw new Error('the fixture no longer carries its marker box')
    const noIndex = bytes.subarray(0, free.offset + free.size)
    expect(topLevelBoxOrder(noIndex)).toEqual(['ftyp', 'free'])
    expect(() => assertFaststart(noIndex, 'mobile/hevc')).toThrow(/\[mp4-has-no-moov-and-mdat\]/)
  })

  it('refuses a box whose declared size runs past the end', () => {
    // A truncated file must not read as a short one: `assertFaststart` would then report "no mdat" for a
    // file that has one, and the finding would point at the muxer instead of at the transfer.
    const truncated = standInMp4({ padToBytes: 4096 }).subarray(0, 300)
    expect(() => topLevelBoxOrder(truncated)).toThrow(/\[mp4-box-runs-past-end\]/)
  })

  it('walks a nested path and refuses to descend into a box that is not a container', () => {
    const bytes = standInMp4()
    expect(findBoxPath(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])).toBeDefined()
    expect(findBoxPath(bytes, ['moov', 'nope'])).toBeUndefined()
    // `stsd`'s payload starts with a version and an entry count, not a box. A parser that guessed would
    // read the entry count as a box size and walk off into the sample table.
    expect(findBoxPath(bytes, ['moov', 'mvhd', 'trak'])).toBeUndefined()
    expect(readBoxes(bytes).length).toBe(4)
  })
})

describe('the codec tag, which is four characters inside stsd', () => {
  it('reads avc1 and hvc1 out of the sample entry', () => {
    expect(readCodecTag(standInMp4({ codecTag: 'avc1' }))).toBe('avc1')
    expect(readCodecTag(standInMp4({ codecTag: 'hvc1' }))).toBe('hvc1')
    expect(() =>
      assertCodecTag(standInMp4({ codecTag: 'hvc1' }), 'hvc1', 'desktop/hevc'),
    ).not.toThrow()
  })

  it('refuses hev1 where hvc1 is required', () => {
    // The whole reason the tag is read rather than trusted: Safari ignores an hev1 track silently — no error
    // event, no `playing` event, the poster simply stays — so nothing downstream would report this.
    const wrong = standInMp4({ codecTag: 'hev1' })
    expect(readCodecTag(wrong)).toBe('hev1')
    expect(() => assertCodecTag(wrong, 'hvc1', 'desktop/hevc')).toThrow(
      /\[mp4-codec-tag-unexpected\]/,
    )
    expect(() => assertCodecTag(wrong, 'hvc1', 'desktop/hevc')).toThrow(/hev1/)
    // And the converse, so the rule is not "always throw": an H.264 track tagged hvc1 is refused too.
    expect(() => assertCodecTag(standInMp4({ codecTag: 'hvc1' }), 'avc1', 'desktop/h264')).toThrow(
      /\[mp4-codec-tag-unexpected\]/,
    )
  })

  it('does not mistake the marker or a brand list for a sample entry', () => {
    // `hvc1` appears in `ftyp` compatible-brand lists and inside `hvcC` payloads, which is why this reads a
    // box at a known offset rather than searching for the string.
    const bytes = standInMp4({ codecTag: 'avc1' })
    expect(Buffer.from(bytes).includes(STAND_IN_MARKER)).toBe(true)
    expect(readCodecTag(bytes)).toBe('avc1')
  })
})

describe('duration', () => {
  it('reads the movie timescale and duration from mvhd', () => {
    const duration = readDuration(standInMp4({ durationSeconds: 3, timescale: 1000 }))
    expect(duration?.timescale).toBe(1000)
    expect(duration?.units).toBe(3000)
    expect(duration?.seconds).toBeCloseTo(3, 5)
  })

  it('reads the track geometry, rate and frame count', () => {
    const track = readTrackSummary(
      standInMp4({ width: 1920, height: 1080, durationSeconds: 4, frameRate: 25 }),
    )
    expect(track?.width).toBe(1920)
    expect(track?.height).toBe(1080)
    expect(track?.sampleCount).toBe(100)
    expect(track?.frameRate).toBeCloseTo(25, 5)
    // The control: a different declared geometry reads differently, so the offsets are being used.
    expect(readTrackSummary(standInMp4({ width: 720, height: 900 }))?.width).toBe(720)
  })

  it('accepts a ping-pong of exactly twice the master and refuses one that is not', () => {
    const master = { timescale: 25, units: 75, seconds: 3 }
    const good = { timescale: 1000, units: 6000, seconds: 6 }
    expect(() =>
      assertPingPongDuration({ master, rendition: good, frameRate: 25, label: 'desktop/h264' }),
    ).not.toThrow()
    // One frame at 25fps is 40ms, and the tolerance is exactly that: 6.03s passes, 6.2s does not.
    expect(() =>
      assertPingPongDuration({
        master,
        rendition: { ...good, seconds: 6.03 },
        frameRate: 25,
        label: 'x',
      }),
    ).not.toThrow()
    // The known-bad case, and it is the realistic one: the reverse leg did not run, so the output is the
    // master's own length and the loop cuts at the wrap instead of turning.
    expect(() =>
      assertPingPongDuration({
        master,
        rendition: { ...good, seconds: 3 },
        frameRate: 25,
        label: 'desktop/h264',
      }),
    ).toThrow(/\[ping-pong-duration-wrong\]/)
  })
})

describe('the frame comparison at the loop wrap', () => {
  it('passes identical frames and fails frames that differ beyond tolerance', () => {
    const flat = new Uint8Array(300).fill(120)
    expect(compareFrames(flat, flat, { tolerance: 2, maxDifferingRatio: 0.01 }).seamless).toBe(true)
    expect(compareFrames(flat, flat, { tolerance: 2, maxDifferingRatio: 0.01 }).maxDelta).toBe(0)

    // A whole frame two levels off is inside the per-channel tolerance: that is a lossy encode, not a cut.
    const nudged = new Uint8Array(300).fill(122)
    expect(compareFrames(flat, nudged, { tolerance: 2, maxDifferingRatio: 0.01 }).seamless).toBe(
      true,
    )

    // A different picture is not. The known-bad case is the loop that cuts: the last frame is the master's
    // LAST frame rather than its first, so the wrap is a jump.
    const other = new Uint8Array(300).fill(40)
    const verdict = compareFrames(flat, other, { tolerance: 2, maxDifferingRatio: 0.01 })
    expect(verdict.seamless).toBe(false)
    expect(verdict.differing).toBe(300)
    expect(verdict.maxDelta).toBe(80)
  })

  it('tolerates a few outlying samples and not a majority of them', () => {
    const a = new Uint8Array(1000).fill(100)
    const b = new Uint8Array(1000).fill(100)
    for (let index = 0; index < 5; index += 1) b[index] = 200
    // Five samples in a thousand is chroma subsampling at an edge, not a broken loop.
    expect(compareFrames(a, b, { tolerance: 2, maxDifferingRatio: 0.01 }).seamless).toBe(true)
    for (let index = 0; index < 500; index += 1) b[index] = 200
    expect(compareFrames(a, b, { tolerance: 2, maxDifferingRatio: 0.01 }).seamless).toBe(false)
  })

  it('refuses to compare two different geometries', () => {
    // A comparison across a resize would report a difference that is a resize rather than a cut, which is
    // the shape of a test that passes for the wrong reason.
    expect(() =>
      compareFrames(new Uint8Array(10), new Uint8Array(20), {
        tolerance: 2,
        maxDifferingRatio: 0.01,
      }),
    ).toThrow(/\[frame-size-mismatch\]/)
  })
})

describe('the y4m header, which is how the stand-in declares itself', () => {
  it('reads the geometry, the rate and the extension parameters', () => {
    const header = readY4mHeader(
      Buffer.from(`YUV4MPEG2 W1920 H1080 F25:1 Ip A1:1 C420mpeg2 X${STAND_IN_MARKER}\nFRAME\n`),
    )
    expect(header?.width).toBe(1920)
    expect(header?.height).toBe(1080)
    expect(header?.frameRate).toBe(25)
    expect(header?.colourSpace).toBe('420mpeg2')
    expect(header?.extensions.some((extra) => extra.includes(STAND_IN_MARKER))).toBe(true)
  })

  it('returns undefined for anything that is not one', () => {
    // The control, and the reason it is `undefined` rather than a throw: `describeMaster` uses this to decide
    // which container it has, and an MP4 must fall through to the box parser rather than fail here.
    expect(readY4mHeader(standInMp4())).toBeUndefined()
    expect(readY4mHeader(Buffer.from('YUV4MPEG2 Wxx Hyy F25:1\n'))).toBeUndefined()
  })
})

describe('the one-pass probe', () => {
  it('reports every fact a caller logs, and reports them from the bytes', () => {
    const probe = probeMp4(standInMp4({ codecTag: 'hvc1', durationSeconds: 6, padToBytes: 5000 }))
    expect(probe.bytes).toBe(5000)
    expect(probe.faststart).toBe(true)
    expect(probe.codecTag).toBe('hvc1')
    expect(probe.duration?.seconds).toBeCloseTo(6, 5)
    expect(probe.boxOrder).toContain('mdat')
  })
})
