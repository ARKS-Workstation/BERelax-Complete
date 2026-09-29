import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BOT_KINDS, classifyBot, OTHER_BOT_KINDS } from '@berelax/core'
import {
  AI_CRAWLER_BOT_KINDS,
  AI_CRAWLER_FETCHERS,
  AI_CRAWLER_USER_AGENTS,
  AI_CRAWLERS,
} from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { buildRobotsTxt } from './facts/robots.ts'

/**
 * One source of truth for the AI crawler policy (A-FIRST-04), held equal from three directions.
 *
 * `robots.txt` says which AI crawlers may fetch. `packages/core/src/analytics/bots.ts` says which ones the
 * funnel can recognise. Those are two halves of one decision and they were about to be written in two
 * places — which drifts in the direction nobody notices: a crawler allowed but unclassified is counted as
 * a person, every figure on the analytics page moves, and nothing is broken enough to fail. docs/03 §6 is
 * explicit that the second half is what makes the first affordable: *"Without a filter list and a `bot`
 * flag on every session, the funnel is meaningless."*
 *
 * So the agents live in ONE table, `packages/shared/src/crawlers.ts`, and this file is the check that
 * keeps them there. It is in `apps/web` because that is the only place all three are reachable: the
 * rendered policy is built here, `@berelax/core` holds the classifier, `@berelax/shared` holds the table,
 * and `packages/core` may not import `apps/web` in the other direction.
 *
 * ## What each claim would catch
 *
 *   - **The pin.** The six tokens are spelled out ONCE, here, so adding or removing one is a deliberate
 *     committed diff rather than a silent change to what a crawler is allowed to fetch.
 *   - **The rendered file.** Parsed back out of `buildRobotsTxt`'s own output, not read off the constant it
 *     was built from. A builder that hard-coded a list, dropped an entry, or stopped reading the table is
 *     the same defect as an edited list, and only the rendered bytes can see it.
 *   - **The classifier.** Every token the policy allows must classify as that crawler's own kind. This is
 *     the direction that fails when the table is edited alone: an entry added with no user agent in
 *     `packages/core/test/fixtures/user-agents.json` fails `bots.test.ts`, and one the classifier cannot
 *     recognise fails here.
 *   - **The scan.** A repository-wide refusal of any of these names appearing in a third file. Set equality
 *     between two statements is worth much less if a third one can be written beside them.
 */

/** The repository root, from this file's own location. `apps/web/src/` → three levels up. */
const REPO_ROOT = join(new URL('.', import.meta.url).pathname, '..', '..', '..')

const body = buildRobotsTxt({ origin: 'https://example.test', sitemapPath: null })

/** Every `User-agent:` group in the rendered file, in order, wildcard included. */
const renderedGroups = (text: string): readonly string[] =>
  text.split('\n').flatMap((line) => {
    const match = /^User-agent:\s*(\S+)\s*$/.exec(line)
    return match?.[1] === undefined ? [] : [match[1]]
  })

describe('the AI crawler policy is pinned in exactly one place', () => {
  it('is these six tokens, in this order', () => {
    // The ONE spelling of the list in the repository outside the table itself, which is what makes every
    // other assertion in this file a comparison rather than a restatement. A seventh crawler, or a
    // removal, changes this line and is reviewed as the policy change it is.
    expect([...AI_CRAWLER_USER_AGENTS]).toEqual([
      'GPTBot',
      'ClaudeBot',
      'PerplexityBot',
      'Google-Extended',
      'CCBot',
      'Bytespider',
    ])
  })

  it('pairs a bot_kind with every entry that fetches, and with no entry that does not', () => {
    // `Google-Extended` never makes a request — it controls whether content Googlebot already has may be
    // used by Gemini and Vertex. So it is allowed and unclassifiable, and the asymmetry is asserted here
    // rather than left to read as an oversight.
    expect(AI_CRAWLERS.filter((entry) => !entry.fetches).map((entry) => entry.token)).toEqual([
      'Google-Extended',
    ])
    for (const entry of AI_CRAWLERS) {
      expect(entry.botKind === null, entry.token).toBe(!entry.fetches)
      expect(entry.why.length, entry.token).toBeGreaterThan(30)
    }
    expect([...AI_CRAWLER_BOT_KINDS]).toEqual([
      'gptbot',
      'claudebot',
      'perplexitybot',
      'ccbot',
      'bytespider',
    ])
  })
})

