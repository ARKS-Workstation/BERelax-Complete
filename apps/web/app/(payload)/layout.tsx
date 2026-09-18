/* The admin's own document. See the note below and `payload.config.ts` before changing anything here. */
import { handleServerFunctions, RootLayout } from '@payloadcms/next/layouts'
import type { ServerFunctionClient } from 'payload'
import type { ReactNode } from 'react'
import config from '../../payload.config.ts'
import { importMap } from './admin/importMap.js'
/*
 * Payload's admin stylesheet, imported HERE and nowhere else.
 *
 * This import and `../globals.css` are the two halves of the collision this route group exists to
 * prevent. `globals.css` clears Tailwind's colour, spacing, radius, breakpoint, font and `--text-*`
 * namespaces with `: initial` and then defines ours; Payload's admin is built on its own custom
 * properties and its own reset. Loaded together, whichever lands second wins, and the symptom is an admin
 * with no spacing scale or a site whose focus ring has moved.
 *
 * Next scopes a CSS import to the layout subtree that imports it, so the isolation is structural: the two
 * locale root layouts import `globals.css` and this one imports Payload's. Neither imports the other, and
 * `scripts/check-cms-boundary.mjs` fails the build if either crosses — see its
 * `payload-admin-must-not-load-the-site-stylesheet` rule.
 */
import '@payloadcms/next/css'

/**
 * The third root layout.
 *
 * `app/(en)/layout.tsx` and `app/(ar)/layout.tsx` each render a document through `_document/shell.tsx`,
 * because the locale belongs to `<html>` (see that file's note). Payload's `RootLayout` renders a third
 * one, with its own `lang`, its own `<head>` and its own theme handling. It cannot be nested inside ours:
 * two `<html>` elements is invalid HTML that React will warn about and hydrate wrongly, and our
 * `ThemeProvider` would be fighting Payload's for the same `data-theme` attribute.
 *
 * So `(payload)` is a sibling route group with no shared ancestor, which is exactly what Next's App Router
 * route groups are for. Nothing in `_document/shell.tsx` runs for an admin request.
 */
const serverFunction: ServerFunctionClient = async function serverFunction(args) {
  'use server'
  return handleServerFunctions({ ...args, config, importMap })
}

export default function PayloadRootLayout({ children }: { children: ReactNode }) {
  return (
    <RootLayout config={config} importMap={importMap} serverFunction={serverFunction}>
      {children}
    </RootLayout>
  )
}
