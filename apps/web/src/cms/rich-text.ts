/**
 * Lexical editor state, flattened to the two shapes a rendered page needs.
 *
 * ## Why this exists rather than `@payloadcms/richtext-lexical`'s renderer
 *
 * Two things need the text of a rich-text field and only one of them is markup: the page renders it, and
 * the **publication lint reads it**. `lintCmsCopy` and `healthAdjacencyOf` take a string, and a lint handed
 * an empty string passes every document — so the flattener is the single most load-bearing twenty lines on
 * these routes, and it is here, in a `.ts` file a unit test can import, with `content.test.ts` asserting it
 * against a nested fixture. A renderer that produced React would not be testable by the unit suite at all
 * (`apps/web/tsconfig.json` sets `jsx: "preserve"`, so vitest cannot parse a `.tsx` from this application).
 *
 * ## What it deliberately does not do
 *
 * It does not preserve structure. A heading, a list item and a quotation all come out as paragraphs, and
 * inline formatting is dropped. That is a real limitation and it is stated rather than hidden: the copy
 * these routes render is FAQ answers, an editorial page body and a journal standfirst, all of which are
 * prose, and a partial renderer that handled three node types and silently dropped the fourth would lose
 * the copy an editor had written without telling anybody. When a route needs formatted bodies, the right
 * move is Payload's own `RichText` component beside this — which returns markup and leaves this function
 * as the lint's input.
 *
 * Nothing here assumes the value is well-formed: it arrives from a JSON column, and a row written by a
 * different Payload version is the case that would otherwise throw inside a page render.
 */

/** One node of the tree, as much of it as this module looks at. */
interface LexicalNode {
  readonly type?: unknown
  readonly text?: unknown
  readonly children?: unknown
}

function nodesOf(value: unknown): readonly LexicalNode[] {
  if (value === null || typeof value !== 'object') return []
  const children = (value as LexicalNode).children
  return Array.isArray(children) ? (children as LexicalNode[]) : []
}

/** Every string in one node's subtree, concatenated. Inline formatting is a span, not a break. */
function textOf(node: LexicalNode): string {
  const own = typeof node.text === 'string' ? node.text : ''
  const nested = nodesOf(node).map(textOf).join('')
  return `${own}${nested}`
}

/**
 * The block-level pieces of a rich-text value, in order, blank ones dropped.
 *
 * A block is a direct child of the root: a paragraph, a heading, a list. Each becomes one `<p>` on the
 * page, which is what makes a rendered answer a sequence of paragraphs rather than one run-on line.
 */
export function richTextParagraphs(value: unknown): readonly string[] {
  if (value === null || typeof value !== 'object') return []
  const root = (value as { readonly root?: unknown }).root
  return nodesOf(root)
    .map((node) => textOf(node).trim())
    .filter((text) => text !== '')
}

/**
 * The whole value as plain text, paragraphs separated by a blank line.
 *
 * This is what the lint reads. The separator matters for exactly one reason: `lexiconTokens` splits on
 * every non-alphanumeric character, so joining two paragraphs with no separator would fuse the last word of
 * one to the first word of the next and produce a token neither of them is.
 */
export function richTextToPlainText(value: unknown): string {
  return richTextParagraphs(value).join('\n\n')
}