describe('the rendered robots.txt and the table are the same set', () => {
  it('names a group for every token in the table and no token outside it', () => {
    const groups = renderedGroups(body)
    const named = groups.filter((agent) => agent !== '*')
    // Set equality, both directions, stated as two differences so the failure says WHICH side is wrong —
    // and stated BEFORE the count, which is not the order it was first written in. A missing group and an
    // extra one both change the count, so a count assertion first meant a gate case breaking one of the two
    // sides got "expected 7 to be 6" and never reached the sentence naming what was actually wrong. Gate
    // cases 140a and 140b found that on their first run.
    const inTable = new Set<string>(AI_CRAWLER_USER_AGENTS)
    const inFile = new Set(named)
    expect(
      named.filter((agent) => !inTable.has(agent)),
      'robots.txt names an agent the shared table does not hold, so it is allowed and unclassifiable',
    ).toEqual([])
    expect(
      AI_CRAWLER_USER_AGENTS.filter((agent) => !inFile.has(agent)),
      'the shared table holds an agent robots.txt does not name, so the classifier knows a crawler the policy never allowed',
    ).toEqual([])
    // The wildcard group, which is a different claim and must not be counted as one of them. Then the
    // count, which is what catches a parse that found nothing or a group rendered twice — a duplicate
    // satisfies both differences above and is a second, contradictory policy for one crawler.
    expect(groups[0]).toBe('*')
    expect(groups.length).toBe(AI_CRAWLER_USER_AGENTS.length + 1)
    // And the order, because the rendered file is what a person reads and the table is what it is read
    // against: a set-equal file in a different order is a diff nobody can review.
    expect(named).toEqual([...AI_CRAWLER_USER_AGENTS])
  })

  it('gives each of them the whole policy, which is why the list cannot be split', () => {
    // Restated from `facts.test.ts` for one reason: this file is what a future maintainer edits when the
    // list changes, and the trap is right here. A crawler obeys exactly ONE group and a named group
    // REPLACES the wildcard, so adding a token without the rules under it grants that crawler the admin.
    const groups = body.split(/\nUser-agent: /).slice(1)
    expect(groups).toHaveLength(AI_CRAWLER_USER_AGENTS.length + 1)
    for (const group of groups) {
      const rules = group.split('\n').filter((line) => /^(Allow|Disallow):/.test(line))
      expect(rules).toContain('Disallow: /admin')
      expect(rules).toContain('Disallow: /api/')
      expect(rules).toContain('Allow: /api/facts')
    }
  })
})

describe('the classifier recognises exactly what the policy allows', () => {
  it('classifies every allowed fetcher as its own distinct kind', () => {
    expect(AI_CRAWLER_FETCHERS.length).toBe(AI_CRAWLER_USER_AGENTS.length - 1)
    for (const entry of AI_CRAWLER_FETCHERS) {
      // The token alone, deliberately: the claim is that the NAME the policy allows is the name the
      // classifier knows. Whether the vendor's real string classifies is a different claim, asserted
      // against 56 committed real strings in packages/core/src/analytics/bots.test.ts.
      const verdict = classifyBot({ userAgent: entry.token, signals: null })
      expect(verdict.bot, entry.token).toBe(true)
      expect(verdict.botKind, entry.token).toBe(entry.botKind)
      expect(verdict.basis, entry.token).toBe('user_agent_claim')
    }
    expect(new Set(AI_CRAWLER_BOT_KINDS).size).toBe(AI_CRAWLER_FETCHERS.length)
  })

  it('has no AI crawler kind that the table did not put there', () => {
    // The other way a second list arrives: a rule written straight into the classifier for a crawler the
    // policy never allowed. Its kind would have to be declared in `OTHER_BOT_KINDS`, where it would be a
    // family name rather than a crawler — so the two lists are asserted disjoint and exhaustive.
    expect([...BOT_KINDS]).toEqual([...AI_CRAWLER_BOT_KINDS, ...OTHER_BOT_KINDS])
    for (const kind of AI_CRAWLER_BOT_KINDS) {
      expect(OTHER_BOT_KINDS as readonly string[], kind).not.toContain(kind)
    }
  })

  it('classifies nothing for the token that fetches nothing', () => {
    // `Google-Extended` as a user agent is a string no client sends. It must not be recognised: a kind for
    // it would be a `bot_kind` in `analytics.session` that no request could ever have produced.
    const verdict = classifyBot({ userAgent: 'Google-Extended', signals: null })
    expect(verdict).toEqual({ bot: false, botKind: null, basis: 'no_evidence' })
  })
})

