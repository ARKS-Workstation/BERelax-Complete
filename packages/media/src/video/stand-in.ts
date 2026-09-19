/**
 * The marked stand-in hero master, because there is no hero footage.
 *
 * ## What is actually in the repository
 *
 * `assets/media/` holds twenty-five files extracted from the business's own prototype: nineteen staff
 * portraits, four interiors, two wordmarks. **Not one frame of video.** `pnpm media` catalogues them and
 * the shot list in docs/08 §6 puts "hero loop" first among the things still to be shot. So the four
 * renditions this unit produces have nothing real to be produced from, and the choice is between leaving
 * the pipeline unexercised and giving it an input that cannot be mistaken for footage.
 *
 * This is that input, and it is deliberately the thing docs/08 §8's cut order already names as an
 * acceptable *shipping* option: "Drop video everywhere; animate the poster with a 24s `scale(1.0 → 1.06)`.
 * Zero network bytes, reduced-motion-safe, genuinely beautiful on a calm site." A slow scale of the real
 * committed hero photograph is therefore not an invention — it is the fallback the design document
 * already sanctions, rendered as frames so the encoder has something to encode.
 *
 * ## Why it cannot be mistaken for the real thing
 *
 * Three markers, none of them removable by accident:
 *
 *  - The y4m header carries `X` + `STAND_IN_MARKER`, which names `Y12-hero-video`. `readY4mHeader` reads
 *    it back, `describeMaster` reports it, and the job's log line and result both say so — so no run can
 *    claim to have encoded footage.
 *  - It is **uncompressed**. A y4m of a 3-second 1080p loop is 233MB. Nothing would ever ship one, and
 *    nothing would mistake one for a delivered master.
 *  - It is one photograph. There is no cut, no motion in the frame and no person moving; it is visibly a
 *    still being scaled, which is what the cut order describes.
 *
 * ## Uncompressed, and therefore capped
 *
 * `MAX_STAND_IN_BYTES` exists because the frames are held in memory as one buffer. 1920×1080 in 4:2:0 is
 * 3.11MB per frame, so the cap is about 84 frames — 3.3 seconds at 25fps, which the ping-pong filter turns
 * into a 6.6-second loop. That is longer than docs/08 §8's cut order asks a hero loop to be, so the cap
 * costs nothing real, and a caller that asks for more is refused by name rather than by the OOM killer.
 */
import { AppError } from '@berelax/shared'
import sharp from 'sharp'
import { CROPS } from '../ladders.ts'
import { STAND_IN_MARKER } from './testing.ts'

export { STAND_IN_MARKER }

/** 256MiB. See the file header: one buffer, 3.11MB per 1080p frame. */
export const MAX_STAND_IN_BYTES = 256 * 1024 * 1024

/** docs/08 §8's cut order #6: `scale(1.0 → 1.06)`. The end of the ramp, not a number chosen here. */
export const STAND_IN_ZOOM = 1.06

export interface StandInMasterOptions {
  /** The committed photograph the frames are made from. A real asset, never generated. */
  readonly source: Uint8Array
  readonly width?: number
  readonly height?: number
  readonly frames?: number
  readonly frameRate?: number
}

/**
 * BT.709 studio-swing coefficients, as the specification states them.
 *
 * Limited range, not full: y4m has no colour-range tag and ffmpeg reads `C420mpeg2` as limited, so full-
 * range samples here would be re-interpreted as limited and every rendition would come out with crushed
 * blacks and clipped highlights — on pastel photography, which is the one subject where that is obvious.
 * White lands on 235 and black on 16 by construction; `stand-in.test.ts` asserts both, plus the 240
 * ceiling on Cr for pure red, so a transposed coefficient fails rather than shifting the grade.
 */
const BT709 = {
  y: [0.1826, 0.6142, 0.062],
  cb: [-0.1006, -0.3386, 0.4392],
  cr: [0.4392, -0.3989, -0.0403],
} as const

const clamp = (value: number): number => (value < 0 ? 0 : value > 255 ? 255 : Math.round(value))

export interface Yuv420Frame {
  readonly y: Uint8Array
  readonly u: Uint8Array
  readonly v: Uint8Array
}

/**
 * One packed RGB frame to three planes, chroma box-averaged 2×2.
 *
 * Box-averaged rather than point-sampled: taking every second pixel's chroma aliases a fine pattern into a
 * colour shimmer that the encoder then spends bits on. Averaging is one addition per sample and is what
 * every real converter does.
 */
