/**
 * The one libvips this system uses, re-exported so there can only be one.
 *
 * Payload needs a `sharp` instance to measure an upload's pixel dimensions, and the `media` collection's
 * slot constraints — minimum dimensions, the ratio tolerance, the crop window — are checks on exactly
 * those numbers. The obvious wiring is `import sharp from 'sharp'` in `apps/web/payload.config.ts`, and it
 * is wrong for a reason that is invisible until it bites: that makes `sharp` a second declared dependency
 * with its own version range, and two ranges can resolve to two libvips builds. The dimensions Payload
 * measures would then come from one decoder and the crop `buildDerivatives` takes from another — and the
 * disagreement would show up as an upload accepted at 1280x720 and cropped as though it were something
 * else, which is not a failure anybody would trace to a version range.
 *
 * So the pipeline's own sharp is the one the admin measures with. `@berelax/media` already depends on it,
 * `derivatives.ts` already encodes with it, and this module is the single door.
 *
 * It is a subpath rather than part of the package barrel on purpose: the barrel is the sharp-ful half
 * already, but `@berelax/media/slots`, `/ladders`, `/loader`, `/url` and `/placeholder` are the halves a
 * browser bundle imports, and nothing about "give me libvips" belongs near them.
 */
export { default as sharp } from 'sharp'