describe('no third statement of any of these names', () => {
  /**
   * Where a crawler's name may appear in the source tree.
   *
   * Two files: the table, and the pin in this one. Everything else reads the table — `robots.txt`'s
   * builder, the classifier, the two suites that assert the rendered policy — so a name appearing anywhere
   * else is a copy, and a copy is what this unit exists to remove.
   *
   * `packages/core/test/fixtures/user-agents.json` legitimately contains all of them, inside real
   * user-agent strings, which is why the scan reads TypeScript only: the defect is a second LIST in code,
   * and that fixture's rows are held honest against the classifier by `bots.test.ts` instead. Comments are
   * skipped too — see {@link isProse}, and the control that proves the exemption is live rather than
   * matching everything.
   */
  const ALLOWED = new Set([
    'packages/shared/src/crawlers.ts',
    'apps/web/src/crawler-policy.test.ts',
  ])

  const SKIP_DIRECTORIES = new Set(['node_modules', '.next', 'dist', '.git', 'artifacts'])

  const walk = (dir: string): readonly string[] =>
    readdirSync(dir).flatMap((entry) => {
      if (SKIP_DIRECTORIES.has(entry)) return []
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) return walk(full)
      return entry.endsWith('.ts') || entry.endsWith('.tsx') ? [full] : []
    })

  it('finds every token in the table, which is the control on the search itself', () => {
    // Without this, a scan whose pattern had gone stale would report a clean tree for ever.
    const table = readFileSync(join(REPO_ROOT, 'packages/shared/src/crawlers.ts'), 'utf8')
    for (const token of AI_CRAWLER_USER_AGENTS) {
      expect(table, token).toContain(token)
    }
  })

  /**
   * A line that is prose rather than code.
   *
   * The scan is about a second LIST, and a comment naming a crawler is the opposite of the problem — the
   * two best explanations in this repository of why a `User-agent:` group must carry the whole policy both
   * name one, and rewording them to say "a named group" would cost a reader the concrete case. docs/ and
   * scripts/ are outside the scanned roots entirely for the same reason.
   *
   * WHAT THIS CAN AND CANNOT SEE, because a line test is an approximation of a parser. It sees `//`, `/*`
   * and the continuation `*` every block comment in this tree is written with, so a name in prose is
   * skipped and a name in a string literal, an identifier or a trailing comment on a code line is not.
   * It would miss a name inside a multi-line template literal whose continuation line began with `*`,
   * which nothing in this repository does and which would be a second list written to evade a check.
   */
  const isProse = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line)

  it('tells prose from code', () => {
    // The two directions the scan below depends on, asserted directly. The `inProse` count at the end of
    // that scan can only see an exemption that has gone DEAD; an exemption that had started matching every
    // line would leave the scan reporting a clean tree for ever, and this is what refuses that.
    expect(isProse(' * a comment naming GPTBot, which is what this exemption is for')).toBe(true)
    expect(isProse('  // the same in a line comment: GPTBot')).toBe(true)
    expect(isProse("  const second = ['GPTBot', 'ClaudeBot']")).toBe(false)
    expect(isProse('  lines.push(`User-agent: GPTBot`)')).toBe(false)
  })

  it('finds no crawler name in the code of any other TypeScript file under packages or apps', () => {
    const files = [...walk(join(REPO_ROOT, 'packages')), ...walk(join(REPO_ROOT, 'apps'))]
    // A scan that examined nothing must not print a green tick (ADR 0002). The floor is well under the
    // real count and exists only to tell "nothing to find" from "nowhere looked".
    expect(files.length).toBeGreaterThan(200)
    const offenders: string[] = []
    let inProse = 0
    for (const file of files) {
      const relative = file.slice(REPO_ROOT.length).replace(/^\/+/, '')
      if (ALLOWED.has(relative)) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        const lowered = line.toLowerCase()
        for (const token of AI_CRAWLER_USER_AGENTS) {
          if (!lowered.includes(token.toLowerCase())) continue
          if (isProse(line)) inProse += 1
          else offenders.push(`${relative}:${index + 1} names ${token} in code`)
        }
      })
    }
    expect(
      offenders,
      'an AI crawler is named in code outside the shared table and this file. Read ' +
        'AI_CRAWLER_USER_AGENTS from @berelax/shared instead — a second copy of the list is the drift ' +
        'A-FIRST-04 removed.',
    ).toEqual([])
    // The control on the exemption in the one direction this scan can see it: a skip nothing ever reaches
    // is a branch that could be deleted, and its absence would mean the prose the policy is explained in
    // had gone. Measured at 6 when this was written; the floor is 1 because that prose is meant to be
    // edited freely. The other direction — an exemption that matches everything — is the case above.
    expect(
      inProse,
      'no crawler name was found in prose anywhere, so the comment exemption is dead. Either the two ' +
        'explanations of the robots.txt group trap have gone, or isProse has stopped matching a comment.',
    ).toBeGreaterThanOrEqual(1)
  })
})
