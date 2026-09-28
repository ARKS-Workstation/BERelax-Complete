# ADR 0048 — the marketing kill switch cannot reach transactional traffic, and its state has one home

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** C-AUTO-05
- **Covers:** docs/01 decisions — none; this is the containment mechanism under ADR 0016 (messaging
  compliance is structural, and two sender identities exist so a marketing sanction is not an operational
  outage), and it sits beside ADR 0040 (the interpreter owns no window) as the second thing the gate is the
  one choke point for

## Decision

Four things, and three of them are refusals to hold a fact in two places.

1. **The switch is read in a function whose parameter cannot be a transactional message.**
   `evaluateGate` answers `allow` for a transactional message and then delegates to
   `evaluatePromotionalGate`, whose `message` is a `PromotionalOutboundMessage`; `killSwitchVerdict` takes a
   `PromotionalOnly`. A transactional message is not assignable to either, so a caller that tries does not
   compile.

2. **The switch's state lives in one row and is resolved at the application edge.**
   `messaging_control.marketing_kill_switch` (migration 0098) is the only home. `GateContext` takes a
   `boolean`, the worker and the console resolve it with `resolveMarketingKillSwitch`, and
   `check-send-chokepoint.mjs` refuses a second writer of the table and a hard-coded value outside the five
   declared transactional-only runtimes.

3. **The environment's answer is computed and not stored.** The kill switch is engaged in every
   non-production environment, by `resolveMarketingKillSwitch` from `APP_ENV`. No row says so and none may.

4. **A kill-switch stop is `held`, not `refused`.** `promotionalSendDisposition` classifies it with the
   window queue and apart from a missing consent record, because one of those answers is *not yet* and the
   other is *no*.

## Why the type rather than the comment

The gate already contained the sentence. `decide.ts` said, in a header paragraph, that transactional traffic
never enters the function's body, and it was true: `evaluateGate`'s first line returned `allow` and the kill
switch was read on the line after it.

That arrangement is one edit from stopping every booking confirmation, reminder and OTP in the system, and
the edit does not look like a mistake. Move the `if (ctx.marketingKillSwitch)` block four lines up — while
tidying, while adding a fifth check, while "checking the cheap thing first" — and every existing test still
passes. The refusal tests assert that a promotional send is refused, which it still is. The containment test
in `fail-closed.test.ts` asserts that a confirmation goes out with the switch engaged, and it is the only
thing in the build that would have caught it, in one file, for one template, by one assertion somebody could
delete for looking redundant. The first evidence in production is a day of customers not being told their
appointments are confirmed, in the hour after somebody stopped a campaign.

So the claim moved into a parameter type. `tsc` refuses the mutation, and the only narrowing in the system is
a value — `{ ...message, messageClass: message.messageClass }` on the branch where the discriminant has
already been narrowed — rather than a cast or a type predicate, both of which would let the wrong class
through if the body were ever wrong.

`OutboundMessage` is deliberately **not** turned into a discriminated union of the two classes. `buildMessage`
in `send.ts` reads the class off a template row, where it is a `MessageClass`, so a union would be
unconstructible there and every call site would need its own narrowing — which is the opposite of one place.

## Why a table and not an `app_setting` row

`app_setting` holds business configuration with a bounded change rule; migration 0087's promotional window is
the example. The kill switch is not that, and this schema already draws the distinction: `agent_definition`
carries both `enabled` and `kill_switch`, and its own comment says why — *"a disabled agent is silent by
design, a killed one is an incident, and the two want different audit stories."*

Three consequences follow, and each is a column `app_setting` could not carry honestly. A toggle has a
**direction** and a **reason**, and both belong on the row a screen reads rather than only in the history
behind it. The tier system would have to classify it, and both available answers are wrong:
`compliance_locked` is owner-only through `assertRoleMayEdit`, which would stop the floor manager engaging
the switch at 22:00, and `operational` would file "stop all marketing" beside a turnaround time. And the
second control the table holds — the promotional sender ID being suspended by TDRA — is not a setting in any
reading. Nobody *configures* a suspension.

## Why the non-production default is computed

A seeded or imported campaign firing during a staging walkthrough is a real promotional SMS to whatever
numbers the fixture holds, and F03's staging send guard is not the answer: it diverts by **recipient
allowlist**, so an allowlisted number in a seeded campaign still goes out.

Seeding `true` into staging's row would look equivalent and is not. It would make staging's row disagree with
production's for a reason no column explains, and — the part that matters — it would be disengageable by an
UPDATE that looks entirely legitimate. The environment's answer is applied on top of the row and cannot be
switched off by a row at all.

## Why DELETE is refused rather than discouraged

`delete from messaging_control where control_key = 'marketing_kill_switch'` is a **disengagement**: the row is
gone, the reader finds nothing, nothing is engaged, and there is no direction, actor or reason anywhere
because no UPDATE happened for an audit row to hang off. Every other way of disengaging writes one. So the
route is not available: `ZY084`, from a BEFORE DELETE trigger, with the grant revoked from `berelax_app`
beneath it.

The same reasoning makes `readMessagingControls` **refuse** a missing row rather than answering "disengaged".
A reader with a default has the switch's state written into it twice, and the default is the permissive one.

## Why the transactional runtimes do NOT read the switch

Five runtimes hard-code `marketingKillSwitch: false` and are allowlisted by name in
`check-send-chokepoint.mjs`: the booking route, the OTP route, the reminder drain, the obligation notices and
the Google re-auth ladder. Every one of them sends transactional traffic only.

Reading the control row there would be worse than useless. `readMessagingControls` refuses a missing row, so an
unreadable marketing control table would stop a booking confirmation — the marketing-problem-becomes-an-outage
failure this whole record is about, arriving through the mechanism meant to prevent it. The second half of the
argument is what makes the allowlist safe rather than convenient: all five wire gate evaluators that **throw**,
because none has a recipient list to prefetch for, so a promotional message that somehow reached one of them is
refused `blocked_unevaluable` before the switch would have mattered.

`apps/worker/src/automation/runtime.ts` is the worked example of a runtime that *can* send promotional
traffic: it reads the row per message, and only for a promotional one.

## Consequences

- **Two places state who may toggle**, and they cannot be reduced to one: the permission matrix in
  `@berelax/core` (`settings:write`) and the SQL literals in `messaging_control_role_may_toggle()`. SQL
  cannot read the matrix. The pair is held equal **behaviourally** — the same eight roles asked of both and
  the answers compared, in `packages/fixtures/src/marketing-kill-switch.itest.ts` and gate case 126d — rather
  than trusted, which is migration 0087's arrangement for the promotional window's ceiling restated.
- **The manager may stop marketing and the owner-only tier does not apply.** That is a deliberate widening
  against `settings:write_compliance`: a switch that needs the proprietor fetched at 22:00 is a switch nobody
  pulls. The marketer holds `campaign:send` and not `settings:write`, so un-stopping their own campaign is
  refused by name.
- **A new `SendResult` kind must be classified deliberately.** `promotionalSendDisposition` throws for a kind
  it has not been taught, because defaulting to `refused` stops owing the recipient a release and defaulting
  to `sent` reports a send that did not happen.
- **The durable `campaign_recipient` row a held recipient becomes is C-AUTO-10's.** What exists here is the
  classification and the conservation property (`held + sent == total`, nobody sent after the flip, nobody
  lost) asserted over a batch driven through `sendMessage`.
