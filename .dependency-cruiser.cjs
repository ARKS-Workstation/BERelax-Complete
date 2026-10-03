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
      name: 'analytics-taxonomy-must-be-pure',
      comment:
        'The event taxonomy and the funnel vocabulary in packages/shared/src/analytics may reach zod and ' +
        'their own siblings inside packages/shared, and nothing else. A-FIRST-02 asks for modules that ' +
        '"import nothing beyond @berelax/shared and never read the clock". ' +
        'WHY THIS RULE EXISTS ALONGSIDE shared-must-not-import-siblings, because the overlap is nil: that ' +
        'rule forbids the OTHER FIRST-PARTY PACKAGES and says nothing about a Node builtin, a framework or ' +
        'a database driver. packages/shared is the leaf every package imports, so until this rule existed ' +
        'a `node:fs` in the taxonomy was a boundary violation no gate could see — the tree with the ' +
        'strictest purity requirement in the build was the only one with no import rule about it. ' +
        'packages/core is covered by core-must-be-pure; the vocabulary had to leave core precisely ' +
        'BECAUSE packages/db needs it (funnel_step.stage is these words) and db must never import core, ' +
        'so the move that made it reachable also moved it out from under its own gate. ' +
        'WHAT THIS RULE CAN AND CANNOT DO, and the difference is why the acceptance names two gates. ' +
        'Dependency-cruiser sees module-to-module edges, so it closes the IMPORT path to I/O. It cannot ' +
        'see `Date.now()` or `process.env`, which are globals and not dependencies — that half is ' +
        'scripts/check-core-purity.mjs, which was widened to read this one directory outside ' +
        'packages/core for exactly this reason and bans Date and Intl here outright. Neither gate can ' +
        'see that a function takes its instant as an ARGUMENT; that is the type signature, and ' +
        'packages/core/src/analytics/funnel.test.ts is what exercises it. ' +
        'Three alternations, for core-must-be-pure’s reason — the trap that left ' +
        'no-lucide-outside-the-icon-wrapper configured, green and dead: a Node builtin and an ' +
        'UNINSTALLED package both resolve to their bare name, while an installed one resolves into ' +
        'node_modules. The known-bad fixture is in scripts/test-gates.mjs block 124 and asserts this rule ' +
        'fires BY NAME, with a control that imports zod alone and must pass. ' +
        'A-FIRST-04 widened the `from` to cover packages/shared/src/crawlers.ts, which is the AI crawler ' +
        'policy table that packages/core/src/analytics/bots.ts is built from. Same argument, one step ' +
        'removed: core is pure, core reads that table, and a `node:fs` inside it would make core impure ' +
        'through an edge no gate could see — check-core-purity.mjs walks DIRECTORIES and cannot take a ' +
        'single file as a root. The known-bad fixture is in scripts/test-gates.mjs block 140.',
      severity: 'error',
      from: { path: '^packages/shared/src/(analytics/|crawlers\\.ts$)' },
      to: {
        path:
          '^(node:)?(fs|path|os|http|https|net|tls|dns|crypto|child_process|worker_threads)$|' +
          '^(next|react|drizzle-orm|pg|postgres|undici|axios|node-fetch)(/|$)|' +
          '(^|/)node_modules/(next|react|drizzle-orm|pg|postgres|undici|axios|node-fetch)/',
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
      name: 'review-email-parse-takes-its-input-as-an-argument',
      comment:
        'packages/core/src/reviews/email-parse.ts may depend on NOTHING outside packages/core and ' +
        'packages/shared. G-REV-02s acceptance line asks for a dependency-cruiser assertion plus the ' +
        'core-must-be-pure gate to prove the parser takes the raw body as an argument and performs no I/O ' +
        'and no clock read, and this is the half the purity script cannot make. ' +
        'WHY IT IS NOT REDUNDANT WITH core-must-be-pure, which is the obvious objection. That rule names a ' +
        'list: fs, http, https, net, dns, child_process, worker_threads, and the four frameworks. It does ' +
        'not name node:perf_hooks, whose `performance.now()` is a clock read, and it does not name ' +
        'node:crypto, node:os or node:timers. check-core-purity.mjs does not see them either, because it ' +
        'greps for `Date.now`, `new Date()`, `process.`, `fetch(`, `Math.random(`, `globalThis` and ' +
        '`console.` — an imported clock is none of those. So both existing checks pass for a parser that ' +
        'reads `performance.now()`, and a parse whose answer depends on when it ran is a parse that cannot ' +
        'be replayed against the bytes it was given. An allowlist closes the whole class at once instead ' +
        'of extending two lists every time Node grows a module. ' +
        'WHY IT IS SCOPED TO ONE FILE rather than to the directory. The rest of packages/core/src/reviews ' +
        'legitimately imports the compliance lexicon and the escalation tables, and would keep doing so; ' +
        'this module is the one whose contract is *a string and an instant in, a value out*, and it is the ' +
        'one an inbound email reaches first. Widening it to the directory would either ban imports that are ' +
        'correct or be relaxed to nothing within the week. ' +
        'The known-bad fixture in scripts/test-gates.mjs adds `import { performance } from ' +
        '"node:perf_hooks"` and asserts THIS rule fires by name — deliberately a module that core-must-be-pure ' +
        'does not list, so the fixture proves this rule rather than an older one shadowing it, and a ' +
        'control fixture importing @berelax/shared must pass.',
      severity: 'error',
      from: { path: '^packages/core/src/reviews/email-parse\\.ts$' },
      to: { pathNot: '^packages/(core|shared)/' },
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
        'rule rather than an older one shadowing it. ' +
        'WIDENED BY C-CRM-09 to name packages/core/src/clinical/, and the argument is a gap the other ' +
        'three entries cannot close. C-CRM-08 considered this and left it, reasoning that the real ' +
        'protection is that decrypting needs the KEK and the store — which is true of DATA and is not ' +
        'what this rule is for: the rule closes the IMPORT PATH, and every path it named crosses a package ' +
        'boundary. packages/core/src/reviews/ and packages/core/src/clinical/ are sibling directories of ' +
        'ONE package, so `import { deriveContraindicationFlags } from "../clinical/..."` needs no entry in ' +
        'any package.json, is invisible to pnpm deps, and would have been the shortest edit in the ' +
        'repository. What it reaches is not incidental either: renderSubmission takes a decrypted answer ' +
        'map and labels it with the questions a client was asked, and deriveContraindicationFlags takes ' +
        'the same map — a prompt builder importing either has a payload in hand, which is the only reason ' +
        'to import them. Type-only is not exempted here for the reason it is not exempted above: ' +
        'ContraindicationFlagSet and RenderedAnswer are the shapes of fields somebody intends to ' +
        'interpolate. What is NOT forbidden is @berelax/shared, which holds the flag KEY SET (a closed list ' +
        'of eight column names, and the negative half of the manage-booking allowlist derives from it) — ' +
        'banning it would ban the package every package may import. The known-bad fixture for this entry is ' +
        'in scripts/test-boundaries.mjs, because a relative import inside one package is what has to be ' +
        'seen to fire and a fixture importing @berelax/core would resolve to core/src/index.ts and match ' +
        'nothing.',
      severity: 'error',
      from: { path: '^(packages/core/src/reviews/|packages/google/src/reviews/)' },
      to: {
        path: [
          '^packages/clinical/',
          '^packages/core/src/clinical/',
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
      name: 'reviews-v4-is-quarantined',
      comment:
        'Only packages/google/src/reviews/ and the package barrel may import ' +
        'packages/google/src/adapters/reviews-v4.ts. docs/10 SS7 calls Reviews the HIGHEST-RISK dependency ' +
        'in the plan and says why in one line: "Reviews remaining on legacy v4 while everything else ' +
        'migrated is the clearest possible signal it will move." Everything else this build touches is v1 ' +
        'on a host Google maintains; this is the one API on a host it has deprecated the rest of. ' +
        'WHAT THE RULE BUYS. The cost of that migration is the number of modules that know the old shape, ' +
        'so the manifest puts the goal as "a migration is a day not a month" - which is only true while ' +
        'the answer to how many modules know is ONE. A route, a worker job or the SEO agent holding a ' +
        'reference to this adapter is a second module to change, and the one nobody remembers. ' +
        'The barrel is permitted because it is the package entry point a consumer legitimately imports and ' +
        'because the submitter has to be wirable from outside; packages/google/src/reviews/ is permitted ' +
        'because that is the subsystem the adapter belongs to - the send path that takes it as an injected ' +
        'port, and the first-sync reconciliation. ' +
        'A DIRECT-dependency rule and not `reachable`, for messaging-providers-only-inside-a-transport ' +
        'reason: the barrel re-exports the factory, so reachability would condemn every consumer of ' +
        '@berelax/google and report the intended design as a violation. Tests are exempt - the adapter ' +
        'suite has to import it to exercise it, and a test ships nowhere. ' +
        'The HOST STRING half of the same claim cannot be made here at all: dependency-cruiser sees ' +
        'module edges, not strings. It is packages/fixtures/src/reviews-v4-quarantine.test.ts, which ' +
        'asserts the host appears in exactly one non-test module. Both halves have known-bad fixtures in ' +
        'scripts/test-gates.mjs asserting they fire BY NAME.',
      severity: 'error',
      from: {
        pathNot: [
          '^packages/google/src/reviews/',
          '^packages/google/src/index\\.ts$',
          '^packages/google/src/adapters/reviews-v4\\.ts$',
          '\\.(test|itest)\\.ts$',
        ],
      },
      to: { path: '^packages/google/src/adapters/reviews-v4\\.ts$' },
    },
    {
      name: 'gbp-consistency-check-is-read-only',
      comment:
        'packages/google/src/seo/gbp-consistency.ts may not reach ' +
        'packages/google/src/adapters/business-information-write.ts, which holds the only path to a ' +
        'Business Profile PATCH. G-SEO-06s acceptance line asks for exactly this: the checker is ' +
        '"read-only by construction", and construction means the write cannot be referenced rather than ' +
        'is not currently called. ' +
        'WHY IT MATTERS MORE THAN IT LOOKS. The checker reports that the profile and the premises row ' +
        'disagree. The obvious next feature is a button that fixes it, and the obvious implementation is ' +
        'the checker calling the write while it already has both values in hand - at which point an ' +
        'agent-driven pass writes to the business Google profile with no human in between. The write ' +
        'adapter exists and is reached from the SCREEN, where a person approves the change: ' +
        'applyApprovedHours takes the periods a human approved as an argument and refuses a payload ' +
        'wider than its mask, because docs/10 SS7 says a naive whole-object PATCH wipes the Ramadan ' +
        'specialHours. ' +
        'A `reachable` rule rather than a direct-dependency one, because the hazard is a hop: a helper ' +
        'module that re-exported the write would satisfy a direct rule while leaving the checker one ' +
        'import from the PATCH. Tests are exempt - business-information-write.test.ts has to import the ' +
        'adapter to exercise it, and a test ships nowhere. ' +
        'The known-bad fixture is in scripts/test-gates.mjs and asserts this rule fires BY NAME.',
      severity: 'error',
      from: { path: '^packages/google/src/seo/gbp-consistency\\.ts$' },
      to: {
        path: '^packages/google/src/adapters/business-information-write\\.ts$',
        reachable: true,
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
      name: 'payments-must-not-reach-the-network',
      comment:
        'The payment adapters in packages/db/src/adapters may not reach an HTTP client, a socket or a ' +
        'name resolver. M-TILL-07 asks for a manual tender adapter that is "real, not a fake" and for ' +
        'the module to be "forbidden from making network calls", and the reason is narrower than ' +
        'tidiness: this is the code that records money received, inside a transaction, and a module ' +
        'that can reach out over the network has a failure mode where the payment is recorded in one ' +
        'place and not the other — and a request that hangs on a socket holds the row lock on the ' +
        'invoice while it does. Cash, a card terminal and a bank transfer are all keyed in by a person ' +
        'standing at the till: there is nothing to call. ' +
        'The Y-PAY gateway WILL make network calls. It implements the same PaymentAdapter interface ' +
        'and it will live behind a port in packages/providers, which is where the retry taxonomy, the ' +
        'correlation id and the declared degraded mode already are — so this rule is what keeps that ' +
        'boundary somewhere it can be seen rather than in a comment. ' +
        "Two alternations, for core-must-be-pure's reason, which is the trap that left " +
        'no-lucide-outside-the-icon-wrapper configured, green and dead: a Node builtin and an ' +
        'UNINSTALLED package both resolve to their bare name, while an installed one resolves into ' +
        'node_modules. `fetch` is a global and therefore invisible to dependency-cruiser at all, ' +
        'which is why manual-payment.itest.ts also runs the adapter with fetch, http.request and ' +
        'https.request replaced by throwing stubs — a module-graph rule cannot see a global, and the ' +
        'two halves together are the claim. ' +
        'THE TEST FILES ARE EXEMPT, and the exemption is the point rather than a hole. ' +
        'manual-payment.itest.ts imports node:http and node:https in order to REPLACE their `request` ' +
        'with a throwing stub — the opposite of using them — and it is the file that proves the adapter ' +
        'succeeds with no network at all. A rule that condemned it would leave the claim unprovable, and ' +
        'the first version of this rule did exactly that: two errors against the test that exists to ' +
        'demonstrate the rule. Nothing imports a test file, vitest would run anything named like one, and ' +
        'the fixtures in scripts/test-boundaries.mjs and gate block 92 are ordinary modules, so the ' +
        'exemption cannot be used to smuggle shipped code past this.',
      severity: 'error',
      from: { path: '^packages/db/src/adapters/', pathNot: '\\.(test|itest)\\.ts$' },
      to: {
        path:
          '^(node:)?(http|https|net|tls|dgram|dns|http2)$|' +
          '(^|/)node_modules/(undici|axios|node-fetch|got|superagent|ky|request|form-data)/|' +
          '^(undici|axios|node-fetch|got|superagent|ky|request|form-data)(/|$)',
      },
    },
    {
      name: 'tax-and-filing-must-not-reach-the-network',
      comment:
        'The tax modules and the return export path may not reach an HTTP client, a socket, a name ' +
        'resolver or an outward-facing package. ADR 0017 and docs/01 decision 13 say the codebase has NO ' +
        'CAPABILITY TO FILE A RETURN — "absent, not disabled, because a future maintainer will eventually ' +
        'switch a flag on" — and ADR 0052 is what turns that sentence into something a build can refuse. ' +
        'A prohibition nothing enforces is a comment, and the comment in this case is about the one ' +
        'artefact whose liability sits with the taxable person rather than with this software. ' +
        'WHY IT IS A SEPARATE RULE FROM core-must-be-pure. That rule covers packages/core and forbids ' +
        'http, https and net — three of the eight builtins that reach a network, and none of the seven ' +
        'client libraries. It also cannot reach packages/db at all, where the snapshot, the filing door ' +
        'and the export live, and db legitimately does I/O, so there is no purity rule to extend. The ' +
        'estate here is therefore named: packages/core/src/tax, the working papers, the sealed return, ' +
        'and the Zoho export. scripts/test-no-autofile.mjs holds the same list and fails if this rule ' +
        'stops covering any of it, so the two cannot drift apart. ' +
        'WHAT THIS RULE CANNOT SEE, stated rather than left to be discovered: `fetch` is a global, so a ' +
        'module graph is blind to it, exactly as the payments rule above records. The other half is ' +
        'scripts/test-no-autofile.mjs, which scans the same files for the network-capable globals and ' +
        'for the identifiers a filing path would be named after. Neither half is the claim on its own. ' +
        'THE TEST FILES ARE EXEMPT, for the payments rule’s reason and the same way round: ' +
        'zoho-export.itest.ts imports node:http and node:https in order to REPLACE their `request` with ' +
        'a throwing stub, which is how it proves the export completes with no network and no credentials ' +
        'at all. A rule that condemned that file would leave the claim unprovable.',
      severity: 'error',
      from: {
        path:
          '^packages/core/src/tax/|' +
          '^packages/db/src/queries/vat201-working-papers\\.ts$|' +
          '^packages/db/src/services/vat-return-signoff\\.ts$|' +
          '^packages/db/src/services/zoho-export\\.ts$',
        pathNot: '\\.(test|itest)\\.ts$',
      },
      to: {
        path:
          '^(node:)?(http|https|net|tls|dgram|dns|http2)$|' +
          '(^|/)node_modules/(undici|axios|node-fetch|got|superagent|ky|request|form-data)/|' +
          '^(undici|axios|node-fetch|got|superagent|ky|request|form-data)(/|$)|' +
          '^packages/(google|messaging|providers)/',
      },
    },
    {
      name: 'payment-gateway-adapters-only-through-the-registry',
      comment:
        'Only packages/payments/src/registry.ts may construct a payment gateway adapter. Everything else ' +
        'takes one from the registry, which is the only place PAYMENT_PROVIDER is read — and that is what ' +
        'makes choosing a real gateway a configuration change rather than an edit at every call site ' +
        '(ADR 0022 rule 3, ADR 0055). A consumer that imported createFakeCardGateway directly would keep ' +
        'using the fake in production with nothing saying so: `parseConfig` would still refuse ' +
        'PAYMENT_PROVIDER=real outside production, the boot-time refusal for `real` would still fire, and ' +
        'the money would still go through a fake, because that call site never asked the config anything. ' +
        'The registry also owns the shared movement sink and the shared failure script, so a directly ' +
        'constructed adapter writes to a log the payments screen does not read. ' +
        'THE BARREL IS THE LOOPHOLE, and it is closed the way ' +
        'messaging-providers-only-inside-a-transport closes its own: packages/payments/src/index.ts does ' +
        'NOT re-export anything from adapters/, because a re-export makes a module-matching rule match ' +
        'nothing. The gateway names a consumer might want are reachable as `registry.till.name`. ' +
        'Tests are exempt: registry.test.ts and the conformance suite have to build adapters to test them, ' +
        'and the conformance suite building every adapter is the point rather than a hole.',
      severity: 'error',
      from: {
        pathNot: [
          '^packages/payments/src/registry\\.ts$',
          '^packages/payments/src/conformance/',
          '^packages/payments/src/.*\\.(test|itest)\\.ts$',
        ],
      },
      to: {
        path: '^packages/payments/src/adapters/',
        // A type constructs nothing, and `google-tokens-only-in-with-google` exempts `SealedToken` for the
        // same reason: without this, the barrel could not re-export `FakeCardGateway` — the type carrying
        // the fake's 3DS hook — and the rule would have been relaxed to nothing instead.
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'non-conforming-payment-fixtures-stay-in-the-conformance-suite',
      comment:
        'packages/payments/src/conformance/fixtures holds adapters that are DELIBERATELY broken — one ' +
        'returns success and writes no movement at all, which is the acceptance line Y-PAY-01 exists to ' +
        'prove the suite catches. They exist so that the conformance suite has been seen to fail ' +
        '(ADR 0003), and they must be unreachable from anything that could register one. ' +
        'This is not a hypothetical tidiness rule. The fixture is a complete, compiling PaymentGateway ' +
        'that looks entirely plausible at a call site: it authorises, it captures, it refunds, it returns ' +
        'snapshots with the right shape. The one thing it does not do is leave a record, and a system ' +
        'wired to it would take money and post nothing — which presents as a reconciliation that is short ' +
        'by every transaction, with no error anywhere. ' +
        'Scoped to the fixtures directory rather than to a filename, so a second saboteur added beside the ' +
        'first is covered without anyone remembering.',
      severity: 'error',
      from: { pathNot: '^packages/payments/src/conformance/' },
      to: { path: '^packages/payments/src/conformance/fixtures/' },
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
    {
      name: 'seo-site-analysis-must-take-the-untrusted-envelope',
      comment:
        'The two G-SEO-04 analyses handed FETCHED BYTES — internal-link-audit.ts, which reads sitemap.xml, ' +
        'and structured-data-validate.ts, which reads a rendered page — must import ' +
        'packages/core/src/seo/untrusted-envelope.ts, because their acceptance criterion is that the bytes ' +
        'arrive ALREADY WRAPPED: the argument is a SeoUntrustedEnvelope, so the wrapping is visible at every ' +
        'call site rather than being a convention the next caller has not read. ' +
        'WHY THESE TWO AND NOT EVERY MODULE IN THE DIRECTORY. The third analysis, coverage-anomaly.ts, is ' +
        'handed NUMBERS — a Search Console series, a PageSpeed score, a CrUX record — and wrapping a count ' +
        'in a prompt-safety envelope would be theatre: there is no region for an instruction to escape from, ' +
        'and a rule that demanded the import would be satisfied by a dead one. A rule satisfied by a dead ' +
        'import is worse than no rule, because it reads as proof. The G-SEO-01/03 modules beside them ' +
        '(gsc-window, query-rows, ctr-outliers, content-gaps, cannibalisation, rare-query-gap) are the same ' +
        'case for the same reason. So the module set is named, exactly as ' +
        'seo-prompt-must-use-the-untrusted-envelope names its own by a path convention. ' +
        'WHAT IT CATCHES. The change this is really against is a later maintainer widening one of the two ' +
        'to take a `string` for convenience — in a test, then in a caller that copied the test — at which ' +
        'point fetched HTML enters packages/core with no stripping and no cap, and the scanners in both ' +
        'modules can be handed a NUL that truncates the document or a bidi run that makes the extracted ' +
        'JSON read in a different order than it parses. ' +
        'Like its companion it is satisfiable only from INSIDE packages/core/src/seo — @berelax/core exports ' +
        'its barrel and nothing else — which is where both modules live, for the reason link-graph.ts does: ' +
        'a rule that can only run against a live server is a rule whose failure nobody has seen. The ' +
        'known-bad fixture is gate case 163, and there is a control fixture that keeps the import and must ' +
        'pass (ADR 0003).',
      severity: 'error',
      module: {
        path: '^packages/core/src/seo/(internal-link-audit|structured-data-validate)\\.ts$',
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
