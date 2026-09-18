# Information Architecture, SEO and the Settings Spine

Companion to [08-frontend-design.md](08-frontend-design.md). Covers what the pages *are*, how the
booking flow works on a phone, how one location record drives all SEO, and the settings architecture
that ties the frontend to the backend and the agents.

---

## 1. Page set

| Route | Rendering | Purpose |
|---|---|---|
| `/` | ISR | Hero, proof, treatments overview, therapists, booking CTA |
| `/treatments` | ISR | Commercial index, generated from the catalogue |
| `/treatments/[slug]` | ISR | The commercial core. Price, duration, what happens, who delivers it, FAQ, booking |
| `/therapists` | ISR | The trust layer |
| `/therapists/[slug]` | ISR | **The differentiator.** See §2 |
| `/spa` | ISR | The place: rooms, arrival, facilities, address, hours, parking |
| `/pricing` | ISR | Full price list from the catalogue |
| `/journal`, `/journal/[slug]` | ISR | Informational intent, topic clusters |
| `/faq` | ISR | Feeds both `FAQPage` schema and the on-page accordion |
| `/book` | dynamic | The booking flow |
| `/booking/[token]` | dynamic | Magic-link self-service manage-booking |
| `/contact`, `/about`, legal | static | Trust, and the pages an acquirer requires |
| `/(admin)/**` | dynamic | `noindex`, excluded from sitemap |

**Deliberately absent: a `{treatment} in {area}` page matrix.** With one location that is a doorway-page
pattern with no unique content behind it. The honest play is depth on treatments and therapists. One
`/spa` location page carries the local signals.

---

## 2. The therapist page

The owner's stated focus, and genuinely the strongest asset on the site — for three reasons: a returning
client searches for a *person*, not a service; it is the site's best E-E-A-T signal in a health-adjacent
category; and it converts better than a service page because the decision is already made.

Contents: portrait (see the photography brief), name, credentials with years of practice, specialisms
**mapped to bookable services**, languages spoken, a short first-person note in their own voice, an
availability preview, their reviews, and a direct **"Book with [name]"** action that pre-selects them in
the flow.

### The tension, handled rather than ignored

Naming and photographing therapists builds trust and creates two problems.

**Consent.** Photography and naming require explicit, recorded consent, with a first-name-only or
pseudonym option. This connects to the model-release requirement in the photography brief.

**Departure.** A therapist leaves and their page has inbound links, accumulated reviews and rankings.
Do **not** 404 it. On archival: the page 301s to `/therapists`, their reviews stay attributed to the
business, their internal links are rewritten, and their bookable availability disappears. The
commercial point underneath: **the business owns the client relationship** — preferences, history and
the house rebooking flow — so a departure is survivable. Clients following a departing therapist is a
real risk this design mitigates.

---

## 3. Mobile-first booking flow

Most spa bookings happen on a phone. Design decisions follow from that, not from a desktop mock.

**Mechanics:** primary actions in the lower third (thumb zone) · 48px targets with 8px gaps ·
`env(safe-area-inset-*)` for notch and home indicator · `100dvh` never `100vh` · **16px minimum on
inputs** or iOS zooms on focus · correct `type` and `autocomplete` to summon the right keyboard ·
bottom sheets rather than modals · no hover-only affordances.

**Steps:** service → therapist (or *any*) → date and time → details → confirm.

Entry points: hero CTA, sticky book bar, treatment page, therapist page, Google Business Profile link.

Design notes per step:

- **Availability** is presented as a day strip plus a grouped slot grid (morning / afternoon / evening),
  not a wall of times. `SlotGrid` uses container queries for 3/4/6 columns.
- **No availability** is a designed state, not an empty one: nearest alternative days, the same treatment
  with another therapist, and a waitlist join.
- **Phone input** with country selector, normalising to E.164. **OTP** with `autocomplete="one-time-code"`
  for SMS autofill, a resend cooldown, and a visible path when the message does not arrive.
- **Guest checkout, no account.** Returning customers are recognised by phone.
- **Confirmation** with add-to-calendar and the magic link to manage the booking.

### Error and edge states — enumerated, because these are what get skipped and then handled by phone calls

Slot taken while deciding · OTP never arrives · network drop mid-submit · double submission
(idempotency key) · therapist became unavailable after selection · required room type now booked ·
service duration no longer fits before closing · session expiry mid-flow · browser back after confirm.

