/**
 * Every cookie this application sets, what it is allowed to be, and why (H-HARD-01).
 *
 * ## Why a table rather than five tests beside five builders
 *
 * The acceptance line is *"a test asserts no cookie in the app escapes those flags"* — a claim about the
 * SET of cookies, not about any one of them. Five separate assertions, each in the suite of the unit that
 * wrote its cookie, cannot make it: the sixth cookie, added next month by a unit that never reads this
 * file, is exactly the one the claim is about and the only one nobody asserts. So the flags are declared
 * here, once, and two things hold the declaration to the code: `security-headers.test.ts` asserts every
 * builder's OUTPUT against its row, and `scripts/check-headers.mjs` walks the filesystem for `Set-Cookie`
 * builders and fails on one that has no row. Adding a cookie without declaring it is a failed gate.
 *
 * ## The flags, and the one that is a prefix
 *
 * `HttpOnly`, `Secure`, `SameSite=Lax` and — for the session credential — the `__Host-` prefix, which a
 * browser enforces by REFUSING to store a cookie that lacks `Secure`, lacks `Path=/`, or carries a
 * `Domain`. `session-cookie.ts` records why that prefix costs this estate nothing.
 *
 * ## Exceptions are DECLARED, with the reason, and that is the point
 *
 * Three of the five cookies below are missing at least one flag, each deliberately and each with an
 * argument already written at its own definition. A scan that demanded four flags of all five would be
 * wrong three times, and the way that ends is with the scan deleted. So the shape is: every cookie names
 * the flags it carries and, for each one it does not, the reason — and the reason is checked for being
 * present and non-trivial, because "legacy" is how an exception table becomes a list of everything.
 */

/** The flags a cookie can be held to. `hostPrefix` is the `__Host-` name prefix, not an attribute. */
export const COOKIE_FLAGS = ['httpOnly', 'secure', 'sameSiteLax', 'pathRoot', 'hostPrefix'] as const

export type CookieFlag = (typeof COOKIE_FLAGS)[number]

/** The prefix a browser enforces: `Secure`, `Path=/`, and no `Domain`. */
export const COOKIE_HOST_PREFIX = '__Host-' as const

/**
 * What a cookie is for, which is what decides which flags it must carry.
 *
 * `session` is the strict class: a bearer credential, so all five. `identifier` carries no authority but
 * is still nothing the page needs to read. `page_readable` is a value whose whole purpose is to be read by
 * script in the browser, so `HttpOnly` would break it.
 */
export type CookiePurpose = 'session' | 'identifier' | 'page_readable'

export interface CookieDeclaration {
  /*
    `cookieName` and not `name`, which is not tidiness: `apps/web/src/seo/brand.test.ts` treats a line
    matching `name: '…'` as a schema.org or document TITLE and refuses the bare brand in one, because
    berelax.com is an international airport-spa chain with an outlet in the same city. Five cookie names
    beginning `berelax_` are five findings in a scan that is right about titles and has no business
    reading this table. Renaming the field here is cheaper and safer than widening somebody else's SEO
    rule, and it reads better anyway.
  */
  readonly cookieName: string
  readonly purpose: CookiePurpose
  /** Where the `Set-Cookie` is assembled, relative to the repository root. */
  readonly builder: string
  /** What it carries. Everything not listed here must appear in {@link CookieDeclaration.exceptions}. */
  readonly flags: readonly CookieFlag[]
  /** Flag → why this cookie does not carry it. A flag in `flags` must not appear here, and vice versa. */
  readonly exceptions: Readonly<Partial<Record<CookieFlag, string>>>
}

/** The flags each purpose would carry if nothing argued otherwise. */
export const COOKIE_FLAGS_BY_PURPOSE: Readonly<Record<CookiePurpose, readonly CookieFlag[]>> =
  Object.freeze({
    session: COOKIE_FLAGS,
    identifier: ['httpOnly', 'secure', 'sameSiteLax', 'pathRoot'],
    page_readable: ['secure', 'sameSiteLax', 'pathRoot'],
  })

/**
 * Every cookie in `apps/web`, with its flags and its reasons.
 *
 * Keyed by name so a test can look a response's `Set-Cookie` up by what it actually set, which is the
 * direction that catches a cookie whose name changed and whose declaration did not.
 */
