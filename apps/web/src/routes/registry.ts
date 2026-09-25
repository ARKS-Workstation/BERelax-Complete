/**
 * The route registry: every route this application serves, declared once.
 *
 * Four things need the same list and must not each keep their own: the sitemap (W-SITE-08), the
 * `hreflang` set, the screenshot matrix (H04), and the `x-robots-tag` policy. Every one of them is a
 * list of routes with a property attached, and every separately maintained copy of such a list has the
 * same failure: a route is added, one list is updated, and the omission is invisible. A page missing
 * from the sitemap is not a build error. A page with no `hreflang` is not a build error. A page nobody
 * screenshots is not a build error. So the list lives here and
 * `apps/web/src/routes/registry.test.ts` asserts an exact bijection between these entries and the
 * routes on disk — which *is* a build error, in both directions.
 *
 * ## What is deliberately absent
 *
 * **The CMS.** `/admin` and `/cms-api` belong to W-SYS-08 and to `@berelax/cms`, which owns their
 * prefixes and their robots header (`next.config.ts`). The bijection test asserts `cmsRoutesIn` over
 * these paths is empty *and* skips them on the filesystem side, so the two halves cannot drift into
 * declaring the admin a public route.
 *
 * **Routes that do not exist yet.** docs/09 §1 lists eleven more — `/treatments`, `/therapists`,
 * `/spa`, `/book` and the rest — and each arrives with its own unit. An entry here for a route with no
 * file fails the bijection, which is the point: the registry describes what is served, not what is
 * planned.
 *
 * ## Why the path is the default locale's path
 *
 * One entry covers both documents of a route. `path` is written as the English URL and the Arabic URL is
 * derived by `localisedPath`, because a route that is declared once cannot have a prefix in one locale
 * and not the other — which is how `hreflang` sets end up non-reciprocal.
 */
import { CMS_ROBOTS_TAG, cmsRoutesIn } from '@berelax/cms'
import { LOCALES, type Locale, localisedPath } from '../i18n/locales.ts'

/** A document is a page with `<html>` around it; a handler is a `route.ts` that answers with bytes. */
export type RouteKind = 'document' | 'handler'

/**
 * How the route is produced.
 *
 * `static` is prerendered at build and never revalidated; `dynamic` is rendered per request; `isr` is
 * prerendered at build **from the database** and replaced by on-demand revalidation when the row it was
 * built from changes. Not decoration: the registry's claim is checked against
 * `.next/prerender-manifest.json` — what the build actually produced — by `route-spine.itest.ts`, so a
 * page that quietly became dynamic because something read a header fails a test rather than a page-speed
 * report six weeks later.
 *
 * `isr` arrived with W-SITE-05 and the three catalogue-derived routes, which docs/09 §1 planned it for.
 * The distinction from `static` is not a rendering detail: an `isr` route reads the catalogue during
 * `next build`, so **the database must be migrated and seeded before the build** — and a route with a
 * dynamic segment prerenders its `generateStaticParams`, so the prerender manifest holds its concrete
 * paths and not the pattern this registry declares. Both are asserted in `route-spine.itest.ts`.
 */
export type RenderingMode = 'static' | 'dynamic' | 'isr'

/** `<changefreq>` in a sitemap. A hint, and the only one of the sitemap fields that is a judgement. */
export type ChangeFrequency =
  | 'always'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'never'

export interface RouteEntry {
  /** Stable, locale-independent, and the name a screenshot is filed under. */
  readonly id: string
  /** The path in the default locale, spelled exactly as the router resolves it, dynamic segments included. */
  readonly path: string
  readonly kind: RouteKind
  readonly rendering: RenderingMode
  /**
   * The locales this route is served in. Empty for a locale-neutral handler: an API endpoint has no
   * document, no direction and no font stack, and giving it a locale would give one endpoint two URLs.
   */
  readonly locales: readonly Locale[]
  /** False means every response carries `x-robots-tag` and the route is in no sitemap. */
  readonly indexable: boolean
  readonly sitemap: boolean
  /** Null exactly when `sitemap` is false — there is nothing for a changefreq to describe. */
  readonly changefreq: ChangeFrequency | null
  /**
   * The params a **document** with a dynamic segment is *visited* with, declared exactly when it has one.
   *
   * `/treatments/[slug]` is a pattern, not a URL: nothing can fetch it, screenshot it or read its
   * `hreflang` set. Every consumer of this registry that opens a route needs one real path, and the
   * alternative to declaring it here was for each of them to invent one — the screenshot harness, the
   * normalisation walk and the header assertions each hard-coding a slug, and each of them silently
   * skipping the most valuable pages on the site the day the slug changed.
   *
   * It is a **catalogue** value in a registry, which is the one thing here that is not derived: the slug
   * is the first row of docs/13 §4's menu, seeded by B-CAT-06. `apps/web/src/treatments.itest.ts`
   * asserts it resolves to a published service, so a rename fails a test rather than leaving the harness
   * photographing a 404.
   *
   * A parameterised **handler** declares none, and `registry.test.ts` asserts that asymmetry: nothing opens
   * a handler's URL to screenshot it or to read an `hreflang` set out of it.
   */
  readonly sampleParams?: Readonly<Record<string, string>>
  /** Why this route is in the registry with these properties. Read by nobody; read by everybody. */
  readonly why: string
}

/**
 * Every route, in path order.
 *
 * Sorted because two consumers read it as a sequence — the sitemap and the capture matrix — and an
 * unsorted source produces a sitemap whose diff is noise. `registry.test.ts` asserts the order.
 */