**Perceived performance:** skeletons matching final layout, prefetch the next step, optimistic slot
rendering, and CSS press feedback (90ms) so the slot picker's click-to-paint stays under 100ms. The
booking flow is the **one** heavy client island; everything else is a server component.

**Accessibility:** WCAG 2.2 AA. The date/time picker is the hard part — use native `<input type="date">`
on mobile where the platform picker is accessible and familiar, and a custom grid only on desktop, with
a roving tabindex, `aria-selected`, and a live region announcing the selected date.

**Measure:** INP on `/book` specifically, step-by-step funnel drop-off, time to first slot rendered, and
mobile versus desktop completion rate.

---

## 4. One location record drives all SEO

The owner's requirement — *"the settings will show exactly where the spa is"* — becomes the spine of the
SEO architecture.

**`premises` (single row) holds:** legal and trading name · street address in local convention · area /
district · emirate · country · PO box · Makani or building reference · latitude and longitude · Plus Code
· Google `place_id` and CID · phone in E.164 and display form · WhatsApp number · email · opening hours
with exceptions and **Ramadan hours** · parking and access notes · nearest landmarks · public transport.

Everything below is **derived**, never hand-authored:

| Consumer | Derived output |
|---|---|
| Structured data | `LocalBusiness`/`DaySpa` JSON-LD with `GeoCoordinates`, `OpeningHoursSpecification`, `areaServed` |
| Visible site | Footer NAP block, `/contact`, `/spa`, map embed, directions link |
| Discovery | `sitemap.xml`, Open Graph metadata, `hreflang` set |
| Machines | `/api/facts` — the canonical machine-readable fact sheet |
| Operations | Availability engine opening hours; reminder message copy |
| Integrity | Google Business Profile consistency check (§6) |

**The rule: one source of truth.** No hard-coded address in a template, no hand-written schema block.
Divergence between the site, the schema and GBP is precisely what makes AI assistants state wrong hours
and prices with total confidence.

### Schema types

`DaySpa` (a subtype of `LocalBusiness` and `HealthAndBeautyBusiness`) as the primary type. **Do not**
claim `MedicalBusiness` or `MedicalClinic` unless the licence classification supports it — see
[04-uae-compliance.md](04-uae-compliance.md) §1. Claiming a medical type the licence does not permit is a
compliance problem, not an SEO tactic.

Plus: `Service` + `Offer` with `priceSpecification` in AED · `Person` per therapist with `knowsAbout`
and `knowsLanguage` · `FAQPage` · `BreadcrumbList` · `ImageObject` · `VideoObject` for the hero ·
`Organization` with `sameAs`. On `AggregateRating`/`Review`: Google's rules on self-serving review
markup are strict — surface genuine reviews, do not mark up your own testimonials as review snippets.

### Local SEO

For this business Google Business Profile outranks the website for discovery, so it is a first-class
channel, not an afterthought: category accuracy, the full service list, attributes, photos, Posts, Q&A,
the **UTM-tagged booking link**, and review velocity. NAP consistency across UAE directories. Apple
Business Connect and Bing Places. What moves the map pack is proximity, prominence, relevance, review
signals and category accuracy — so effort goes there before it goes into blog volume.

### Technical SEO

Titles and metas generated from the catalogue · hub-and-spoke internal linking · canonicalisation ·
trailing-slash and case normalisation · **automatic 301 on slug change** · sitemap index with per-type
sitemaps and CMS-driven `lastmod` · `robots.txt` · IndexNow · Search Console and Bing verification.

**Because this is an operating business with an existing site:** a full crawl and rank baseline *before*
anything changes, and a 301 map for every retired URL. A relaunch without this routinely costs 30–50%
of organic traffic, and there is real traffic here to lose.

### LLM SEO

The single biggest factor is already decided: **server-rendered HTML**, because most AI crawlers do not
execute JavaScript. Beyond that:

- **Extractability.** Question-shaped `<h2>`s with stable anchor IDs, a direct answer in the first
  sentence under each, tables for comparable facts.
- **Entity consistency.** Name, address, phone, hours, services and prices must agree across the site,
  GBP and every directory. AI answers synthesise across sources; disagreement yields a confident wrong
  answer about your prices.
