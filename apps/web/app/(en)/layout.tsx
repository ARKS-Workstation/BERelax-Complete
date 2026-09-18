import type { ReactNode } from 'react'
import { DocumentShell, documentMetadata, documentViewport } from '../_document/shell.tsx'
import '../globals.css'

export const metadata = documentMetadata
export const viewport = documentViewport

/** The English document. One of two root layouts; see `_document/shell.tsx`. */
export default function EnglishRootLayout({ children }: { children: ReactNode }) {
  return <DocumentShell locale="en">{children}</DocumentShell>
}
