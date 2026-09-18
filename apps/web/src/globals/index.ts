import { CONTENT_GLOBALS, type ContentGlobal } from '@berelax/cms'
import type { GlobalConfig } from 'payload'
import { globalReadAccess, globalWriteAccess } from '../payload/access.ts'
import { auditGlobalChange } from '../payload/audit.ts'
import { toPayloadField } from '../payload/fields.ts'

/**
 * Payload globals, built from the content model in `@berelax/cms`.
 *
 * The write permission comes from the descriptor, which is what makes the compliance-locked global
 * different from the editorial one without a second code path: `compliance_notices` declares
 * `settings:write_compliance` (the owner alone in the F07 matrix) and `editorial_defaults` declares
 * `content:write`. Nothing here names a role.
 */
export function toPayloadGlobal(global: ContentGlobal): GlobalConfig {
  return {
    slug: global.slug,
    label: global.label,
    admin: { description: global.purpose },
    // Versioned with drafts, so the compliance wording has a diff and a revert. For the one global an
    // inspector reads, "what did it say in March?" is a question that gets asked.
    versions: { drafts: true, max: global.maxVersions },
    access: {
      read: globalReadAccess(global.slug),
      update: globalWriteAccess(global.slug),
    },
    hooks: { afterChange: [auditGlobalChange] },
    fields: global.fields.map(toPayloadField),
  }
}

export const PAYLOAD_GLOBALS: readonly GlobalConfig[] = CONTENT_GLOBALS.map(toPayloadGlobal)
