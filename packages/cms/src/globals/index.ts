import type { ContentGlobal } from '../fields.ts'
import { COMPLIANCE_NOTICES } from './compliance-notices.ts'
import { EDITORIAL_DEFAULTS } from './editorial-defaults.ts'

export { COMPLIANCE_NOTICES } from './compliance-notices.ts'
export { EDITORIAL_DEFAULTS } from './editorial-defaults.ts'

export const CONTENT_GLOBALS = [
  COMPLIANCE_NOTICES,
  EDITORIAL_DEFAULTS,
] as const satisfies readonly ContentGlobal[]

export type ContentGlobalSlug = (typeof CONTENT_GLOBALS)[number]['slug']

const BY_SLUG = new Map<string, ContentGlobal>(
  CONTENT_GLOBALS.map((global) => [global.slug, global]),
)

export function contentGlobal(slug: string): ContentGlobal | undefined {
  return BY_SLUG.get(slug)
}
