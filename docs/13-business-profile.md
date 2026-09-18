# Business Profile — extracted facts

The authoritative record of what is known about the business, and the seed source for `legal_entity`,
`premises` and the service catalogue.

**Sources:** the prototype at `berelax.netlify.app`, the live site at `berelaxmassage.com`, and public
search results, all read 2026-09-18. Anything marked **[CONFIRM]** was inferred and needs the owner's
sign-off before it seeds production data.

---

## 1. Identity

| Field | Value |
|---|---|
| Trading name | **BE RELAX — Massage Center and Spa** |
| Legal entity | **BE RELAX SPA - L.L.C - O.P.C** — goes on every tax invoice |
| Tagline | "Come in tense. Leave light." |
| Positioning line | "Rest is not a luxury. It is maintenance." |
| Licence claim | "Fully licensed by Abu Dhabi authorities" — no number published |
| TRN | **[CONFIRM]** — required on every tax invoice |
| Licence number | **[CONFIRM]** |

**Emirate: Abu Dhabi.** So the licensing authority is **ADDED** (Abu Dhabi Department of Economic
Development) plus Abu Dhabi Municipality, and the health regulator is **DoH Abu Dhabi** — *not* Dubai
DET or DHA. [04-uae-compliance.md](04-uae-compliance.md) is corrected accordingly.

## 2. Premises

| Field | Value |
|---|---|
| Address | 250 Al Meena Street, Tower Block A/B, **M-Floor**, Al Zahiyah (Al Mina), E14, Abu Dhabi |
| Area | Al Zahiyah — also known as Al Mina / Tourist Club Area, near the Corniche |
| Parking | "Large public parking available at the back of the building" |
| Opening hours | **Daily 11:00 – 02:00** |
| Facilities | Private rooms with temperature control, **wet-room facilities** (Moroccan bath, jacuzzi), complimentary herbal tea and shower |

### The hours are the single most consequential operational fact

**11:00–02:00 crosses midnight**, which breaks more than the availability query:

- A naive `open_time <= t <= close_time` comparison fails for any slot after midnight.
- A 01:30 appointment belongs to the **previous business day** for cash-up, rota, commission,
  daily reporting and "today" in the owner dashboard. Business day ≠ calendar date.
- Last bookable slot is `02:00 − duration − turnaround`, so a 120-minute treatment must start by 23:40
  at the latest with a 20-minute turnaround.
- Staff transport at 02:00 is a safety matter, and the shift crosses a date boundary for MOHRE
  working-hours and overtime purposes.
- **TDRA's promotional window is 07:00–21:00**, so marketing sends are prohibited during the busiest
  trading hours. Transactional confirmations at 01:00 are fine.

A `business_day` concept is therefore first-class in the data model, not a reporting afterthought.

## 3. Contact — and an existing NAP conflict

| Channel | Prototype site | Live site |
|---|---|---|
| WhatsApp | **052 510 8633** | **+971 52 823 9069** |
| Mobile | 056 342 9399 | +971 56 342 9399 |
| Landline | 02 557 6533 | — |

**The two sites disagree on the WhatsApp number.** This is exactly the divergence that makes AI
assistants state wrong contact details. A single canonical set must be agreed and then lives only in the
`premises` row. **[CONFIRM]** which WhatsApp number is correct.

## 4. Service catalogue — the seed

Style (**Asian** / **Arabic**) is a **treatment-style attribute, not a therapist attribute** (confirmed
by the owner). So a service is the pair `(style × treatment)` — 8 services, each with 4 duration
variants = **32 price points**. Pricing and therapist assignment stay decoupled; style maps to a
**required therapist skill** for eligibility only.

All prices AED, **VAT-inclusive gross** ([01 decision 7](01-scope-and-decisions.md)).

### Asian menu

| Treatment | 45 min | 60 min | 90 min | 120 min |
|---|---|---|---|---|
| Normal Massage | 170 | 200 | 300 | 400 |
| Hot Oil / Balm Massage | 200 | 250 | 350 | 450 |
| Morocco Bath or Jacuzzi | 250 | 300 | 440 | 550 |
| Massage with Shaving | 200 | 250 | 350 | 450 |

### Arabic menu

| Treatment | 45 min | 60 min | 90 min | 120 min |
|---|---|---|---|---|
| Normal Massage | 200 | 250 | 350 | 450 |
| Hot Oil / Balm Massage | 250 | 300 | 400 | 500 |
| Morocco Bath or Jacuzzi | 330 | 380 | 520 | 620 |
| Massage with Shaving | 300 | 350 | 450 | 550 |

### Price on request — and each needs a distinct resource shape

| Service | Resource requirement |
|---|---|
| **Four Hands Massage** | **2 therapists, 1 standard room, 1 client** |
| **Couple Massage** | **2 therapists, 1 double-capacity room, 2 clients** |
| **Full Body Shaving** | Consumables and hygiene protocol; **[CONFIRM]** whether a specific room |

These three are why the resource model is `booking (1) → appointments (n)` with a deferred room-capacity
constraint rather than one appointment per booking.

**Morocco Bath / Jacuzzi requires a wet room**, which makes `service_room_type_compat` load-bearing
rather than defensive — the wet room is a scarce resource and mis-scheduling it is a real failure.

Techniques advertised: **Thai, Arabic, Swedish.**

## 5. Therapists

**19 therapists**, photographs only — no names, credentials, specialisms or languages published.

