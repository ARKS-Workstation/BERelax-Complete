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
        // Three alternations, because dependency-cruiser matches `path` against the *resolved* path and
        // what that is depends on whether the module is installed:
        //
        //   1. a Node builtin resolves to its own name, so `node:fs` matches by name;
        //   2. an *uninstalled* package also resolves to its bare name, which is why `pg` and `next`
        //      appeared to be covered — neither was a dependency of this repo;
        //   3. an installed one resolves into node_modules, which is why the bare `drizzle-orm` branch
        //      never fired: `drizzle-orm/pg-core` resolves to
        //      `node_modules/.pnpm/drizzle-orm@…/node_modules/drizzle-orm/pg-core/index.js`.
        //
        // The third branch is what M-TILL-01's ledger fixture in scripts/test-boundaries.mjs caught: the
        // rule was configured, green, and dead for every framework actually installed. ADR 0003.
        path: '^(node:)?(fs|http|https|net|dns|child_process|worker_threads)$|^(next|react|drizzle-orm|pg|postgres)(/|$)|(^|/)node_modules/(next|react|drizzle-orm|pg|postgres)/',
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
        path: '^packages/(config|messaging|auth|db|clinical|pdf|ui|providers|fixtures|harness|google)/',
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
        path: '^(packages/(core|db|ui|config|messaging|auth|clinical|pdf|providers|fixtures|harness|google)|apps)/',
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
      name: 'messaging-providers-only-inside-a-transport',
      comment:
        'Only packages/messaging/src/transports may reach an SMS or email provider. Everything else ' +
        'sends through the sendMessage() choke point, which is where the sender-ID class rule, the ' +
        'promotional gate, the campaign spend cap and the staging send guard live. A feature that calls ' +
        'SMSala directly bypasses all four: it can send promotional content from the transactional ' +
        'identity, inside quiet hours, to a real customer from a staging run. See ADR 0016 and docs/03 ' +
        '§4. Scoped to the messaging providers on purpose — the Google OAuth port carries none of those ' +
        'concerns, and a rule that banned all of packages/providers stopped packages/google compiling ' +
        'while proving nothing extra.',
      severity: 'error',
      from: { pathNot: '^packages/(providers|messaging/src/transports)/' },
      to: {
        // Three things, and the middle one is the interesting one. The SMS and email ports and their
        // SDKs are the hazard; the **barrel** is the loophole, because `@berelax/providers` re-exports
        // every port, so `import { SMSALA } from '@berelax/providers'` reaches SMSala while naming
        // nothing forbidden. Banning the barrel outside a transport closes it, and a consumer with a
        // legitimate non-messaging need imports a subpath — `@berelax/providers/google`,
        // `/failure`, `/call-log` — which is what `packages/google` does.
        //
        // Deliberately a direct-dependency rule and not `reachable`: reachability also condemns
        // `send.test.ts` for importing the transport, which is the one path that is *supposed* to
        // reach a provider. It was tried; it reported four violations, all of them the intended design.
        path: '^packages/providers/src/(sms|email)/|^packages/providers/src/index\\.ts$|/node_modules/(smsala|resend|twilio)/',
      },
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