export const COOKIE_DECLARATIONS: readonly CookieDeclaration[] = Object.freeze([
  {
    cookieName: 'berelax_admin',
    purpose: 'session',
    builder: 'apps/web/src/session-cookie.ts',
    flags: ['httpOnly', 'secure', 'sameSiteLax', 'pathRoot'],
    exceptions: {
      hostPrefix:
        'Applied, MEASURED and reverted — the one exception in this table backed by an experiment ' +
        'rather than an argument. `security-headers.itest.ts` serves this cookie to Chromium at two ' +
        'spellings of one server: at `http://localhost` it is stored and so is the prefixed version, ' +
        'and at `http://127.0.0.1` NEITHER is, because the exception permitting a `Secure` cookie over ' +
        'plain HTTP is written against the hostname and not the loopback address. `startWebServer` ' +
        'hands twelve admin suites the address, so the prefix would log all of them out. Every ' +
        'requirement the prefix ENFORCES is asserted directly instead — `Secure`, `Path=/` and no ' +
        '`Domain`, read off the cookie a browser stored — and the remedy is measured: one constant in ' +
        'the harness. See `session-cookie.ts`.',
    },
  },
  {
    cookieName: 'berelax_book',
    purpose: 'session',
    builder: 'apps/web/src/book/flow.ts',
    flags: ['httpOnly', 'sameSiteLax', 'pathRoot'],
    exceptions: {
      secure:
        'A-FIRST-04 made `Secure` a parameter, dropped outside production, because the booking suite ' +
        'drives `http://127.0.0.1` and was written before anybody checked that browsers treat loopback ' +
        'as a secure context. That reading is probably now obsolete — `adminSessionCookie` and ' +
        '`visitorCookie` both set `Secure` unconditionally and their suites drive the same origin — but ' +
        "the fix is a change to the public booking flow's cookie, which belongs to the unit that owns " +
        'the flow and whose six suites would have to be re-run. H-HARD-01 records the finding instead of ' +
        "making an unverified edit to another estate's session cookie, and reports it as a DEFECT.",
      hostPrefix:
        'A browser refuses a `__Host-` cookie that lacks `Secure`, so the prefix cannot be applied ' +
        'before the exception above is resolved. Prefixing it now would silently log every booking ' +
        'visitor out in development: the cookie would not be stored at all.',
    },
  },
  {
    cookieName: 'berelax_visitor',
    purpose: 'identifier',
    builder: 'apps/web/app/api/collect/ingest.ts',
    flags: ['httpOnly', 'secure', 'sameSiteLax', 'pathRoot'],
    exceptions: {
      hostPrefix:
        'Eligible — it has `Secure`, `Path=/` and no `Domain` — and NOT taken, because the name is the ' +
        'join key between a browser and `analytics.visitor`: renaming it orphans every cookie already ' +
        "in a visitor's browser, so every returning visitor is counted as new and the measurement has a " +
        'discontinuity nothing in the data explains. It carries no authority, so the prefix would buy ' +
        'enforcement of attributes that are already asserted by `ingest.test.ts`. Worth taking the next ' +
        'time the analytics estate accepts a visitor-identity migration.',
    },
  },
  {
    cookieName: 'berelax_consent',
    purpose: 'page_readable',
    builder: 'apps/web/app/api/v1/consent/analytics/handler.ts',
    flags: ['secure', 'sameSiteLax', 'pathRoot'],
    exceptions: {
      httpOnly:
        'Deliberately absent, and argued at `consent-signal.ts`: the banner writes this value and the ' +
        'gate that decides whether a tag loads reads it, both in the browser. Nothing is protected by ' +
        'hiding a value that carries no credential and no identifier — only which of four named signals ' +
        'its own owner agreed to. `analytics-consent.itest.ts` asserts `HttpOnly` stays ABSENT.',
      hostPrefix:
        "Eligible, and not taken for `berelax_visitor`'s reason plus one more: the name appears in the " +
        'consent bootstrap script that runs in the browser, so the prefix would have to be threaded ' +
        'through a string that is read by code the server does not type-check.',
    },
  },
  {
    cookieName: 'berelax_google_consent',
    purpose: 'session',
    builder: 'apps/web/app/(admin)/settings/integrations/google/connect/route.ts',
    flags: ['httpOnly', 'secure', 'sameSiteLax'],
    exceptions: {
      pathRoot:
        'Scoped to `/settings/integrations/google`, which is NARROWER than `Path=/` and therefore ' +
        'stronger: it holds a PKCE verifier for ten minutes and no request outside that one flow has any ' +
        'reason to carry it. This is the exception that proves the table is about the property and not ' +
        'the letter of the flag.',
      hostPrefix:
        '`__Host-` requires `Path=/` exactly, so the prefix and the narrower path are mutually ' +
        'exclusive — and the narrower path is the better of the two for a ten-minute flow cookie.',
    },
  },
])

