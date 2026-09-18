# External Dependencies — start these now

Every item here has a lead time measured in **weeks** and sits outside engineering control. No
amount of development speed compresses them. The single most common way a project like this slips
is discovering in month four that the SMS sender ID takes three weeks to register.

Start all of them in Phase 0, in parallel with the foundations work.

## Hard blockers

These stop a phase from shipping.

### 1. Licence classification — ask a UAE corporate lawyer
**Blocks:** any public copy going live; the vocabulary lint; clinical retention rules.

Which licence classification applies to the intended service menu: commercial beauty-and-wellness
under the emirate's economic department with municipality health approval, or a healthcare activity
under DHA / DoH / MOHAP? Ask in terms of **your specific service list** — one service can pull the
whole business across the line. In the same conversation ask: which words may and may not appear in
public copy under that classification (specifically *treatment*, *therapy*, *therapeutic*, *pain
relief*, *rehabilitation*, *prenatal*, *lymphatic drainage*); what public titles staff may be given;
and what clinical record retention applies.

*If delayed:* the regulatory profile defaults to the stricter combination. Development continues.

### 2. Health-data residency — same lawyer
**Blocks:** go-live with real client intake data. Also the hosting region decision.

Does Federal Law 2 of 2019 on the use of ICT in health fields apply to our intake and treatment
notes, and if so does it prohibit storing that data outside the UAE? If an exemption route exists,
what does relying on it require? Also: **is the entity registered, or will it be registered, in DIFC
or ADGM?** That replaces the federal PDPL with a different law and regulator, and we cannot design
the privacy layer without knowing which.

*If delayed:* build behind the clinical boundary as planned, and do not load real intake data.

### 3. Same-gender matching — licensing authority + municipality, in writing
**Blocks:** sign-off on the availability engine.

Is there a requirement that therapists serve only clients of the same gender, and are separate male
and female areas or zoned rooms required? Get it in writing. Also ask what hygiene, linen,
sterilisation, waste and water-safety records an inspection expects and in what form, so the
premises log schema matches reality rather than guesswork.

*If delayed:* implemented as configurable, defaulted to same-gender-only, which is the safe position.

### 4. Two SMS sender IDs — SMSala + e& + du, with TDRA rules confirmed
**Blocks:** the first marketing campaign. Transactional messaging can ship without it.

Can we register two separate sender IDs — one transactional, one `AD-` prefixed promotional — under
the same trade licence? What is the registration lead time and document list? What are the current
promotional send-window hours in UAE time, and are there Ramadan variations? How is the national
Do-Not-Call register made available to senders, and who does it bind — us, the aggregator, or both?
Confirm per-message pricing for GSM-7 versus UCS-2 Arabic, and the suspension and appeal process if
a promotional ID is blocked.

*If delayed:* ship transactional-only messaging; hold the campaign sender behind a feature flag.

### 5. Tax invoice requirements — FTA-registered tax agent
**Blocks:** issuing the first invoice.

Confirm VAT registration status and obligation against the AED 375,000 mandatory and AED 187,500
voluntary thresholds; the assigned tax period and filing deadline; the exact mandatory field list for
full and simplified tax invoices and the current Arabic-language requirement; whether our gross-price
rounding rule is acceptable; the VAT treatment and date of supply for gift vouchers versus prepaid
packages; which costs carry blocked input VAT (client refreshments in particular); and the
reverse-charge treatment and record requirements for our offshore suppliers.

*If delayed:* the schema snapshots generously, so late confirmation changes templates, not tables.

## Start early, needed later

### 6. Merchant account and MCC — acquirer / PSP
**Needed for:** Phase 10. **Start in Phase 0 anyway.**

Which merchant category code will be applied, and will you confirm in writing that our activity is
acceptable under it? Realistic onboarding timeline and full document list? What statement descriptor
length and wording are permitted, and can it be changed later? What website requirements must be live
before approval? Is AED settlement standard, and what is the settlement cycle?

**Ask at least two providers** — the answers differ materially for this merchant category, and some
acquirers decline it outright. Knowing the answer early also changes the website, because the
acquirer's reviewer reads the live copy.

### 7. Labour rules — MOHRE-experienced PRO consultant or employment lawyer
**Needed for:** Phase 5, before the first payroll.

