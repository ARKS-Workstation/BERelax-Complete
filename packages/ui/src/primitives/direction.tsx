'use client'

/**
 * The direction the Radix tree is in.
 *
 * docs/08 §7: "RTL requires `<DirectionProvider dir={locale === 'ar' ? 'rtl' : 'ltr'}>` around the
 * Radix tree." This is that, with the locale-to-direction decision taken from `theme/theme.ts` instead
 * of re-made here, so the `<html dir>` the document shell renders and the direction every portal reads
 * come from one function.
 *
 * ## Why a provider is needed at all when `<html dir>` is already right
 *
 * Radix portals its overlays into `document.body`, and several of its behaviours are direction-dependent
 * in JavaScript rather than in CSS: which arrow key moves to the next item, which side a popper flips
 * to, which edge a slider starts from. None of that can be read off an ancestor's computed style,
 * because the portalled node's ancestors are the body and nothing else. The provider is how the
 * direction crosses the portal boundary — and `Select` then puts it back on the DOM as a `dir`
 * attribute, which is what `apps/web/src/primitives.itest.ts` reads.
 *
 * It is a client component because it is React context. The document shell that renders it is a server
 * component; a server component may render a client one, which is the whole point of the boundary.
 */
import { DirectionProvider as RadixDirectionProvider } from '@radix-ui/react-direction'
import type { ReactNode } from 'react'
import { directionFor, type Locale } from '../theme/theme.ts'

export { useDirection } from '@radix-ui/react-direction'

export function DirectionProvider({
  locale,
  children,
}: {
  readonly locale: Locale
  readonly children: ReactNode
}) {
  return <RadixDirectionProvider dir={directionFor(locale)}>{children}</RadixDirectionProvider>
}
