/**
 * The bidi specimen: every mixed-direction case this system emits, isolated and un-isolated.
 *
 * This document exists for two reasons.
 *
 * **It is the known-bad fixture.** A test that only renders the isolated version cannot tell a
 * working isolate from a renderer that happens to be doing what we wanted anyway. Each case here
 * appears twice — once as the code writes it, once as a careless edit would write it — and the test
 * asserts the careless version is *wrong*. If both pass, the test is not testing anything, and the
 * suite says so.
 *
 * **It is documentation that cannot go stale.** The committed render shows, in ink, what happens to
 * a phone number in an Arabic sentence without an isolate. The next person to simplify
 * `documents/invoice.ts` can look at it.
 *
 * Every expectation below was measured in Chromium, not derived from UAX #9 by hand. The percent
 * case in particular is not obvious: a bare `5%` in an Arabic paragraph puts the sign on the left of
 * the figure, while the same `5%` in a table cell puts it on the right, so an invoice that writes it
 * both ways states its VAT rate two different ways on one page.
 */
import { bdi, safeText } from '@berelax/core'
import { FONT_STACK, fontFaceCss } from '../fonts.ts'

/** A dialling code is the classic case: the `+` is a neutral and it moves. */
export const SPECIMEN_PHONE = '+971 52 823 9069'
/**
 * A reference with a leading hash.
 *
 * Measured: the bare reference `INV-2026-000123` survives an Arabic sentence un-isolated, because
 * Arabic on both sides and hyphens between digits happen to resolve the way we wanted. Put a `#` in
 * front of it — `Invoice #INV-...`, which is how a reference is normally written — and the hash
 * jumps to the far end of the run. That is why isolation is unconditional rather than applied where
 * someone checked: the same string is safe in one sentence and broken in the next.
 */
export const SPECIMEN_REFERENCE = '#INV-2026-000123'
/** The same reference without the hash, which survives by position. Case T12 documents it. */
export const SPECIMEN_BARE_REFERENCE = 'INV-2026-000123'
export const SPECIMEN_RATE = '5%'
export const SPECIMEN_AMOUNT = 'AED 950.00'
/**
 * Trading hours, and the worst of the lot.
 *
 * `11:00 - 02:00` un-isolated in an Arabic sentence renders as `02:00 - 11:00`: not mangled, not
 * obviously broken — just the two times swapped. A customer reads a plausible sentence stating the
 * wrong hours, and nothing about it looks like a bug. This is a booking system, so this case is the
 * reason the isolation helpers exist in `@berelax/core` rather than in this package.
 */
export const SPECIMEN_HOURS = '11:00 - 02:00'

const ARABIC_LEAD = 'المبلغ المستحق'
const ARABIC_TAIL = 'شكراً لكم'
const ARABIC_HOURS_LEAD = 'ساعات العمل'

export interface BidiCase {
  /**
   * A short Latin marker, isolated and placed first in the paragraph.
   *
   * A PDF carries no element ids, so the test finds a case's line by looking for its marker. In a
   * right-to-left paragraph the marker therefore sits at the far right of its own line, which is
   * itself a check that the paragraph direction took effect. The `T` prefix keeps markers from
   * colliding with words in the captions, which share the page.
   */
  readonly id: string
  readonly title: string
  readonly direction: 'rtl' | 'ltr'
  /** Paragraph body, already escaped and isolated exactly as the case intends. */
  readonly body: string
  /** A string the reader must see, reading the line left to right. */
  readonly expectVisual?: string
  /**
   * A string the reader must NOT see.
   *
   * Used by the un-isolated cases: the assertion is that the run does *not* survive, which is what
   * makes the isolated case's success meaningful. Each one was measured, not predicted.
   */
  readonly rejectVisual?: string
}

