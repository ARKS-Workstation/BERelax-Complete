# UAE Compliance — regulation translated into software requirements

Everything here needs confirming by a UAE lawyer, an FTA-registered tax agent, the licensing
authority and MOHRE. Items marked **[UNVERIFIED]** are our current understanding from secondary
sources and must be checked before they are relied on. This document exists so the *software
consequences* are designed in, not so it substitutes for professional advice.

## 1. The licence classification question

This is the most consequential single fact in the project — and because the business is already
operating, **the answer is already on file.** Read the trade licence and any municipality health or
DHA/DoH/MOHAP approval. The table below is what changes depending on which side of the line the
licence sits, so that the software can be configured from the document rather than from guesswork.

| | Commercial wellness | Healthcare activity |
|---|---|---|
| Licensed by | Emirate economic department (DET / SEDD / ADDED) + municipality health approval | DHA / DoH / MOHAP, as a health facility |
| Practitioners | Trade-licence staff | Individually licensed practitioners |
| Public wording | "Treatment", "therapy", "therapeutic", "pain relief", "rehabilitation" likely **not** permissible | Clinical language permitted within scope |
| Records | Commercial retention | Clinical record-keeping duties, longer retention |
| Data residency | PDPL sensitive-data rules | **[UNVERIFIED]** Federal Law 2/2019 on ICT in health fields may prohibit storing UAE health data abroad |
| Inspection | Municipality hygiene | Health authority clinical inspection |

**[UNVERIFIED]** Reporting suggests Dubai requires DHA practitioner licensing for therapists
delivering *therapeutic* massage plus Dubai Municipality health-establishment approval alongside
the DET trade licence, and that Trakhees publishes specific health requirements for massage and
spa premises in its jurisdiction. Treat as indicative; confirm per emirate and per premises.

A single service on your menu can pull the whole business across this line. Ask the lawyer in
terms of **your specific service list**, not in the abstract.

**Software response:** a `regulatory_profile` row carrying `licence_class` in (`wellness`,
`healthcare`, `unconfirmed`), defaulting to `unconfirmed`, which resolves to the **stricter
combination** — wellness vocabulary (conservative copy) plus healthcare-grade retention and data
isolation. The worst case of a late answer is then some copy being more cautious than necessary,
rather than published medical claims under the wrong licence, or health data in the wrong country.

## 2. Data residency

DigitalOcean has **no UAE region**. All personal data, including intake notes, would sit abroad.

- Under a wellness classification the position is arguable: intake data remains sensitive personal
  data under the PDPL requiring explicit consent and safeguards, but the health-sector localisation
  rule may not bite.
- Under a healthcare classification it plausibly does bite, and "we encrypted it" is not a defence
  against a localisation rule.

**Software response:** Frankfurt as the working default, with the **clinical boundary built from
day one** — separate `clinical` schema, its own database role, envelope encryption with keys held
outside the database, UUID-only references and no foreign keys crossing the boundary. Relocating
the clinical store to a UAE-hosted Postgres then becomes about a week of work rather than migrating
the most sensitive table in the system while it is live. Take the residency decision explicitly, in
writing, with legal input, **before launch** — never as the accidental output of a hosting
preference.

Also confirm whether the entity is or will be registered in **DIFC or ADGM**, because that replaces
the federal PDPL with a different law and regulator, and the privacy layer cannot be designed
without knowing which.

## 3. Gender matching

**[UNVERIFIED]** but strongly indicated: UAE municipal and licensing practice commonly restricts
massage so that therapists serve clients of the same gender, with separate male and female areas in
mixed facilities.

**Software response:** a hard constraint in the availability solver, **default strict**, downgradable
to advisory only as an audited configuration change once the authority confirms in writing. If the
requirement applies and the engine cannot express it, the system will routinely generate bookings
the business must cancel by hand, and one non-compliant appointment found at inspection is a licence
risk rather than a scheduling annoyance. Room gender zoning is modelled alongside it.

## 4. VAT and tax documents

- **5% VAT.** Registration mandatory above **AED 375,000** turnover, voluntary above **AED 187,500**.
- **Consumer prices must be displayed tax-inclusive** and the advertised price honoured. This is why
  gross-in-fils is the authoritative stored price (see decision 7 in
  [01-scope-and-decisions.md](01-scope-and-decisions.md)). Storing net produces AED 262.50 prices
  that marketing rounds, silently desynchronising the agreed price, the invoice and the ledger.
