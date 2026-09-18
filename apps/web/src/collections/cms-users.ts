import { ROLES } from '@berelax/core'
import type { CollectionConfig } from 'payload'
import { auditCollectionChange, auditCollectionDelete } from '../payload/audit.ts'
import { principalFrom } from '../payload/principal.ts'

/**
 * Who can sign into the admin.
 *
 * ## Why this is a Payload collection and not the staff identity table
 *
 * F07 landed as `packages/auth` — password hashing, TOTP and session primitives — plus the
 * authorisation matrix in `packages/core`. It did **not** land a `staff_user` table: there is no
 * identity store in the migration chain for a session to point at, and nothing in the manifest declares
 * one. Payload's admin needs an auth collection to exist at all, so this is it, and it lives in the
 * `payload` schema with the rest of Payload's tables.
 *
 * The part that matters is bound correctly regardless: `role` is constrained to the F07 `ROLES` set, and
 * every access decision in this admin goes through `can(role, permission)` from `@berelax/core`. When a
 * `staff_user` table arrives, this collection becomes a projection of it — a custom `authStrategies`
 * entry that resolves the session and returns the role — and no access rule in this app changes.
 *
 * **What is missing until then, stated plainly:** ADR 0009 makes TOTP mandatory for owner, manager and
 * accountant. Payload's local strategy has no second factor, so this admin authenticates with a password
 * alone. That is a gap in the admin's login, not in the matrix, and it is recorded as a NOTE on this
 * unit in `build/manifest.yaml`.
 */
export const CMS_USERS: CollectionConfig = {
  slug: 'cms_user',
  labels: { singular: 'Admin user', plural: 'Admin users' },
  auth: {
    // 30 minutes, matching `SESSION_TTL.accessMs` in `packages/auth`. A CMS session that outlived a
    // booking-screen session would be the longer-lived of two sessions for the same person.
    tokenExpiration: 30 * 60,
    maxLoginAttempts: 5,
    lockTime: 15 * 60 * 1000,
    useSessions: true,
  },
  admin: {
    useAsTitle: 'email',
    description:
      'Admin sign-in. The role decides everything this person can do; see packages/core/src/access.',
    defaultColumns: ['email', 'role', 'updatedAt'],
  },
  access: {
    // Only a role that may change compliance-locked settings may mint or alter an admin account. In the
    // F07 matrix that is the owner alone, which is the right answer for the one collection whose rows
    // decide what every other collection permits.
    read: ({ req }) => principalFrom(req.user) !== null,
    create: ({ req }) => principalFrom(req.user)?.role === 'owner',
    update: ({ req }) => principalFrom(req.user)?.role === 'owner',
    delete: ({ req }) => principalFrom(req.user)?.role === 'owner',
  },
  hooks: {
    // An account created, a role changed or an account removed is the most consequential change in this
    // admin, so it is audited like everything else rather than being the one exception.
    afterChange: [auditCollectionChange],
    afterDelete: [auditCollectionDelete],
  },
  fields: [
    {
      name: 'role',
      type: 'select',
      label: 'Role',
      required: true,
      // The F07 role set, spread rather than retyped. A role list that drifted from the matrix would
      // produce accounts `can()` denies everything to, which looks like a broken admin.
      options: [...ROLES],
      admin: {
        description:
          'From the authorisation matrix in packages/core. Publishing requires content:publish, which ' +
          'only the owner holds.',
      },
    },
  ],
}
