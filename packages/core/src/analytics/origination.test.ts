import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CLICK_ID_MAX_LENGTH,
  CLICK_ID_ORIGINATION,
  CLICK_ID_PARAMS,
  type ClickIdParam,
  type ClickIds,
  DIRECT_MEDIUM,
  DIRECT_SOURCE,
  isOwnHost,
  MULTI_LABEL_PUBLIC_SUFFIXES,
  ORIGINATION_BASES,
  ORIGINATION_RESOLVER_VERSION,
  type OriginationSignals,
  REFERRAL_MEDIUM,
  registrableDomain,
  resolveOrigination,
  UNSET_MEDIUM,
  UTM_PARAMS,
} from './origination.ts'

/**
 * The origination resolver (A-FIRST-03): the strict precedence, the click ids that survive a UTM set
 * winning, and the two normalisations that are deliberately asymmetric.
 *
 * Every assertion here is paired with a control that must fail if the thing it measures stops being
 * measured (brief rule 3). The pairs that matter most are the precedence ones: "utm wins" is satisfied by
 * a resolver that never looks at a click id at all, so each row of the matrix also asserts what the
 * LOSING basis would have produced and that the answer is not it.
 */

const OWN_HOSTS = ['berelaxmassage.com', 'www.berelaxmassage.com'] as const

const resolve = (signals: Partial<OriginationSignals>) =>
  resolveOrigination({ ownHosts: OWN_HOSTS, ...signals })

/** The tuple, with the four dimensions that are `''` in every inferred basis already filled in. */
const inferred = (basis: string, source: string, medium: string) => ({
  basis,
  source,
  medium,
  campaign: '',
  term: '',
  content: '',
})

const originationOf = (signals: Partial<OriginationSignals>) => {
  const { decision } = resolve(signals)
  if (decision.kind !== 'origination') {
    throw new Error(`expected an origination, got ${decision.kind}: ${decision.why}`)
  }
  return decision.origination
}

// ------------------------------------------------------------------------------------------------
// The precedence matrix. Every row of the acceptance line, in its order.
// ------------------------------------------------------------------------------------------------

