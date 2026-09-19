import { mayOperateOnCollection, permissionFor } from '@berelax/cms'
import { cropBoxesFor, focalXSweep } from '@berelax/media/crop-preview'
import { resolveDerivativeSet, rungVerdicts } from '@berelax/media/derivative-set'
import { heightFor } from '@berelax/media/ladders'
import { mediaSlot } from '@berelax/media/slots'
import { PREVIEW_CSS_WIDTHS, pictureSourcesFor, selectedRungFor } from '@berelax/media/srcset'
import { isAppError } from '@berelax/shared'
import {
  type BreakpointPreviewView,
  type PreviewRow,
  renderBreakpointPreviewHtml,
  renderMissingDerivativesHtml,
} from '../../../../../../src/components/admin/breakpoint-preview.ts'
import {
  assessMediaForPublication,
  loadMediaSubject,
  PUBLISH_ENDPOINT,
} from '../../../../../../src/media/publish-gate.ts'
import { appMediaStorage } from '../../../../../../src/media/storage.ts'
import { appPayload, principalForRequest } from '../../../../../../src/payload/request-principal.ts'

/**
 * `GET /settings/media/preview/{mediaId}` — the breakpoint preview.
 *
 * ## Authorisation is the policy layer's answer, not this file's
 *
 * `mayOperateOnCollection(role, 'update')` from `@berelax/cms`, which is `can(role, 'content:write')` from
 * the F07 matrix — the same call the CMS's own access rules make. Nothing here names a role. A receptionist
 * holds neither `content:write` nor `content:publish` and gets a 403; a manager, a marketer and the owner
 * hold `content:write` and get a 200. Writing `role === 'receptionist'` here would be a second
 * authorisation matrix, which is to say one that will disagree with the first within a release.
 *
 * The preview is a **read** of unpublished editorial state — the alt text, the crop, the weights of images
 * that are not live yet — so `content:write` is the right gate rather than `content:publish`. Publishing is
 * a separate decision made by a separate endpoint, which refuses on its own.
 *
 * ## Why a handler and not a page
 *
 * A `page.tsx` cannot answer 403 without Next's experimental `authInterrupts`, and W-SITE-01's registry
 * requires every *document* to be served in both locales — an Arabic admin document plus a twelve-cell
 * screenshot matrix, for a surface whose acceptance criterion asks for three viewports times two themes.
 * The Messages inbox and the Google picker are handlers for the same reason, one directory along. The
 * components are still React; `renderToStaticMarkup` turns them into the bytes.
 */
export const dynamic = 'force-dynamic'

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function htmlDocument(markup: string, status: number): Response {
  return new Response(markup, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cached: an admin screen carries unpublished copy, and a cached copy of one outlives the
      // page. The same reason `noarchive` is in the registry's robots directive.
      'cache-control': 'no-store',
    },
  })
}

