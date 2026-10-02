import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ANONYMOUS_BUCKET,
  VISITOR_COOKIE,
  VISITOR_COOKIE_MAX_AGE_SECONDS,
  visitorCookie,
  visitorIdFrom,
} from './ingest.ts'

/**
 * The visitor cookie's attributes, and the parse that reads it back.
 *
 * Attributes are a string, and a string is testable without a server — which is why
 * `apps/web/src/admin-guard.test.ts` exists for the admin cookie and why this file exists for this one. The
 * served `Set-Cookie` is asserted separately by `collect.itest.ts`, against a real response, because "the
 * route emits this header" and "this function returns this string" are different claims.
 */

const VISITOR = '018f2c3d-4e5f-7a8b-9c0d-1e2f3a4b5c6d'

describe('the first-party visitor cookie', () => {
  it('is host-only, Secure and SameSite=Lax, with no Domain attribute at all', () => {
    const cookie = visitorCookie(VISITOR)
    expect(cookie).toContain(`${VISITOR_COOKIE}=${VISITOR}`)
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    // Host-only IS the absence of `Domain`. There is no attribute to spell correctly, only one not to
    // write — and a leading-dot domain would send a first-party identifier to every subdomain, including
    // any future one this repository does not control.
    expect(cookie).not.toMatch(/Domain=/i)
    expect(cookie, 'a leading-dot domain is what host-only excludes').not.toContain('=.')
  })

  it('is HttpOnly, because nothing on the page has any reason to read it', () => {
    // The acceptance line does not ask for this and it is right anyway: the server sets the value and the
    // server reads it, so hiding it from the page costs nothing and removes a first-party identifier from
    // everything a cross-site scripting hole can reach. The consent cookie is deliberately the opposite —
    // A-MEAS-02's banner has to write that one from JavaScript.
    expect(visitorCookie(VISITOR)).toContain('HttpOnly')
  })

  it('is never SameSite=Strict, which would make every ad click a new visitor', () => {
    // `Strict` withholds the cookie on a cross-site top-level GET, which is every paid click this business
    // pays for. The visitor would arrive with no cookie, the route would mint a new id, and the origination
    // resolver would re-attribute a returning visitor on every campaign.
    expect(visitorCookie(VISITOR)).not.toContain('SameSite=Strict')
    expect(visitorCookie(VISITOR)).not.toContain('SameSite=None')
  })

  it('has no Secure-off switch, because that switch is what gets defaulted wrongly', () => {
    // `adminSessionCookie` records the argument and it holds here: a `secure: boolean` parameter is a
    // parameter somebody eventually defaults the wrong way, and the integration suite presents the cookie
    // through an explicit `fetch` header rather than a browser jar, so nothing needs it dropped for
    // `http://127.0.0.1`. Asserted structurally — the function's own source must not mention one.
    //
    // Against the FILE rather than against `Function.prototype.toString`: the suite runs transpiled source,
    // so a quoting style read off `toString()` is the transform's and not the author's — which is how the
    // first version of this case failed on a file that was entirely correct.
    const declaration = /export function visitorCookie\([\s\S]*?\n}/.exec(
      readFileSync(new URL('ingest.ts', import.meta.url).pathname, 'utf8'),
    )?.[0]
    expect(
      declaration,
      'visitorCookie is no longer declared in the shape this case reads',
    ).toBeDefined()
    expect(declaration).not.toMatch(/\bsecure\b/)
    expect(declaration).toContain("'Secure'")
  })

  it('lives exactly as long as the raw retention window, which is where the figure comes from', () => {
    // A second statement of `analytics.raw_retention_days()`, so it arrives with the check that holds the
    // two equal — and that check needs a database, so it is in `collect.itest.ts`. What is asserted here is
    // the arithmetic: 90 days in seconds, not a round number that happens to be near it.
    expect(VISITOR_COOKIE_MAX_AGE_SECONDS).toBe(90 * 24 * 60 * 60)
    expect(VISITOR_COOKIE_MAX_AGE_SECONDS).toBe(7_776_000)
  })
})

describe('reading the visitor cookie back', () => {
  it('finds it anywhere in the header, by exact name', () => {
    expect(visitorIdFrom(`${VISITOR_COOKIE}=${VISITOR}`)).toBe(VISITOR)
    expect(visitorIdFrom(`a=1; ${VISITOR_COOKIE}=${VISITOR}; z=2`)).toBe(VISITOR)
    expect(visitorIdFrom(`  ${VISITOR_COOKIE}=${VISITOR}  `)).toBe(VISITOR)
  })

  it('never reads a differently named cookie as this one', () => {
    // `berelax_visitor_theme` must not be read as the visitor id, and a `startsWith` here is how that
    // happens — the defect `adminSessionTokenFrom` records.
    expect(visitorIdFrom(`${VISITOR_COOKIE}_theme=${VISITOR}`)).toBeNull()
    expect(visitorIdFrom(`x${VISITOR_COOKIE}=${VISITOR}`)).toBeNull()
  })

  it('treats a value that is not a uuid as no cookie at all', () => {
    // Not a refusal, deliberately. A malformed cookie is not something a visitor can fix and not something
    // worth a 400; the visitor gets a fresh server-generated id instead. What matters is that such a value
    // never reaches a `::uuid` cast, because the error it would produce there names a column rather than a
    // cookie.
    for (const value of ['', 'abc', "'; drop table analytics.visitor--", 'x'.repeat(5_000)]) {
      expect(visitorIdFrom(`${VISITOR_COOKIE}=${value}`)).toBeNull()
    }
    expect(visitorIdFrom(null)).toBeNull()
    expect(visitorIdFrom(VISITOR_COOKIE)).toBeNull()
  })
})