export const ROUTES = [
  {
    id: 'home',
    path: '/',
    kind: 'document',
    rendering: 'isr',
    locales: LOCALES,
    indexable: true,
    sitemap: true,
    changefreq: 'weekly',
    why:
      'The home page, in both locales. Weekly rather than daily: the hero, the proof and the ' +
      'treatments overview change when the catalogue does, and claiming daily change on a page that ' +
      'does not change teaches a crawler to ignore the hint. ISR since W-SITE-04, which is what docs/09 ' +
      '§1 lists it as: the page is composed from the premises row, the catalogue and the roster, and ' +
      'while it was `static` it could carry neither the locality beside the trading name nor a JSON-LD ' +
      'block, because a static route is evaluated during `next build` and the build has no database. ' +
      'Both were deferred here by name — by the page itself and by structured-data.itest.ts — and a ' +
      'correction now reaches it by revalidation rather than by a deploy.',
  },
  {
    id: 'about',
    path: '/about',
    kind: 'document',
    rendering: 'isr',
    locales: LOCALES,
    indexable: true,
    sitemap: true,
    changefreq: 'yearly',
    why:
      'docs/09 §1s "trust, and the pages an acquirer requires". The one question it answers that no other ' +
      'page does is the entity question docs/09 §"The brand collision" raises: an international ' +
      'airport-spa chain trades under a similar short name and has an outlet in this city, so a reader ' +
      'and an assistant both need somewhere that says which business this is, by full name and address. ' +
      'ISR rather than static, which is what docs/09 §1 lists it as: the answers are composed from the ' +
      'premises row, the legal entity and the size of the catalogue, and an editorial body from the CMS ' +
      '`pages` collection renders above them when one is published. Yearly: an about page changes when ' +
      'the business does.',
  },
  {
    id: 'facts',
    path: '/api/facts',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: true,
    sitemap: false,
    changefreq: null,
    why:
      'W-SITE-02s canonical machine-readable fact sheet (docs/09 §4). Indexable, which reads oddly for ' +
      'JSON and is the decision: the whole point of the endpoint is that a crawler and an assistant may ' +
      'fetch and cite it, and `indexable: false` here would put `noindex` on the one response this site ' +
      'most wants quoted. Absent from the sitemap because a sitemap lists documents — this has no ' +
      '<html>, no hreflang and nothing for a changefreq to describe. Locale-neutral: one endpoint, one ' +
      'URL, and the payload carries both locales worth of nothing, because a fact has no language.',
  },
  {
    id: 'book-flow',
    path: '/api/v1/book',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'B-UI-02s steps 4 and 5. Every step of the booking flow past the slot picker is a POST here that ' +
      'answers 303 with the URL of the next state, which is what makes them work with JavaScript off ' +
      'without being GET requests that send an SMS or take a slot. Its GET serves the add-to-calendar ' +
      'file for a booking the session cookie proves is the readers. Locale-neutral for the reason the ' +
      'OTP route below gives — the locale is a field in the body, and the 303s Location is built from ' +
      'it — and noindex because nothing here is a document: the POST writes and the GET needs a cookie ' +
      'no crawler has.',
  },
  {
    id: 'bookings',
    path: '/api/v1/bookings',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'B-AVAIL-06s booking transaction. Locale-neutral for the reason the OTP route below gives — one ' +
      'endpoint, one URL — and noindex because a POST that takes a row lock and writes five records is ' +
      'nothing a crawler should be encouraged to find. Dynamic by necessity: it reads the catalogue, ' +
      'locks the room rows and writes, on every request.',
  },
  {
    id: 'media-publish',
    path: '/api/v1/media/publish',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'W-SYS-10s publish gate: the API half of "blocked in the UI AND at the API endpoint". Under /api ' +
      'and not beside the preview for three reasons — /api is exempt from the proxy, so a trailing ' +
      'slash is trimmed with a 308 rather than a 301, and a 301 on a POST is downgraded to a GET with ' +
      'the body dropped; a publish is not a document, so a locale would give one endpoint two URLs; and ' +
      'an endpoint under /api is somewhere a curl naturally goes, which is what the acceptance ' +
      'criterion means by an assertion independent of the UI. Not indexable, and covered by the proxy ' +
      'exemption rather than by a header, exactly like the OTP endpoint beside it.',
  },
  {
    id: 'otp',
    path: '/api/v1/otp',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'B-LIFE-02s code request. Locale-neutral on purpose — the locale of the message is a field in ' +
      'the request body — and exempt from the proxy, because a 301 turns its POST into a GET.',
  },
  {
    id: 'preferences',
    path: '/api/v1/preferences',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'C-CRM-04s preference centre, which docs/04 SS5 makes the only functional opt-out this business ' +
      'has: an alphanumeric sender ID cannot receive an SMS, so "reply STOP" does not exist here and the ' +
      'link in a message is it. Locale-neutral for the reason the OTP route above gives - one endpoint, ' +
      'one URL - and the locale the wording was shown in is a field on the request, because it is part of ' +
      'the consent capture context rather than a property of the URL. Not indexable and covered by the ' +
      'proxy exemption rather than by a header, exactly like the three endpoints above. Unparameterised on ' +
      'purpose: the contact and the capability are query parameters, so a path segment does not make the ' +
      'token part of the resource identity and appear in every log line and Referer for one page.',
  },
  {
    id: 'book',
    path: '/book',
    kind: 'document',
    rendering: 'dynamic',
    locales: LOCALES,
    indexable: true,
    sitemap: true,
    changefreq: 'daily',
    why:
      'B-UI-01s booking flow, and the first **document** on this site that is dynamic. Everything else ' +
      'reads rows that change a few times a year and is prerendered from them; this one reads ' +
      'availability, which changes on every booking, every shift change and every walk-in, so a ' +
      'prerendered copy would offer times that are already gone. It is also dynamic in Next own terms ' +
      'because it reads `searchParams`: every step of the flow is a query field submitted by a GET ' +
      'form, which is what makes steps 1-3 work with JavaScript off (docs/09 §3) and what keeps one ' +
      'page from becoming five documents in the hreflang set. Indexable and in the sitemap: it is the ' +
      'page the Google Business Profile link, the hero CTA and the sticky book bar all point at, and ' +
      'the one page on the site that exists to convert. `daily` rather than `always`, which is a ' +
      'hint about the DOCUMENT and not about the slot list inside it — the form, the menu and the ' +
      'copy change when the catalogue does.',
  },
  {
    id: 'manage-booking',
    path: '/booking/[token]',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'B-UI-05s magic-link self-service manage-booking page (docs/09 §1). It renders a DOCUMENT and it is ' +
      'declared a handler, which is the one entry here where that reads oddly, so the three reasons are ' +
      'worth stating. A registry document must declare `sampleParams`, and the screenshot harness, the ' +
      'normalisation walk and the header assertions each open that path and require a 200 - so the sample ' +
      'would be a live, permanently valid magic link committed to this file. A registry document must carry ' +
      'a reciprocal hreflang set in both locales, which would publish the token in the head of the page for ' +
      'every crawler and proxy and make two URLs for one capability. And a document must be served in both ' +
      'locales, where this is one URL whose language comes from `customer.locale` - the language that ' +
      'customers reminder was sent in. The Messages inbox, the HR credentials screen and the compliance ' +
      'calendar are the precedents for a document served by a handler; this one has a security reason on top ' +
      'of their shell reason. Not indexable and covered by NOINDEX_PATTERNS rather than a prefix, because ' +
      '`/booking/` claims no other route and a prefix would be a claim on paths nothing serves. Dynamic: ' +
      'the page is one booking read under a capability, and a prerendered copy of it is a leaked credential.',
  },
  {
    id: 'admin-calendar',
    path: '/calendar',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'B-UI-03s front-desk diary: room x time as the primary axis because rooms are the scarce resource, ' +
      'therapist x time as a second reading of the same query result, and drag-to-reschedule through ' +
      'B-LIFE-03s transaction. A handler answering text/html rather than a document, for the reason the ' +
      'Messages inbox, the template editor and the compliance calendar give: a document must be served in ' +
      'both locales, which would need an Arabic admin document and the W-SYS-01 shell, and would join a ' +
      'screenshot matrix whose RTL half has to be a real Arabic route. It is the first admin surface that ' +
      'WRITES — its POST is the reschedule — and it is NOT authenticated until W-SYS-01, so the actor it ' +
      'records is the declared principal system:front_desk_diary rather than a job title nobody signed in ' +
      'as. Not indexable and covered by NOINDEX_PATTERNS rather than a prefix, because `/calendar` claims ' +
      'no other route and a prefix would be a claim on paths nothing serves. Dynamic because the page is a ' +
      'claim about which trading date it is: a prerendered copy would be wrong from the next close of ' +
      'trading, and would show appointments that have since moved.',
  },
  {
    id: 'duplicate-queue',
    path: '/clients/duplicates',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'C-CRM-06s duplicate review queue: the candidate pairs above the review threshold, ordered by score, ' +
      'each linking to a preview. A handler rather than a document for the reason the Messages inbox and ' +
      'the template editor give one directory along - a registry document must be served in BOTH locales, ' +
      'which needs an Arabic admin document and the W-SYS-01 shell - and `?dir=rtl` re-renders this English ' +
      'document mirrored so the direction half of the accessibility matrix is audited without inventing an ' +
      'Arabic admin surface. Dynamic because every row is read per request and a prerendered copy would ' +
      'offer a merge of a pair somebody has already merged. It WRITES NOTHING and is NOT authenticated, ' +
      'exactly as the routes under /compliance, /hr and /settings record. The /clients prefix in ' +
      'ADMIN_GROUP_PREFIXES is what makes it noindex, so the client screens the manifest puts beside it ' +
      'arrive excluded rather than being indexed until somebody reads Search Console.',
  },
  {
    id: 'duplicate-merge-preview',
    path: '/clients/duplicates/preview',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'C-CRM-06s merge preview, and the one route in the admin group that WRITES. GET runs the real merge ' +
      'inside a transaction that is rolled back and renders what it did, so the preview cannot disagree ' +
      'with the outcome; POST performs it for real and redirects back here, where the pair then reads as ' +
      '`already_merged`. Dynamic and never cached: a cached preview would show row counts from before ' +
      'somebody elses merge. Not authenticated, like every route under /compliance, /hr and /settings - ' +
      'there is no admin session until W-SYS-01 - so the authorisation it enforces is the databases: 0069 ' +
      'refuses a merge_record with a placeholder actor or a placeholder reason, and both arrive from the ' +
      'form. Covered by the /clients noindex prefix.',
  },
  {
    id: 'compliance-calendar',
    path: '/compliance',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'M-VAT-11s compliance calendar (docs/04 §9): every obligation definition, its dated occurrences, ' +
      'the reminders and escalations planned against each, and the owner banner an overdue BLOCKING ' +
      'obligation raises. A handler answering text/html rather than a document, for the reason the ' +
      'credentials screen and the Messages inbox give: a document must be served in both locales, which ' +
      'would need an Arabic admin document and the W-SYS-01 shell, and would join a screenshot matrix ' +
      'whose RTL half has to be a real Arabic route. Dynamic because the page is a claim about which ' +
      'TRADING date it is, so a prerendered copy would be wrong from the next close of trading. The /compliance ' +
      'prefix in ADMIN_GROUP_PREFIXES is what makes it noindex, and it is NOT authenticated until ' +
      'W-SYS-01, exactly as the routes under /hr and /settings record. It shows no licence number, ' +
      'permit number or TRN: none is on file (Y1-licence, Y1-trn) and the obligation table holds none.',
  },
  {
    id: 'compliance-evidence',
    path: '/compliance/evidence/[evidenceId]',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'M-VAT-11s private evidence download: the bytes of one filed attachment, served only against an ' +
      'expiring grant and audited on every download. A handler rather than a document for a reason of ' +
      'its own beyond the two the calendar gives — it returns a STATUS CODE and a byte stream, and ' +
      '"403 without a grant" is a status code. Every refusal is 403 and never 404, deliberately: a 404 ' +
      'for an id that does not exist and a 403 for one that does would answer "has an inspection report ' +
      'been filed against this occurrence" to anybody who can guess a uuid. Covered by the /compliance ' +
      'noindex prefix, and the response repeats the directive itself so a direct hit cannot lose it.',
  },
  {
    id: 'compliance-questions',
    path: '/compliance/unverified',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'M-VAT-11s open-compliance-questions dashboard, driven by the [UNVERIFIED] flags on the ' +
      'obligation table so an unresolved legal question stays visible in the product instead of being ' +
      'lost in docs/04. Its own route rather than a section of the calendar, because the distinction it ' +
      'exists to make is the one the calendar must not blur: an unconfirmed DUTY, a confirmed duty with ' +
      'no deadline on file, and an actual breach are three different facts with three different ' +
      'remedies, and a screen that added them together would report every unanswered question as a ' +
      'false alarm. A handler for the calendars reasons; dynamic because the overdue section is a claim ' +
      'about the trading date. Covered by the /compliance noindex prefix.',
  },
  {
    id: 'contact',
    path: '/contact',
    kind: 'document',
    rendering: 'isr',
    locales: LOCALES,
    indexable: true,
    sitemap: true,
    changefreq: 'monthly',
    why:
      'The second of the three visible surfaces docs/09 §4 says the premises row drives ("Footer NAP ' +
      'block, /contact, /spa, map embed, directions link"), and W-SITE-02 deferred it here by name. Every ' +
      'number, address line and opening time is the rows; no WhatsApp number appears at all, because ' +
      'Y1-nap has not said which of two candidates is the business (factsSchema types the unconfirmed ' +
      'branch with no digits). ISR because it reads that row: a corrected telephone number reaches it by ' +
      'revalidation rather than by a deploy, which is the whole reason W-SITE-02 left this route for the ' +
      'first ISR page that renders NAP.',
  },
  {
    id: 'faq',
    path: '/faq',
    kind: 'document',
    rendering: 'isr',
    locales: LOCALES,
    indexable: true,
    sitemap: true,
    changefreq: 'monthly',
    why:
      'docs/09 §1: "Feeds both FAQPage schema and the on-page accordion." The page and the schema block ' +
      'are built from ONE read of `faq_entries` — the same array to the body and to `pageGraph({ faq })` — ' +
      'which is what makes "the page and the schema derive from the same rows" a property rather than a ' +
      'comparison. W-SITE-03 built the FAQPage node and deferred it to "the unit that adds /faq" because ' +
      'there was no Payload read path on a rendered route; src/cms/read.ts is that path. ISR: the entries ' +
      'are CMS rows, so publishing one revalidates this page.',
  },
  {
    id: 'hero-demo',
    path: '/hero-demo',
    kind: 'document',
    rendering: 'dynamic',
    locales: LOCALES,
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'W-SYS-07s hero: the LCP-safe poster and the attach island. A development surface like the ' +
      'kitchen sink, so noindex and in no sitemap \u2014 and in the registry anyway, because it is a route ' +
      'and a route the registry does not know about is the failure this file exists to prevent. In both ' +
      'locales because two of the units criteria are "in both themes and both directions", and the ' +
      'direction axis is the locale: the pause control sits at the bottom INLINE-END, which is a claim ' +
      'that is only false in one direction, and a mirrored English document would have passed it. A ' +
      'route of its own rather than a section of the kitchen sink because the ban on entrance animation ' +
      'is a claim about everything above the fold at first paint, and the kitchen sinks condensing ' +
      'header is a scroll-driven animation on an above-the-fold element. Dynamic because the page reads ' +
      'the committed photographs bytes to compute its content address, and a prerendered copy would bake ' +
      'the address of whichever photograph was there at build time.',
  },
  {
    id: 'hr-credentials',
    path: '/hr/credentials',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'P-HR-02s credential registry: every employees mandatory documents, their expiry and the ' +
      'eligibility verdict, judged at one instant against the regulatory profile in force. A handler ' +
      'answering text/html rather than a document, for the reason the Messages inbox and the breakpoint ' +
      'preview both give: a document must be served in both locales, which would need an Arabic admin ' +
      'document and the W-SYS-01 shell, and would join a screenshot matrix whose RTL half has to be a ' +
      'real Arabic route. This surface is English-only on purpose — it shows an HR administrator ' +
      'which credentials are current — and it shows no document number: number_ct is a ciphertext ' +
      'under STAFF_PII_KEK and the only path to a plaintext is the audited decrypt in packages/hr. ' +
      'Dynamic because the verdict is a claim about which day it is, so a prerendered copy would be ' +
      'wrong from the next midnight. The /hr prefix in ADMIN_GROUP_PREFIXES is what makes it noindex, ' +
      'and NOT authenticated until W-SYS-01, exactly as the routes under /settings record.',
  },
  {
    id: 'hr-reassignment',
    path: '/hr/reassignment',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'P-HR-04s reassignment work queue: every appointment whose therapist may no longer take it, ' +
      'soonest first, with the credential that took them off it. A handler answering text/html rather ' +
      'than a document, for the reason the credentials screen one directory along gives: a document must ' +
      'be served in both locales, which would need an Arabic admin document and the W-SYS-01 shell, and ' +
      'would join a screenshot matrix whose RTL half has to be a real Arabic route. READ-ONLY on ' +
      'purpose — reassigning is a write with an actor, a reason and a client gender no table holds ' +
      '(B-AVAIL-05), so a page that offered a therapist without it would offer one the transaction then ' +
      'refuses. It names no customer and no therapist: staff_reference is the handle, and nineteen ' +
      'employees have no name recorded (ADR 0020). Dynamic because a work queue that was prerendered ' +
      'would still show work already done. The /hr prefix in ADMIN_GROUP_PREFIXES is what makes it ' +
      'noindex, and NOT authenticated until W-SYS-01, exactly as the routes under /settings record.',
  },
  {
    id: 'journal',
    path: '/journal',
    kind: 'document',
    rendering: 'isr',
    locales: LOCALES,
    indexable: true,
    sitemap: true,
    changefreq: 'weekly',
    why:
      'The informational half of docs/09 §1s topic clusters. It holds no posts: a post publishes only with ' +
      'an author byline, a reviewer byline and a date, and this build invents none of the three, so the ' +
      'index states that rather than listing copy nobody signed. Indexable and in the sitemap all the ' +
      'same, for the reason /treatments is: the flag is a policy about the route, not a count of todays ' +
      'rows, and a noindex hub is one somebody has to remember to flip. `/journal/[slug]` is deliberately ' +
      'absent — a dynamic document needs sampleParams that resolve to a 200, and no post can resolve to ' +
      'one yet; the manifest NOTE records what would unblock it. Weekly, because that is what a journal ' +
      'claims when it has posts, and claiming less would have to be corrected the day one lands.',
  },
  {
    id: 'kitchen-sink',
    path: '/kitchen-sink',
    kind: 'document',
    rendering: 'dynamic',
    locales: LOCALES,
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'W-SYS-02 and W-SYS-03s proving ground, in both locales because the RTL half of the ' +
      'twelve-render sweep has to be a real Arabic document. A development surface, so noindex and ' +
      'absent from every sitemap — but still in the registry, because it is a route, and a route the ' +
      'registry does not know about is the failure this file exists to prevent. Dynamic since ' +
      'W-SITE-02: it renders the NAP block from the premises row, and a statically prerendered copy ' +
      'would bake the address at build time — the staleness that unit exists to remove. It is the one ' +
      'document that can afford to be dynamic, because nobody outside the team ever requests it.',
  },
  {
    id: 'kitchen-sink-portrait',
    path: '/kitchen-sink/portrait/[index]',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'Serves one staff portrait to both kitchen sinks from `assets/media/`. Locale-neutral because ' +
      'route groups do not appear in a URL and a photograph has no language; dynamic because the ' +
      'index is a segment and the bytes are read at request time.',
  },
  {
    id: 'llms-txt',
    path: '/llms.txt',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: true,
    sitemap: false,
    changefreq: null,
    why:
      'W-SITE-02s LLM-SEO index (docs/09 §"LLM SEO"), a different artefact from robots.txt and from the ' +
      'sitemap: it says what the business IS and which pages are worth reading, in prose, for a reader ' +
      'that will not run JavaScript. Indexable for the same reason as /api/facts, and its page list is ' +
      'derived from this registry, so docs/09 §1s eleven planned routes appear in it the day they land.',
  },
  {
    id: 'derivative',
    path: '/m/[mediaId]/[contentHash]/[filename]',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: true,
    sitemap: false,
    changefreq: null,
    why:
      'The derivative origin (W-SYS-10). packages/media/src/storage/port.ts states the rule this route ' +
      'exists to satisfy — derivatives are served SAME-ORIGIN, because a Spaces hostname costs DNS, TCP ' +
      'and TLS before the first byte of the LCP image — and until now nothing answered the URLs the ' +
      'pipeline produced. Locale-neutral because a photograph has no language, and dynamic because the ' +
      'bytes are read from the bucket per request. Indexable on purpose, and it is the one route here ' +
      'where that reads oddly: a noindex on an image is a page removed from Google Images, which is ' +
      'traffic this business wants, and the URL carries no unpublished state — it is content-addressed, ' +
      'immutable and already public. Absent from the sitemap because a sitemap lists documents.',
  },
  {
    id: 'template-editor',
    path: '/messaging/templates/editor',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'C-AUTO-02s authoring-time cost preview: the encoding, segment count and fils an SMS body will ' +
      'cost, recomputed as it is typed. docs/04 section 5 asks for it by name, because a 150-character ' +
      'Arabic body is three segments and an author who learns that from the invoice has already sent it. ' +
      'A handler rather than a document for the reason B-MSG-04s inbox gives one directory along: a ' +
      'document must be served in both locales, which needs an Arabic admin document and the W-SYS-01 ' +
      'shell. GET renders and POST prices — it writes nothing, creates no template and is NOT ' +
      'authenticated, exactly as the routes under /settings record. The /messaging prefix in ' +
      'ADMIN_GROUP_PREFIXES is what makes it noindex, so the approve and reject screens that land beside ' +
      'it arrive excluded rather than being indexed until somebody reads Search Console.',
  },
  {
    id: 'pricing',
    path: '/pricing',
    kind: 'document',
    rendering: 'isr',
    locales: LOCALES,
    indexable: true,
    sitemap: true,
    changefreq: 'monthly',
    why:
      'The whole menu as one comparable table: 8 treatments x 4 durations, and the three offerings ' +
      'docs/13 §4 prints with no figure. A route of its own rather than a section of the index because ' +
      'it is the page a customer sends a friend and the page an assistant is asked to quote — docs/09 ' +
      '§"LLM SEO" asks for "tables for comparable facts", and a price table is the comparable fact this ' +
      'business has. Monthly: the price list changes when the owner changes it, which is a few times a ' +
      'year, and claiming weekly on a page that does not move teaches a crawler to ignore the hint. ISR ' +
      'because every figure on it is a row.',
  },
  {
    id: 'robots-txt',
    path: '/robots.txt',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: true,
    sitemap: false,
    changefreq: null,
    why:
      'W-SITE-02s crawl policy: what a crawler may FETCH, which is a different question from what may be ' +
      'indexed — that is this registrys `indexable` flag and the x-robots-tag the proxy serves. The two ' +
      'are alternatives rather than layers, so the noindex prefixes here are deliberately not disallowed ' +
      'there: a crawler forbidden to fetch them could never read the header. Dynamic because SITE_ORIGIN ' +
      'is read at request time, so a build promoted between environments cannot serve the wrong host.',
  },
  {
    id: 'catalogue-revalidate',
    path: '/settings/catalogue/revalidate',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'W-SITE-05s publish loop: the POST that invalidates the cached copies of the catalogue-derived ' +
      'pages after a price or a name changes. It exists because those pages are prerendered from the ' +
      'database and `revalidatePath` only works inside the Next process, which is the whole reason this ' +
      'is a route rather than a function the worker could call. Inside the (admin) group, so the ' +
      '/settings noindex prefix covers it; POST only, because a GET would let any crawler invalidate the ' +
      'site caches on every visit.',
  },
  {
    id: 'content-revalidate',
    path: '/settings/content/revalidate',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'W-SITE-07s publish loop, and the sibling of /settings/catalogue/revalidate: the POST that ' +
      'invalidates the cached copies of the CMS-and-premises routes after an FAQ entry, a page, a post or ' +
      'the premises row changes. It exists for the same reason that one does — those pages are prerendered ' +
      'from the database and `revalidatePath` only works inside the Next process — and it is separate ' +
      'rather than merged because the two answer different questions: a price change moves the catalogue ' +
      'pages and an FAQ entry moves this set, and one endpoint that invalidated both on every call would ' +
      'rebuild eighteen documents to publish one answer. POST only, so a crawler cannot fire it; inside ' +
      'the (admin) group, so the /settings noindex prefix covers it.',
  },
  {
    id: 'google-integrations',
    path: '/settings/integrations',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'G-CONN-07s connection card: the connected account, the selected listing, what the grant is ' +
      'allowed to do in English, how recently it was verified, when the next automatic check runs, and ' +
      'Reconnect. A handler rather than a document for the reason the four surfaces under this prefix ' +
      'give — a document must be served in both locales, which needs an Arabic admin document and the ' +
      'admin shell — and read-only: it makes no Google call, so it still says what is wrong on the day ' +
      'the grant died. Covered by the /settings noindex prefix.',
  },
  {
    id: 'google-connect',
    path: '/settings/integrations/google/connect',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'G-CONN-03s consent start and callback, inside the (admin) group. Covered by the /settings ' +
      'noindex prefix below rather than by a rule of its own, so the next admin route is noindex ' +
      'before it is written.',
  },
  {
    id: 'google-health',
    path: '/settings/integrations/google/health',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'G-CONN-06s connection health fragment: the plain-English state of every Google connection, how ' +
      'recently it was verified, and — while the OAuth consent screen is in Testing — the date the ' +
      'grant expires. A handler rather than a document for the reason the picker beside it gives, and ' +
      'read-only: it makes no Google call, so it still renders on the day the grant dies. G-CONN-07 ' +
      'replaces the fragment with the rendered card. Covered by the /settings noindex prefix.',
  },
  {
    id: 'google-picker',
    path: '/settings/integrations/google/picker',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'G-CONN-05s account and location picker: GET enumerates the accounts and locations this Google ' +
      'account manages, POST records the chosen listing or Search Console property. A handler rather ' +
      'than a document because a document has to be served in both locales and needs the admin shell ' +
      'W-SYS-01 builds; the settings card that will call this is G-CONN-07. Covered by the /settings ' +
      'noindex prefix, like the consent route beside it.',
  },
  {
    id: 'google-test-connection',
    path: '/settings/integrations/test-connection',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'G-CONN-07s Test connection: the POST that runs the 03:00 passs own implementation over one ' +
      'connection and answers what it established. POST only, because it forces a token refresh and ' +
      'makes one authenticated read per capability — a GET would let a crawler spend the Google ' +
      'accounts refresh quota on every visit. Covered by the /settings noindex prefix.',
  },
  {
    id: 'media-breakpoint-preview',
    path: '/settings/media/preview/[mediaId]',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'W-SYS-10s breakpoint preview: the real crop at real widths from the real derivative URLs, with ' +
      'per-rung transferred bytes against the slot budget. A handler rather than a document for the two ' +
      'reasons the Messages inbox gives one directory along — a document must be served in both locales, ' +
      'which would need an Arabic admin document and would join a twelve-cell screenshot matrix, and ' +
      'this surfaces acceptance asks for three viewports times two themes — plus a third that is this ' +
      'routes own: a handler returns a STATUS CODE, and "403 for the receptionist, 200 for editor and ' +
      'above" is a status code. Covered by the /settings noindex prefix; dynamic because it measures the ' +
      'objects in the bucket on every request.',
  },
  {
    id: 'messages-inbox',
    path: '/settings/messages',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'B-MSG-04s admin Messages inbox: every message a vendor was asked to send, with its body, ' +
      'encoding, segments, cost, status and delivery receipts, plus an HTML preview pane for a Resend ' +
      'email. A handler answering text/html rather than a document, for the reason G-CONN-05s picker ' +
      'gives: a document must be served in both locales, which would need an Arabic admin document and ' +
      'the W-SYS-01 shell, and would join a screenshot matrix whose RTL half has to be a real Arabic ' +
      'route. This surface is English-only on purpose and is screenshotted at 3 viewports x 2 themes by ' +
      'apps/web/src/messages-inbox.itest.ts. Covered by the /settings noindex prefix, like the two ' +
      'Google routes beside it; dynamic because it reads the message rows on every request.',
  },
  {
    id: 'spa',
    path: '/spa',
    kind: 'document',
    rendering: 'isr',
    locales: LOCALES,
    indexable: true,
    sitemap: true,
    changefreq: 'monthly',
    why:
      'docs/09 §1: "The place: rooms, arrival, facilities, address, hours, parking." The third visible ' +
      'surface of the premises row (docs/09 §4) and the one W-SITE-02 named when it deferred /spa to this ' +
      'unit. Everything on it is the row or a stated absence: there is no column for public transport or ' +
      'landmarks although docs/09 §4 lists both, and the room inventory on record is the provisional ' +
      'five-room stub (Y8-rooms), so neither is published as fact. ISR for the same reason /contact is — ' +
      'it reads the row, and a corrected opening time reaches it by revalidation.',
  },
  {
    id: 'treatments',
    path: '/treatments',
    kind: 'document',
    rendering: 'isr',
    locales: LOCALES,
    indexable: true,
    sitemap: true,
    changefreq: 'monthly',
    why:
      'The treatments index: the 8 (style x treatment) services of docs/13 §4, each linking to its own ' +
      'page. Also the destination every archived treatment 301s to (0029, `TREATMENTS_INDEX_PATH`), ' +
      'which is why it has to exist before a service can be withdrawn without losing its inbound links. ' +
      'ISR: it is generated from the catalogue, so a published price or a renamed treatment reaches it ' +
      'by revalidation rather than by a deploy.',
  },
  {
    id: 'treatment',
    path: '/treatments/[slug]',
    kind: 'document',
    rendering: 'isr',
    locales: LOCALES,
    indexable: true,
    sitemap: true,
    changefreq: 'monthly',
    sampleParams: { slug: 'asian-normal-massage' },
    why:
      'One treatment, one page, and the commercial core of the site: the four priced durations, the ' +
      'question-shaped headings docs/09 §"LLM SEO" asks for, and the Service + Offer JSON-LD. It ' +
      'replaced B-CAT-05s `route.ts` stub, which answered text/plain and was `indexable: false` for ' +
      'exactly as long as it was a stub — a page.tsx and a route.ts cannot share a segment, so this ' +
      'entry flipping to a document is what that supersession looks like. `generateStaticParams` over ' +
      'the catalogue prerenders one path per published service (8 today, per locale), so the prerender ' +
      'manifest holds those paths and not this pattern. Durations are rows on this page, never routes: ' +
      '32 of them would be 32 near-duplicate pages competing with each other for one query.',
  },
  // `as const satisfies` rather than an annotation: the annotation would widen every `id` to `string`
  // and `RouteId` with it, so `routeById('hoem')` would compile.
] as const satisfies readonly RouteEntry[]

