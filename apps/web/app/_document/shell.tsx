import {
  DARK_PALETTE,
  directionFor,
  LIGHT_PALETTE,
  type Locale,
  motionBootstrapScript,
  themeBootstrapScript,
} from '@berelax/ui'
import { DirectionProvider } from '@berelax/ui/direction'
import { ThemeProvider } from '@berelax/ui/theme-provider'
import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { fontVariables } from '../_fonts/index.ts'

/**
 * The document's fallback title and description — and the address it deliberately no longer carries.
 *
 * The title used to end with the district and the emirate, and the description carried the street and the
 * hours. Both came off docs/13 by hand, and `packages/db/src/seed/premises.test.ts` exempted this file for
 * it. W-SITE-02 retired that exemption, and the fix is a deletion rather than a lookup. The reason is the
 * one the `SITE_ORIGIN` guard in
 * `apps/web/src/route-spine.itest.ts` records for canonical URLs, applied to the address:
 *
 * `/` and `/ar` are statically prerendered, so a root layout's `metadata` is evaluated during `next build`
 * and **baked into the HTML**. A build-time read of the `premises` row would therefore either fail the
 * build on a machine with no database — which includes CI, where the build step runs before the migrations
 * (see `app/api/v1/otp/route.ts` on exactly this) — or bake whatever that machine's database happened to
 * hold, which is a hard-coded address with extra steps and no way to tell it had gone stale.
 *
 * So the shared document metadata carries the **name only**. The name is the one NAP element that is also
 * the brand, docs/09 §"The brand collision" requires the *full* name in every title because
 * `berelax.com` is an unrelated airport-spa chain with an outlet in the same city, and there is nowhere
 * else for a fallback title to get it. The locality that docs/09 also wants in titles belongs to the
 * per-route metadata of the routes that are rendered from the catalogue and the CMS — W-SITE-04's home
 * page, W-SITE-05's treatment pages, W-SITE-07's `/contact` and `/spa` — each of which reads the row.
 *
 * The address, the area aliases and the hours are published today by `/api/facts` and `/llms.txt`, and
 * rendered by `@berelax/ui`'s NAP block wherever a route can read the row at request time.
 */
export const documentMetadata: Metadata = {
  title: 'BE RELAX — Massage Center and Spa',
  description:
    'A massage and spa centre in Abu Dhabi. Private rooms, a wet room, and one session that runs from ' +
    'late morning until the small hours.',
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
        {/*
          The same trick for the same reason, one line further down: the reveal.

          In a browser with no `animation-timeline`, `[data-reveal]` is an ordinary animation that plays
          on load, so the below-fold reveal has finished before the reader has scrolled to it. The
          fallback holds each one at its first frame instead — which only works if the decision is made
          before the first paint, or the reveal plays and the reader then watches content that was
          already on screen vanish and come back when the island hydrates.

          It is a string, not a module. That is what keeps `build/budgets.json`'s claim true — the shared
          layout ships zero bytes of motion JavaScript — while the shell still carries the decision, and
          `@berelax/ui/motion/reveal` stays a code-split island nothing here imports.
        */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant from motionBootstrapScript(), never user input, and it has to be inline to run before paint
          dangerouslySetInnerHTML={{ __html: motionBootstrapScript() }}
        />
      </head>
      <body>
        {/*
          `DirectionProvider` is imported from `@berelax/ui/direction` rather than from the primitives
          barrel: every page in the application renders this shell, and importing the barrel here would
          put a client reference to the dialog, the sheet, the popover and the select into the module
          graph of routes that render none of them.

          It is here as well as on `<html dir>` because Radix portals its overlays into `document.body`,
          where an ancestor's direction cannot reach them, and because several of its behaviours are
          direction-dependent in JavaScript rather than in CSS. See `primitives/direction.tsx`.
        */}
        <ThemeProvider>
          <DirectionProvider locale={locale}>{children}</DirectionProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