/** The attributes read out of a `Set-Cookie` header value. */
export interface CookieAttributes {
  /*
    `cookieName` and not `name`, which is not tidiness: `apps/web/src/seo/brand.test.ts` treats a line
    matching `name: '…'` as a schema.org or document TITLE and refuses the bare brand in one, because
    berelax.com is an international airport-spa chain with an outlet in the same city. Five cookie names
    beginning `berelax_` are five findings in a scan that is right about titles and has no business
    reading this table. Renaming the field here is cheaper and safer than widening somebody else's SEO
    rule, and it reads better anyway.
  */
  readonly cookieName: string
  readonly value: string
  readonly httpOnly: boolean
  readonly secure: boolean
  readonly sameSite: string | null
  readonly path: string | null
  readonly domain: string | null
  readonly maxAge: number | null
}

/**
 * Reads one `Set-Cookie` header value into its attributes.
 *
 * Case-insensitive on the attribute NAMES and not on the cookie name, which is RFC 6265: `httponly` and
 * `HttpOnly` are the same attribute and `berelax_admin` and `BERELAX_ADMIN` are different cookies. Written
 * here rather than taken from a library because it is nine lines and because the thing being tested is a
 * string this app produced — a parser with its own normalisation would be a second opinion about what was
 * sent.
 */
export function cookieAttributesOf(setCookie: string): CookieAttributes {
  const parts = setCookie.split(';').map((part) => part.trim())
  const [pair = '', ...attributes] = parts
  const eq = pair.indexOf('=')
  const lower = attributes.map((attribute) => attribute.toLowerCase())
  const attributeNamed = (key: string): string | null => {
    const found = lower.findIndex((attribute) => attribute.startsWith(`${key}=`))
    return found === -1 ? null : (attributes[found]?.slice(key.length + 1) ?? null)
  }
  const maxAge = attributeNamed('max-age')
  return {
    cookieName: eq === -1 ? pair : pair.slice(0, eq),
    value: eq === -1 ? '' : pair.slice(eq + 1),
    httpOnly: lower.includes('httponly'),
    secure: lower.includes('secure'),
    sameSite: attributeNamed('samesite'),
    path: attributeNamed('path'),
    domain: attributeNamed('domain'),
    maxAge: maxAge === null ? null : Number(maxAge),
  }
}

/** The flags a `Set-Cookie` actually carries, in {@link COOKIE_FLAGS} order. */
export function cookieFlagsOf(setCookie: string): readonly CookieFlag[] {
  const attributes = cookieAttributesOf(setCookie)
  const carried: CookieFlag[] = []
  if (attributes.httpOnly) carried.push('httpOnly')
  if (attributes.secure) carried.push('secure')
  if (attributes.sameSite?.toLowerCase() === 'lax') carried.push('sameSiteLax')
  if (attributes.path === '/') carried.push('pathRoot')
  // The prefix is only MEANINGFUL with the attributes a browser demands of it, so a name that claims it
  // without them does not count as carrying it. A cookie called `__Host-x` with a `Domain` is not stored
  // at all, and reporting it as host-prefixed would be reporting the opposite of what happens.
  if (
    attributes.cookieName.startsWith(COOKIE_HOST_PREFIX) &&
    attributes.secure &&
    attributes.path === '/' &&
    attributes.domain === null
  ) {
    carried.push('hostPrefix')
  }
  return carried
}