- **`/api/facts`** as the canonical machine-readable fact sheet, and **`/llms.txt`** — worth publishing,
  with the honest caveat that it is an unofficial convention with limited adoption, not a standard.
- **AI crawler policy** as an explicit decision in `robots.txt` for GPTBot, ClaudeBot, PerplexityBot,
  Google-Extended and CCBot. This is a strategic trade-off: blocking protects content but forfeits
  citation. **Recommendation: allow.** A local service business that wants to be recommended by an
  assistant has far more to gain from citation than from protecting treatment descriptions.
- **Measure it.** Track whether assistants recommend the business for the queries that matter, as a KPI.
  When one states a wrong price, that is a fact-consistency bug to fix at source.

**E-E-A-T:** named therapists with verifiable credentials, author and reviewer bylines with dates, a
medical-disclaimer pattern, and the hard rule that no copy makes a medical claim the licence does not
support — enforced by the publication lint, not by good intentions.

---

## 5. The settings spine

### Why bounded

"Everything can be tweaked" is accepted; "everything is a free-form input" is not. The five tiers are in
[07](07-frontend-and-agents-requirements.md) §2. Implementation:

**A declarative registry.** Every setting declares: key · Zod type and constraint · default · scope ·
required role · i18n label and help text · whether changing it is audited · and an `onChange` effect —
which routes to revalidate, which cache tags to purge, which job to re-run, which schema block to
invalidate.

**Storage:** Payload globals, since Payload is already in the stack and brings versioning, draft/publish
and access control for free. Secrets are the exception: API keys live in an encrypted settings table
under the application key hierarchy, masked on display, never logged, and **validated against the
provider before saving**.

**Runtime:** a typed cached accessor with a documented staleness window. A change propagates by
**on-demand revalidation with cache tags**, never a redeploy. **Boot-time validation** so a bad value
fails loudly at startup rather than rendering a broken page.

**Safety:** preview mode rendering unpublished settings · a diff before save · revert to any prior
version · an impact summary answering "what will this change" · role-gated publishing · full audit trail
· and a hard guard that no settings change can cause a non-production environment to message a real
customer.

### The interconnection map

This is what "everything interconnected" actually means, concretely.

| Change | Cascades to |
|---|---|
| **Address** | `LocalBusiness` JSON-LD · footer NAP · `/contact` · `/spa` · map embed · sitemap · OG image · `/api/facts` · flags a GBP consistency check · **invoices snapshot the issuing address, so historic invoices never change** |
| **Opening hours** | Availability engine · `OpeningHoursSpecification` · GBP consistency check · reminder copy · the "no availability" alternatives |
| **Service price** | Treatment page · `Offer` schema · pricing page · booking flow · **snapshotted onto future bookings, never historic ones** |
| **Publish a therapist** | `/therapists/[slug]` page · `Person` schema · sitemap entry · bookable filter in the availability engine · therapist index |
| **Archive a therapist** | 301 to `/therapists` · removed from availability · future appointments flagged for reassignment · internal links rewritten |
| **Accent / density / radius** | CSS custom properties at `:root` · both themes · regenerated hex mirror · email templates · PDF templates |
| **Hero media** | Derivative generation job · CDN purge · new immutable URL · `VideoObject`/`ImageObject` schema · weight check at publish |
| **LLM provider** | Review autoresponder **and** SEO agent · key validated before save · cost ledger reset against the new price · agent console |
| **Reminder timing** | Existing scheduled reminders rebuilt with new invalidation keys — not just future bookings |
| **Quiet hours** | Campaign scheduler · automation engine send gate · **cannot be disabled, only shifted within legal bounds** |

### The agent console

Where interconnection becomes visible and controllable. One screen listing every agent — SEO agent,
review autoresponder, reminder scheduler, campaign sender, analytics dispatcher, nightly rollups,
compliance calendar — each showing last run, last **success**, next run, cost to date against budget,
pending items awaiting approval, error state, and a per-agent kill switch.

This is also where the heartbeat and watchdog from [07](07-frontend-and-agents-requirements.md) §6
surface. The rule it enforces: **no agent ever stops quietly.**

### Settings UI for a non-technical owner

Grouped by intent rather than by database table. Searchable. Plain-language help on every field.
Sensible defaults everywhere. And a visible separation between *safe to experiment with* and *this
affects money or the law* — because those two categories deserve different levels of caution, and the
interface should say so rather than assuming the owner infers it.
