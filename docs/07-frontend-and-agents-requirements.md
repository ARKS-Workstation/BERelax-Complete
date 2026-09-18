# Frontend and Agents — Confirmed Requirements

Requirements captured from the owner. The *design* for these is under research; this document is the
requirements record they are designed against, so nothing is lost between conversations.

Design documents to follow: the visual system, media strategy, mobile UX, SEO/localisation, the
review autoresponder and the settings architecture.

---

## 1. Design language

- **Minimal, beautiful, aesthetically pleasing.** Beauty and aesthetics are the stated focus, not a
  by-product.
- **Swedish / Scandinavian inspiration** — restraint, negative space, natural light, functionalism
  (nothing decorative that is not also useful), muted natural palettes, craft in small details.
- **Pastel colour palette.**
- **Photos and videos as the hero.**
- **Microinteractions** throughout.
- **Elegant and minimal**, with the **therapists as the focus** of the experience.
- **Mobile view extremely well designed and optimised.**

### Constraints this creates

Three genuine conflicts, to be resolved in the design rather than discovered later:

| Requirement | Conflicts with | Resolution direction |
|---|---|---|
| Pastel palette | WCAG 2.2 AA contrast (4.5:1 body text) | Pastels carry **surfaces and large shapes only**. Contrast comes from ink and photography. Pastel is never load-bearing for text. Every foreground/background pair ships with a measured ratio |
| Video hero | Largest Contentful Paint | The LCP element is the **poster frame**, not the video. Optimised preloaded poster, video attached after. Hero loop measured in seconds and hundreds of KB, not tens of MB |
| Rich microinteractions | Interaction to Next Paint | Motion is a **system of named tokens**, not a collection of effects. Any motion that does not communicate something is decoration and gets cut. `prefers-reduced-motion` is a first-class branch |

---

## 2. Everything configurable in settings

The owner's requirement: *"everything on the front end and backend and all the agents will be
interconnected and everything can be tweaked and changed in the settings"*, including frontend photos
and videos.

Accepted, with one deliberate qualification: **bounded, not unbounded.** An unbounded settings surface
— a free-form colour picker on text, arbitrary font upload, unconstrained media dimensions — is how
the aesthetic being paid for gets destroyed and how a page becomes slow or illegible. The requirement
is met with a **typed, validated settings registry** where every setting declares its type,
constraints, who may change it, and what it invalidates downstream.

### Tiers of configurability

1. **Content** — free for staff to edit. Copy, FAQs, therapist bios, promotions, media within slot
   constraints.
2. **Operational parameters** — owner/manager, validated, real consequences. Prices, durations,
   turnaround, reminder timing, cancellation windows, quiet hours, LLM provider and budget caps.
3. **Brand tokens** — bounded. Accent selected from a **curated set of pre-designed palettes, each
   pre-validated for AA contrast in light and dark mode**; density and radius as enums; logo upload
   with constraints; font pairing from approved options. No arbitrary hex on text-bearing surfaces —
   and if a hex input exists at all, it runs a contrast check and **refuses** a failing value with an
   explanation.
4. **Structural** — developer-only, in code and ADRs. Layout, component composition, type scale
   ratio, breakpoints, schema.
5. **Compliance-locked** — code, not settings. Consent gating, quiet-hours enforcement, the
   banned-claims lexicon, the same-gender booking constraint, sender-ID class mapping, and the SEO
   agent's denied publish permission. Anything that can be switched off eventually will be.

### Media as settings

Frontend photos and videos are editable through **named media slots** — hero, therapist portrait,
service card, gallery, testimonial background — each declaring aspect ratio, minimum dimensions,
maximum file size and **required alt text**. Server-side validation rejects a 12MB portrait-orientation
hero rather than silently ruining the page. Editors see the real crop at real breakpoints before
publishing, and a per-page weight budget is enforced at publish time.

---

## 3. SEO and LLM SEO

- Extremely well adapted for **both** conventional SEO and **LLM SEO** — being cited by ChatGPT,
  Claude, Perplexity and Google AI Overviews.
- **Localisation: settings show exactly where the spa is.** One canonical location record — address,
  area, emirate, coordinates, Plus Code, Google place ID, phone, opening hours with Ramadan
  exceptions, parking and access notes, landmarks — driving the `LocalBusiness` JSON-LD, the visible
  NAP, the map embed, the sitemap, Open Graph metadata, the machine-readable facts endpoint and the
  Google Business Profile consistency check. **One source of truth.** No hard-coded address in a
  template, no hand-written schema block — divergence is exactly what makes AI assistants state wrong
  hours with confidence.
- **Automatically kept updated by an SEO agent**, with the LLM provider selectable in settings.

The LLM-SEO requirement reinforces a decision already made: **server-rendered HTML is mandatory.**
Most AI crawlers do not execute JavaScript, so a client-rendered SPA is close to invisible to the
exact channel being optimised for.

The SEO agent stays **propose-only, with publish denied at the permission layer** — not a prompt
instruction, an API permission. "Automatically updated" means the analysis, drafts and prioritised
worklist are produced automatically; a human approves anything that reaches the public. An LLM that
can publish to a live site can also de-index it or publish copy the licence does not permit.

---

