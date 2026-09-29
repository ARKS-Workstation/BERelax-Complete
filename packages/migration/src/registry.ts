import { AppError } from '@berelax/shared'
import { probeImporter } from './conformance/probe-importer.ts'
import type { ImporterDefinition } from './framework.ts'

/**
 * Every importer `scripts/migrate-import.mjs` can run, by name.
 *
 * A registry rather than a dynamic import of a path the caller supplies, for the reason `packages/payments`
 * gives about its gateway adapters: the thing being chosen decides what gets written into the books, so the
 * choice is a value in the tree that a reader can enumerate, not a string on a command line that resolves to
 * whatever is on disk. A typo then names nothing instead of running something.
 *
 * H-MIG-02 through H-MIG-11 add theirs here. The only entry today is the framework's conformance importer,
 * which is deliberately listed rather than hidden: the CLI is what a person runs, and a CLI whose registry is
 * empty cannot be exercised at all — the first real importer would be the first time the command had ever
 * been run. `probe` writes into the framework's conformance target and nothing reads that table, so the
 * worst a mistaken invocation can do is add rows nothing looks at.
 */
export const IMPORTERS: readonly ImporterDefinition[] = Object.freeze([probeImporter()])

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
