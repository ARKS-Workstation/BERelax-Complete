/**
 * The Arabic route.
 *
 * A separate route rather than a runtime toggle, because the language is part of the URL a crawler
 * indexes and a customer shares. `lang` and `dir` are set by the `(ar)` root layout on `<html>`, not
 * here on a wrapper — `theme/arabic.css` inherits the whole recalibration from the document element,
 * and a wrapper leaves `body` Latin. `W-SITE` replaces this with a `[locale]` segment once there are
 * real pages to localise.
 */
export default function ArabicHomePage() {
  return (
    <main>
      <h1>بي ريلاكس</h1>
      <p>مركز مساج في الزاهية، أبوظبي.</p>
    </main>
  )
}