describe('the precedence matrix — UTM, click id, referrer, direct', () => {
  it('lets a UTM set win over a gclid, and STILL persists the gclid', () => {
    const result = resolve({
      query:
        '?utm_source=newsletter&utm_medium=email&utm_campaign=Eid_Offer_2026&gclid=CjwKCAjwABCD',
    })
    expect(result.decision).toEqual({
      kind: 'origination',
      origination: {
        basis: 'utm',
        source: 'newsletter',
        medium: 'email',
        campaign: 'Eid_Offer_2026',
        term: '',
        content: '',
      },
    })
    // The half of this row that a resolver can silently drop, and the reason the click id is on the
    // resolution rather than inside the tuple: it is the only join key back to Google Ads.
    expect(result.clickIds).toEqual({ gclid: 'CjwKCAjwABCD' })
    // The control. Had the click id won, the tuple would be google/cpc — so this row is about the
    // precedence and not about newsletter/email happening to be the answer either way.
    expect(originationOf({ query: '?gclid=CjwKCAjwABCD' })).toEqual(
      inferred('click_id', 'google', 'cpc'),
    )
  })

  it('resolves a gclid alone to google/cpc', () => {
    expect(originationOf({ query: 'gclid=CjwKCAjwABCD' })).toEqual(
      inferred('click_id', 'google', 'cpc'),
    )
  })

  it('resolves an fbclid to meta/paid_social', () => {
    expect(originationOf({ query: 'fbclid=IwAR0abcDEF' })).toEqual(
      inferred('click_id', 'meta', 'paid_social'),
    )
  })

  it('resolves a wbraid to google/cpc — the consent-mode click is the same media fact', () => {
    expect(originationOf({ query: 'wbraid=Cj0KAQiA1' })).toEqual(
      inferred('click_id', 'google', 'cpc'),
    )
    // The control on "the same media fact": a wbraid and a gclid must not resolve to different rows, or
    // one campaign's spend splits on the visitor's cookie choice.
    expect(originationOf({ query: 'wbraid=Cj0KAQiA1' })).toEqual(
      originationOf({ query: 'gclid=Cj0KAQiA1' }),
    )
  })

  it('resolves an msclkid to bing/cpc', () => {
    expect(originationOf({ query: 'msclkid=9f3b2c1d4e5a' })).toEqual(
      inferred('click_id', 'bing', 'cpc'),
    )
  })

  it('resolves an external referrer to its registrable domain with medium referral', () => {
    expect(originationOf({ referrer: 'https://www.instagram.com/p/Cabc123/?igshid=xyz' })).toEqual(
      inferred('referrer', 'instagram.com', REFERRAL_MEDIUM),
    )
    // Every page of a referring site must group into ONE row, which is what the registrable domain is
    // for. A resolver returning `parsed.hostname` would give `www.instagram.com` here and
    // `l.instagram.com` on the next hit.
    expect(originationOf({ referrer: 'https://l.instagram.com/' }).source).toBe('instagram.com')
  })

  it('treats a referrer on our own host as no new origination, not as direct', () => {
    const result = resolve({ referrer: 'https://www.berelaxmassage.com/services/deep-tissue' })
    expect(result.decision.kind).toBe('no_new_origination')
    // The control, and it is the whole point of the row: `direct` here would OVERWRITE whatever
    // originated the visitor on the page they came from with the absence of an origination.
    expect(result.decision).not.toEqual({
      kind: 'origination',
      origination: inferred('direct', DIRECT_SOURCE, DIRECT_MEDIUM),
    })
    if (result.decision.kind !== 'no_new_origination') throw new Error('unreachable')
    expect(result.decision.why).toContain('internal navigation')
  })

  it('resolves nothing at all to direct/none, in the one spelling the database accepts', () => {
    expect(originationOf({})).toEqual(inferred('direct', DIRECT_SOURCE, DIRECT_MEDIUM))
    expect(originationOf({ query: '', referrer: '' })).toEqual(
      inferred('direct', DIRECT_SOURCE, DIRECT_MEDIUM),
    )
    expect(originationOf({ query: null, referrer: null })).toEqual(
      inferred('direct', DIRECT_SOURCE, DIRECT_MEDIUM),
    )
  })

  it('puts the click id above the referrer, which is the row paid traffic depends on', () => {
    // A paid click's referrer is frequently the network's own redirector. If the referrer won, every
    // Google Ads session would be reported as a referral from a Google domain and the cpc medium would
    // never appear.
    expect(
      originationOf({ query: 'gclid=CjwKCAjwABCD', referrer: 'https://www.googleadservices.com/' }),
    ).toEqual(inferred('click_id', 'google', 'cpc'))
  })

  it('keeps the click ids when the referrer is our own host and nothing else won', () => {
    const result = resolve({
      query: 'gclid=CjwKCAjwABCD',
      referrer: 'https://berelaxmassage.com/',
    })
    // The click id outranks the referrer, so this is an origination and not `no_new_origination`.
    expect(result.decision).toEqual({
      kind: 'origination',
      origination: inferred('click_id', 'google', 'cpc'),
    })
    expect(result.clickIds).toEqual({ gclid: 'CjwKCAjwABCD' })
  })
})

describe('the click-id tie-break is declared, not incidental', () => {
  it('prefers the earlier parameter in CLICK_ID_PARAMS when several arrive', () => {
    // Built from the tuple rather than written out, so a reordering of CLICK_ID_PARAMS moves this
    // assertion with it instead of leaving a test that pins the old order.
    const all = CLICK_ID_PARAMS.map((param) => `${param}=value-for-${param}`).join('&')
    const first = CLICK_ID_PARAMS[0]
    expect(originationOf({ query: all }).source).toBe(CLICK_ID_ORIGINATION[first].source)
    // Reversed, the answer must be the SAME: the winner is the tuple's order and not the query's.
    const reversed = [...CLICK_ID_PARAMS]
      .reverse()
      .map((p) => `${p}=value-for-${p}`)
      .join('&')
    expect(originationOf({ query: reversed }).source).toBe(CLICK_ID_ORIGINATION[first].source)
    // And every one of them is still persisted, whichever won.
    expect(Object.keys(resolve({ query: all }).clickIds).sort()).toEqual(
      [...CLICK_ID_PARAMS].sort(),
    )
  })

  it('takes the first occurrence of a repeated parameter, deterministically', () => {
    expect(resolve({ query: 'gclid=first&gclid=second' }).clickIds).toEqual({ gclid: 'first' })
  })
})