/**
 * One entry of the registry, as declared.
 *
 * Narrower than `RouteEntry`: it carries the literal types the array declares, which is what makes
 * `RouteId` a union of the declared ids rather than `string`, and what lets `alternatesFor(route.id, …)`
 * typecheck without a cast.
 */
export type Route = (typeof ROUTES)[number]
export type RouteId = Route['id']

/**
 * The prefixes the admin group owns in the URL space.
 *
 * The `(admin)` route group is a route group, so it contributes **nothing** to the URL: its routes are
 * top-level paths that share no prefix. That is why this list exists rather than a single `/admin/**`
 * rule — and why it names `/analytics`, which has no route yet. A-FIRST-10 puts the funnel dashboard
 * there (docs/09 §1: "Add `/analytics` inside the admin route group — `noindex`, excluded from the
 * sitemap"), and declaring the prefix now means the route arrives already excluded instead of being
 * indexed for as long as it takes somebody to notice. `route-spine.itest.ts` asserts the header is on
 * the live response today, where the route is a 404.
 *
 * `/hr` is P-HR's, and it is a prefix for the same reason rather than one entry per screen. The manifest
 * puts eight more routes under it — `/hr/rota`, `/hr/timesheets`, `/hr/payroll`, `/hr/leave/[id]` and the
 * rest — and every one of them shows wages, identity documents or somebody's leave. A prefix means the
 * ninth arrives noindex on the commit that creates it rather than on the commit that remembers to.
 *
 * `/compliance` is M-VAT-11's, and a prefix for a sharper version of the same reason: the three routes
 * under it today are the calendar, the open-questions dashboard and the private evidence download, and the
 * third serves the bytes of a municipality inspection report. A per-route rule would have to be remembered
 * for the fourth, and the fourth is the one that leaks.
 *
 * `/messaging` is the template estate's, and it holds one route today: C-AUTO-02's cost preview. It is a
 * prefix rather than an entry because the screens that go beside it are already allocated — C-AUTO-01's
 * NOTE hands the approve and reject controls to W-SYS-01, and those show the words of every message this
 * business sends, with a body an operator has not approved among them. The second route under a prefix
 * arrives noindex on the commit that creates it rather than on the commit that remembers to.
 * `/clients` is the CRM's, and C-CRM-06's two routes are the first under it: the duplicate review queue and
 * the merge preview. A prefix rather than two entries because the manifest already allocates the rest of the
 * client estate there — C-CRM-08 puts the clinical intake screens at `/clients/[id]/intake` — and those show
 * a person's clinical file. The second route under a prefix arrives noindex on the commit that creates it
 * rather than on the commit that remembers to, and for that one the difference is a health record.
 *
 */