Exact profession titles that must appear on therapists' work permits and how they must match the work
performed and the licence classification. Whether an occupational health card, medical fitness test,
good-conduct certificate or screening is required, and at what renewal interval. Current standard
contract term and probation rules. Precise sick-leave tiers and pay rates. Current overtime uplift
percentages and daily cap. End-of-service gratuity formula, service bands, cap and treatment of
unpaid leave. WPS deadline and the file format your bank requires. Mandatory unemployment and
employee health insurance. Headcount thresholds at which Emiratisation obligations begin.

*Retrofitting a leave-accrual engine is expensive — confirm before building it.*

### 8. Corporate tax and e-invoicing — tax agent
**Needed for:** Phase 4 onward; revisit quarterly.

Corporate tax registration status and first tax period. Whether Small Business Relief will be
elected. Which financial reporting basis applies and whether the cash basis is available. Record
retention for corporate tax as distinct from VAT. How payments to the owner and connected persons
must be documented. And the e-invoicing mandate: confirm the dates and thresholds that apply to us,
whether consumer sales are in the first scope, when an accredited provider must be appointed, and
which accredited providers integrate with a custom system.

### 9. Insurance — insurer or broker
**Needed for:** before opening to clients.

Which covers are mandatory under the licence classification and which are commercially essential:
professional indemnity or malpractice, public and premises liability, employer liability and
workmen's compensation, employee health insurance, property and business interruption, and cyber or
data-breach cover given we hold health data. **Ask what incident documentation they require to accept
a claim — that answer defines the incident record schema.** Ask whether cover is conditional on any
hosting location or security control, and what the notification deadline is after an incident.

### 10. Trade licence scope — economic department + municipality
**Needed for:** room configuration at launch.

What does the trade licence permit in terms of room types (wet rooms, hammam, couples rooms), the
number of treatment rooms, and gender-segregated sections? This determines the `rooms` and
`room_types` data and whether a couples room is permitted at all. Not a code blocker; a launch
blocker.

### 11. Promotion permits — licensing authority
**Needed for:** the first discount or prize promotion.

Is a permit required to advertise a discount or run a prize promotion, what does the application
need, and how long does it take? Also whether any health-related advertising permit applies to the
copy we intend to publish under the classification we hold.

### 12. Data protection detail — lawyer or DP adviser
**Needed for:** before launch.

Current status and content of the PDPL executive regulations. Whether registration with the UAE Data
Office applies. Breach notification threshold, recipients and deadline. What the transfer basis for
hosting outside the UAE must look like in writing. Whether a DPIA is required for the intake and
marketing processing. The exact consent wording for marketing and for health-data processing, in
Arabic and English — which we will version and hash.

### 13. Platform verifications — technical, but with queues
**Needed for:** Phases 6 and 8.

Google Business Profile claim and verification (postcard or video verification can take weeks, and
it is the single highest-value local SEO asset). Google Search Console property verification. Meta
Business verification for the Conversions API. Resend sending-domain verification plus SPF, DKIM and
DMARC records, and a warm-up period before any bulk send. **Separate sending subdomains for
transactional and marketing**, so a campaign complaint never kills booking confirmations.

### 14. DigitalOcean specifics — support or docs
**Cheap, but confirm early.**

The current permitted extension list on Managed Postgres — **`btree_gist` in particular, because
double-booking prevention depends on it.** Available regions and their latency from the UAE. Whether
a standby node is available on the intended plan tier. If `btree_gist` is unavailable the concurrency
design changes, so confirm before Phase 1.

## Also needed from the owner, before Phase 1

Not external, but on the critical path and easy to forget:

- The **real service menu** with durations and prices, and which services are online-bookable.
- The **actual room inventory**: how many rooms, which types, which are couples-capable, which
  services each room supports, and realistic turnaround times.
- Current **staff list** with skills, languages, gender and certification expiry dates.
- Current **opening hours**, including Ramadan variations.
- The **existing chart of accounts** and what your accountant expects to receive.
- **Unredeemed gift vouchers and outstanding packages already sold** — these are real liabilities,
  and missing them at migration produces angry customers and a wrong balance sheet.
- Existing customer list for import, and the existing website's URLs for a redirect map.
- Staff **leave balances** as they stand today.