/**
 * Why a `Set-Cookie` does not match its declaration, or nothing.
 *
 * A list of sentences rather than a throw, so one test reports every cookie that drifted instead of the
 * first — the same shape as `portalFieldPolicyProblems` and `tillFailureSentenceProblems`. It checks BOTH
 * directions: a declared flag that is missing from the header, and a flag the header carries that the
 * declaration does not claim. The second matters more than it looks: a cookie that silently GAINED
 * `HttpOnly` would break the consent gate in the browser, and the only thing that would say so is a page
 * that stopped loading a tag.
 */
export function cookieDeclarationProblems(
  declaration: CookieDeclaration,
  setCookie: string,
): readonly string[] {
  const problems: string[] = []
  const attributes = cookieAttributesOf(setCookie)
  if (attributes.cookieName !== declaration.cookieName) {
    problems.push(
      `${declaration.builder} set \`${attributes.cookieName}\` but is declared as \`${declaration.cookieName}\`.`,
    )
  }
  const carried = new Set(cookieFlagsOf(setCookie))
  const claimed = new Set(declaration.flags)
  for (const flag of COOKIE_FLAGS) {
    if (claimed.has(flag) && !carried.has(flag)) {
      problems.push(
        `${declaration.cookieName} is declared \`${flag}\` and the header does not carry it.`,
      )
    }
    if (!claimed.has(flag) && carried.has(flag)) {
      problems.push(
        `${declaration.cookieName} carries \`${flag}\` and does not declare it. Add it to \`flags\`, or ` +
          'find out which browser-side reader it just broke.',
      )
    }
  }
  return problems
}

/**
 * Why ONE declaration is wrong, or nothing.
 *
 * Split out from {@link cookieTableProblems} because the two checks are about different things and the
 * combined function was a loop with four independent bodies: this one is about a row being well-formed,
 * and the caller is about the table being a set.
 */
function declarationProblems(declaration: CookieDeclaration): readonly string[] {
  const problems: string[] = []
  const expected = COOKIE_FLAGS_BY_PURPOSE[declaration.purpose]
  const claimed = new Set(declaration.flags)
  for (const flag of expected) {
    const excused = declaration.exceptions[flag]
    if (claimed.has(flag) && excused !== undefined) {
      problems.push(`${declaration.cookieName} both claims and excepts \`${flag}\`.`)
    }
    if (!claimed.has(flag) && excused === undefined) {
      problems.push(
        `${declaration.cookieName} is a ${declaration.purpose} cookie missing \`${flag}\` with no reason. ` +
          'Carry the flag or write down why it cannot.',
      )
    }
  }
  for (const [flag, reason] of Object.entries(declaration.exceptions)) {
    if (reason.length < 80) {
      problems.push(
        `${declaration.cookieName}'s reason for not carrying \`${flag}\` is ${reason.length} characters. ` +
          'A reason that short is a label; write the argument.',
      )
    }
  }
  if (declaration.purpose === 'session' && !claimed.has('httpOnly')) {
    // The one flag no reason excuses. A session cookie readable by script is the XSS hole and the session
    // theft in one step, and there is no page feature worth it.
    problems.push(
      `${declaration.cookieName} is a session cookie without \`HttpOnly\`. No reason excuses that one.`,
    )
  }
  return problems
}

/**
 * Why the table itself is wrong, or nothing.
 *
 * The declaration is the claim, so the claim has to be well-formed before it means anything: every flag
 * the purpose would carry is either claimed or excepted with a reason, no flag is both, and every reason
 * is a sentence somebody wrote rather than a word. The minimum length is the crude half of that and it is
 * there on purpose — "legacy", "TODO" and "n/a" are how an exception table becomes a list of everything.
 *
 * What this adds to {@link declarationProblems} is the only claim about the SET: a name declared twice,
 * which would make one of the two rows dead and the other authoritative with nothing saying which.
 */
export function cookieTableProblems(
  declarations: readonly CookieDeclaration[] = COOKIE_DECLARATIONS,
): readonly string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const declaration of declarations) {
    if (seen.has(declaration.cookieName))
      problems.push(`${declaration.cookieName} is declared twice.`)
    seen.add(declaration.cookieName)
    problems.push(...declarationProblems(declaration))
  }
  return problems
}