## 4. Google review autoresponder

- LLM-generated replies to Google reviews.
- **Provider selectable in settings** — DeepSeek and MiniMax named as candidates.

### Safety routing (not optional in a health-adjacent business)

| Review | Handling |
|---|---|
| 4–5 star, no free text, no named individual | May auto-send after a cooling-off delay |
| 1–2 star | Always escalated to a human. Never auto-sent |
| Any mention of injury, illness, pain, staff conduct, refunds, hygiene, or legal threat | Always escalated |
| Language outside the configured set | Always escalated |

Hard rules for the generator: never confirm that a named reviewer was a client (a confidentiality
breach in this industry), never admit fault or liability, never make a medical claim, never offer a
refund or compensation, never disclose a therapist's name or roster. Review text is **untrusted
input** and may contain prompt injection. Output passes the banned-claims lint before it can be sent
or queued. No clinical or intake data ever enters any LLM prompt.

Template-plus-LLM rather than free generation: a small set of house-voice skeletons with the LLM
personalising specifics. This reduces variance, avoids boilerplate-at-scale (which reads as spam to
both humans and Google), and makes the output lint tractable.

---

## 5. Google account connection

**Confirmed:** the owner signs in with their own Google account via OAuth and grants access to the
specific business.

One connection in settings serves three consumers — review autoresponder, SEO agent, and the
GBP-versus-website consistency checker — off a shared, encrypted token store.

Two things this does **not** solve, and which the plan must handle:

- **OAuth grants authorisation, not API access.** The Google Business Profile APIs are gated
  separately at the Google Cloud project level by an access request that Google reviews. Until
  granted, calls fail regardless of token validity. **[UNVERIFIED — confirm current process.]** The
  draft-and-notify fallback is therefore the launch path for the autoresponder, not a contingency.
  Search Console is **not** gated this way, so the SEO agent can be fully working while GBP access is
  pending.
- **OAuth app publishing status has an operational consequence.** An app left in *Testing* issues
  short-lived refresh tokens, which would stop both agents on a recurring cadence with no obvious
  cause. Moving to *Production* avoids this but may trigger app verification for sensitive scopes.
  A launch-blocking decision, to be resolved during the build rather than after.

**Recommendation to put to the owner:** connect a **dedicated business Google account that owns the
GBP listing**, with the proprietor as a manager — not a personal Gmail. A personal account is a single
point of failure: a password change, a lost 2FA device, or the proprietor leaving breaks both agents.
If they prefer their own account anyway, that is their call; the minimum safeguards are documented
with the design.

---

## 6. Connection health and re-authorisation — confirmed requirement

**The owner must get an easy, unmissable notification to re-login whenever the Google connection
breaks.** Specified as follows.

### Detection

- A scheduled health check on pg-boss (hourly) making one cheap authenticated call per connected
  Google surface.
- Inline detection: any `401` or `invalid_grant` during an agent run marks the connection degraded
  immediately, without waiting for the next scheduled check.

### Connection states

`never_connected` · `healthy` · `expiring_soon` · `degraded` (some scopes failing) · `broken`
(revoked or `invalid_grant`)

### In the admin panel

1. **A persistent banner** on every admin page when `degraded` or `broken` — **not dismissible while
   broken** — with a single **Reconnect Google** button that starts the OAuth flow and returns the
   owner to the page they were on.
2. **A badge** on the Settings → Integrations navigation item.
3. **The Agent Console** shows the real reason per agent — *"paused: Google connection needs
   re-authorising"* — never a generic error.
4. **A connection card** in Settings → Integrations showing the connected account, the selected
   business location, granted scopes, last successful call, next scheduled run, and Reconnect.

### Notifications out of the app

- **Email via Resend to the owner immediately** on transition to `broken`, repeated at 24 hours if
  unresolved, then daily with a cap. Every email deep-links straight to the reconnect screen.
- **Also to the manager role**, so an owner on holiday is not a single point of failure.
- **Optional SMS** (transactional, via SMSala) for `broken` only, since it halts revenue-adjacent
  automation. Off by default; cost is per message.

### Degrade, never silently stop

- Review autoresponder → **draft-only**. Drafts queue for manual posting.
- SEO agent → continues on cached GSC history, skips fresh pulls.
- GBP consistency check → pauses.

Nothing hard-errors, and nothing stops quietly.

### One-click re-auth

The reconnect flow **preserves the previously selected location** so the owner does not re-pick it,
and verifies that location is still accessible. If the Google account being connected differs from
the previous one, warn before overwriting.

### The general rule this is an instance of

The failure mode being designed out is not "the Google token expired" — it is **any agent stopping
without telling anyone.** So:

- Every agent writes a heartbeat: `last_run_at`, `last_success_at`, `next_run_at`, `last_error`.
- A watchdog job alerts when any **enabled** agent has had no success within **2× its expected
  interval**, whatever the cause.
- This catches failure modes nobody predicted — a provider outage, an expired API key, a quota
  exhaustion, a deploy that broke a cron registration, a silent exception.

The same heartbeat and watchdog cover the SEO agent, the review autoresponder, the reminder
scheduler, the campaign sender, the analytics dispatcher, the nightly rollups and the compliance
calendar generator.
