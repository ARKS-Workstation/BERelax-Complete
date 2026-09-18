import { can, type Permission, ROLES, type Role } from '@berelax/core'
import { AppError } from '@berelax/shared'
import { COLLECTION_WRITE_PERMISSION, PUBLISH_PERMISSION } from './fields.ts'
import { contentGlobal } from './globals/index.ts'

/**
 * Who may do what in the CMS, decided by the F07 matrix and nothing else.
 *
 * Payload has its own access-control hooks and it would have been shorter to write role names into them
 * — `({ req }) => req.user?.role === 'manager'`. That is a second authorisation matrix, and a second
 * matrix is one that disagrees. So every decision below is a call to `can()` from `@berelax/core`, which
 * is deny-by-default and is the same function the booking screens and the till use.
 *
 * Two consequences worth stating rather than discovering:
 *
 *   - **Publishing is the owner's alone.** `content:publish` appears in no role's grant list except the
 *     owner's wildcard. `manager` and `marketer` hold `content:write`, so they draft; the owner
 *     publishes. That is what F07 landed and this unit does not widen it — widening an authorisation
 *     matrix from a CMS unit is exactly how a matrix stops meaning anything.
 *   - **A receptionist cannot write content at all**, let alone publish, because they hold neither
 *     permission. The acceptance asks only that they cannot publish; they also cannot draft.
 */

/** The CMS operations access is decided for. `publish` covers unpublish and version revert too. */
export const CMS_OPERATIONS = ['read', 'create', 'update', 'delete', 'publish'] as const
export type CmsOperation = (typeof CMS_OPERATIONS)[number]

/** A staff principal as the admin sees it. No name: the role is what decides, and the id is the audit key. */
export interface CmsPrincipal {
  readonly id: string
  readonly role: Role
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/**
 * Whether a role may perform an operation on a collection.
 *
 * `read` is granted to anybody who may write content OR who holds `audit:read` — an auditor has to be
 * able to see what was published without being able to change it, which is the whole point of the role.
 */
export function mayOperateOnCollection(role: Role, operation: CmsOperation): boolean {
  if (operation === 'read') {
    return can(role, COLLECTION_WRITE_PERMISSION) || can(role, 'audit:read')
  }
  if (operation === 'publish') return can(role, PUBLISH_PERMISSION)
  return can(role, COLLECTION_WRITE_PERMISSION)
}

/**
 * Whether a role may write a global.
 *
 * The global declares its own permission, which is how `compliance_notices` (owner only, via
 * `settings:write_compliance`) and `editorial_defaults` (anybody with `content:write`) differ without
 * two code paths. An unknown slug is refused rather than defaulted — deny by default, same as `can()`.
 */
export function mayWriteGlobal(role: Role, slug: string): boolean {
  const global = contentGlobal(slug)
  if (global === undefined) return false
  return can(role, global.writePermission)
}

export function mayReadGlobal(role: Role, slug: string): boolean {
  if (contentGlobal(slug) === undefined) return false
  return can(role, COLLECTION_WRITE_PERMISSION) || can(role, 'audit:read')
}

/** The permission a refusal should name, for the message and for the audit row. */
export function permissionFor(operation: CmsOperation): Permission {
  return operation === 'publish' ? PUBLISH_PERMISSION : COLLECTION_WRITE_PERMISSION
}

export function assertMayOperateOnCollection(
  role: Role,
  slug: string,
  operation: CmsOperation,
): void {
  if (mayOperateOnCollection(role, operation)) return
  throw new AppError(
    'forbidden',
    `Role "${role}" may not ${operation} ${slug}: it requires ${permissionFor(operation)}`,
    { details: { role, slug, operation, permission: permissionFor(operation) } },
  )
}

export function assertMayWriteGlobal(role: Role, slug: string): void {
  if (mayWriteGlobal(role, slug)) return
  const required = contentGlobal(slug)?.writePermission ?? 'unknown global'
  throw new AppError(
    'forbidden',
    `Role "${role}" may not change ${slug}: it requires ${required}`,
    {
      details: { role, slug, permission: required },
    },
  )
}