export async function GET(
  request: Request,
  context: { params: Promise<{ mediaId: string }> },
): Promise<Response> {
  const { mediaId } = await context.params
  const principal = await principalForRequest(request)
  if (principal === null) {
    return text('Sign in to the admin to open the breakpoint preview.\n', 401)
  }
  // `update`, i.e. `content:write`. The permission is named in the body so the refusal is actionable.
  if (!mayOperateOnCollection(principal.role, 'update')) {
    return text(
      `Role "${principal.role}" may not open the breakpoint preview: it requires ` +
        `${permissionFor('update')}.\n`,
      403,
    )
  }

  try {
    const payload = await appPayload()
    const subject = await loadMediaSubject(payload, mediaId, { ...principal })
    if (subject === null) return text(`No media row ${mediaId}.\n`, 404)

    const slot = mediaSlot(subject.slot)
    const storage = appMediaStorage()
    const set = await resolveDerivativeSet(storage, mediaId, subject.slot)
    if (set === undefined || set.missing.length > 0) {
      // Not an error. `derivative_manifest` is empty until `media.build-derivatives` runs and nothing
      // enqueues it yet (the NOTE on W-SYS-09 says why), so "not built" is a normal state with its own
      // document — rather than seven broken images, or an invented URL that 404s inside a srcset.
      return htmlDocument(
        renderMissingDerivativesHtml({
          mediaId,
          slotLabel: slot.label,
          missing: set?.missing ?? [],
          storageKind: storage.kind,
        }),
        200,
      )
    }

    /*
     * The focal point the preview opens on is the row's own.
     *
     * The slider explores alternatives; it does not change the row, and it cannot change the derivative —
     * the bytes in the bucket were encoded around the stored focal point, and moving the slider shows the
     * window the job WOULD take if the row were saved with that value. Saving it is the media collection's
     * own field, and the rebuild is `media.build-derivatives`.
     */
    const sweep = focalXSweep({ width: subject.width, height: subject.height }, subject.focalY)
    const verdicts = rungVerdicts(set, slot.publishedBudgetBytes)
    const rows: PreviewRow[] = PREVIEW_CSS_WIDTHS.map((cssWidth) => {
      const rung = selectedRungFor(cssWidth)
      const verdict = verdicts.find(
        (candidate) =>
          candidate.rendition.crop === rung.crop && candidate.rendition.width === rung.width,
      )
      if (verdict === undefined) {
        // Unreachable: the ladder was asserted complete above. Throwing rather than rendering a row with
        // no weight, because a preview with a blank byte count is a preview nobody can act on.
        throw new Error(`No ${rung.crop}/${rung.width} AVIF rendition for media ${mediaId}`)
      }
      return {
        cssWidth,
        verdict,
        /*
         * The frame's height at this width, from the ladder — never a literal, and never the *slot's* ratio.
         * The slot declares 16:9 for the hero and every row below 768px shows the 4:5 crop, so a frame sized
         * from the slot would be 203px tall where the photograph is 450 and `overflow: hidden` would crop the
         * phone's crop. `heightFor` takes the row's own crop.
         */
        frameHeight: heightFor(rung.crop, cssWidth),
      }
    })

    const assessment = await assessMediaForPublication(payload, mediaId, { ...principal })
    const publishPermitted = mayOperateOnCollection(principal.role, 'publish')
    const view: BreakpointPreviewView = {
      media: { mediaId, contentHash: set.contentHash, slot: set.slot },
      slotLabel: slot.label,
      alt: subject.alt,
      decorative: subject.decorative,
      filename: subject.filename,
      source: {
        width: subject.width,
        height: subject.height,
        bytes: set.sourceBytes,
        key: set.sourceKey,
      },
      focal: { x: subject.focalX, y: subject.focalY },
      // The window at the stored focal point, exactly: the sweep is indexed by whole percentage points and a
      // row's focalX is a number, so `sweep[45.5]` would find nothing and the card would open at zero size.
      initialBoxes: cropBoxesFor(
        { width: subject.width, height: subject.height },
        { x: subject.focalX, y: subject.focalY },
      ),
      rows,
      sources: pictureSourcesFor({ mediaId, contentHash: set.contentHash, slot: set.slot }),
      sweep,
      refusals: assessment?.refusals ?? [],
      publishPermitted,
      publishPermissionNote:
        `Your role, ${principal.role}, may edit this image but not publish it: publishing requires ` +
        `${permissionFor('publish')}.`,
      storageKind: storage.kind,
      publishEndpoint: PUBLISH_ENDPOINT,
    }
    return htmlDocument(renderBreakpointPreviewHtml(view), 200)
  } catch (error) {
    const message = isAppError(error) ? error.message : 'Unexpected'
    // Plain text and a 503, like the Messages inbox: this surface has no error document, and a blank page
    // would read as "this image has no derivatives" when the truth is "nothing could be read".
    return text(`The breakpoint preview could not be built: ${message}\n`, 503)
  }
}
