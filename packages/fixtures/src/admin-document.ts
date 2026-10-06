/**
 * The content of an admin document, without its chrome.
 *
 * ## Why a test needs this
 *
 * Every admin screen is now rendered inside a shell with a sidebar and a topbar, and the topbar carries a
 * sign-out form. That broke a family of assertions which were right about the screen and wrong about the
 * document: "offers no way to publish it", "offers no control at any role", "disables the submit control"
 * — each written as `expect(html).not.toMatch(/<form|<button/)` over the whole page, because at the time
 * the page was only the screen.
 *
 * The property those tests assert is still exactly right and still worth asserting. It is a claim about
 * what the SCREEN offers, so it belongs over the screen's own markup. A sign-out control in the chrome is
 * not a way to publish a rota, and a test that said otherwise would be measuring the furniture.
 *
 * The alternative was to loosen each assertion to count controls or allow one more, and that is the shape
 * a gate rots into: the number is the arithmetic of the day it was written, and the next control added to
 * the chrome makes it wrong again with no clue as to why.
 */

/**
 * The slice between the document's `<main>` and `</main>`.
 *
 * Throws rather than returning the whole document when there is no `<main>`, because a silent fallback
 * would turn every assertion using this back into a claim about the chrome — which is the bug it exists to
 * fix, reintroduced in a place nobody would look.
 */
export function adminMain(html: string): string {
  const open = html.indexOf('<main')
  if (open === -1) throw new Error('adminMain: this document has no <main> element.')
  const start = html.indexOf('>', open)
  const close = html.indexOf('</main>', start)
  if (start === -1 || close === -1) throw new Error('adminMain: the <main> element is not closed.')
  return html.slice(start + 1, close)
}
