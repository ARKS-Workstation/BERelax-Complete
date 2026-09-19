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
      name: 'google-tokens-only-in-with-google',
      comment:
        'Only the Google token-handling modules may reach the token accessors in ' +
        'packages/google/src/token-store.ts — openToken, sealToken, rewrapToken and connectionBinding. ' +
        'The refresh token is a durable bearer credential for control of the business Google presence, ' +
        'and the scope it carries has no read-only variant: the token that reads reviews also rewrites ' +
        'the address and the opening hours (docs/10 §3). A consumer that decrypted one would also be ' +
        'bypassing withGoogle, and with it the taxonomy, the correlation id, the declared degraded mode ' +
        'and the dashboard row that makes a failure visible. ' +
        'WHAT THIS RULE CAN AND CANNOT DO, because the difference is the whole design: ' +
        'dependency-cruiser sees module-to-module edges, so it can close the import path to the ' +
        'accessors and nothing else. It cannot see an identifier, and it cannot see the string ' +
        'refresh_token_ct in a query — those halves are scripts/check-google-token-chokepoint.mjs, ' +
        'whose rules are google-token-columns-outside-the-token-modules, ' +
        'google-token-accessor-outside-the-token-modules and google-token-in-a-template-literal. ' +
        'A rule matching a module is also defeated by a RE-EXPORT, which is how ' +
        'messaging-providers-only-inside-a-transport came to ban the providers barrel; here the barrel ' +
        'cannot be banned, because it is the package entry point the consent route legitimately imports, ' +
        'so the accessors were removed from packages/google/src/index.ts instead and only the ' +
        'SealedToken type is re-exported. A type decrypts nothing.',
      severity: 'error',
      from: {
        // The four modules that legitimately hold a plaintext token, plus with-google.ts, the chokepoint
        // this rule is named for. Tests are allowed because a fixture has to seal a token to exist, and
        // a test file ships nowhere. Narrowing this to the two modules the manifest names would mean
        // moving the refresh into with-google.ts, which G-CONN-04 immediately moves back out.
        pathNot: [
          '^packages/google/src/(with-google|token-store|lifecycle|rewrap|oauth/reconnect)\\.ts$',
          '^packages/google/src/.*\\.(test|itest)\\.ts$',
        ],
      },
      to: {
        path: '^packages/google/src/token-store\\.ts$',
        // The exemption that keeps the rule honest rather than merely strict. `SealedToken` is the five
        // sealed columns as a type, and connection-store, memory-store and postgres-store all move those
        // columns around without ever holding a key. Condemning a type-only import would have forced
        // either a pointless type move or — far likelier — the rule being relaxed to nothing.
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'no-lucide-outside-the-icon-wrapper',
      comment:
        'Only packages/ui/src/icon.tsx may import Lucide. docs/08 §7 asks for it "behind a wrapped ' +
        '<Icon> export at strokeWidth 1.5, 20px UI / 24px nav" — imported directly, those three numbers ' +
        'are props somebody has to remember at every call site, and the ones they forget are the Lucide ' +
        'defaults: stroke 2 at 24px, which is a heavier, geometrically different system sitting beside ' +
        '17px humanist text. The wrapper also closes the set of names, so an icon nobody chose does not ' +
        'compile and the bundle carries eight glyphs rather than the library. Two alternations, for the ' +
        'same reason core-must-be-pure has three: an installed package resolves into node_modules, an ' +
        'uninstalled one resolves to its bare name.',
      severity: 'error',
      from: { pathNot: '^packages/ui/src/icon\\.tsx$' },
      to: { path: '(^|/)node_modules/lucide-react/|^lucide-react(/|$)' },
    },
    {
      name: 'no-motion-in-the-shared-layout',
      comment:
        'docs/08 §7 budgets the motion library at "≤2 code-split islands, never in the shared layout". ' +
        'This is the "never in the shared layout" half, and it is a rule rather than a convention ' +
        'because the cost is invisible at the call site: every route in the application renders ' +
        'app/_document/shell.tsx through one of the four root layouts, so a client reference imported ' +
        'there is in the chunk every page loads — about 33KB gzip for `motion` v12, on a home route ' +
        'budgeted at 110KB for all of its first-party JavaScript (docs/08 §8). Nothing in the diff says ' +
        'so: the page renders, the animation works, and the number moves. ' +
        'WHAT IS FORBIDDEN, and what is deliberately not. The `to` names two things: the motion ' +
        'ISLANDS — the .tsx files in packages/ui/src/motion — and the motion LIBRARY itself, in both ' +
        'spellings, because an uninstalled package resolves to its bare name and an installed one ' +
        'resolves into node_modules (the same trap that left no-lucide-outside-the-icon-wrapper ' +
        'configured, green and dead). It does not forbid the rest of that directory: the shell imports ' +
        'motionBootstrapScript from motion/bootstrap.ts, which is a pure function returning a string ' +
        'that goes inline into the document head, and it is exactly what lets the fallback decide ' +
        'before the first paint without the shared layout carrying a single byte of motion JavaScript. ' +
        'A type or a token is not a bundle. ' +
        'Dynamic imports are forbidden here too, and that is not an oversight. A dynamic import in the ' +
        'shared layout still puts the island on every route in the application; it only changes when it ' +
        'is fetched. The `from` list is the four root layouts, the document shell they all render, and ' +
        'packages/ui/src/layout — the layout primitives, which are server components that every page ' +
        'composes and which have no business owning a browser-only behaviour. ' +
        'The byte-level half of the same claim is build/budgets.json: shared-layout-client-js measures ' +
        'the chunks every route loads, with the two client modules that are allowed named explicitly, ' +
        'because this rule sees module-to-module edges and cannot see a library bundled inside a module ' +
        'it permits.',
      severity: 'error',
      from: {
        path: '^(apps/web/app/\\([a-z]+\\)/layout\\.tsx$|apps/web/app/_document/|packages/ui/src/layout/)',
      },
      to: {
        path: '^packages/ui/src/motion/[^/]+\\.tsx$|(^|/)node_modules/(motion|framer-motion)/|^(motion|framer-motion)(/|$)',
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
    //
    // Anchored to first-party paths, which it was not. `(^|/)(dist|\.next|\.claude)/` also excluded
    // every installed package that ships from `dist/` — which is most of them — so a rule whose `to.path`
    // named such a package could never fire: the dependency was dropped before any rule saw it.
    // `no-lucide-outside-the-icon-wrapper` was configured, green, and dead, and a fixture importing
    // `lucide-react` was cruised with no violation reported. Same class of defect as ADR 0002's "green
    // tick on zero modules", one layer down. `react` resolves to `react/index.js` and had no `dist/` in
    // its path, which is why `core-must-be-pure` never noticed.
    exclude: { path: '(^|/)\\.claude/|^(packages|apps)/[^/]+/(dist|\\.next)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require'] },
    reporterOptions: { text: { highlightFocused: true } },
  },
}