- **Tax invoice contents** must be confirmed with a tax agent, but design to carry generously:
  supplier name, address and TRN; sequential number; issue date and supply date; customer details;
  per-line description, quantity, unit price, VAT rate and VAT amount; totals in AED; and the
  **Arabic-language requirement**. Simplified tax invoices for retail below the threshold.
- **Sequential, gap-free numbering** per series, allocated inside the document insert transaction.
- **Credit notes only** for corrections. Never edit or delete an issued invoice.
- **Reverse charge on imported services** — DigitalOcean, Resend, SMSala if billed offshore, Google,
  Meta, Anthropic. Incurred from day one and the most commonly missed obligation at this size.
  Automate it: flag suppliers offshore and run a nightly exception report on bills lacking the
  reverse-charge pair.
- **Blocked input VAT** — entertainment and certain other categories. Needs an account
  classification so it is excluded from recovery automatically.
- **VAT201** is produced as **working papers with drill-down to source documents** and preparer /
  reviewer sign-off. The codebase contains **no auto-file capability** — absent, not disabled,
  because a future maintainer will eventually switch a flag on.
- **Five-year record retention**, which conflicts with PDPL erasure rights. Resolution: erasure
  anonymises the CRM identity and retains the financial record under statutory obligation, recording
  the conflict and the reason.
- **Corporate tax** at 9% above AED 375,000 of taxable income; **Small Business Relief** is elective
  and claimed in the return. **[UNVERIFIED]** reported as extended to tax periods ending on or before
  31 December 2029 — confirm applicability.
- **E-invoicing. [UNVERIFIED]** Our understanding is a Peppol-based accredited-service-provider model,
  pilot from mid-2026, provider appointment for businesses under AED 50m revenue around March 2027 and
  go-live around July 2027, initially scoped to B2B and B2G. Confirm the dates, thresholds, and
  whether consumer sales are in the first scope at all. Revisit quarterly. This is a strong argument
  for routing statutory filing through an accredited package rather than building it.

## 5. SMS, and why it constrains the product

**[UNVERIFIED]** but consistently reported and important enough to design around:

- Sender IDs are registered **separately with e& (Etisalat) and du** — registering with one does not
  cover the other.
- Promotional sender IDs must carry an **`AD-` prefix** and match the registered company name.
- Message templates may need submission and approval.
- Promotional SMS is restricted to roughly **07:00–21:00** UAE time, with Ramadan variations to check.
- Explicit opt-in is required, with a free opt-out; TDRA reportedly requires opt-in proofs to be
  available via a consent management system before a promotional blast.
- A **national Do-Not-Call register** applies; confirm whether it binds you, the aggregator, or both.
- Penalties are cited as high as **AED 400,000** per non-compliant message, and the practical sanction
  is sender-ID suspension.

**Software response**, and the reason this is architectural rather than a settings page:

1. **Two registered sender IDs.** With one, a single over-eager promotional blast suspends the
   identity and every booking confirmation and reminder stops — a marketing decision causing an
   operational outage. Two registrations cost paperwork and remove an entire class of self-inflicted
   outage.
2. **`message_class` is immutable on the template**, and changing it is a privileged, audited action
   that re-triggers approval.
3. **Consent, window and suppression are enforced in the send path as code.** Fail closed.
4. **A marketing kill switch that cannot touch transactional traffic.**
5. **Arabic doubles the cost.** GSM-7 gives 160 characters per segment; a single Arabic character
   forces UCS-2 at 70 (67 concatenated). A "short" 150-character Arabic message is three segments.
   Compute encoding, segments and cost at authoring time and show it to whoever writes the copy.
6. **Alphanumeric sender IDs cannot receive replies**, so "Reply STOP" is non-functional and a
   compliance lie. Opt-out is a link to the preference centre.

WhatsApp is the channel this market actually reads, and both Google and Meta apply heightened
restrictions to massage and wellness advertising — which means owned messaging carries more of the
acquisition load here than it would elsewhere. The template model is therefore channel-shaped from
day one: per-channel variants, category, approval state, and the 24-hour customer-care window as
first-class state. **[UNVERIFIED]** WhatsApp pricing and category rules changed recently; check
current Meta documentation at build time.

## 6. Advertising and content

Under a non-healthcare licence, medical claims are not permissible, and a massage business in the
UAE carries specific positioning sensitivity. Service *names* are themselves claims: "Therapeutic
Deep Tissue Treatment" is a claim, which is why the catalogue carries an internal name and a
separately linted **public display name**.

**Software response — the publication control plane.** Nothing reaches the public without passing:

1. An automated lint against a **banned-claims lexicon** and controlled vocabulary drawn from the
   regulatory profile, plus forbidden staff titles and a check for terms outside the licensed scope.
