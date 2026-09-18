# Blind Spots and Risk Register

The brief asked us to think of things it did not include. This document is that answer. Items are
grouped by theme, and each says what to do rather than only what to worry about.

---

## A. Where bookings actually come from

**A1. The website is the smallest channel.** For a local massage business, booking volume arrives
roughly in this order: walk-ins, phone calls, WhatsApp, Instagram DMs, Google Maps, then the
website. The brief specifies a web booking engine and says nothing about the first four. A plan that
perfects the web form and ignores the phone has optimised the smallest channel.
**Do:** make staff-side quick-book as fast as the web flow (workstream B (Booking)), treat Google Business Profile
as a first-class booking surface with the booking link installed and UTM-tagged, and put WhatsApp on
the roadmap rather than treating it as an extra.

**A2. Nobody has specified who answers the phone.** Missed calls are lost revenue and currently
invisible. **Do:** log call outcomes against the customer record, and consider call tracking so
phone bookings are attributable. A "how did you hear about us" field is the cheap attribution
fallback for everything that never touched the site.

**A3. The front desk is the product.** If the new system is slower than the paper diary at 6pm on a
Thursday, staff will quietly stop using it and the data will rot. **Do:** treat "book a walk-in in
under 10 seconds" as a hard performance requirement with a stopwatch acceptance test, not a
nice-to-have.

**A4. Rebooking at checkout is the single biggest revenue lever in the industry** and it is not in
the brief. **Do:** a rebooking prompt is part of the workstream M (Money) checkout flow, and rebooking rate is a
headline KPI.

---

## B. Operational constraints the software must respect

**B1. Room turnaround is not a therapist buffer.** Linen change, cleaning and airing occupy the
*room* after the client leaves. Conflating the two either over-books rooms or silently wastes ~15
minutes of capacity per treatment. Modelled separately in workstream B (Booking).

**B2. Therapist fatigue is a real capacity limit.** A therapist cannot deliver eight hours of deep
tissue. **Do:** per-service physical-load weighting and a daily cap in the rota validator, otherwise
the schedule will look feasible and the staff will burn out or call in sick.

**B3. Laundry and linen throughput constrains bookings.** If you have 40 linen sets and a daily
laundry cycle, that is a hard ceiling regardless of what the calendar says. **Do:** a simple stock
model, and visibility of consumption per job so loss is detectable.

**B4. Professional-use consumption is a cost, not a sale.** Oils, creams and linens used on clients
must be expensed, not treated as retail stock movements. Separate stock categories from workstream M (Money).

**B5. Lunar public holidays are announced at short notice.** **Do:** provisional-versus-confirmed
holiday states, plus an impact report showing which already-booked appointments a newly confirmed
holiday affects.

**B6. Ramadan and the summer exodus change demand materially** — reduced hours, shifted evening
demand, and a genuinely quiet July/August. Any forecast that assumes a flat year will be wrong
twice annually. Built into the workstream R (Reporting) seasonality model.

---

## C. Money: where the numbers go wrong quietly

**C1. Vouchers and packages are liabilities, not revenue.** Selling AED 10,000 of gift vouchers in
December is not December revenue. Getting this wrong overstates profit, misstates VAT timing, and is
discovered during a VAT reconciliation when it is already historical.

**C2. Unredeemed vouchers already sold are a migration problem.** They are real, enforceable
liabilities held by real customers. Miss them at cutover and you get angry clients and a wrong
opening balance sheet. On the workstream F (Foundation) data-collection list.

**C3. Reverse-charge VAT on imported services** — DigitalOcean, Resend, Google, Meta, Anthropic —
incurred from day one and the most commonly missed UAE obligation at this size. Automated as a
nightly exception report in workstream M (Money).

**C4. End-of-service gratuity is an accruing balance-sheet liability**, not a surprise payment when
someone leaves. Accrued monthly in workstream P (People).

**C5. Contribution margin per service will surprise you.** Once therapist commission and room-hour
cost are loaded, some services on most spa menus are barely profitable and a few lose money.
Discount culture makes it worse. workstream R (Reporting) produces this; it usually changes the menu.

**C6. No-show and late-cancellation cost is invisible until measured.** A 10% no-show rate on a
full book is a double-digit percentage of revenue. Measured from workstream M (Money); addressable with deposits
in workstream Y (Payments).

**C7. Tips are politically and fiscally awkward** — cash versus card, pooled versus individual,
pass-through rather than revenue. Decide the model *before* card payments are designed, because
retrofitting tip distribution into settlement reconciliation is unpleasant.

**C8. Commission is where staff disputes happen.** Rules versioned, calculations reproducible,
therapist-visible derivation. A commission number a therapist cannot check is a number they will
not trust.