// ------------------------------------------------------------------------------------------------
// Click ids: verbatim, capped, never case-folded.
// ------------------------------------------------------------------------------------------------

describe('click ids are stored verbatim', () => {
  it('round-trips a mixed-case gclid byte-identically', () => {
    const MIXED = 'CjwKCAjw_R4nBhAlEiwA-Xq3Zz9PmQ0abcDEF_hij-KLM'
    const { clickIds } = resolve({ query: `?gclid=${MIXED}` })
    expect(clickIds.gclid).toBe(MIXED)
    // The control on "never case-folded": both of the plausible normalisations would change these bytes,
    // and asserting only `toBe(MIXED)` would go vacuous if MIXED were ever edited to be lower-case.
    expect(MIXED).not.toBe(MIXED.toLowerCase())
    expect(clickIds.gclid).not.toBe(MIXED.toLowerCase())
    expect(clickIds.gclid).not.toBe(MIXED.toUpperCase())
  })

  it('does not trim a click id, because an opaque token is what arrived', () => {
    const { clickIds } = resolve({ query: 'gclid=%20Abc%20' })
    expect(clickIds.gclid).toBe(' Abc ')
  })

  it('caps a click id at 512 characters and keeps the first 512 unchanged', () => {
    const long = `Z${'aB'.repeat(400)}`
    expect(long.length).toBeGreaterThan(CLICK_ID_MAX_LENGTH)
    const { clickIds } = resolve({ query: `gclid=${long}` })
    expect(clickIds.gclid).toHaveLength(CLICK_ID_MAX_LENGTH)
    expect(clickIds.gclid).toBe(long.slice(0, CLICK_ID_MAX_LENGTH))
    // Truncated and still paid: dropping an over-long id would reclassify a paid session as direct, which
    // nothing downstream could detect. See CLICK_ID_MAX_LENGTH.
    expect(originationOf({ query: `gclid=${long}` }).basis).toBe('click_id')
  })

  it('does not treat an empty click-id parameter as a click', () => {
    const result = resolve({ query: 'gclid=&fbclid=' })
    expect(result.clickIds).toEqual({})
    expect(originationOf({ query: 'gclid=&fbclid=' })).toEqual(
      inferred('direct', DIRECT_SOURCE, DIRECT_MEDIUM),
    )
  })

  it('percent-decodes, because that is transport and not normalisation', () => {
    expect(resolve({ query: 'gclid=Ab%2FCd%3De' }).clickIds.gclid).toBe('Ab/Cd=e')
  })

  it('returns a frozen object a caller cannot edit before storing it', () => {
    const { clickIds } = resolve({ query: 'gclid=abc' })
    expect(Object.isFrozen(clickIds)).toBe(true)
  })
})

// ------------------------------------------------------------------------------------------------
// The UTM normalisation, which is deliberately asymmetric.
// ------------------------------------------------------------------------------------------------

