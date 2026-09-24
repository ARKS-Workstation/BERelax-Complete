/**
 * `/ar/book` — the public booking flow, in Arabic.
 *
 * A separate route rather than a runtime toggle, for the reason `app/(ar)/ar/page.tsx` records: the
 * language is part of the URL a crawler indexes and a customer shares, and `lang`/`dir` belong to the
 * `(ar)` root layout's `<html>`. It renders the same component as the English page with the Arabic copy,
 * so the two documents cannot drift in structure — and it is the same registry entry, which is what makes
 * the `hreflang` sets identical. An `hreflang` set with one locale pointing at a 404 invalidates the whole
 * set, so this route lands with its English twin rather than after it.
 *
 * The mirroring is the layout's, not the copy's: every rule this page relies on is authored with logical
 * properties, and `book.itest.ts` asserts the day strip really changes side between the two documents
 * rather than only changing language.
 */
import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { BOOK_COPY_AR } from '../../../../src/book/copy-ar.ts'
import { BOOK_SESSION_COOKIE } from '../../../../src/book/flow.ts'
import { bookingPageData } from '../../../../src/book/read.ts'
import { parseBookingParams } from '../../../../src/book/state.ts'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { BookingPageBody } from '../../../_book/booking-page.tsx'

export const metadata: Metadata = {
  title: 'احجز جلستك — BE RELAX Massage Center and Spa',
  description: 'اختر الجلسة واليوم والوقت. الأوقات المعروضة متاحة فعلًا، ولا حاجة لإنشاء حساب.',
  ...routeMetadata('book', 'ar'),
}

export default async function ArabicBookPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = parseBookingParams(await searchParams)
  // The flow session, read here and passed down — see the English twin for why it is an argument
  // rather than a `cookies()` call inside `bookingPageData`.
  const token = (await cookies()).get(BOOK_SESSION_COOKIE)?.value ?? null
  const data = await bookingPageData(params, { now: Date.now(), sessionToken: token })
  return <BookingPageBody data={data} params={params} copy={BOOK_COPY_AR} locale="ar" />
}