2. **Named human approval.**
3. An immutable `publication_record` carrying the content hash, linter version, approver and timestamp.

The lint runs over CMS drafts, service display names and descriptions, meta descriptions, therapist
bios, image alt text, message templates, Google Business Profile posts and ad copy. The **SEO agent
is denied publish at the permission layer**, and its keyword expansion is filtered against the
blocking lexicon so non-compliant terms never surface as opportunities.

Also confirm whether a **permit is required to advertise a discount or run a prize promotion**, and
how long that takes, before the first campaign.

## 7. Labour and HR

Under Federal Decree-Law 33 of 2021 and its executive regulations — all figures to confirm with
MOHRE or a labour lawyer:

- MOHRE contracts, work permits, Emirates ID; **the profession on the permit must match the work
  performed** and the licence classification.
- **[UNVERIFIED]** Occupational health card / municipality health card, medical fitness test,
  good-conduct certificate and screening requirements for therapists, with renewal intervals.
- Annual leave **30 calendar days** in the standard case; sick-leave tiers (full / half / unpaid)
  after probation; overtime uplifts and daily caps; weekly rest.
- **End-of-service gratuity** as an accruing balance-sheet liability, accrued monthly.
- **Wage Protection System** salary file, in the format the bank requires.
- Mandatory unemployment insurance and employee health insurance; Emiratisation thresholds by headcount.
- Public holidays are **lunar and announced at short notice** — so the holiday calendar needs
  provisional-versus-confirmed states and an impact report when a provisional date is confirmed
  against already-booked appointments. Ramadan reduced hours are a dated override.

**Software response:** a credential registry with expiry dates that **gates bookable availability**,
a rota validator enforcing working-hours, rest, break and overtime limits, monthly gratuity accrual
posting to the ledger, and field-level encryption plus separate access control on identity document
numbers and bank details, with every read audited.

## 8. Privacy (PDPL)

Federal Decree-Law 45 of 2021. **[UNVERIFIED]** the status and content of the executive regulations
are reported inconsistently; confirm, along with whether registration with the UAE Data Office
applies, the breach notification threshold and deadline, and whether a DPIA is required for the
intake and marketing processing.

**Software response:**

- A **processor register** covering DigitalOcean, Resend, SMSala, Google, Meta, Zoho, Sentry, any
  payment gateway and any AI provider, each with its transfer basis documented. This register drives
  the privacy policy and the deletion logic — it is a working artefact, not a formality.
- **Consent** per channel and per purpose, timestamped, storing the **exact wording version shown**,
  in Arabic and English, versioned and hashed.
- **Data-subject rights as a policy engine**, not a manual process: export, rectification, erasure
  with per-class resolution (anonymise marketing identity, retain the financial record under
  statutory obligation, record the conflict), objection, withdrawal — each with an SLA and audit trail.
- **Retention and legal hold** per data class, with automated purge jobs and a stated position on
  backups, which cannot have individual rows deleted.
- **Health data never enters marketing tooling or analytics.** Enforced by the egress guard and a
  test enumerating every service.

## 9. Premises and inspections

Municipality hygiene inspection records, linen and waste handling, equipment sanitation logs,
water safety, trade licence and permit renewals, insurance renewals, and an incident register.

**Software response:** the premises log and the **compliance calendar**. Obligation definitions
(statutory, recurring or event-driven) generate dated instances with multi-step reminders,
escalation if unacknowledged, and evidence attachment. Some obligations are **blocking**: an overdue
blocking obligation changes system behaviour — a therapist leaves bookable availability, publishing
is blocked, the owner sees a banner. This is the cheapest high-value feature in the whole plan and
it belongs in the first release, not a later hardening phase, because it is exactly what an
inspection asks for.

An **open-compliance-questions dashboard** is driven by the `[UNVERIFIED]` flags in the obligation
table, so unresolved legal questions stay visible in the product instead of being lost in a document
like this one.

## 10. Consumer protection and payments

Price display obligations and honouring advertised prices; cancellation and refund rules;
gift-voucher expiry rules.

For workstream Y (Payments): the **merchant category code** matters. Massage and wellness sit in a category several
acquirers treat as heightened risk, and the classification applied during onboarding — by people
reading your website — can decide whether an account is available at all. Get it confirmed in
writing, ask at least two providers, and note the acquirer will require a physical address, AED
pricing, a refund and cancellation policy, a privacy policy and contact details **live on the site**
before approval. That is a second reason the content lint must exist from the first public page.
A discreet, configurable statement descriptor is a genuine product requirement for this business.
