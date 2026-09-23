/**
 * `/book` — the public booking flow, in English.
 *
 * `rendering: 'dynamic'` in the registry, and it is the first document on this site that is. Everything
 * else reads rows that change a few times a year and is prerendered; this one reads *availability*, which
 * changes on every booking, every shift change and every walk-in — so a prerendered copy would offer times
 * that are gone. `route-spine.itest.ts` checks that claim against `.next/prerender-manifest.json`, so a
 * page that quietly became static fails a test rather than a customer's evening.
 *
 * ## Why `searchParams` and not a route segment
 *
 * Every choice — treatment, client, therapist, day, time — is a query field submitted by a GET form, which
 * is what makes steps 1–3 work with JavaScript off (docs/09 §3) and what makes the URL shareable,
 * bookmarkable and restorable. A path segment per step would make each one a separate document in the
 * `hreflang` set and the sitemap, for what is one page in one state.
 *
 * Reading `searchParams` is also what makes the route dynamic in Next's own terms, which is the honest
 * spelling of the registry's claim rather than a `force-dynamic` export asserting it.
 *
 * ## The clock
 *
 * `Date.now()` here and an argument everywhere below it. The day strip starts at the trading date the
 * premises is currently in, which is the one thing on this page that is a function of the moment rather
 * than of the URL — `bookingPageData` takes it as a parameter so the same render can be produced at a
 * frozen instant by a test.
 */
import type { Metadata } from 'next'
import { BOOK_COPY_EN } from '../../../../src/book/copy-en.ts'
import { bookingPageData } from '../../../../src/book/read.ts'
import { parseBookingParams } from '../../../../src/book/state.ts'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { BookingPageBody } from '../../../_book/booking-page.tsx'

export const metadata: Metadata = {
  title: 'Book a treatment — BE RELAX Massage Center and Spa',
  description:
    'Choose a treatment, a day and a time. Availability is live, and no account is needed to book.',
  ...routeMetadata('book', 'en'),
}

export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = parseBookingParams(await searchParams)
  const data = await bookingPageData(params, { now: Date.now() })
  return <BookingPageBody data={data} params={params} copy={BOOK_COPY_EN} locale="en" />
}
