import { createConnection, type Sql } from '@berelax/db'
import { SLOT_REGISTRY } from '@berelax/media/slots'
import { getPayload, type Payload } from 'payload'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import config from '../payload.config.ts'

/**
 * W-SYS-09 — the slot constraints and the junk-alt filter, through Payload's own write pipeline.
 *
 * The unit tests in `packages/media/src/slots` prove the rules. This proves they are connected to
 * something: that the hook runs on create *and* on update, that a refusal is a 400 the admin can show
 * rather than an unhandled throw, that Payload's native focal point really does arrive as two percentages,
 * and that a row Payload accepted is a row whose constraints were checked.
 *
 * None of that is provable without booting Payload. A hook is a dozen layers deep in an operation that
 * merges partial data, runs field validators, opens a transaction and calls `beforeChange` with a document
 * assembled from three sources — and "the validator is correct" says nothing about whether it is reached.
 *
 * Every row this file creates is deleted in `afterAll`. `media` is not an append-only table (ADR 0008
 * names the three that are), and leaving rows behind would make the next unit's count assertions somebody
 * else's problem — the failure mode the brief's rule 12 records three times over.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''

/** Alt text that passes the filter, so a refusal in a test is never about the alt text by accident. */
const GOOD_ALT = 'Therapist warming aromatherapy oil between her palms before a back massage'

/** Marks every row this file creates, so teardown can find them and nothing else. */
const CREDIT_MARKER = 'W-SYS-09 integration fixture'

let payload: Payload
let sql: Sql
let owner: { readonly id: string; readonly collection: string; readonly role: string }

/**
 * A deterministic pastel gradient at the requested size.
 *
 * Synthetic rather than one of the real photographs, for the reason `packages/media/src/derivatives.itest.ts`
 * gives: what is under test here is Payload's pipeline and the slot constraints, and those are properties of
 * numbers. The real photography is measured against these same constraints in
 * `packages/fixtures/src/media-slots.itest.ts`, which is where a file on disk belongs.
 */
async function image(width: number, height: number, quality = 80): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3
      raw[i] = 212 + Math.round((16 * x) / width)
      raw[i + 1] = 208 + Math.round((20 * y) / height)
      raw[i + 2] = 202
    }
  }
  return await sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality })
    .toBuffer()
}

/** Noise, which is what makes a file large. Used only to exceed a byte cap. */
async function heavyImage(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3)
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 2654435761) % 251
  return await sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer()
}

interface UploadArgs {
  readonly slot: string
  readonly bytes: Buffer
  readonly name: string
  readonly mimetype?: string
  readonly data?: Record<string, unknown>
}

async function upload({ slot, bytes, name, mimetype = 'image/jpeg', data = {} }: UploadArgs) {
  return await payload.create({
    collection: 'media',
    user: owner,
    data: { slot, alt: GOOD_ALT, credit: CREDIT_MARKER, ...data },
    file: { data: bytes, mimetype, name, size: bytes.length },
  })
}

/** The rule names a refusal reported. Empty when the write was accepted. */
async function refusalRules(args: UploadArgs): Promise<readonly string[]> {
  try {
    await upload(args)
    return []
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return [...message.matchAll(/\[([a-z-]+)\]/g)].map((match) => match[1] ?? '')
  }
}

async function auditCount(prefix: string): Promise<number> {
  const rows = (await sql`
    select count(*)::int as n from audit_event where action like ${`${prefix}%`}
  `) as unknown as { n: number }[]
  return rows[0]?.n ?? 0
}

beforeAll(async () => {
  payload = await getPayload({ config })
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  const email = 'owner@berelax.test'
  await payload.delete({ collection: 'cms_user', where: { email: { equals: email } } })
  const created = await payload.create({
    collection: 'cms_user',
    data: { email, password: 'a-long-enough-test-password', role: 'owner' },
  })
  owner = { id: String(created.id), collection: 'cms_user', role: String(created['role']) }
}, 180_000)

afterAll(async () => {
  // Optional chaining for the reason payload.itest.ts gives: a teardown that throws because setup gave up
  // reports itself as the failure and scrolls the real cause away.
  await payload?.delete?.({ collection: 'media', where: { credit: { equals: CREDIT_MARKER } } })
  await payload?.destroy?.()
  await sql?.end({ timeout: 5 })
})

