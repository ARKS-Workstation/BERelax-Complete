/**
 * The slot registry, projected into the shape `assets/media/manifest.json` records.
 *
 * Two scripts need it and they must not each have their own copy: `emit-media-manifest.mjs` writes the
 * block and `check-media.mjs` asserts the committed file still equals it. That is the same arrangement as
 * `tokens.css` and `palette.generated.ts` — a generated file committed so a change is visible in a diff,
 * with a gate that fails when it goes stale — and it is what makes the registry the single source rather
 * than the first of two lists.
 *
 * The projection is narrower than the registry on purpose. A manifest describing photographs on disk has
 * nothing to say about a slot's placeholder token or its published byte budget, so those stay where they
 * are read from.
 */
import { MEDIA_SLOT_NAMES, SLOT_REGISTRY } from '../../packages/media/src/slots/registry.ts'

export function manifestSlotSpecs() {
  const specs = {}
  for (const name of MEDIA_SLOT_NAMES) {
    const slot = SLOT_REGISTRY[name]
    specs[name] = {
      ratio: slot.ratio === null ? null : [slot.ratio[0], slot.ratio[1]],
      minWidth: slot.minWidth,
      minHeight: slot.minHeight,
      maxBytes: slot.maxBytes,
      mimeTypes: [...slot.mimeTypes],
      // A slot that is cropped must say where its subject is; see the registry and
      // assets/media/README.md on the nineteen full-length portraits.
      focalRequired: slot.cropped,
    }
  }
  return specs
}

export { MEDIA_SLOT_NAMES, SLOT_REGISTRY }
