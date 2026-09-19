/**
 * The one component that renders a `<script type="application/ld+json">`.
 *
 * ## Why there is exactly one
 *
 * The acceptance criterion is *"zero hand-written `application/ld+json` string literals; every JSON-LD block
 * on every registry route is produced by a builder function"*. A convention cannot be checked, so this is
 * the only place in the repository where that attribute value appears —
 * `apps/web/src/seo/structured-data.test.ts` greps for it and fails on a second one, and
 * `apps/web/src/seo/structured-data.itest.ts` fetches every registry document, parses every block out of the
 * served HTML and compares it with `buildStructuredDataGraph`'s output for the same route — node for node,
 * with only the breadcrumb's per-locale copy excluded. A block nobody built has nothing to match, and a
 * document nobody expected a block on has to carry none.
 *
 * ## Why `dangerouslySetInnerHTML`, and why that is not dangerous here
 *
 * JSX escapes text children as HTML entities, and `{"&quot;@context&quot;"}` inside a script
 * element is not JSON — a consumer's `JSON.parse` fails on the first entity. The only way to put raw JSON in
 * the element is to set the inner HTML, which is what every structured-data implementation does.
 *
 * The escaping that matters is done in `serialiseGraph`: `<`, `>` and `&` become their JSON `\uXXXX`
 * escapes, so a value containing `</script>` cannot close the element early. Every string in the graph comes
 * from a database row or a CMS field a person can type into, which is exactly why the escape is in the
 * serialiser rather than trusted to the data.
 *
 * ## Why the graph arrives already built, and why this file holds nothing else
 *
 * This component does no reading and no deciding. The read is `readGraphForPage` in `./page-graph.ts`, which
 * needs a database; the per-route assembly is `./graph-input.ts`, which is pure; the node builders are
 * `@berelax/core`, which is pure and unit-tested against the emitted JSON.
 *
 * The split is not only tidiness. `apps/web/tsconfig.json` sets `jsx: "preserve"` — Next compiles the JSX,
 * not the typechecker — so vitest's transform cannot parse a `.tsx` from this application at all. A unit test
 * therefore cannot import this file, and anything a unit test has to reach has to live outside it. Putting
 * the route assembly in here would have made it unreachable by every test but an integration one.
 */
import { type StructuredDataGraph, serialiseGraph } from '@berelax/core'

/**
 * The attribute value, spelled once.
 *
 * A constant rather than a literal in the JSX below, because the grep gate that enforces "one block
 * builder" has to be able to tell the one legitimate spelling from a second one somebody added. The gate
 * knows this file and this constant; anything else that spells it is a finding.
 */
export const JSON_LD_MIME = 'application/ld+json'

/** Renders one graph. The only `<script type="application/ld+json">` in the application. */
export function StructuredData({ graph }: { readonly graph: StructuredDataGraph }) {
  return (
    <script
      type={JSON_LD_MIME}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: JSX would entity-escape the JSON and no consumer can parse that. serialiseGraph escapes <, > and & to their JSON \uXXXX forms, so a value containing </script> cannot close the element.
      dangerouslySetInnerHTML={{ __html: serialiseGraph(graph) }}
    />
  )
}
