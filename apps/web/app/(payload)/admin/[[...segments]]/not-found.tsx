import { NotFoundPage } from '@payloadcms/next/views'
import config from '../../../../payload.config.ts'
import { importMap } from '../importMap.js'

/**
 * The admin's own 404.
 *
 * Without this, an unknown path under `/admin` falls through to Next's not-found, which has no root layout
 * in this group and would render the site's document — the one thing `(payload)` exists to keep out.
 */
type AdminRouteArgs = {
  readonly params: Promise<{ segments: string[] }>
  readonly searchParams: Promise<Record<string, string | string[]>>
}

export default function AdminNotFound({ params, searchParams }: AdminRouteArgs) {
  return NotFoundPage({ config, importMap, params, searchParams })
}
