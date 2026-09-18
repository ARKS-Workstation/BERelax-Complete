import {
  DARK_PALETTE,
  directionFor,
  LIGHT_PALETTE,
  type Locale,
  themeBootstrapScript,
} from '@berelax/ui'
import { ThemeProvider } from '@berelax/ui/theme-provider'
import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { fontVariables } from '../_fonts/index.ts'

export const documentMetadata: Metadata = {
  title: 'BE RELAX — Massage Center and Spa, Al Zahiyah, Abu Dhabi',
  description:
    'A massage centre on Al Meena Street in Al Zahiyah, Abu Dhabi. Open every day from 11am until 2am.',
}

export const documentViewport: Viewport = {
  // Both, so the browser paints form controls and scrollbars to match whichever theme is in force.
  colorScheme: 'light dark',
  // The one place in the application that needs a literal colour: `<meta name="theme-color">` is read
  // by the browser chrome before any stylesheet exists, so it cannot take a `var()`. Taken from the
  // generated palette rather than typed again — `scripts/palette.py` re-derives and re-measures these
  // on every run, and a second copy would be the one that went stale.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: LIGHT_PALETTE.ground },
    { media: '(prefers-color-scheme: dark)', color: DARK_PALETTE.ground },
  ],
}

/**
 * The document, shared by both root layouts.
 *
 * ## Why `lang` and `dir` have to be on `<html>`
 *
 * Every rule in `theme/arabic.css` is written `[lang='ar'] body`, `[dir='rtl'] *` — the recalibration
 * is inherited from the document element down. An earlier draft set them on a `<main>` wrapper inside
 * a single English root layout, which typechecked, built, rendered mirrored text, and did **none** of
 * the four things the recalibration exists to do: `body` kept its Latin `font-family`, so the Arabic
 * face was never requested at all; `--font-size-scalar` stayed at 1; the line-height and the 500 weight
 * never applied. Arabic rendered in Arial. Nothing failed — it just quietly was not done.
 *
 * So the locale belongs to the document, and a document per locale means a root layout per locale.
 * Next.js supports exactly that through route groups: `(en)` and `(ar)` each declare their own `<html>`,
 * and neither is nested inside the other. `W-SITE` folds them into a `[locale]` segment once there is
 * more than one page in each.
 */
export function DocumentShell({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <html lang={locale} dir={directionFor(locale)} className={fontVariables}>
      <head>
        {/*
          Before first paint, deliberately blocking.

          A stored preference lives in localStorage and the server cannot read it, so a page that
          corrects itself after hydration shows the wrong theme for a frame. This is the only way to
          be right on the first paint, and it is why it is inline rather than a module.
        */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant from themeBootstrapScript(), never user input, and it has to be inline to run before paint
          dangerouslySetInnerHTML={{ __html: themeBootstrapScript() }}
        />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
