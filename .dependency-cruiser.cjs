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
        path: '^packages/(config|messaging|auth|db|clinical|pdf|ui|providers|fixtures|harness|google|hr)/',
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
        path: '^(packages/(core|db|ui|config|messaging|auth|clinical|pdf|providers|fixtures|harness|google|hr)|apps)/',
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
      name: 'reviews-generator-must-not-reach-clinical-data',
      comment:
        'The review reply prompt builder and the reply generator must not import packages/clinical or ' +
        'any intake repository. docs/07 SS4: "No clinical or intake data ever enters any LLM prompt." ' +
        'WHY THIS IS A RULE AND NOT A CONVENTION. The mistake is the most natural one in the unit: a ' +
        'treatment note, a contraindication flag or an intake answer is exactly the "context" somebody ' +
        'reaches for to make a reply feel personal, and it would work — the draft would be better, and ' +
        'the breach would be invisible until a reply quoted a health disclosure on a public listing. ' +
        'F08 built the boundary that makes the data unreachable at the database (a separate schema, no ' +
        'cross-schema foreign key, the application role denied); this closes the import path, which is ' +
        'the half a database grant cannot close because the generator runs as a role that could be ' +
        'granted it later. ' +
        'WHAT IS IN THE `to`, and why each entry. packages/clinical is the package itself, including its ' +
        'envelope and its store. The two path patterns after it are any db repository or schema module ' +
        'whose name carries `intake` or `clinical`: there is no intake repository today, and naming the ' +
        'shape now is deliberate, because the day one is added is the day this rule has to already ' +
        'exist — a rule added after the import is a rule added after the review that would have caught ' +
        'it. ' +
        'WHAT IS DELIBERATELY NOT FORBIDDEN. `@berelax/db` as a whole: the generator has to read the ' +
        'review row and write the draft, and a rule banning the database would ban the unit. The ' +
        'boundary being defended is clinical data, not persistence. ' +
        'A type-only exemption is deliberately absent, unlike google-tokens-only-in-with-google: there ' +
        'is no legitimate reason for the prompt builder to name a clinical TYPE either, because a type ' +
        'here would only ever be the shape of a field somebody intends to interpolate. ' +
        'The known-bad fixture is in scripts/test-gates.mjs and asserts this rule fires BY NAME, from ' +
        'packages/google/src/reviews — where no other rule forbids clinical, so the fixture proves this ' +
        'rule rather than an older one shadowing it.',
      severity: 'error',
      from: { path: '^(packages/core/src/reviews/|packages/google/src/reviews/)' },
      to: {
        path: [
          '^packages/clinical/',
          '^packages/db/src/repositories/[^/]*(intake|clinical)',
          '^packages/db/src/schema/[^/]*(intake|clinical)',
        ],
      },
    },
    {
      name: 'seo-llm-only-through-a-prompt-module',
      comment:
        'Only a *prompt* module under packages/google/src/seo may reach an LLM provider. G-SEO-02 requires ' +
        'that every byte the SEO agent did not write passes through one untrusted-data envelope ' +
        '(packages/core/src/seo/untrusted-envelope.ts), and the companion rule ' +
        'seo-prompt-must-use-the-untrusted-envelope requires every *prompt* module to import it. Those two ' +
        'rules only add up to the criterion if the set of SEO modules that can reach a model IS the set of ' +
        'prompt modules — otherwise a module called analysis.ts builds a prompt, reaches the provider, and ' +
        'satisfies both rules by matching neither. ' +
        'WHY THIS IS A RULE AND NOT A CONVENTION. The SEO agent’s inputs are fetched competitor HTML, SERP ' +
        'text and Search Console query strings: all three arrive through an API, which is exactly why they ' +
        'read as trustworthy at the call site — nobody typed them into our form. An `${html}` in a template ' +
        'literal handed to a model is one line, works, and is invisible in review. ' +
        'WHAT IS DELIBERATELY NOT FORBIDDEN. The provider barrel is already closed to everything outside a ' +
        'transport by messaging-providers-only-inside-a-transport, so this names the llm subpath only; and ' +
        'tests are exempt, because a fuzz corpus has to be able to drive a fake provider directly.',
      severity: 'error',
      from: {
        path: '^packages/google/src/seo/',
        pathNot: ['^packages/google/src/seo/[^/]*prompt[^/]*\\.ts$', '\\.(test|itest)\\.ts$'],
      },
      to: { path: '^packages/providers/src/llm/' },
    },
    {
      name: 'seo-agent-must-not-reach-a-publish-path',
      comment:
        'No module of the SEO agent may import the CMS, Next’s cache API or the publication chokepoint. ' +
        'docs/07 §3: the agent is "propose-only, with publish denied at the permission layer — not a prompt ' +
        'instruction, an API permission", and G-SEO-02 is the unit that builds that cage. The permission ' +
        'layer is the guarantee; this rule is the second half of it, which is that the agent’s code cannot ' +
        'hold a reference to the thing it may not do. A refusal it never reaches is a refusal that cannot be ' +
        'argued with at three in the morning. ' +
        'WHAT THIS RULE CAN AND CANNOT DO, because the difference is the whole design. Dependency-cruiser ' +
        'sees module-to-module edges, so it closes the paths a module names DIRECTLY: @berelax/cms and ' +
        'next/cache (neither is a dependency of packages/google, so both resolve to their bare names — the ' +
        'same reason core-must-be-pure carries three alternations), and ' +
        'packages/core/src/access/publication.ts by path. It does NOT close the @berelax/core BARREL, which ' +
        'the agent legitimately imports and which re-exports performPublication: that is the loophole ' +
        'messaging-providers-only-inside-a-transport documents, and here it cannot be closed by banning the ' +
        'barrel because the barrel is where assertPrincipalMay comes from. The barrel half is closed by the ' +
        'POLICY layer instead and not by a lint: a caller that reaches performPublication through the barrel ' +
        'and calls it with the seo_agent principal gets PrincipalDenied, which is asserted in ' +
        'packages/core/src/access/seo-agent.policy.test.ts. ' +
        'The known-bad fixture is in scripts/test-gates.mjs and asserts this rule fires BY NAME.',
      severity: 'error',
      from: { path: '^(packages/google/src/seo/|packages/core/src/seo/)' },
      to: {
        path:
          '^packages/cms/|^@berelax/cms(/|$)|^next(/|$)|(^|/)node_modules/next/' +
          '|^packages/core/src/access/publication\\.ts$',
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
  /**
   * `required` rules: a module matching `module` MUST depend on something matching `to`.
   *
   * The inverse of everything above, and the only shape that can express "this must go through that". A
   * `forbidden` rule can say a module may not reach a provider; it cannot say that a module which does reach
   * one must also reach the escaping primitive, because that is a conjunction over two edges.
   */
  required: [
    {
      name: 'seo-prompt-must-use-the-untrusted-envelope',
      comment:
        'Any *prompt* module under packages/core/src/seo or packages/google/src/seo must import ' +
        'packages/core/src/seo/untrusted-envelope.ts. G-SEO-02: fetched HTML, SERP text and Search Console ' +
        'query strings are untrusted input (docs/07 §3, §4 on review text for the same reason), and they pass ' +
        'through ONE wrapper that fences them so the region cannot be closed from inside — proven over 200 ' +
        'adversarial strings by untrusted-envelope.fuzz.test.ts. A prompt module that does not import it is ' +
        'either interpolating the text directly or has written a second envelope, and a second envelope is a ' +
        'second thing to get right. ' +
        'WHY A PATH CONVENTION IS THE RIGHT MATCHER HERE. Dependency-cruiser cannot see a template literal, ' +
        'so the set of modules this applies to has to be nameable. The companion rule ' +
        'seo-llm-only-through-a-prompt-module closes the gap that a convention alone leaves: it forbids every ' +
        'OTHER SEO module from reaching an LLM provider at all, so a module that builds a prompt and is not ' +
        'called *prompt* cannot send it. ' +
        'THE RULE IS SATISFIABLE ONLY FROM INSIDE packages/core/src/seo, AND THAT IS THE POINT rather than a ' +
        'limitation. @berelax/core exports its barrel and nothing else, so an import of the envelope through ' +
        '@berelax/core is an edge to packages/core/src/index.ts and does NOT satisfy this rule — only a ' +
        'relative import of untrusted-envelope.ts does. So a prompt builder under packages/google/src/seo ' +
        'fails this rule, which is the correct answer: a prompt is a pure function of its inputs and belongs ' +
        'in core, where it can be fuzzed over 200 adversarial strings with no provider and no database. That ' +
        'is exactly where buildReviewReplyPrompt lives, for exactly those reasons, and G-REV-04 records them. ' +
        'THIS RULE MATCHES NO MODULE ON THE COMMITTED TREE, and that is deliberate rather than dead. ' +
        'G-SEO-05 adds the LLM drafting; naming the shape now is the same decision ' +
        'reviews-generator-must-not-reach-clinical-data records for the intake repository that does not yet ' +
        'exist — a rule added after the import is a rule added after the review that would have caught it. ' +
        'Because it can therefore never fire on the committed tree, the known-bad fixture in ' +
        'scripts/test-gates.mjs is the ONLY evidence it is alive (ADR 0003), and there is a matching control ' +
        'fixture that imports the envelope and must pass.',
      severity: 'error',
      module: {
        path: '^packages/(core|google)/src/seo/[^/]*prompt[^/]*\\.ts$',
        pathNot: '\\.(test|itest)\\.ts$',
      },
      to: { path: '^packages/core/src/seo/untrusted-envelope\\.ts$' },
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
