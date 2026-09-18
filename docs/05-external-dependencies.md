# External Dependencies

**The business is already operating**, which changes the shape of this list considerably. It has a
trade licence, an accountant, insurance in force, staff on visas, a service menu and customers. Most
of what follows is therefore **retrieval from documents already held**, not a discovery project.

Three things genuinely sit in an external queue and are measured in weeks. Start those now. Everything
else is a morning of pulling files together, plus one question for a lawyer.

---

## Part 1 — In an external queue. Start now.

### 1. Two SMS sender IDs — SMSala + e& (Etisalat) + du
**Blocks:** any marketing send. Transactional messaging can ship without it.

Can we register two separate sender IDs under the trade licence — one transactional, one `AD-`
prefixed promotional? What is the registration lead time and document list? What are the current
promotional send-window hours in UAE time, and are there Ramadan variations? How is the national
Do-Not-Call register made available to senders, and who does it bind — us, the aggregator, or both?
Per-message pricing for GSM-7 versus UCS-2 Arabic. And the suspension and appeal process if a
promotional ID is blocked.

Registering with one operator does not cover the other. The reason two IDs matter rather than one is
in [04-uae-compliance.md](04-uae-compliance.md) §5: with a single ID, one over-eager promotional blast
suspends the identity and every booking confirmation stops.

*If delayed:* ship transactional-only messaging; hold the campaign sender behind a feature flag.

### 1b. Google Business Profile API access — the application Google reviews
**Blocks:** programmatic review replies. Does **not** block the SEO agent.

Submit the *Application for Basic API Access* (`support.google.com/business/contact/api_default`) with
the Cloud project number, from an account that is an owner or manager of the listing. Prerequisites:
the profile **verified and active 60+ days**, with a **website representing the business** on it.
Approval is visible as project quota moving **0 → 300 QPM**. **[UNVERIFIED]** timeline — reports range
from days to ~6 weeks.

Two things to do in the same week, because both have their own waiting periods: **establish which Google
account currently owns the listing** (for an operating business, possibly a former agency), and start the
**nine-day refresh-token expiry experiment** in §8 of [10-google-connection.md](10-google-connection.md).

*If not granted by launch:* the autoresponder runs in draft-and-notify mode, which is ~70–80% of the
value and is the designed launch mode rather than a degraded one.

### 2. Platform verifications — Google, Meta, Resend
**Blocks:** workstreams A (analytics), W (web/SEO), S (SEO agent).

- **Google Business Profile** claim and verification. Postcard or video verification can take weeks,
  and for a local massage business this is the single highest-value acquisition asset — it outranks
  the website for discovery. If it is already claimed, confirm access.
- **Search Console** property verification, needed before the SEO agent has any data.
- **Meta Business verification** for the Conversions API.
- **Resend** sending-domain verification plus SPF, DKIM and DMARC records, and a warm-up period
  before any bulk send. Use **separate sending subdomains for transactional and marketing**, so a
  campaign complaint never kills booking confirmations.

### 3. Merchant category code — acquirer / PSP
**Blocks:** workstream Y (payments). Start now anyway; onboarding is slow.

Which MCC will be applied, and will you confirm in writing that our activity is acceptable under it?
Realistic onboarding timeline and full document list? Permitted statement descriptor length and
wording, and can it be changed later? What must be live on the website before approval? Is AED
settlement standard, and what is the settlement cycle?

**Ask at least two providers.** Massage and wellness sits in a category some acquirers restrict or
decline outright, and the classification is decided during onboarding by people reading your live
site. If the business already takes cards on an in-salon terminal, start with that acquirer — an
existing relationship materially shortens this.

---

## Part 2 — Answered from documents the business already holds

A morning's work. No external wait.