describe('acceptance — the slot constraints are enforced server-side', () => {
  it('accepts a correct upload and measures it', async () => {
    // The control for every refusal below. A gate that refused everything would pass all of them.
    const row = await upload({
      slot: 'hero',
      bytes: await image(1920, 1080),
      name: 'interior-wide.jpg',
    })
    expect(row['slot']).toBe('hero')
    expect(row['width']).toBe(1920)
    expect(row['height']).toBe(1080)
    expect(row['alt']).toBe(GOOD_ALT)
  }, 60_000)

  it('refuses a disallowed mime type before the file is read at all', async () => {
    // The same gradient, re-encoded as WebP. Not a literal colour: `pnpm colours` rejects a hex anywhere
    // outside the token layer, and it is right to — one hand-typed shade in a test is one nobody measured.
    const bytes = await sharp(await image(1920, 1080))
      .webp()
      .toBuffer()
    try {
      await upload({ slot: 'hero', bytes, name: 'interior.webp', mimetype: 'image/webp' })
      expect.unreachable('a WebP master must not be stored')
    } catch (error) {
      // Payload's own `upload.mimeTypes` restriction fires first, before `beforeChange` — the right order,
      // because the file is never decoded. What it produces is "The following field is invalid: file",
      // with the type only in the server log: which is exactly why every constraint this unit adds
      // reports its own rule name and the value it measured. `[slot-mime-not-allowed]` is the same
      // decision enforced where Payload is not in the path — `validateUpload` over
      // `assets/media/manifest.json` in `pnpm media` — and its fixture and control are the table test in
      // packages/media/src/slots/validate.test.ts.
      expect(error instanceof Error ? error.message : String(error)).toMatch(/invalid: file/i)
    }
    const found = await payload.find({
      collection: 'media',
      where: { filename: { equals: 'interior.webp' } },
      overrideAccess: true,
    })
    expect(found.totalDocs).toBe(0)
  }, 60_000)

  it('refuses a file over the slot byte cap, with the measured weight', async () => {
    // The wordmark slot, whose cap is 512KB: an 8MB fixture for the hero would be eight megabytes of
    // libvips on every `pnpm verify` to prove a comparison of two integers.
    const bytes = await heavyImage(700, 400)
    expect(bytes.length).toBeGreaterThan(SLOT_REGISTRY.logo.maxBytes)
    try {
      await upload({ slot: 'logo', bytes, name: 'wordmark.png', mimetype: 'image/png' })
      expect.unreachable('a file over the slot cap must not be stored')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('[slot-over-maximum-bytes]')
      expect(message).toContain(String(bytes.length))
      expect(message).toContain(String(SLOT_REGISTRY.logo.maxBytes))
      // Never silently resized: there is no row, so nothing was accepted and fixed.
      const found = await payload.find({
        collection: 'media',
        where: { filename: { equals: 'wordmark.png' } },
        overrideAccess: true,
      })
      expect(found.totalDocs).toBe(0)
    }
  }, 60_000)

  it('refuses a frame below the slot minimum', async () => {
    const rules = await refusalRules({
      slot: 'hero',
      bytes: await image(1024, 576),
      name: 'small.jpg',
    })
    expect(rules).toContain('slot-below-minimum-dimensions')
  }, 60_000)

  it('gets a centre focal point from Payload on create, so the ratio rule cannot fire through the admin', async () => {
    // A measured fact about Payload 3.89, not an assumption: `parseUploadEditsFromReqOrIncomingData`
    // defaults the focal point to { x: 50, y: 50 } on every create. So `focal === undefined` — the
    // condition `[slot-ratio-out-of-tolerance]` tests — is never true for an upload through this
    // collection, and an out-of-ratio frame is accepted with a centre crop.
    //
    // That is recorded rather than worked around, because the two obvious workarounds are both worse.
    // Treating a centre focal point as "no answer" would refuse `photos/spa-01.jpg`, whose 2.50 frame is
    // correctly centred horizontally; refusing every out-of-ratio source outright would refuse 23 of the
    // 25 real assets. See the NOTE on W-SYS-09 in build/manifest.yaml. Where the rule does fire is the
    // path that has no Payload in it: `assets/media/manifest.json`, whose focal points really can be
    // absent, checked by `pnpm media` and proved by gate case 29a.
    const row = await upload({
      slot: 'hero',
      bytes: await image(1600, 1000),
      name: 'wrong-shape.jpg',
    })
    expect(row['focalX']).toBe(50)
    expect(row['focalY']).toBe(50)
  }, 60_000)

  it('keeps a focal point the editor did set', async () => {
    // The control for the paragraph above: Payload's default is a default, not an override, so a stated
    // focal point survives — which is what the derivative job then crops around.
    const row = await upload({
      slot: 'hero',
      bytes: await image(1600, 1000),
      name: 'wrong-shape-with-focal.jpg',
      data: { focalX: 40, focalY: 30 },
    })
    expect(row['focalX']).toBe(40)
    expect(row['focalY']).toBe(30)
  }, 60_000)

  it('refuses a slot nobody declared', async () => {
    const rules = await refusalRules({
      slot: 'carousel',
      bytes: await image(1920, 1080),
      name: 'carousel.jpg',
    })
    expect(rules).toContain('unknown-slot')
  }, 60_000)
})

