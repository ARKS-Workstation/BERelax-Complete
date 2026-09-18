/**
 * Module boundary rules. The dependency direction is:
 *
 *   apps/*  ->  core, db, shared
 *   db      ->  shared
 *   core    ->  shared          (core is pure: no db, no I/O, no framework)
 *   shared  ->  (nothing internal)
 *
 * This is what stops a nine-module system rotting into a ball of mud.
 * See docs/02-architecture.md §3.
 */
module.exports = {
  forbidden: [
    {
      name: 'core-must-not-import-db',
      comment:
        'packages/core is pure domain logic. It must not reach the database — inject data instead.',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: '^packages/db/' },
    },
    {
      name: 'core-must-be-pure',
      comment:
        'packages/core must not do I/O or depend on a framework. Availability, pricing, VAT and ' +
        'accrual logic stay testable as pure functions.',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: {
        path: '^(node:)?(fs|http|https|net|dns|child_process|worker_threads)$|^(next|react|drizzle-orm|pg|postgres)(/|$)',
      },
    },
    {
      name: 'core-must-not-import-infrastructure',
      comment:
        'packages/config reads the environment and packages/messaging performs I/O. core stays pure ' +
        'and receives what it needs as arguments.',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: '^packages/(config|messaging|auth|db|clinical)/' },
    },
    {
      name: 'db-must-not-import-core',
      comment: 'Dependency direction is core <- db, never db -> core.',
      severity: 'error',
      from: { path: '^packages/db/' },
      to: { path: '^packages/core/' },
    },
    {
      name: 'shared-must-not-import-siblings',
      comment: 'packages/shared is the leaf. Nothing internal may be imported into it.',
      severity: 'error',
      from: { path: '^packages/shared/' },
      to: { path: '^(packages/(core|db|ui|config|messaging|auth|clinical)|apps)/' },
    },
    {
      name: 'nothing-imports-an-app',
      comment: 'Apps are entry points. A package must never import from an app.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-circular',
      comment: 'Circular dependencies make build order and reasoning undecidable.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment: 'An unreferenced module is either dead code or a missing wire-up.',
      severity: 'warn',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '(^|/)index\\.ts$', '\\.test\\.ts$'] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)dist/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require'] },
    reporterOptions: { text: { highlightFocused: true } },
  },
}