**C9. Price-change audit trail.** "You charged me AED 400, the website said 350." You need to know
what the price was on that date and who changed it. Effective-dated prices plus an audit log, from
workstream B (Booking).

---

## D. Data protection and confidentiality, specific to this business

**D1. The association of a named person with a massage appointment is itself sensitive**,
independently of any health note. This shapes several concrete product decisions rather than being
an abstract concern.

**D2. What appears on a lock screen.** An SMS preview reading "Reminder: your Deep Tissue massage
with Maria tomorrow at 3pm" is visible to anyone holding the client's phone. **Do:** discreet
message templates by default, with the detail behind a link. Same logic for calendar invite titles
and, later, the card statement descriptor.

**D3. A receptionist should not be able to read clinical notes.** Field-level authorisation, not
route-level. Built into the workstream C (CRM) clinical boundary.

**D4. The insider threat is the realistic breach.** A therapist leaving with the client list is more
likely than an external attacker. **Do:** every client-list export is logged *and alerted*, export
permission is narrow, and the audit log is separate and tamper-evident.

**D5. Therapist relationships are a commercial risk.** Clients often follow a therapist who leaves.
**Do:** make the *business* own the relationship data — preferences, history, and a house rebooking
flow — so a departure is survivable.

**D6. "Prenatal massage" as a GA4 item name is a health disclosure to Google.** The egress guard and
its enumerating test exist for exactly this.

**D7. A server-side conversion push that ignores consent is a compliance hole** that client-side
consent banners hide. Consent gates both paths in workstream A (Analytics).

**D8. Staging emailing real customers** is the classic disaster. A hard environment guard is in
workstream F (Foundation), not later.

**D9. Backups cannot have individual rows deleted.** Erasure requests need a stated, documented
position on backup retention rather than an implied promise the system cannot keep.

---

## E. Safety, conduct and legitimacy — still relevant in-parlour

Dropping outcall removed the lone-worker problem but not these.

**E1. A client blocklist that actually blocks**, across phone, email and later card fingerprint, so
a barred client cannot simply rebook online. Staff safety depends on it being enforced in the
booking path, not a note on a record.

**E2. An incident register** with structured categories, timestamps, who was notified, and
**immutability once filed** — because it is a legal and insurance artefact. Your insurer will tell
you exactly what they need to accept a claim; that answer should define the schema.

**E3. A therapist's right to terminate a session**, with a recorded reason and a fee policy, and a
private "do not book me with this client again" flag the scheduler honours without exposing it to
the client.

**E4. Versioned client conduct and consent acknowledgement** at booking, storing which version was
shown. This protects both parties if an allegation is ever made in either direction.

**E5. Chaperone, draping and professional-boundary policy** as records the system holds, because an
inspection or an insurer will ask.

---

## F. Things absent from the brief entirely

**F1. Retail product inventory and supplier ordering.** Retail attachment is a standard spa revenue
line and needs stock, COGS, reorder points and stock takes (workstream M (Money)).

**F2. Corporate and hotel wellness contracts.** A recurring B2B revenue line most owners discover in
year one — needs contract rates, consolidated monthly invoicing and a referral code. Not built, but
the model should not preclude it.

**F3. Memberships.** Different economics from packages (recurring revenue, breakage, churn) and a
different recognition pattern.

**F4. Equipment maintenance and permit renewals** — beds, hydrotherapy equipment, insurance, trade
licence, municipality permits. Covered by the compliance calendar, which is why it is in the first
release.

**F5. Shift handover notes and internal task management.** What the evening shift needs to know from
the morning shift currently lives in a WhatsApp group.

**F6. Notifications to *staff and the owner*, not just customers.** Rota published, leave approved,
overdue obligation, revenue below forecast, a VIP booking arriving.

**F7. Admin quality-of-life that determines whether the system is liked:** global search across
everything, undo, bulk edit, saved views, keyboard shortcuts, an activity feed.

**F8. Hardware.** Receipt printer, cash drawer, tablet at reception, barcode scanner for retail.
Decide before workstream M (Money) whether the checkout targets a tablet or a desktop; it changes the UI.

**F9. Offline tolerance.** The salon's wifi will drop mid-checkout. What happens? At minimum, an
honest error state and a paper fallback for the first fortnight after go-live.

**F10. What happens when SMSala is down** and confirmations stop. Queue, retry, alert, and a visible
"messages delayed" banner for staff so they can phone clients instead.

**F11. Reviews as an operational workflow**, not a marketing idea: solicit after a good visit,
route unhappy feedback privately first, respond to every public review. Google Maps reviews dominate
local acquisition for this business — more than the website does.

**F12. Accessibility.** WCAG 2.2 AA, and a date/time picker that works with a screen reader, which is
notoriously hard. It is also a legal exposure, not only a courtesy.