describe('acceptance — focal points are percentages, stored and read back', () => {
  it('round-trips focalX and focalY as percentages of the frame', async () => {
    const row = await upload({
      slot: 'therapist-portrait',
      bytes: await image(880, 1600),
      name: 'portrait.jpg',
      data: { focalX: 50, focalY: 16 },
    })
    const read = await payload.findByID({
      collection: 'media',
      id: String(row.id),
      overrideAccess: true,
    })
    // 16 percent from the top, which is where the face is in the real portraits — not 16 pixels, and not a
    // fraction. The same two numbers feed `cropRectFor` at every rung of both ladders.
    expect(read['focalX']).toBe(50)
    expect(read['focalY']).toBe(16)
  }, 60_000)

  it('refuses a focal point outside the frame', async () => {
    const rules = await refusalRules({
      slot: 'therapist-portrait',
      bytes: await image(880, 1600),
      name: 'portrait-bad-focal.jpg',
      data: { focalX: 140, focalY: 16 },
    })
    expect(rules).toContain('slot-focal-point-out-of-range')
  }, 60_000)
})

describe('acceptance — the junk-alt filter runs on the server, not in the form', () => {
  it('refuses alt text that is only boilerplate', async () => {
    const rules = await refusalRules({
      slot: 'hero',
      bytes: await image(1920, 1080),
      name: 'boilerplate.jpg',
      data: { alt: 'image image image' },
    })
    expect(rules).toContain('alt-is-boilerplate')
  }, 60_000)

  it('refuses missing alt text on a slot that cannot hold decoration', async () => {
    const rules = await refusalRules({
      slot: 'therapist-portrait',
      bytes: await image(880, 1600),
      name: 'no-alt.jpg',
      data: { alt: '', focalX: 50, focalY: 16 },
    })
    expect(rules).toContain('alt-missing')
  }, 60_000)

  it('refuses the uploaded file’s own name as alt text', async () => {
    const rules = await refusalRules({
      slot: 'hero',
      bytes: await image(1920, 1080),
      name: 'hero-team-final.jpg',
      data: { alt: 'hero-team-final version two' },
    })
    expect(rules).toContain('alt-is-a-filename')
  }, 60_000)

  it('refuses the heading repeated verbatim', async () => {
    const rules = await refusalRules({
      slot: 'hero',
      bytes: await image(1920, 1080),
      name: 'repeat.jpg',
      data: {
        alt: 'Hot Stone Massage photo',
        alt_context: [{ phrase: 'Hot Stone Massage' }],
      },
    })
    expect(rules).toContain('alt-repeats-the-context')
  }, 60_000)

  it('accepts empty alt text on the one slot that may hold decoration', async () => {
    const row = await upload({
      slot: 'testimonial-background',
      bytes: await image(1920, 1080),
      name: 'quote-background.jpg',
      data: { alt: '', decorative: true },
    })
    expect(row['decorative']).toBe(true)
    expect(row['alt'] ?? '').toBe('')
  }, 60_000)

  it('refuses decoration on a slot whose images are content', async () => {
    const rules = await refusalRules({
      slot: 'therapist-portrait',
      bytes: await image(880, 1600),
      name: 'portrait-decorative.jpg',
      data: { alt: '', decorative: true, focalX: 50, focalY: 16 },
    })
    expect(rules).toContain('alt-decorative-not-permitted-in-slot')
  }, 60_000)

  it('checks an accepted row again when it is edited', async () => {
    // The claim the hook placement rests on. An alt check that only ran at upload would be a check the
    // second save walks past, and emptying a field is one save.
    const row = await upload({
      slot: 'gallery',
      bytes: await image(1920, 1080),
      name: 'gallery-tile.jpg',
    })
    await expect(
      payload.update({
        collection: 'media',
        id: String(row.id),
        user: owner,
        data: { alt: 'photo' },
      }),
    ).rejects.toThrow(/\[alt-(too-short|is-boilerplate)\]/)

    // And the row is unchanged, which is what says the refusal happened before the write.
    const read = await payload.findByID({
      collection: 'media',
      id: String(row.id),
      overrideAccess: true,
    })
    expect(read['alt']).toBe(GOOD_ALT)

    // The control: a legitimate edit of the same row succeeds, so the refusal is not "this row is frozen".
    const better = 'Steam rising from a copper kettle poured into a ceramic foot bath'
    const updated = await payload.update({
      collection: 'media',
      id: String(row.id),
      user: owner,
      data: { alt: better },
    })
    expect(updated['alt']).toBe(better)
  }, 60_000)
})

describe('acceptance — a media mutation is audited like every other CMS mutation', () => {
  it('writes an audit_event for the upload', async () => {
    // A delta, never a total: the integration suite runs sequentially against one database and earlier
    // files leave rows behind (the brief's rule 12). `audit_event` is append-only, so this can only grow.
    const before = await auditCount('cms.media.')
    await upload({ slot: 'hero', bytes: await image(1920, 1080), name: 'audited.jpg' })
    const after = await auditCount('cms.media.')
    expect(after - before).toBe(1)

    // The control: a refused upload writes nothing. An audit trail in which a rejection and an accepted
    // upload look the same cannot answer what is in the bucket.
    const refusedBefore = await auditCount('cms.media.')
    await refusalRules({
      slot: 'hero',
      bytes: await image(1024, 576),
      name: 'refused-and-unaudited.jpg',
    })
    expect((await auditCount('cms.media.')) - refusedBefore).toBe(0)
  }, 60_000)
})