describe('the UTM normalisation', () => {
  it('trims and lower-cases utm_source so two spellings collapse to one value', () => {
    const padded = originationOf({ query: `${UTM_PARAMS.source}=%20%20Google%20` })
    const plain = originationOf({ query: `${UTM_PARAMS.source}=google` })
    expect(padded.source).toBe('google')
    expect(padded.source).toBe(plain.source)
    // The control: without it, a resolver that lower-cased nothing would still pass a `toBe('google')`
    // written against an input that was already lower-case.
    expect('  Google ').not.toBe('google')
  })

  it('lower-cases utm_medium too, so CPC and cpc are one row', () => {
    expect(
      originationOf({ query: `${UTM_PARAMS.source}=google&${UTM_PARAMS.medium}=CPC` }).medium,
    ).toBe('cpc')
  })

  it('keeps the original case of utm_campaign, term and content', () => {
    const tuple = originationOf({
      query:
        `${UTM_PARAMS.source}=Google&${UTM_PARAMS.medium}=cpc` +
        `&${UTM_PARAMS.campaign}=%20Eid_Offer_2026%20&${UTM_PARAMS.term}=Deep+Tissue` +
        `&${UTM_PARAMS.content}=Hero_A`,
    })
    expect(tuple.campaign).toBe('Eid_Offer_2026')
    expect(tuple.term).toBe('Deep Tissue')
    expect(tuple.content).toBe('Hero_A')
    // Trimmed but not folded: the campaign name has to keep matching the one in the ad platform.
    expect(tuple.campaign).not.toBe('eid_offer_2026')
    expect(tuple.source).toBe('google')
  })

  it('gives a UTM set with no medium the unset medium, never blank and never none', () => {
    const tuple = originationOf({ query: `${UTM_PARAMS.source}=newsletter` })
    expect(tuple).toEqual({
      basis: 'utm',
      source: 'newsletter',
      medium: UNSET_MEDIUM,
      campaign: '',
      term: '',
      content: '',
    })
    // The two spellings the database would either refuse or silently fold into direct traffic.
    expect(tuple.medium).not.toBe('')
    expect(tuple.medium).not.toBe(DIRECT_MEDIUM)
  })

  it('does not let a utm_medium with no utm_source win', () => {
    // A medium is not a place. Carrying it under another basis would make `basis` a lie about two of the
    // five dimensions.
    expect(originationOf({ query: `${UTM_PARAMS.medium}=email` })).toEqual(
      inferred('direct', DIRECT_SOURCE, DIRECT_MEDIUM),
    )
    expect(originationOf({ query: `${UTM_PARAMS.medium}=email&gclid=abc` })).toEqual(
      inferred('click_id', 'google', 'cpc'),
    )
  })

  it('does not let a whitespace-only utm_source win', () => {
    expect(originationOf({ query: `${UTM_PARAMS.source}=%20%20` })).toEqual(
      inferred('direct', DIRECT_SOURCE, DIRECT_MEDIUM),
    )
  })
})

// ------------------------------------------------------------------------------------------------
// Hosts: the label boundary, and the registrable domain.
// ------------------------------------------------------------------------------------------------

describe('own-host detection stops at a label boundary', () => {
  it('treats the apex, www and a subdomain of a declared host as ours', () => {
    for (const host of [
      'berelaxmassage.com',
      'www.berelaxmassage.com',
      'book.berelaxmassage.com',
    ]) {
      expect(isOwnHost(host, OWN_HOSTS)).toBe(true)
    }
  })

  it('treats a host that merely ENDS with ours as external — the endsWith bug, as a test', () => {
    // Both of these pass a naive `host.endsWith(own)`. If either were read as ours, an attacker-chosen
    // domain could suppress a session's origination by referring to us from it.
    for (const host of ['notberelaxmassage.com', 'berelaxmassage.com.evil.test']) {
      expect(isOwnHost(host, OWN_HOSTS)).toBe(false)
      expect(originationOf({ referrer: `https://${host}/` }).basis).toBe('referrer')
    }
  })

  it('is case- and trailing-dot-insensitive, because a browser will send either', () => {
    expect(isOwnHost('WWW.BeRelaxMassage.COM.', OWN_HOSTS)).toBe(true)
    expect(resolve({ referrer: 'https://WWW.BeRelaxMassage.COM./x' }).decision.kind).toBe(
      'no_new_origination',
    )
  })

  it('reads no host as ours when the caller declared none', () => {
    expect(isOwnHost('berelaxmassage.com', [])).toBe(false)
    expect(isOwnHost('berelaxmassage.com', [''])).toBe(false)
  })
})

describe('the registrable domain', () => {
  it('takes two labels under a single-label suffix', () => {
    expect(registrableDomain('news.ycombinator.com')).toBe('ycombinator.com')
    expect(registrableDomain('example.com')).toBe('example.com')
    expect(registrableDomain('a.b.c.example.ae')).toBe('example.ae')
  })

  it('takes three labels under a declared multi-label suffix', () => {
    expect(registrableDomain('www.blog.example.co.uk')).toBe('example.co.uk')
    expect(registrableDomain('shop.example.com.au')).toBe('example.com.au')
    expect(registrableDomain('x.example.co.ae')).toBe('example.co.ae')
    // The control on the table being consulted at all: `co.zz` is not in it, so the fallback applies and
    // this answer is one label too broad — which is the cost ADR 0058 records, made visible.
    expect(registrableDomain('example.co.zz')).toBe('co.zz')
  })

  it('has a suffix table that is non-empty, lower-case and free of duplicates', () => {
    // A table that had silently become empty would make every multi-label answer fall back, and nothing
    // else in the build would say so (ADR 0002).
    expect(MULTI_LABEL_PUBLIC_SUFFIXES.length).toBeGreaterThan(20)
    expect(new Set(MULTI_LABEL_PUBLIC_SUFFIXES).size).toBe(MULTI_LABEL_PUBLIC_SUFFIXES.length)
    for (const suffix of MULTI_LABEL_PUBLIC_SUFFIXES) {
      expect(suffix).toBe(suffix.toLowerCase())
      expect(suffix.split('.')).toHaveLength(2)
    }
  })
})