export const ADMIN_GROUP_PREFIXES: readonly string[] = [
  '/analytics',
  '/clients',
  '/compliance',
  '/hr',
  '/messaging',
  '/settings',
]

/**
 * The value a non-indexable response carries.
 *
 * The same three directives as the CMS's, because the reasons are the same ones `@berelax/cms` gives:
 * `noindex` alone leaves a crawler free to follow links out of the page, and a cached copy of an admin
 * screen outlives the page. `registry.test.ts` asserts this equals `CMS_ROBOTS_TAG` so the two cannot
 * drift into two spellings of one policy.
 */
export const NOINDEX_ROBOTS_TAG = 'noindex, nofollow, noarchive'
export const ROBOTS_HEADER = 'x-robots-tag'

/**
 * Every prefix under which a response is noindex, in sorted order.
 *
 * Derived, not typed: the admin group's prefixes, plus every locale of every non-indexable *document*
 * in the registry. A handler is covered when a document prefix already contains it — the portrait
 * handler sits under `/kitchen-sink` — and `registry.test.ts` asserts that every non-indexable entry is
 * either covered here or exempt from the proxy, so there is no third category that quietly gets neither.
 */
export const NOINDEX_PREFIXES: readonly string[] = [
  ...ADMIN_GROUP_PREFIXES,
  ...ROUTES.filter((route) => !route.indexable && route.kind === 'document').flatMap((route) =>
    route.locales.map((locale) => localisedPath(route.path, locale)),
  ),
].sort()

