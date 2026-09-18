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
        'packages/config reads the environment, packages/messaging performs I/O and packages/pdf drives a ' +
        'browser. core stays pure ' +
        'and receives what it needs as arguments.',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: {
        path: '^packages/(config|messaging|auth|db|clinical|pdf|ui|providers|fixtures|harness)/',
      },
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
      to: {
        path: '^(packages/(core|db|ui|config|messaging|auth|clinical|pdf|providers|fixtures|harness)|apps)/',
      },
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
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)index\\.ts$',
          '\\.test\\.ts$',
          '\\.itest\\.ts$',
          // Next.js resolves these by file-system convention rather than by import, so every route in
          // the App Router is an orphan by construction. Scoped to the names Next actually reserves, so
          // a genuinely unreferenced component in `app/` is still reported.
          '^apps/[^/]+/(app|src)/.*(^|/)(page|layout|template|loading|error|not-found|global-error|route|default|sitemap|robots|opengraph-image|icon|apple-icon|manifest|middleware|instrumentation)\\.(ts|tsx)$',
          // Build-tool configuration, loaded by the tool rather than imported.
          '^apps/[^/]+/(next|postcss|tailwind|vitest)\\.config\\.(ts|mjs|js)$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // `.next` is build output — 180-odd generated chunks, every one an orphan, which buries a real
    // finding in noise. `.claude/worktrees` is a parallel checkout of this same repository, so cruising
    // it would report every module twice.
    exclude: { path: '(^|/)(dist|\\.next|\\.claude)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require'] },
    reporterOptions: { text: { highlightFocused: true } },
  },
}
