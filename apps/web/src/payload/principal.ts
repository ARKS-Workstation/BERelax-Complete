import { type CmsPrincipal, isRole } from '@berelax/cms'
import type { Role } from '@berelax/core'

/**
 * The staff principal behind a Payload request, or `null`.
 *
 * `null` is not an error here and it is not a role either. An unauthenticated request must fall through
 * to Payload's own login handling, and the access functions deny it the same way they deny a role
 * without the permission — deny by default, one path.
 *
 * A `role` Payload holds that is not in the F07 set is treated as absent rather than as something. That
 * can happen: the column is a Payload `select` and a database edited by hand, or a migration from an
 * earlier role list, can put anything in it. Trusting it would mean `can(role, …)` deciding on a string
 * the matrix has never heard of.
 */
export function principalFrom(user: unknown): CmsPrincipal | null {
  if (user === null || typeof user !== 'object') return null
  const candidate = user as { readonly id?: unknown; readonly role?: unknown }
  if (!isRole(candidate.role)) return null
  const id = candidate.id
  if (typeof id !== 'string' && typeof id !== 'number') return null
  return { id: String(id), role: candidate.role satisfies Role }
}