describe('a referrer that is not a web page is no referrer', () => {
  it.each([
    ['an unparseable header', 'not a url at all'],
    ['an app scheme', 'android-app://com.google.android.gm'],
    ['about:blank', 'about:blank'],
    ['a data url', 'data:text/html,<p>hi</p>'],
    ['whitespace', '   '],
  ])('reads %s as direct rather than as a referral', (_label, referrer) => {
    expect(originationOf({ referrer })).toEqual(inferred('direct', DIRECT_SOURCE, DIRECT_MEDIUM))
  })

  it('still reads a real referrer, so the cases above are about the scheme', () => {
    expect(originationOf({ referrer: 'http://example.com/x' }).basis).toBe('referrer')
  })
})

describe('the resolution carries the version that produced it', () => {
  it('stamps ORIGINATION_RESOLVER_VERSION on every answer', () => {
    for (const signals of [
      {},
      { query: 'gclid=a' },
      { query: `${UTM_PARAMS.source}=x` },
      { referrer: 'https://example.com/' },
      { referrer: 'https://berelaxmassage.com/' },
    ]) {
      expect(resolve(signals).resolverVersion).toBe(ORIGINATION_RESOLVER_VERSION)
    }
    expect(ORIGINATION_RESOLVER_VERSION.trim()).not.toBe('')
  })

  it('only ever answers with a declared basis', () => {
    expect([...ORIGINATION_BASES].sort()).toEqual(['click_id', 'direct', 'referrer', 'utm'])
  })
})

// ------------------------------------------------------------------------------------------------
// The property test.
// ------------------------------------------------------------------------------------------------

/**
 * A generator WEIGHTED towards inputs that can disagree (brief rule 22).
 *
 * The claims under test are about precedence, so a generated case is only informative if it carries more
 * than one signal. Uniform junk would make almost every case `direct`, and the properties below would hold
 * for a resolver that returned `direct` unconditionally. So click-id parameters appear often, UTM
 * parameters appear often, and the counters at the end of each property assert how many cases could
 * actually have disagreed — against a floor that was MEASURED, not guessed.
 */
const clickIdValue = fc.oneof(
  { weight: 6, arbitrary: fc.stringMatching(/^[A-Za-z0-9_-]{8,40}$/) },
  { weight: 2, arbitrary: fc.string({ minLength: 1, maxLength: 30 }) },
  { weight: 1, arbitrary: fc.constant('') },
  { weight: 1, arbitrary: fc.string({ minLength: 520, maxLength: 600 }) },
)

const queryPair = fc.oneof(
  {
    weight: 8,
    arbitrary: fc
      .tuple(fc.constantFrom(...CLICK_ID_PARAMS), clickIdValue)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`),
  },
  // A `utm_source` that certainly WINS, as its own branch. Without it the only way to generate one was
  // for the branch below to pick `utm_source` out of five parameter names and then a non-blank value, and
  // the measurement said that put a click id under a winning UTM set in about 9% of cases — close enough
  // to what a fully unweighted generator gives (measured: 9 to 18 of 500) that a floor could not tell the
  // two apart. This branch is what makes the precedence collision the common case rather than a rarity.
  {
    weight: 6,
    arbitrary: fc.constantFrom(
      'utm_source=Google',
      'utm_source=%20%20Google%20',
      'utm_source=newsletter',
      'utm_source=Google&utm_medium=CPC&utm_campaign=Eid_Offer_2026',
    ),
  },
  {
    weight: 4,
    arbitrary: fc
      .tuple(
        fc.constantFrom(...Object.values(UTM_PARAMS)),
        fc.oneof(
          fc.constantFrom('Google', '  google ', 'newsletter', 'CPC', 'Eid_Offer_2026', ''),
          fc.string({ maxLength: 20 }),
        ),
      )
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`),
  },
  // The prototype keys, present on purpose. A resolver that indexed a frozen object by a caller's string
  // would resolve `constructor` to `Object` and throw where it expected a schema — the hole this build has
  // fixed twice, and the reason every lookup here iterates a tuple.
  {
    weight: 2,
    arbitrary: fc.constantFrom('__proto__=x', 'constructor=y', 'toString=z', 'valueOf'),
  },
  { weight: 2, arbitrary: fc.string({ maxLength: 24 }) },
)