| Question | Where the answer is |
|---|---|
| Licence classification — commercial wellness or a healthcare activity | The trade licence itself, plus any municipality health approval or DHA/DoH/MOHAP registration already on file |
| Therefore: permitted public vocabulary, permitted staff titles, clinical retention duties | Follows from the above. See [04-uae-compliance.md](04-uae-compliance.md) §1 |
| Permitted room types (wet rooms, hammam, couples rooms), treatment-room count, gender-segregated sections | The licence and municipality approval. Determines the `rooms` and `room_types` data |
| Same-gender therapist matching requirement | Municipality approval conditions, or current operating practice — the business already knows how it operates. Confirm in writing if the licence is silent |
| VAT registration status, TRN, assigned tax period, filing deadline | The accountant, and the FTA portal |
| Exact tax-invoice format currently issued and accepted | Existing invoices. Compare against [04-uae-compliance.md](04-uae-compliance.md) §4 and have the accountant confirm any gaps |
| Current VAT treatment of vouchers and packages | The accountant. This one is worth asking explicitly — it is commonly got wrong |
| Whether offshore supplier invoices currently carry reverse charge | The accountant. Also commonly missed |
| Mainland, DIFC, ADGM or free zone | Incorporation documents. Determines whether federal PDPL or a free-zone regime applies |
| Insurance cover in force, and what the insurer requires to accept a claim | The existing policy and broker. The claim requirements define the incident record schema |
| Staff visa, labour-card, Emirates ID and certification expiry dates | HR file. These seed the credential registry that gates availability |
| Current contract terms, probation, leave practice, overtime handling | Existing employment contracts |
| Corporate tax registration and Small Business Relief position | The accountant |

---

## Part 3 — One professional conversation worth having

### Health-data residency
**Gates:** loading real intake data, and the hosting region choice.

Do the massage intake notes — contraindications, pregnancy, medication, injuries — count as health
data subject to UAE localisation rules, and if so may they be stored outside the UAE? DigitalOcean has
no UAE region, so the answer decides the hosting architecture.

This is the one item where reading the licence is not sufficient, because it turns on how the intake
data is characterised rather than on what the business is licensed to do. It is a single question for
the company's existing lawyer, not a new engagement.

*If delayed:* the clinical boundary is built from day one regardless (separate schema, separate role,
envelope encryption, UUID-only references, no cross-boundary foreign keys), so relocating the clinical
store is about a week of work. Do not load real intake data before the answer.

### While you are asking, two cheap add-ons
- Is a permit required to advertise a discount or run a prize promotion, and how long does it take?
  Needed before the first campaign, not before the build.
- Confirm the e-invoicing timeline that applies to this business, and whether consumer sales are in
  the first scope at all. Revisit quarterly. See [04-uae-compliance.md](04-uae-compliance.md) §4.

---

## Part 4 — Technical confirmation, cheap and early

**DigitalOcean Managed Postgres:** confirm `btree_gist` is in the permitted extension list — the
double-booking prevention depends on it. Also confirm region availability and that a standby node is
offered on the intended plan tier. If `btree_gist` is unavailable the concurrency design changes, so
check before workstream B starts.

---

## Part 5 — Handover from the owner, before the build starts

Not external, but on the critical path. An operating business has all of this; it needs collecting
rather than deciding.

- The **real service menu** with durations and prices, which services are online-bookable, and which
  require a specific room type.
- The **actual room inventory**: how many, which types, which are couples-capable, which services each
  supports, and honest turnaround times.
- **Staff list** with skills, languages, gender, and certification expiry dates.
- **Opening hours**, including Ramadan variations.
- The **existing chart of accounts** and what the accountant expects to receive each month.
- **Unredeemed gift vouchers and outstanding packages already sold** — with balances and expiry dates.
- **Current staff leave balances.**
- **Customer list** for import, and the existing website's URLs for the redirect map.
- If bookings currently run through an incumbent app (Fresha, Booksy, Zenoti or similar): what the
  export actually contains. Exports are usually incomplete, and reviews and marketplace listings do
  not transfer. Audit this before committing to a cutover date.