describe('the rate-limiter bucket', () => {
  it('uses a key no cookie value can collide with', () => {
    // Every request that presents no visitor cookie shares one bucket, which is the position's consequence:
    // you cannot rate-limit per person without an identifier per person, and an identifier before consent
    // is the thing this unit refuses to create. The key therefore has to be one a real visitor id cannot
    // be — a NUL byte is forbidden in a cookie value by RFC 6265 and is refused by the uuid pattern above
    // anyway.
    expect(ANONYMOUS_BUCKET).toContain('\u0000')
    expect(visitorIdFrom(`${VISITOR_COOKIE}=${ANONYMOUS_BUCKET}`)).toBeNull()
  })
})

describe('what the ingest must not contain', () => {
  const SOURCE = readFileSync(new URL('ingest.ts', import.meta.url).pathname, 'utf8')

  it('never branches on the bot verdict, which ADR 0062 forbids', () => {
    /*
     * The rule is that no verdict from the classifier may refuse, gate or authorise anything: a user agent
     * is a claim, so a suspected bot's events are STORED and FLAGGED rather than dropped. This file is the
     * first place in the build where that could have been broken, and the claim is worth a structural
     * assertion because the code that would break it looks like an optimisation — one `if` that saves a
     * write.
     *
     * A text scan and not a behavioural one, because the behaviour is an ABSENCE and an absence is what a
     * scan can see. The itest asserts the other half: a request with GPTBot's user agent gets its rows.
     */
    expect(SOURCE).not.toMatch(/if\s*\(\s*classification\.bot\b/)
    expect(SOURCE).not.toMatch(/if\s*\([^)]*\.bot\s*\)/)
    expect(SOURCE).not.toMatch(/classification\.bot\s*\?/)
    // The control: the classifier IS called and its answer IS carried onto the row, so the absences above
    // are about a branch rather than about the verdict being missing.
    expect(SOURCE).toContain('classifyBot(')
    expect(SOURCE).toContain('bot: classification.bot')
    expect(SOURCE).toContain('botKind: classification.botKind')
  })

  it('reads nothing from the query string', () => {
    // A rule across `apps/web`, with a second reason here: a `?visitor=` would put a first-party identifier
    // in every access log, every `Referer` and every forwarded link.
    expect(SOURCE).not.toMatch(/searchParams/)
    expect(SOURCE).not.toMatch(/new URL\(request\.url\)/)
  })

  it('reads the clock only through the injected one', () => {
    // The acceptance claims are made under a frozen clock, so the route reads `deps.clock` once and passes
    // the instant down. A `Date.now()` here would be a second reading that no test could freeze.
    expect(SOURCE).not.toMatch(/Date\.now\s*\(/)
    expect(SOURCE).toContain('deps.clock.now()')
  })

  /**
   * The pre-consent branch, asserted on the SOURCE as well as on its behaviour.
   *
   * `collect.itest.ts` proves what the branch DOES — no cookie, no visitor row, no session row, the counter
   * up by exactly one — against a real PostgreSQL, and that is the claim that matters. These two cases are
   * about what the branch may CONTAIN, and they exist because the two failures that would matter most are
   * both one line: a `return` removed so the pre-consent path falls through into the identified write, and a
   * cookie issued on it. Both leave a store full of rows that look exactly like consented rows, which is
   * the one defect in this unit that nothing downstream could ever detect.
   */
  const PRE_CONSENT_BRANCH =
    /if \(!analyticsStorageGranted\(cookieHeader\)\) \{[\s\S]*?\n {2}\}/.exec(SOURCE)?.[0]

  it('writes nothing but the counter before consent', () => {
    expect(
      PRE_CONSENT_BRANCH,
      'the pre-consent branch is no longer declared in the shape this case reads',
    ).toBeDefined()
    // The only writer it may name. `ingestCollectBatch` creates the visitor, the session, its origination
    // and its events; reaching it from here is the whole failure.
    expect(PRE_CONSENT_BRANCH).toContain('countPreConsentLanding(')
    expect(PRE_CONSENT_BRANCH).not.toContain('ingestCollectBatch')
    expect(PRE_CONSENT_BRANCH).not.toContain('visitorCookie(')
    // And it RETURNS, so the identified write below is unreachable from it. A branch that fell through
    // would increment the counter and then create the identifier anyway.
    expect(PRE_CONSENT_BRANCH).toContain('return accepted(null)')
  })

  it('issues no cookie before consent, by passing the only function that can make one a null', () => {
    // Expressed as an argument rather than as an omission: `accepted(null)` is a statement that no cookie
    // is issued, where a branch that simply never called `visitorCookie` would be one careless edit from
    // issuing one. The two consented call sites are the control — the function IS reachable.
    expect(PRE_CONSENT_BRANCH).toContain('accepted(null)')
    expect(SOURCE).toContain(
      'accepted(result.visitorCreated ? visitorCookie(result.visitorId) : null)',
    )
  })
})