/**
 * Does a request path match a route pattern, segment for segment?
 *
 * `NOINDEX_PREFIXES` is a list of literal prefixes, which cannot express a pattern: a request for
 * `/treatments/thai-massage` does not start with `/treatments/[slug]`, so a prefix list can only mark a
 * dynamic route noindex by claiming its whole parent — and `/treatments` is where W-SITE-05 puts the
 * public treatment pages, so claiming it would silently suppress the most valuable pages on the site the
 * day they land. A dynamic segment therefore matches exactly one segment here, and a catch-all the rest.
 */
function matchesRoutePattern(pathname: string, pattern: string): boolean {
  const actual = pathname.split('/').filter((part) => part !== '')
  const expected = pattern.split('/').filter((part) => part !== '')
  for (const [index, segment] of expected.entries()) {
    if (segment.startsWith('[[...') || segment.startsWith('[...')) return actual.length > index
    if (segment.startsWith('[')) {
      if (actual[index] === undefined) return false
      continue
    }
    if (actual[index] !== segment) return false
  }
  return actual.length === expected.length
}

/**
 * Every route the registry declares non-indexable, as a pattern in every locale it is served in.
 *
 * Both kinds, deliberately. `indexable: false` on a handler used to be documentation rather than policy:
 * `NOINDEX_PREFIXES` filters on `kind === 'document'`, and the three handlers that existed happened to sit
 * under `/api` (proxy-exempt) or under a prefix a noindex document already claimed. `/treatments/[slug]`
 * is the first that sits under neither, and it answers 200 `text/plain` on a public path — so a crawler
 * will fetch `/treatments/thai-massage` and index a redirect stub. The field now means what it says.
 */
