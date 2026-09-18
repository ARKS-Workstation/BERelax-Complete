import type { ReactNode } from 'react'
import { DocumentShell, documentMetadata, documentViewport } from '../_document/shell.tsx'
import '../globals.css'

export const metadata = documentMetadata
export const viewport = documentViewport

export default function AdminRootLayout({ children }: { children: ReactNode }) {
  return <DocumentShell locale="en">{children}</DocumentShell>
}
