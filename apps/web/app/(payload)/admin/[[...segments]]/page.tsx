import { generatePageMetadata, RootPage } from '@payloadcms/next/views'
import type { Metadata } from 'next'
import config from '../../../../payload.config.ts'
import { importMap } from '../importMap.js'

/**
 * Every admin screen.
 *
 * An optional catch-all, so `/admin` and `/admin/collections/pages/create` are the same route and Payload
 * decides which view each one is. There is nothing of ours in here on purpose: a wrapper that added our
 * chrome would put two documents on the page (see `../../layout.tsx`).
 */
type AdminRouteArgs = {
  readonly params: Promise<{ segments: string[] }>
  readonly searchParams: Promise<Record<string, string | string[]>>
}

export function generateMetadata({ params, searchParams }: AdminRouteArgs): Promise<Metadata> {
  return generatePageMetadata({ config, params, searchParams })
}

export default function AdminPage({ params, searchParams }: AdminRouteArgs) {
  return RootPage({ config, importMap, params, searchParams })
}
