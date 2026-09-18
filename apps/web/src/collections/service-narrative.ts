import {
  assertMayRetire,
  type RetireAction,
  type RetireRequest,
  SERVICE_NARRATIVE,
} from '@berelax/cms'
import { isAppError } from '@berelax/shared'
import type {
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  PayloadRequest,
} from 'payload'
import { APIError } from 'payload'
import { futureBookingProbe } from '../payload/future-bookings.ts'

/**
 * The guard on retiring a treatment narrative.
 *
 * The rule itself is in `@berelax/cms`'s `lifecycle.ts`, with the reasoning. This file is the wiring: it
 * works out which action the editor is performing, asks the probe for a count, and converts a refusal
 * into the 409 the admin shows.
 *
 * `beforeChange` and `beforeDelete`, not `afterChange`: a refusal has to happen before the write, and an
 * `afterChange` hook that threw would refuse the mutation only by rolling back a transaction that had
 * already fired every other hook — including the audit one, which would then record a change that was
 * undone.
 */

function catalogueServiceIdOf(document: unknown): string | null {
  if (document === null || typeof document !== 'object') return null
  const value = (document as { readonly catalogue_service_id?: unknown }).catalogue_service_id
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Turns a refusal into something the admin can show.
 *
 * `AppError` becomes a 409 `APIError` carrying the same message and the machine-readable reason. Anything
 * else is rethrown untouched: swallowing an unexpected error here would turn a genuine bug into "this
 * treatment has future bookings", which is a message somebody would believe.
 */
async function refuseIfRetiringIsUnsafe(
  req: PayloadRequest,
  action: RetireAction,
  catalogueServiceId: string | null,
): Promise<void> {
  const nowIso = new Date().toISOString()
  const bookings =
    catalogueServiceId === null
      ? ({ kind: 'counted', count: 0 } as const)
      : await futureBookingProbe()(req, catalogueServiceId, nowIso)

  const request: RetireRequest = { action, catalogueServiceId, bookings }
  try {
    assertMayRetire(request)
  } catch (error) {
    if (!isAppError(error)) throw error
    throw new APIError(
      error.message,
      409,
      { ...error.details, collection: SERVICE_NARRATIVE.slug },
      true,
    )
  }
}

export const guardServiceNarrativeUnpublish: CollectionBeforeChangeHook = async ({
  data,
  originalDoc,
  req,
}) => {
  const wasPublished = (originalDoc as { readonly _status?: unknown })?._status === 'published'
  const willBePublished = (data as { readonly _status?: unknown })._status === 'published'
  if (!wasPublished || willBePublished) return data

  // Archiving is a separate action from unpublishing and is always allowed — it keeps the page readable
  // for the guest who already booked. An editor who archives AND unpublishes in one save is still
  // unpublishing, so the `editorial_state` in `data` does not exempt this.
  await refuseIfRetiringIsUnsafe(req, 'unpublish', catalogueServiceIdOf(originalDoc))
  return data
}

export const guardServiceNarrativeDelete: CollectionBeforeDeleteHook = async ({ id, req }) => {
  // `beforeDelete` is given an id, not a document. Read it back through `req` so the read joins the same
  // transaction as the delete — a separate connection would not see an uncommitted earlier change in the
  // same request.
  const document = await req.payload.findByID({
    collection: SERVICE_NARRATIVE.slug,
    id,
    req,
    // The guard must see the row as stored, not as the requesting role is allowed to see it: a field the
    // role cannot read would arrive absent and the reference would look empty.
    overrideAccess: true,
    depth: 0,
  })
  await refuseIfRetiringIsUnsafe(req, 'delete', catalogueServiceIdOf(document))
}
