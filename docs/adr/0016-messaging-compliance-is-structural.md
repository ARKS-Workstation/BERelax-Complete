# ADR 0016 — messaging compliance is structural, not configurable

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** H01
- **Covers:** docs/01 decisions 11, 12

## Two sender IDs, because one is an operational single point of failure

UAE SMS goes through TDRA-registered sender IDs, and promotional traffic must use an identity prefixed
`AD-`. The tempting simplification is one registered identity for everything.

With one sender ID, **a marketing mistake becomes an operational outage**. One over-eager blast, one
complaint, the identity is suspended — and every booking confirmation, every OTP, every "your
therapist is running late" stops with it. The business cannot take a booking because someone sent too
many offers.

So: **two separately registered sender IDs**, transactional and `AD-` promotional, with no code path
that can send a promotional message through the transactional identity. The **marketing kill switch
cannot touch transactional traffic**, by construction rather than by care.

## `message_class` is immutable, and lives on the template

Every template is born transactional or promotional and cannot change. The alternative — a class
chosen per send — puts the compliance decision at the least reviewed point in the system, inside a
loop, at 9pm.

Consent, the 07:00–21:00 promotional window, frequency caps and suppression are enforced **in the send
path as code, not as settings**. A setting is a thing someone can turn off at 2am to get a campaign
out. Quiet hours that a manager can disable are not quiet hours. What *is* configurable is bounded:
the window's hours and the weekly cap have ranges, and changing either is audited — see
`packages/config/src/settings/registry.ts`, where a compliance-locked setting refuses to be defined
without an owner-only guard.

## Templates are channel-shaped from day one

WhatsApp Business is not in scope now and is inevitable in this market — it is already the channel the
business actually books on. A template model shaped like an SMS row (one body, one sender) has to be
rebuilt to hold per-channel variants, a category, an approval state and the 24-hour customer-care
window. Rebuilding it means touching every send path in the system.

So the model carries all of it now, with one channel implemented. The cost today is a few unused
columns. The cost of the alternative is a migration through the middle of every message the business
sends.

## Consequences

- Two sender-ID registrations are an **external dependency with a lead time**, tracked in
  docs/05 rather than discovered at launch.
- Outside production, nothing is sent: the guard in `packages/messaging/src/send-guard.ts` diverts
  every message to a visible local outbox, and `packages/config` refuses a real provider unless
  `APP_ENV=production` ([ADR 0005](0005-non-production-cannot-use-real-providers.md)).
- Arabic message bodies carrying a reference, a price or a time go through the isolation helpers in
  `packages/core/src/text/bidi.ts` — an un-isolated `11:00 - 02:00` renders as `02:00 - 11:00`
  ([ADR 0011](0011-documents-render-in-chromium.md)).