Per the owner: **names will be set in the backend by the admin.** The build therefore provides display
name, first-name-only option, specialism, languages, credentials and a short bio, and enforces one guard:

> A therapist page is publishable **only when it has a display name and a recorded photography
> consent.** Until then the therapist appears in the team grid as an unlinked photo card.

Without that guard, publishing produces 19 indexed, empty, near-duplicate pages — worse for SEO than
having none.

**"Ladies' therapists available on request"** implies gender matching is **request-based, not strict**,
which contradicts the strict default currently set. **[CONFIRM]** with ADDED / Abu Dhabi Municipality in
writing — see [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) `Y9-gender`.

## 6. The existing web estate

| Property | Platform | Status |
|---|---|---|
| **berelaxmassage.com** | **WordPress + WooCommerce** | **Live.** Services as WooCommerce products. Indexed, ranking category pages: `/product-category/arabic-massage-abu-dhabi/`, `/product-category/thai-massage-abu-dhabi/`, plus `/product-tag/` pages. Nav: Home, Services, Therapists, Contact. Booking is WhatsApp only |
| **berelax.netlify.app** | Static prototype | The design prototype being evolved. Single page, anchors `#about #services #team #gallery #video #reviews #contact`. **Reviews are placeholders** — "swap in your real Google reviews before publishing". No JSON-LD |
| TripAdvisor | — | A listing exists for Be Relax Spa, Abu Dhabi |
| Google Business Profile | — | **[CONFIRM] — status unknown, and it is the longest-lead item in the plan.** GBP API access needs the profile verified and active **60+ days** |

### This reverses an earlier recommendation

[09-ia-seo-and-settings.md](09-ia-seo-and-settings.md) argued against building `{treatment} in {area}`
pages for a single-location business. Those pages **already exist and already rank** on
berelaxmassage.com. So the correct move is **preserve and improve them**, with a 301 for every retired
URL — not delete them. A relaunch without that map loses real traffic.

### Brand collision — a genuine SEO and LLM-SEO problem

**`berelax.com` is an international airport-spa chain called Be Relax, with an outlet at Abu Dhabi
International Airport, Terminal A.** Same name, same city, far greater domain authority.

Asked about "Be Relax Abu Dhabi" today, an AI assistant will most likely describe the airport spa.
Mitigation, which must be consistent everywhere:

- Always the full name **"Be Relax Massage Center and Spa"**, never the bare brand.
- Always paired with the locality — **Al Zahiyah / Al Mina / Tourist Club Area / Al Meena Street**.
- Strong `Organization` + `sameAs` linking the site, GBP, TripAdvisor and social profiles into one entity.
- Target **"massage center Al Zahiyah"**-shaped queries over bare-brand queries, which are unwinnable.
- Track brand-citation accuracy in AI answers as a KPI, and treat "the assistant described the airport
  spa" as a measurable defect.

## 7. Prototype design tokens — the starting point

| Token | Value | Verdict |
|---|---|---|
| Sans | **Jost** 300/400/500/600 | Keep for display; **questioned for body** — see [08](08-frontend-design.md) §3 |
| Serif | **Cormorant Garamond** 300–600 | **Keep** for display |
| Ground | `#FDFAF5` | **Keep** — within a hair of the previously specced `#FCF9F5` |
| Ink | `#26241F` | **Keep** — 14.89:1 |
| Muted | `#6E675D` | **Keep** — 5.36:1 |
| Clay / line | `#E6D8C4` | Keep as surface and hairline only — 1.35:1 |
| **Gold** | `#C08A43` | **2.90:1 — fails even the 3:1 UI threshold.** Decorative shapes only |
| Teal | `#5FB8AC` | 2.26:1 — decorative only |
| Green | `#4E7048` | Keep — 5.40:1 |

The evolved, fully validated palette is in [08-frontend-design.md](08-frontend-design.md) §2 and is
generated and gated by `scripts/palette.py`.

## 8. Still unknown

Everything marked **[CONFIRM]** above, plus: TRN and licence number · the canonical WhatsApp number ·
GBP claim status · room count and room types · whether cross-gender service is permitted · Full Body
Shaving room requirement · real turnaround times · cancellation policy · package definitions and
outstanding balances · staff photography consent · and prices for Four Hands, Couple Massage and Full
Body Shaving.

All are tracked in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) with a provisional value, and none blocks the
build.

---

## 8. The media library, extracted

Every image from the prototype is now in `assets/media/`: **19 staff portraits, 4 interiors, 2 logo
files**. Nothing is stock and nothing is generated. `assets/media/manifest.json` measures each one and
`pnpm media` checks it on every build.

Two measured facts came out of the extraction, and both are work rather than trivia.

**The portraits span aspect ratios from 0.461 to 0.799** — nearly two to one. They are full-length
shots and the face sits in roughly the top fifth of the frame, so a therapist grid at a fixed 4:5 with
a centre crop returns a row of torsos. Every portrait therefore carries a focal point, defaulted to
50%/16% from the framing. Setting them per face is `Y12-photos`.

**There are 19 photographs and 0 names**, which is what the prototype publishes. The build does not
invent them: a therapist page is unpublishable without a display name and a recorded photography
consent ([ADR 0020](adr/0020-regulatory-profile-drives-vocabulary-and-eligibility.md)), so every
therapist renders as an unlinked photo card reading *Name not yet published*. The names are
`Y12-names`, and the consent register is `Y12-consent-photo`.