const NOINDEX_PATTERNS: readonly string[] = ROUTES.filter((route) => !route.indexable).flatMap(
  (route) =>
    route.locales.length === 0
      ? [route.path]
      : route.locales.map((locale) => localisedPath(route.path, locale)),
)

/** The `x-robots-tag` a path must carry, or null when it is a public page. */
export function robotsTagFor(pathname: string): string | null {
  const covered =
    NOINDEX_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) ||
    NOINDEX_PATTERNS.some((pattern) => matchesRoutePattern(pathname, pattern))
  return covered ? NOINDEX_ROBOTS_TAG : null
}

/** The CMS's tag, re-exported so the one assertion that compares them has both in one import. */
export { CMS_ROBOTS_TAG }

export function routeById(id: RouteId): Route {
  const route = ROUTES.find((entry) => entry.id === id)
  // Throwing rather than returning undefined: every call site is a page or a builder that cannot
  // proceed without the entry, and an optional return would be checked with `??` and a made-up default.
  if (route === undefined) throw new Error(`No route with id '${id}' in the registry`)
  return route
}

/** The rendered documents, which is what has a locale, a canonical URL and a screenshot. */
export function documentRoutes(): readonly Route[] {
  return ROUTES.filter((route) => route.kind === 'document')
}

/** The path of one route in one locale. Throws for a locale the route is not served in. */
export function pathFor(route: RouteEntry, locale: Locale): string {
  if (!route.locales.includes(locale)) {
    throw new Error(`Route '${route.id}' is not served in locale '${locale}'`)
  }
  return localisedPath(route.path, locale)
}

