'use client'

/**
 * Theme and direction, as a client island.
 *
 * Small on purpose. The whole application renders on the server (ADR 0013); this exists only because
 * a stored theme preference lives in `localStorage`, which the server cannot read. Everything else
 * about the theme — the tokens, the media query, the Arabic recalibration — is CSS and needs no
 * JavaScript at all.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import {
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  type Theme,
  type ThemePreference,
  themeAttributeFor,
} from './theme.ts'

interface ThemeContextValue {
  readonly preference: ThemePreference
  setPreference(preference: ThemePreference): void
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: 'system',
  setPreference: () => undefined,
})

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}

export function ThemeProvider({
  children,
  initial = 'system',
}: {
  children: ReactNode
  initial?: ThemePreference
}) {
  const [preference, setStored] = useState<ThemePreference>(initial)

  // Read once on mount. The blocking script in the layout has already applied the attribute, so this
  // is only catching the state up — it never causes a paint.
  useEffect(() => {
    try {
      const saved = globalThis.localStorage?.getItem(THEME_STORAGE_KEY)
      if (saved === 'light' || saved === 'dark') setStored(saved)
    } catch {
      // A private window throws on localStorage. A theme toggle is not worth taking the page down for.
    }
  }, [])

  const setPreference = useCallback((next: ThemePreference) => {
    setStored(next)
    const attribute = themeAttributeFor(next)
    const root = globalThis.document?.documentElement
    if (root === undefined) return
    if (attribute === undefined) root.removeAttribute(THEME_ATTRIBUTE)
    else root.setAttribute(THEME_ATTRIBUTE, attribute satisfies Theme)
    try {
      if (next === 'system') globalThis.localStorage?.removeItem(THEME_STORAGE_KEY)
      else globalThis.localStorage?.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // As above.
    }
  }, [])

  return (
    <ThemeContext.Provider value={{ preference, setPreference }}>{children}</ThemeContext.Provider>
  )
}