export const BIDI_CASES: readonly BidiCase[] = [
  {
    id: 'T01',
    title: 'Right-to-left paragraph order',
    direction: 'rtl',
    // Two markers whose logical order is known. In RTL the first must end up to the right of the
    // second — the most basic thing a bidi renderer has to get right.
    body: `${bdi('AAA', 'ltr')} ${safeText(ARABIC_LEAD)} ${bdi('ZZZ', 'ltr')}`,
  },
  {
    id: 'T02',
    title: 'Left-to-right control paragraph',
    direction: 'ltr',
    body: `${bdi('AAB', 'ltr')} ${safeText(ARABIC_LEAD)} ${bdi('ZZY', 'ltr')}`,
  },
  {
    id: 'T03',
    title: 'Phone number, NOT isolated — the dialling code moves to the far end',
    direction: 'rtl',
    body: `${safeText(ARABIC_LEAD)} ${safeText(SPECIMEN_PHONE)}`,
    rejectVisual: SPECIMEN_PHONE,
  },
  {
    id: 'T04',
    title: 'Phone number, isolated — correct',
    direction: 'rtl',
    body: `${safeText(ARABIC_LEAD)} ${bdi(SPECIMEN_PHONE, 'ltr')}`,
    expectVisual: SPECIMEN_PHONE,
  },
  {
    id: 'T05',
    title: 'Reference with a leading hash, NOT isolated — the hash moves',
    direction: 'rtl',
    body: `${safeText(ARABIC_LEAD)} ${safeText(SPECIMEN_REFERENCE)} ${safeText(ARABIC_TAIL)}`,
    rejectVisual: SPECIMEN_REFERENCE,
  },
  {
    id: 'T06',
    title: 'Reference with a leading hash, isolated — correct',
    direction: 'rtl',
    body: `${safeText(ARABIC_LEAD)} ${bdi(SPECIMEN_REFERENCE, 'ltr')} ${safeText(ARABIC_TAIL)}`,
    expectVisual: SPECIMEN_REFERENCE,
  },
  {
    id: 'T07',
    title: 'VAT rate, NOT isolated — the sign lands on the wrong side of the figure',
    direction: 'rtl',
    body: safeText(`بنسبة ${SPECIMEN_RATE}`),
    rejectVisual: SPECIMEN_RATE,
  },
  {
    id: 'T08',
    title: 'VAT rate, isolated — correct',
    direction: 'rtl',
    body: `${safeText('بنسبة')} ${bdi(SPECIMEN_RATE, 'ltr')}`,
    expectVisual: SPECIMEN_RATE,
  },
  {
    id: 'T09',
    title: 'Trading hours, NOT isolated — the two times swap and nothing looks wrong',
    direction: 'rtl',
    body: `${safeText(ARABIC_HOURS_LEAD)} ${safeText(SPECIMEN_HOURS)}`,
    rejectVisual: SPECIMEN_HOURS,
  },
  {
    id: 'T10',
    title: 'Trading hours, isolated — correct',
    direction: 'rtl',
    body: `${safeText(ARABIC_HOURS_LEAD)} ${bdi(SPECIMEN_HOURS, 'ltr')}`,
    expectVisual: SPECIMEN_HOURS,
  },
  {
    id: 'T11',
    title: 'Amount, isolated — correct',
    direction: 'rtl',
    body: `${safeText(ARABIC_LEAD)} ${bdi(SPECIMEN_AMOUNT, 'ltr')}`,
    expectVisual: SPECIMEN_AMOUNT,
  },
  {
    id: 'T12',
    title: 'Bare reference, NOT isolated — survives, but only because of where it sits',
    direction: 'rtl',
    body: `${safeText(ARABIC_LEAD)} ${safeText(SPECIMEN_BARE_REFERENCE)} ${safeText(ARABIC_TAIL)}`,
    // Deliberately an expectation, not a rejection. The point of this row is that an un-isolated run
    // can look fine, which is what makes auditing case by case the wrong strategy.
    expectVisual: SPECIMEN_BARE_REFERENCE,
  },
  {
    id: 'T13',
    title: 'Hostile name carrying U+202E — the override must be stripped, not honoured',
    direction: 'ltr',
    // safeText strips the override. Were it honoured, everything after it would print reversed.
    body: safeText('Ahmed Al Mansoori\u202e 950.00'),
    expectVisual: 'Ahmed Al Mansoori 950.00',
  },
]

/** Renders the specimen to a complete, self-contained HTML document. */
export function renderBidiSpecimenHtml(): string {
  const rows = BIDI_CASES.map((testCase) => {
    const verdict =
      testCase.rejectVisual === undefined
        ? '<span class="good">isolated</span>'
        : '<span class="bad">not isolated</span>'
    return [
      '<section>',
      `<div class="caption">${safeText(testCase.title)} ${verdict}</div>`,
      `<p dir="${testCase.direction}" lang="ar" class="specimen">`,
      `${bdi(testCase.id, 'ltr')} ${testCase.body}`,
      '</p>',
      '</section>',
    ].join('')
  }).join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Bidi specimen</title>
<style>
${fontFaceCss()}
@page { size: A4; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: ${FONT_STACK}; font-size: 11pt; color: #1b1a18; }
h1 { font-size: 15pt; font-weight: 600; margin: 0 0 2pt; }
.intro { color: #5f5b55; font-size: 9.5pt; margin: 0 0 14pt; max-width: 62ch; }
section { border-top: 0.5pt solid #d8d3cb; padding: 7pt 0; }
.caption { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.08em; color: #5f5b55; margin-bottom: 3pt; }
.good { color: #2f6b4f; }
.bad { color: #9b3226; }
.specimen { margin: 0; font-size: 13pt; line-height: 1.9; }
</style>
</head>
<body>
<h1>Bidirectional text specimen</h1>
<p class="intro">Each pair shows the same content isolated and un-isolated. The rows marked
<span class="bad">not isolated</span> are deliberate: they are what the document looks like when an
isolate is dropped, and the test suite asserts they are wrong. Generated by unit F10.</p>
${rows}
</body>
</html>`
}
