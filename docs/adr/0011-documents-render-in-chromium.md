# ADR 0011 — generated documents render in Chromium, and every Latin run in Arabic is isolated

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** F10
- **Covers:** docs/01 decisions 27, 28, 29

## The problem

Every document this system issues is bilingual: a tax invoice, a receipt, a payroll slip, a leave
record. The Arabic half needs two things that are easy to underestimate.

**Shaping.** Arabic letters are cursive and each has up to four contextual forms. Choosing between
them is an OpenType `GSUB` problem that needs a shaping engine. Without one you get correct
codepoints drawn in isolated forms — text that looks like Arabic to someone who does not read it,
and looks broken to everyone who does.

**Reordering.** A line mixing Arabic and Latin is resolved by the Unicode Bidirectional Algorithm,
UAX #9. It is a real state machine, and its results are not intuitive.

## Decision 1 — render HTML in headless Chromium

A pdfkit-class library gives neither. It draws the codepoints you hand it, left to right, in the
forms you hand it. Getting Arabic right with one means carrying HarfBuzz and an ICU bidi
implementation and driving them yourself, per document, forever.

Chromium carries both, correct and continuously exercised by the entire web. It also brings CSS, so
an invoice is a stylesheet rather than a coordinate system, and the same template can be shown on
screen and printed.

**Consequence, and it is not free:** the worker process needs a Chromium binary — roughly 170MB in
the image, plus the memory of a browser process while rendering. That rules out the smallest worker
droplet and adds a build step (`playwright install --with-deps chromium`) to CI and to deployment.
Accepted, because the alternative is hand-rolled Arabic typography in a codebase with one builder.

**Fonts travel with the document.** IBM Plex Sans and IBM Plex Sans Arabic are embedded as base64
`data:` URLs from pinned `@fontsource` packages, not referenced from the host. A PDF that names a
font it does not carry renders however the reader's machine feels like rendering it. Worse for the
tests: a missing Arabic face produces notdef boxes whose ToUnicode map still reports the original
characters, so "the PDF contains Arabic" passes while every glyph is a box. Embedding removes the
whole class of failure, and `unicode-range` keeps each script on the face designed for it.

## Decision 2 — isolate every Latin run inside Arabic, unconditionally

Measured in Chromium, inside an Arabic paragraph, without an isolate:

| Written | Displayed | Effect |
|---|---|---|
| `+971 52 823 9069` | `9069 823 52 971+` | a phone number nobody can dial |
| `#INV-2026-000123` | `INV-2026-000123#` | the hash jumps the run |
| `بنسبة 5%` | `%5` | the sign lands on the wrong side of the figure |
| `11:00 - 02:00` | `02:00 - 11:00` | **the two times swap, and nothing looks wrong** |
| `INV-2026-000123` | unchanged | survives — because of where it happens to sit |

The last two rows are the argument. The trading-hours case is not a mangled string a reader would
question; it is a plausible sentence stating the wrong hours, and this is a booking system that sends
Arabic reminders. And the bare reference surviving is why isolation is **not** applied where someone
checked: the same string is safe in one sentence and broken in the next, so auditing case by case
produces a system that is correct until someone edits a template.

The helpers live in `packages/core/src/text/bidi.ts` — pure, no I/O — so outbound SMS and email use
the same ones as the PDF renderer. `bdi()` is the HTML spelling; `isolateLtr()` and friends are the
plain-text spelling for channels with no markup.

**A trap recorded here because it cost a render:** `Intl.NumberFormat('ar-AE', { style: 'currency' })`
wraps the Arabic currency abbreviation in U+200F marks to hold it in place, and `safeText` strips
every bidi control because it cannot tell ICU's marks from an attacker's. That is the right trade,
but it means a formatted Arabic amount is not self-positioning after sanitising. Documents therefore
state amounts as `AED 950.00` in both scripts — which is also the only notation that appears once per
invoice rather than twice.

## Decision 3 — untrusted text is stripped of bidi controls, and source is too

A single U+202E in a customer's name reverses everything after it. On a document that states an
amount, that is enough to make the printed total differ from the stored one. So `safeText` strips
controls from every interpolated value, and the committed invoice fixture carries a hostile name to
prove it.

The same hazard exists one level up, in source code: CVE-2021-42574, "Trojan Source", where the code
a reviewer reads differs from the code the compiler parses. `scripts/check-invisible-chars.mjs`
rejects literal bidi and zero-width characters across `packages`, `apps`, `scripts` and `docs`; the
escape form is what source carries, because a reviewer can see it. Two known-bad fixtures in
`scripts/test-gates.mjs` prove the gate fires, per [ADR 0003](0003-every-gate-needs-a-known-bad-fixture.md).

## How this is proved rather than asserted

Three acceptance criteria, and a fourth thing that decides whether they mean anything: that none of
them can pass vacuously. Each assertion is paired with a control that must fail.

- **Shaping** — the rendered Arabic is measured joined and again with U+200C between every letter.
  Joining makes it ~20% narrower. A fallback font drawing isolated forms, or notdef boxes, would show
  no difference. The PDF is separately checked for Arabic Presentation Forms-B codepoints, which only
  a shaper produces.
- **RTL order** — asserted from PDF geometry (pdf.js reading what Chromium wrote), against an
  identical left-to-right control paragraph.
- **Isolation** — `fixtures/bidi-specimen.pdf` renders each case twice, isolated and not, and the
  suite asserts the un-isolated one is **wrong**. Neutering `bdi()` fails eight tests.

Both fixtures are committed as PDF and as PNG. The PNG is the reviewable artifact: shaping, order and
isolation are covered by assertions, and a column that now wraps badly is not.

## What this does not decide

The invoice's field list, its gap-free numbering and its VAT arithmetic belong to the accounting
workstream (`docs/03` §7, units `M-VAT-*`), which renders through this template rather than replacing
it. The fields present are the FTA tax-invoice fields so that hand-off is a wiring job.

Tagged (accessible) PDF output is not available through Playwright's `page.pdf`. Noted as a gap for
`M-VAT` if an auditor or a screen reader ever needs it.
