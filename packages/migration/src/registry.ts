import { AppError } from '@berelax/shared'
import { probeImporter } from './conformance/probe-importer.ts'
import type { ImporterDefinition } from './framework.ts'
import { packagesImporter } from './importers/packages/import.ts'

/**
 * Every importer `scripts/migrate-import.mjs` can run, by name.
 *
 * A registry rather than a dynamic import of a path the caller supplies, for the reason `packages/payments`
 * gives about its gateway adapters: the thing being chosen decides what gets written into the books, so the
 * choice is a value in the tree that a reader can enumerate, not a string on a command line that resolves to
 * whatever is on disk. A typo then names nothing instead of running something.
 *
 * H-MIG-04 through H-MIG-11 add theirs here. `probe` is the framework's conformance importer, deliberately
 * listed rather than hidden: the CLI is what a person runs, and a CLI whose registry is empty cannot be
 * exercised at all — the first real importer would be the first time the command had ever been run. It
 * writes into the framework's conformance target and nothing reads that table, so the worst a mistaken
 * invocation can do is add rows nothing looks at.
 *
 * `packages` is H-MIG-03's, and it is registered with NO options, which is a decision rather than a
 * default. Everything that importer needs — the owner's sign-off, the opening date, the customer, the
 * template version — it reads inside the transaction the framework hands its `apply`, because this array
 * is a module-level value and cannot have read anything when it was constructed. The one thing it cannot
 * read there is the template list H-MIG-02's validator wants, since `validate` is synchronous: omitting it
 * moves `template-key-names-no-package-template` and `template-has-no-version-to-sell-against` from
 * staging to apply, carrying the same vocabulary value, and `importers/packages/import.ts` says why. A
 * caller that has already read the templates — the CLI, and every test — builds the importer itself with
 * `packagesImporter({ templates })` and gets those two as rejections naming every bad line at once.
 */
export const IMPORTERS: readonly ImporterDefinition[] = Object.freeze([
  packagesImporter(),
  probeImporter(),
])

export function importerNames(): readonly string[] {
  return IMPORTERS.map((importer) => importer.name)
}

export function importerByName(name: string): ImporterDefinition {
  const found = IMPORTERS.find((importer) => importer.name === name)
  if (found === undefined) {
    throw new AppError(
      'not_found',
      `No importer is registered as "${name}". Registered: ${importerNames().join(', ')}.`,
      { details: { name } },
    )
  }
  return found
}