/** Does this path carry a dynamic segment — `[slug]`, `[...rest]`, `[[...all]]`? */
export function isParameterised(path: string): boolean {
  return path.includes('[')
}

/**
 * The sample params a route declares, as a record.
 *
 * A function rather than `route.sampleParams ?? {}` at each call site, and the reason is the registry's own
 * type: `ROUTES` is `as const satisfies`, so each entry keeps its literal type and an entry **without**
 * `sampleParams` has no such property at all — reading it off the union is a type error. Widening the
 * parameter to `RouteEntry`, where the field is optional, is what makes the access legal, and it keeps every
 * consumer from writing the same cast.
 */
export function sampleParamsOf(route: RouteEntry): Readonly<Record<string, string>> {
  return route.sampleParams ?? {}
}

/**
 * A route pattern with its dynamic segments filled in.
 *
 * **Throws when a segment is left unfilled**, and that is the whole reason this is a function rather than
 * a template literal at each call site. An unfilled pattern does not fail: it produces a perfectly
 * well-formed string — `/treatments/[slug]` — which a canonical link, an `hreflang` set, a sitemap entry
 * and a breadcrumb will each publish as a URL. Nothing downstream can tell it from a real one, and the
 * symptom is a page that tells every crawler its canonical URL is a 404.
 */
