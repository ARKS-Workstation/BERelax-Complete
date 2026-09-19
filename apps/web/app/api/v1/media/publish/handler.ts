import { mayOperateOnCollection, permissionFor } from '@berelax/cms'
import { isAppError } from '@berelax/shared'
import { assessMediaForPublication } from '../../../../../src/media/publish-gate.ts'
import { appPayload, principalForRequest } from '../../../../../src/payload/request-principal.ts'

/**
 * `POST /api/v1/media/publish` — the API guard on publishing a slot image.
 *
 * **This endpoint refuses on its own.** It does not trust that the caller came from the breakpoint preview,
 * it does not read a flag the preview set, and it does not take the measured weight from the request: it
 * reads the media row through Payload's access layer, measures the objects in the bucket, and runs
 * W-SYS-09's `publicationRefusals` over the result. A `curl` with a bare `{"mediaId":"…"}` gets exactly the
 * same answer as the button, which is what "the UI is never the only guard" has to mean — a UI-only guard
 * is a disabled button and a working endpoint.
 *
 * ## Status codes, and why 422 rather than 400
 *
 * The request is well formed and the caller is entitled to make it; the *state of the image* is what
 * refuses. 400 would say the caller made a mistake they can fix by re-reading the endpoint's shape, and
 * they cannot — the fix is a lighter photograph or better alt text. 403 is reserved for the authorisation
 * answer, so the two are never confused in a log.
 *
 * ## What a 200 means, exactly
 *
 * That the media gate passes: the alt text validates and no rung is over its slot's budget. It does **not**
 * mean a page went live — there is no draft → approved → published state machine yet (W-SITE-10 owns it and
 * is `todo`), so the response says `published: false` with the reason rather than reporting work that did
 * not happen. docs/12 §1 prohibits a stub that looks like it worked, and "publish succeeded" while nothing
 * was published is the purest form of it.
 *
 * ## Why both encodings are accepted
 *
 * JSON for a programmatic caller, `application/x-www-form-urlencoded` for the preview's own `<form>`. The
 * form keeps the preview working with scripting off, which matters on an admin surface whose whole subject
 * is what the browser does — and it means the UI's publish attempt is a genuinely ordinary request to this
 * endpoint rather than a private channel.
 */
/** The permission publishing requires. `content:publish`, which in the F07 matrix is the owner's alone. */
const PUBLISH_OPERATION = 'publish' as const

function json(body: unknown, status: number): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function mediaIdFrom(request: Request): Promise<string | null> {
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    try {
      const body = (await request.json()) as { readonly mediaId?: unknown }
      return typeof body.mediaId === 'string' && body.mediaId !== '' ? body.mediaId : null
    } catch {
      return null
    }
  }
  try {
    // `formData()` throws a TypeError for a body it cannot parse — a `text/plain` POST, or none at all —
    // and an unhandled throw here is a 500 on a request the caller simply got wrong. 400 says which.
    const form = await request.formData()
    const value = form.get('mediaId')
    return typeof value === 'string' && value !== '' ? value : null
  } catch {
    return null
  }
}

export async function handlePublish(request: Request): Promise<Response> {
  const principal = await principalForRequest(request)
  if (principal === null) {
    return json(
      { error: 'unauthenticated', message: 'This endpoint needs a signed-in admin session.' },
      401,
    )
  }
  if (!mayOperateOnCollection(principal.role, PUBLISH_OPERATION)) {
    // The same decision the CMS makes, through the same function: nothing here names a role.
    return json(
      {
        error: 'forbidden',
        role: principal.role,
        permission: permissionFor(PUBLISH_OPERATION),
        message:
          `Role "${principal.role}" may not publish media: it requires ` +
          `${permissionFor(PUBLISH_OPERATION)}.`,
      },
      403,
    )
  }

  const mediaId = await mediaIdFrom(request)
  if (mediaId === null) {
    return json({ error: 'invalid_request', message: 'mediaId is required.' }, 400)
  }

  try {
    const payload = await appPayload()
    const assessment = await assessMediaForPublication(payload, mediaId, { ...principal })
    if (assessment === null) {
      return json({ error: 'not_found', mediaId, message: 'No such media row.' }, 404)
    }
    if (assessment.refusals.length > 0) {
      return json(
        {
          error: 'publication_refused',
          mediaId,
          slot: assessment.set.slot,
          // The rule names, so a caller can branch on them, and the messages, which carry the measured
          // weight against the budget. A refusal that said only "refused" would send an editor back to
          // guess which of their two problems it was.
          rules: assessment.refusals.map((refusal) => refusal.rule),
          measuredBytes: assessment.refusals.map((refusal) => refusal.measuredBytes),
          messages: assessment.refusals.map((refusal) => refusal.message),
        },
        422,
      )
    }
    return json(
      {
        allowed: true,
        published: false,
        mediaId,
        slot: assessment.set.slot,
        contentHash: assessment.set.contentHash,
        message:
          'The media gate passes: alt text validates and no rung is over the slot budget. Nothing has ' +
          'been published — the draft to approved to published state machine is W-SITE-10 and does not ' +
          'exist yet, so this endpoint reports what it checked rather than work it did not do.',
      },
      200,
    )
  } catch (error) {
    // The named media errors are the caller's problem and are reported as such; anything else is a bug and
    // must not be flattened into a 422 that reads like a rejected photograph.
    const message = isAppError(error) ? error.message : 'Unexpected'
    const known =
      message.includes('[derivative-ladder-incomplete]') ||
      message.includes('[media-original-absent]') ||
      message.includes('[unknown-slot]') ||
      message.includes('[slot-is-never-cropped]') ||
      message.includes('[invalid-media-id]')
    return json(
      { error: known ? 'not_publishable' : 'unexpected', mediaId, message },
      known ? 409 : 503,
    )
  }
}
