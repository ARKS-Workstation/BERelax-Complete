import {
  type CmsOperation,
  mayOperateOnCollection,
  mayReadGlobal,
  mayWriteGlobal,
  permissionFor,
} from '@berelax/cms'
import type { Access } from 'payload'
import { APIError } from 'payload'
import { principalFrom } from './principal.ts'

/**
 * Payload access control, delegated entirely to the F07 matrix.
 *
 * Nothing in this file names a role. Every decision is `can(role, permission)` inside `@berelax/cms`,
 * which is the same function the booking screens and the till call. Writing role names into Payload's
 * hooks — `req.user?.role === 'manager'` — is the shorter version and it is a second authorisation
 * matrix, which is to say a matrix that will disagree with the first one within a release.
 */

export function collectionAccess(operation: CmsOperation): Access {
  return ({ req }) => {
    const principal = principalFrom(req.user)
    if (principal === null) return false
    return mayOperateOnCollection(principal.role, operation)
  }
}

export function globalReadAccess(slug: string): Access {
  return ({ req }) => {
    const principal = principalFrom(req.user)
    return principal !== null && mayReadGlobal(principal.role, slug)
  }
}

export function globalWriteAccess(slug: string): Access {
  return ({ req }) => {
    const principal = principalFrom(req.user)
    return principal !== null && mayWriteGlobal(principal.role, slug)
  }
}

/**
 * The publish gate.
 *
 * Payload cannot express this through `access.update`: publishing is a save whose `_status` becomes
 * `published`, so the same operation is either an ordinary edit or a publication depending on one field
 * in the payload. `access.update` would have to refuse the whole save, which would stop an editor
 * drafting.
 *
 * Both directions are gated. Unpublishing is as consequential as publishing — it takes a live page down
 * — and an access rule that only guarded the way in would let anybody with `content:write` remove the
 * homepage.
 */
export function assertMayChangeStatus(args: {
  readonly slug: string
  readonly user: unknown
  readonly previousStatus: string | null | undefined
  readonly nextStatus: string | null | undefined
}): void {
  const wasPublished = args.previousStatus === 'published'
  const willBePublished = args.nextStatus === 'published'
  if (wasPublished === willBePublished) return

  const principal = principalFrom(args.user)
  /*
   * No principal means this is not a request the access layer let through.
   *
   * `access.update` runs BEFORE any `beforeChange` hook and refuses an unauthenticated request, and one
   * whose `role` is not in the F07 set, outright. So the only way to arrive here without a principal is
   * `overrideAccess: true` — a seed, a data migration, or this app's own integration test calling the
   * Local API. Those are server-side callers, and bypassing access is what `overrideAccess` means
   * everywhere else in Payload; refusing them here would make the CMS impossible to seed and would be an
   * access rule that only this one hook honoured.
   *
   * The case this skip leans on is asserted rather than assumed: `apps/web/src/payload.itest.ts` checks
   * that an unauthenticated, non-overriding publish is refused.
   */
  if (principal === null) return

  const verb = willBePublished ? 'publish' : 'unpublish'
  if (mayOperateOnCollection(principal.role, 'publish')) return

  // APIError rather than our AppError: Payload turns an APIError into the status and message the admin
  // shows the editor, and anything else into a 500 with "Something went wrong", which is the same screen
  // an editor sees for a genuine bug.
  throw new APIError(
    `You may not ${verb} ${args.slug}: it requires ${permissionFor('publish')}.`,
    403,
    { role: principal.role, slug: args.slug, operation: verb },
    true,
  )
}