export function rgbToYuv420(rgb: Uint8Array, width: number, height: number): Yuv420Frame {
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new AppError(
      'validation',
      `[stand-in-odd-dimensions] 4:2:0 subsamples chroma by two, so ${width}x${height} has no ` +
        'representable chroma plane',
      { details: { width, height } },
    )
  }
  const luma = new Uint8Array(width * height)
  const chromaWidth = width / 2
  const chromaHeight = height / 2
  const u = new Uint8Array(chromaWidth * chromaHeight)
  const v = new Uint8Array(chromaWidth * chromaHeight)
  const cbFull = new Float32Array(width * height)
  const crFull = new Float32Array(width * height)

  for (let index = 0; index < width * height; index += 1) {
    const r = rgb[index * 3] ?? 0
    const g = rgb[index * 3 + 1] ?? 0
    const b = rgb[index * 3 + 2] ?? 0
    luma[index] = clamp(16 + BT709.y[0] * r + BT709.y[1] * g + BT709.y[2] * b)
    cbFull[index] = 128 + BT709.cb[0] * r + BT709.cb[1] * g + BT709.cb[2] * b
    crFull[index] = 128 + BT709.cr[0] * r + BT709.cr[1] * g + BT709.cr[2] * b
  }

  for (let row = 0; row < chromaHeight; row += 1) {
    for (let column = 0; column < chromaWidth; column += 1) {
      const a = row * 2 * width + column * 2
      const b = a + 1
      const c = a + width
      const d = c + 1
      const at = row * chromaWidth + column
      u[at] = clamp(((cbFull[a] ?? 0) + (cbFull[b] ?? 0) + (cbFull[c] ?? 0) + (cbFull[d] ?? 0)) / 4)
      v[at] = clamp(((crFull[a] ?? 0) + (crFull[b] ?? 0) + (crFull[c] ?? 0) + (crFull[d] ?? 0)) / 4)
    }
  }
  return { y: luma, u, v }
}

/** The y4m stream header, with the stand-in marker as an `X` extension parameter. */
export function y4mHeaderLine(input: {
  readonly width: number
  readonly height: number
  readonly frameRate: number
}): string {
  return (
    `YUV4MPEG2 W${input.width} H${input.height} F${input.frameRate}:1 Ip A1:1 C420mpeg2 ` +
    `XCOLORRANGE=LIMITED X${STAND_IN_MARKER}\n`
  )
}

/**
 * The stand-in master: a 16:9 window of the real hero photograph, scaled from 1.00 to 1.06.
 *
 * The window is taken at the desktop crop's declared ratio, read from `CROPS` rather than written here, so
 * the master this produces is the shape `masterViolations` requires and the shape the poster behind it
 * uses. The zoom is applied by narrowing the extracted window rather than by upscaling the output, which
 * is why the last frame is as sharp as the first.
 */
export async function standInMasterY4m(options: StandInMasterOptions): Promise<Uint8Array> {
  const width = options.width ?? 1920
  const height = options.height ?? 1080
  const frames = options.frames ?? 75
  const frameRate = options.frameRate ?? 25

  const frameBytes = (width * height * 3) / 2
  const total = frameBytes * frames
  if (total > MAX_STAND_IN_BYTES) {
    throw new AppError(
      'validation',
      `[stand-in-master-too-large] ${frames} frames of ${width}x${height} in 4:2:0 is ${total} bytes ` +
        `against a ${MAX_STAND_IN_BYTES}-byte ceiling. A y4m is uncompressed and is held as one buffer; ` +
        'shorten the loop — docs/08 §8 already cuts it to four seconds before it touches anything else.',
      { details: { width, height, frames, total, ceiling: MAX_STAND_IN_BYTES } },
    )
  }

  const metadata = await sharp(options.source).metadata()
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new AppError(
      'validation',
      '[stand-in-source-unreadable] the source has no pixel dimensions',
    )
  }
  const [ratioWidth, ratioHeight] = CROPS.desktop.ratio
  const ratio = ratioWidth / ratioHeight
  // The largest window of the declared ratio the photograph contains, centred. Cropping to the ratio
  // before the zoom ramp means every frame is the same shape and no frame letterboxes.
  let baseWidth = metadata.width
  let baseHeight = Math.round(metadata.width / ratio)
  if (baseHeight > metadata.height) {
    baseHeight = metadata.height
    baseWidth = Math.round(metadata.height * ratio)
  }

  const parts: Uint8Array[] = [Buffer.from(y4mHeaderLine({ width, height, frameRate }), 'ascii')]
  const frameHeader = Buffer.from('FRAME\n', 'ascii')

  for (let frame = 0; frame < frames; frame += 1) {
    const progress = frames === 1 ? 0 : frame / (frames - 1)
    const zoom = 1 + (STAND_IN_ZOOM - 1) * progress
    // `& ~1` keeps the window even so the chroma plane is exact at every step of the ramp.
    const windowWidth = Math.max(2, Math.floor(baseWidth / zoom) & ~1)
    const windowHeight = Math.max(2, Math.floor(baseHeight / zoom) & ~1)
    const raw = await sharp(options.source)
      .extract({
        left: Math.floor((metadata.width - windowWidth) / 2),
        top: Math.floor((metadata.height - windowHeight) / 2),
        width: windowWidth,
        height: windowHeight,
      })
      // The same colour management the image pipeline uses (docs/08 §6): resize in 16-bit linear light,
      // then come back to sRGB. Resizing gamma-encoded pastels in 8 bits dulls them, and a video hero
      // that does not match the poster it cross-fades from is the one defect nobody can unsee.
      .pipelineColourspace('rgb16')
      .resize({ width, height, fit: 'cover' })
      .toColourspace('srgb')
      .raw()
      .toBuffer()
    const planes = rgbToYuv420(raw, width, height)
    parts.push(frameHeader, planes.y, planes.u, planes.v)
  }

  return Buffer.concat(parts)
}
