import type { ReactNode } from 'react'
import { DocumentShell, documentMetadata, documentViewport } from '../_document/shell.tsx'
import '../globals.css'

/**
 * The Arabic document's title and description.
 *
 * The address and the hours were removed here at the same time as their English counterparts in
 * `_document/shell.tsx`, and for one extra reason worth writing down: the grep gate's patterns are written
 * in Latin script, so an address transliterated into Arabic was a **second hard-coded NAP that the gate
 * could not see**. It is the same defect, one script further from anything that would catch it.
 *
 * Extending the gate to Arabic is not the fix, because there is nothing to compare against: `premises`
 * holds one spelling of the address and it is the English one. An Arabic address has to come from an
 * Arabic column that does not exist, so the honest state is not to assert one in a baked title.
 */
export const metadata = {
  ...documentMetadata,
  title: 'بي ريلاكس — مركز مساج وسبا',
  description:
    'مركز مساج وسبا في أبوظبي. غرف خاصة، وحمام مغربي، وجلسة تمتد حتى ساعات الفجر الأولى.',
}
export const viewport = documentViewport

/** The Arabic document. One of two root layouts; see `_document/shell.tsx`. */
export default function ArabicRootLayout({ children }: { children: ReactNode }) {
  return <DocumentShell locale="ar">{children}</DocumentShell>
}