const arbitraryQuery = fc.oneof(
  { weight: 9, arbitrary: fc.array(queryPair, { maxLength: 6 }).map((pairs) => pairs.join('&')) },
  {
    weight: 2,
    arbitrary: fc.array(queryPair, { minLength: 1, maxLength: 6 }).map((p) => `?${p.join('&')}`),
  },
  { weight: 1, arbitrary: fc.constantFrom('', null, undefined) },
  { weight: 1, arbitrary: fc.string({ maxLength: 40 }) },
)

const arbitraryReferrer = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      'https://www.instagram.com/p/x/',
      'https://www.google.com/search?q=massage',
      'https://example.co.uk/a/b',
      'http://maps.google.ae/',
    ),
  },
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      'https://berelaxmassage.com/services',
      'https://www.berelaxmassage.com/',
      'https://book.berelaxmassage.com/x',
      'https://notberelaxmassage.com/',
    ),
  },
  { weight: 2, arbitrary: fc.constantFrom('', null, undefined, 'about:blank', 'not a url') },
  { weight: 2, arbitrary: fc.string({ maxLength: 40 }) },
)

const hasClickId = (clickIds: ClickIds): boolean => Object.keys(clickIds).length > 0

/** What the query itself says, read independently of the resolver, for the round-trip property. */
const clickIdParamsIn = (query: string | null | undefined): readonly ClickIdParam[] => {
  const params = new URLSearchParams(query ?? '')
  return CLICK_ID_PARAMS.filter((param) => {
    const raw = params.get(param)
    return raw !== null && raw.slice(0, CLICK_ID_MAX_LENGTH) !== ''
  })
}

