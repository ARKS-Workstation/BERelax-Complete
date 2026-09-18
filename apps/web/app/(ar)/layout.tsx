import type { ReactNode } from 'react'
import { DocumentShell, documentMetadata, documentViewport } from '../_document/shell.tsx'
import '../globals.css'

export const metadata = {
  ...documentMetadata,
  title: 'بي ريلاكس — مركز مساج وسبا، الزاهية، أبوظبي',
  description:
    'مركز مساج في شارع الميناء بالزاهية، أبوظبي. مفتوح يوميًا من ١١ صباحًا حتى ٢ بعد منتصف الليل.',
}
export const viewport = documentViewport

/** The Arabic document. One of two root layouts; see `_document/shell.tsx`. */
export default function ArabicRootLayout({ children }: { children: ReactNode }) {
  return <DocumentShell locale="ar">{children}</DocumentShell>
}