**F13. Licensing the platform to other spas.** You have not raised it, but a working spa platform is a
sellable asset. It does not change the build — but it does argue for keeping domain logic in a
framework-free `core` package, which the architecture already does.

---

## G. Programme risks

**G1. SEO migration, if a website already exists.** A redesign launched without a full pre-launch
crawl, a 301 redirect map and a monitoring window routinely loses **30–50% of organic traffic**, and
it takes months to recover. **Do:** baseline crawl before workstream W (Web) touches anything; preserve URL
structure where it ranks; map every retired URL.

**G2. Migrating off an incumbent platform.** If bookings currently run through Fresha, Booksy or
similar: exports are usually incomplete, reviews and the marketplace listing do not transfer, and the
Google Business Profile booking integration may be tied to it. Audit what actually comes out before
committing to a cutover date.

**G3. The honest buy-versus-build question.** Fresha, Zenoti, Booksy, Phorest and Mindbody already do
perhaps 80% of workstreams B, M and C for a monthly fee. The defensible argument for building is that you need the
gender-matching constraint, your specific room model, your intake flow, UAE-shaped accounting and one
owned dataset joining bookings to money to marketing — none of which you can get from a closed
platform, and all of which are what the last six phases depend on. That argument is real. It is worth
stating explicitly so the decision is deliberate rather than assumed. If budget or time compresses,
the pragmatic fallback is to run an off-the-shelf booking product for a year while building Phases 2,
4, 5 and 7 around it.

**G4. Bus factor of one.** The largest programme risk. Mitigations are in the plan for this reason:
ADRs, tests on every money path, a written runbook set, and no undocumented infrastructure.

**G5. Scope creep across nine modules.** Each phase has a stated business outcome precisely so a
feature that does not serve one can be challenged.

**G6. Legally mandated upkeep does not stop when the build does.** VAT rule changes, the e-invoicing
mandate, visa expiry logic, WhatsApp policy changes. Budget maintenance time from day one.

**G7. Founder attention.** Running a spa while building software is the real constraint. The phase
order is chosen so that the earliest phases reduce the owner's daily workload rather than adding to it.

---

## H. Risk register

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | Health-data residency answer requires UAE hosting after launch | Critical | Clinical boundary from day one; relocation is ~1 week, not a rewrite. Do not load real intake data before the answer |
| 2 | Licence classification mis-read from the existing licence | Medium | Regulatory profile makes vocabulary and retention data, not code, so a correction is a config change |
| 3 | Gender-matching rule not reflected in the engine | High | Hard constraint, default strict, in workstream B. The business already knows how it operates — capture current practice, then confirm in writing |
| 4 | Promotional sender ID suspended, stopping booking confirmations | High | Two separately registered sender IDs; class-locked templates; marketing kill switch cannot affect transactional |
| 5 | Double-booking under concurrency | High | `btree_gist` exclusion constraint + deferred room-capacity trigger + row lock + property-based tests |
| 6 | Stale reminders after reschedule or cancellation | High | Invalidation keys on every scheduled step; tested as an invariant |
| 7 | Revenue/VAT misstated by voucher and package treatment | High | Deferred revenue model with the VAT event separated from recognition, from workstream M (Money) |
| 8 | Staff reject the system as slower than paper | High | Front-desk speed as a measured acceptance criterion; super-user per shift; parallel run |
| 9 | Client list exfiltrated by an insider | High | Export logging and alerting; narrow permissions; separate tamper-evident audit log |
| 10 | Health data leaks to Google/Meta | High | Egress guard with an enumerating test; consent gating on both client and server paths |
| 11 | Organic traffic lost at site relaunch | High | Pre-launch crawl, 301 map, post-launch monitoring window |
| 12 | Merchant account declined for the MCC | Medium | Start acquirer conversations in workstream F (Foundation); ask two providers; site copy lint live from the first page |
| 13 | `btree_gist` unavailable on DO Managed Postgres | Medium | Confirm in workstream F (Foundation); fallback is advisory locks plus serialisable transactions |
| 14 | SEO agent publishes something non-compliant | Medium | Publish denied at the permission layer; keyword filtering; fetched content treated as untrusted data |
| 15 | Accounting module drifts from FTA rules over time | Medium | Statutory filing integrated to an accredited package; no auto-file in the codebase |
| 16 | Duplicate customer records corrupt journeys and balances | Medium | Merge as a first-class operation re-pointing consents, suppressions, enrolments and ledgers |
| 17 | Scope overruns the calendar | Medium | Integration milestones M1–M7 surface slippage early; workstreams M, P, A and R parallelise; flex list in 00-plan.md §10 |
| 18 | Arabic RTL invoices and PDFs prove painful late | Low–Medium | Prove RTL PDF rendering in workstream F (Foundation), not workstream M (Money) |