describe('the property: arbitrary query strings and referrers', () => {
  it('never throws, is deterministic, and never answers direct when a click id is present', () => {
    let withClickId = 0
    let clickIdAndUtm = 0
    fc.assert(
      fc.property(arbitraryQuery, arbitraryReferrer, (query, referrer) => {
        // "Never throws" is asserted by calling it: fc reports the shrunk input on any throw, which is
        // more use than a wrapper that only says one was thrown.
        const first = resolveOrigination({ query, referrer, ownHosts: OWN_HOSTS })
        const second = resolveOrigination({ query, referrer, ownHosts: OWN_HOSTS })
        expect(second).toEqual(first)

        const present = clickIdParamsIn(query)
        // Every non-empty click-id parameter in the query is reported, whatever won. This is the half a
        // resolver drops when a UTM set wins, and it cannot be seen from the tuple at all.
        expect([...Object.keys(first.clickIds)].sort()).toEqual([...present].sort())

        if (hasClickId(first.clickIds)) {
          withClickId += 1
          expect(first.decision.kind).toBe('origination')
          if (first.decision.kind === 'origination') {
            expect(first.decision.origination.basis).not.toBe('direct')
            expect(first.decision.origination.source).not.toBe(DIRECT_SOURCE)
            if (first.decision.origination.basis === 'utm') clickIdAndUtm += 1
          }
        }
        if (first.decision.kind === 'origination') {
          const { basis, source, medium } = first.decision.origination
          // The database's own invariants, as a property: `attribution_basis_known`,
          // `attribution_source_not_blank`, `attribution_medium_not_blank` and
          // `attribution_direct_has_one_spelling` all refuse a row this resolver could otherwise produce,
          // and A-FIRST-05's INSERT is where that would surface as a 500 rather than as a red test.
          expect(ORIGINATION_BASES).toContain(basis)
          expect(source.trim()).not.toBe('')
          expect(medium.trim()).not.toBe('')
          if (basis === 'direct') {
            expect({ source, medium }).toEqual({ source: DIRECT_SOURCE, medium: DIRECT_MEDIUM })
          }
        }
      }),
      { numRuns: 500 },
    )

    // The controls that stop the 500 runs above being 500 assertions about `direct` (brief rule 22).
    //
    // MEASURED, both the weighted generator and the degraded one the floor has to be able to tell it from.
    // Ten runs of this file gave 223 to 263 of the 500 cases carrying a click id (mean 243) and 133 to 172
    // carrying a click id under a winning UTM set (mean 153). The same three arbitraries with every
    // `oneof` weight set to 1 — which is what removing the weighting would leave — gave 84 to 102 and 49
    // to 57 over five runs.
    //
    // So the floors are 150 and 80: each sits ABOVE the unweighted maximum, which is the drift they exist
    // to catch, and each is seven to eight binomial standard deviations below the weighted mean, which is
    // what stops the floor becoming its own flake. A floor set just under the observed minimum is the
    // mistake this whole convention is about.
    expect(
      withClickId,
      `only ${withClickId} of 500 generated cases carried a click id, so "never direct when a click id ` +
        'is present" was mostly asserted about nothing. The generator has drifted — see queryPair.',
    ).toBeGreaterThanOrEqual(150)
    expect(
      clickIdAndUtm,
      `only ${clickIdAndUtm} of 500 generated cases had a click id AND a winning UTM set, so the ` +
        'precedence that makes the two disagree was barely exercised. See queryPair.',
    ).toBeGreaterThanOrEqual(80)
    // A property test over hundreds of cases needs an explicit budget: vitest's default is 5,000 ms and
    // this file runs under coverage alongside three other worktrees (brief rule 21).
  }, 30_000)

  it('catches a resolver that discards click ids when a UTM set wins — the known-bad control', () => {
    // The obvious wrong implementation: resolve the basis, then return only what the basis used. If this
    // control ever stops failing, the round-trip assertion above has stopped measuring anything.
    const utmWinsAndForgets = (query: string | null | undefined): ClickIds => {
      const params = new URLSearchParams(query ?? '')
      if ((params.get(UTM_PARAMS.source) ?? '').trim() !== '') return {}
      const found: Partial<Record<ClickIdParam, string>> = {}
      for (const param of CLICK_ID_PARAMS) {
        const raw = params.get(param)
        if (raw !== null && raw !== '') found[param] = raw.slice(0, CLICK_ID_MAX_LENGTH)
      }
      return found
    }
    const query = 'utm_source=newsletter&gclid=CjwKCAjwABCD'
    expect(utmWinsAndForgets(query)).toEqual({})
    expect(clickIdParamsIn(query)).toEqual(['gclid'])
    expect(resolve({ query }).clickIds).toEqual({ gclid: 'CjwKCAjwABCD' })
  })

  it('catches a resolver that ignores click ids entirely — the second known-bad control', () => {
    // `direct` whenever there is no UTM set and no referrer, which is what a resolver written from the
    // referrer backwards does. The property's "never direct when a click id is present" is the assertion
    // that fails on it.
    const ignoresClickIds = (query: string) =>
      (new URLSearchParams(query).get(UTM_PARAMS.source) ?? '').trim() === '' ? 'direct' : 'utm'
    expect(ignoresClickIds('gclid=CjwKCAjwABCD')).toBe('direct')
    expect(originationOf({ query: 'gclid=CjwKCAjwABCD' }).basis).toBe('click_id')
  })
})

describe('the property: arbitrary own-host lists', () => {
  it('never throws and never reads a blank or unrelated host as ours', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string({ maxLength: 20 }), fc.constantFrom(...OWN_HOSTS)), {
          maxLength: 4,
        }),
        fc.string({ maxLength: 30 }),
        (ownHosts, host) => {
          const ours = isOwnHost(host, ownHosts)
          if (ours) {
            const normalised = host.trim().toLowerCase().replace(/\.+$/, '')
            expect(normalised).not.toBe('')
            // Whatever matched must have matched at a label boundary, which is the one thing a naive
            // `endsWith` gets wrong.
            expect(
              ownHosts.some((own) => {
                const o = own.trim().toLowerCase().replace(/\.+$/, '')
                return o !== '' && (normalised === o || normalised.endsWith(`.${o}`))
              }),
            ).toBe(true)
          }
          expect(typeof registrableDomain(host)).toBe('string')
        },
      ),
      { numRuns: 300 },
    )
  }, 30_000)
})