export function fillParams(path: string, params: Readonly<Record<string, string>> = {}): string {
  const filled = path.replace(/\[+\.{0,3}([^\]]+)\]+/g, (segment, name: string) => {
    const value = params[name]
    if (value === undefined || value === '') return segment
    return value
  })
  if (isParameterised(filled)) {
    throw new Error(
      `'${path}' still has an unfilled dynamic segment after substitution: '${filled}'. Every ` +
        'consumer of a route path publishes it as a URL — a canonical link, an hreflang alternate, a ' +
        'sitemap entry — and a pattern published as a URL is a page announcing that its own address is ' +
        'a 404.',
    )
  }
  return filled
}

/**
 * One real, fetchable path for a route, in one locale.
 *
 * `pathFor` for a route with no dynamic segment; `pathFor` with `sampleParams` substituted for one that
 * has. The screenshot harness, the normalisation walk and the header assertions all open routes, and
 * this is the one place that knows a pattern is not a URL.
 */
export function samplePathFor(route: RouteEntry, locale: Locale): string {
  return fillParams(pathFor(route, locale), sampleParamsOf(route))
}

/** One URL the registry claims, with the entry and locale it came from. */
export interface RoutePath {
  readonly path: string
  readonly route: Route
  /** Null for a locale-neutral handler: it has one URL, and no document to have a language. */
  readonly locale: Locale | null
}

/**
 * Every URL the registry claims — the set the bijection is asserted against.
 *
 * A locale-neutral handler contributes its path once. Everything else contributes one path per locale,
 * which is what makes `/ar/kitchen-sink` a route the registry knows about rather than a folder that
 * happens to exist.
 */
export function routePaths(): readonly RoutePath[] {
  // A loop with a declared accumulator rather than a `flatMap` over a ternary: the two branches produce
  // `locale: null` and `locale: Locale`, and inference picks one of them as the array's element type
  // rather than the union — which is a type error about `null` several lines away from the cause.
  const paths: RoutePath[] = []
  for (const route of ROUTES) {
    if (route.locales.length === 0) {
      paths.push({ path: route.path, route, locale: null })
      continue
    }
    for (const locale of route.locales) {
      paths.push({ path: localisedPath(route.path, locale), route, locale })
    }
  }
  return paths
}

export function registryPaths(): readonly string[] {
  return routePaths().map((entry) => entry.path)
}

/** The entry a URL belongs to, in either locale, or undefined when the registry does not claim it. */
export function routeByPath(pathname: string): Route | undefined {
  return routePaths().find((entry) => entry.path === pathname)?.route
}

/**
 * The routes a sitemap may contain, as `{ path, changefreq }` per locale.
 *
 * W-SITE-08 builds the sitemap index and the per-type sitemaps; this is the only source it may read, so
 * that "absent from every sitemap" is a property of the registry rather than a claim repeated in a
 * sitemap builder. Every non-indexable route, every handler and every CMS route is absent here by
 * construction, and `registry.test.ts` asserts each of those three.
 */
export interface SitemapEntry {
  readonly path: string
  readonly locale: Locale
  readonly changefreq: ChangeFrequency
}

export function sitemapEntries(): readonly SitemapEntry[] {
  const entries: SitemapEntry[] = []
  for (const route of ROUTES) {
    if (!route.sitemap || route.changefreq === null) continue
    // A pattern is not a URL. `/treatments/[slug]` is in the sitemap as its eight concrete paths, which
    // only the catalogue knows — `treatmentSitemapEntries` in `src/treatments/sitemap.ts` expands it from
    // the rows, and this function stays synchronous and database-free for every other route.
    if (isParameterised(route.path)) continue
    for (const locale of route.locales) {
      entries.push({ path: pathFor(route, locale), locale, changefreq: route.changefreq })
    }
  }
  return entries
}

/**
 * The sitemap routes whose paths only a database can enumerate.
 *
 * Exported so the expansion is driven by the registry rather than by a builder that happens to know about
 * treatments: a second parameterised route in the sitemap appears here the day it is declared, and the
 * expander fails naming it rather than silently omitting its pages.
 */
export function parameterisedSitemapRoutes(): readonly Route[] {
  return ROUTES.filter(
    (route) => route.sitemap && route.changefreq !== null && isParameterised(route.path),
  )
}

/** The CMS routes hiding in a set of registry paths. Empty, and asserted to be. */
export function cmsRoutesInRegistry(): readonly string[] {
  return cmsRoutesIn(registryPaths())
}
