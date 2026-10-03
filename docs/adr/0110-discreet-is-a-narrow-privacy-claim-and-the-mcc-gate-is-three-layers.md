# ADR 0110 — "discreet" is a NARROW privacy claim, and the MCC gate is three layers with no invented value

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** Y-PAY-10
- **Covers:** docs/01 decisions — none; this is the go-live-shaped consequence of
  [ADR 0005](0005-non-production-cannot-use-real-providers.md) (non-production cannot use real providers)
  and [ADR 0022](0022-provider-ports-and-fakes.md) (selection is configuration, and `real` refuses rather
  than degrading), with [ADR 0067](0067-a-pan-never-touched-claim-is-a-scan-that-fails-not-an-assertion-that-passes.md)'s
  rule that an absence is defended by something that FAILS

## Context

Y-PAY-10's title calls the statement descriptor *discreet*. There is no gateway, no merchant account and
no MCC: `PAYMENT_PROVIDER=real` resolves to `notImplemented('card-gateway')`, docs/05 names no acquirer,
and `Y7-mcc` is open. So the unit is a shape plus a refusal — and the word *discreet* turned out to be the
part that needed deciding, because it is a claim made to a customer about what somebody else can see.

## Decision 1 — the privacy claim is narrow, and the module states what it does NOT conceal

**A discreet descriptor conceals WHAT WAS BOUGHT, and nothing else.**
`DESCRIPTOR_PRIVACY_CLAIM` in `packages/core/src/payments/descriptor.ts` is the one sentence a screen may
show, and it says so in both directions: the statement line names the business and not the treatment; it
does not hide that a payment was made, its amount or its date, and it does not hide the business from
anybody who looks the name up.

The reason the negative half is written down, and tested, is that the positive half is the half somebody
would paraphrase. A reassurance wider than the mechanism is worse than no reassurance: a customer who
believed their visit was concealed and then found a recognisable business name on a shared statement was
misled by this system rather than by their bank. `descriptor.test.ts` asserts the claim contains neither
"private" nor "confidential" — a control on the wording, because the wording is the product here.

Four things it cannot conceal are stated in the module header rather than left to be inferred: the fact
and amount of the payment, the business itself (an unrecognisable descriptor produces a dispute, which is
worse for everybody), anything from the acquirer or the schemes (they hold the MCC, which is a category of
business), and anything from somebody with the full transaction history.

## Decision 2 — the blocking lexicon includes the EUPHEMISMS, and matches on word boundaries

`DESCRIPTOR_BLOCKED_TERMS` has three groups: the service words, the catalogue's own style words — `THAI`
on a statement line names a treatment as surely as `MASSAGE` does — and the euphemisms.

The euphemisms are the group worth arguing for. `RELAXATION` and `WELLNESS CENTRE` are read by a
suspicious reader as concealment, and **a descriptor that invites a question has failed at the one thing
it is for.** They are blocked for being worse than the plain words rather than better.

The match is on **whole words over a normalised descriptor**, not on substrings. `SPA` is a substring of
`SPAIN`, `THAI` of `THAILAND`; a substring rule refuses legitimate descriptors, and the way a rule that
refuses legitimate values dies is by being switched off. The punctuation a card network permits is treated
as a separator, so `BR*SPA` and `SPA-AUH` are both caught.

**Y-PAY-10's own manifest entry proposed `BR SPA AUH`, and the lint refuses it.** That is recorded as a
test rather than as an argument: the proposed value contains `SPA`, which tells a shared bank statement
what was bought.

## Decision 3 — neither the descriptor nor its limit is written down, and the sentinels differ

`payments.statement_descriptor` holds `DESCRIPTOR-PENDING-Y7-DESCRIPTOR` — a **marker
`is_placeholder_text()` refuses** — and not a null, because `app_setting.value` is NOT NULL and because
brief rule 15 asks for a marker rather than a blank. `payments.statement_descriptor_limit` holds **0**,
because a number cannot carry a marker and zero is not a legal length.

The asymmetry is deliberate and is the opposite of `payments.deposit_percent_bp`, where 0 IS a legal
policy meaning "no deposit". For a LENGTH there is no such reading, so a coercing reader is safe here and
dangerous there — which is the distinction `readDepositPolicy`'s note makes from the other side.

The limit is a refusal rather than a figure for a reason worth stating: **a descriptor over the limit is
not rejected by a processor, it is TRUNCATED**, and the characters that go are the ones at the end, where
the city and the branch are. An assumed limit therefore produces a valid statement line that is no longer
recognisable — which is the shape a cardholder disputes. 22 characters is true of some schemes and not
others, so it is in `docs/OPEN-QUESTIONS.md` under `Y7-descriptor` and nowhere else.

## Decision 4 — the MCC gate is three layers, and the database layer is SCOPED

| Layer | What it refuses | What it cannot |
|---|---|---|
| `parseConfig` (ADR 0005) | `PAYMENT_PROVIDER=real` outside production | anything about a row — it reads no database |
| `createPaymentGateways` | `real` unless all three MCC columns are present, naming which is missing | a writer that does not go through the registry |
| `ZY771` (migration 0156) | a `payment_intent` against any gateway but `manual-till` and `fake-card-gateway` while `mcc_confirmed_at` is null | nothing — it is the layer that holds when the other two are edited |

**ZY771 is scoped to the gateway, and the scope is the whole reason it is safe.** A blanket refusal would
stop the manual till adapter and the card fake — the only two payment paths that work today — so the rule
names the two gateways this build ships and refuses everything else. A third gateway is then a diff
somebody has to justify, which is the difference between a gate and a convention.

`mcc_confirmed()` is `STABLE` rather than `IMMUTABLE` because it reads a table, which is why ZY771 is a
trigger and not a CHECK: a CHECK may contain neither a subquery nor a non-immutable function, which
migration 0142's header records being refused for twice.

**A confirmation is three facts or none.** The code, the instant and who recorded it move together
(`legal_entity_mcc_confirmation_is_whole`), and `mayUseRealPaymentProvider` names the three refusals
separately, because an operator fixing a go-live needs to know which column is missing rather than that
something is.

## Decision 5 — the go-live check is NOT in `pnpm verify`, and says so

`pnpm go-live:payments` exits non-zero today and is supposed to: **two of the five public-site
prerequisites have no route in this application at all.** There is no `/refunds` and no `/privacy`.

Putting it in `verify` would make every commit fail on a business fact nobody can fix in code, and the
first response to a check like that is to delete it. So it is a human's pre-go-live check, and
`pnpm descriptor-lint` — a claim about the repository, which holds on every commit — is the half that IS
in `verify` and in gate case 29.

The list and the judgement live in `packages/core/src/payments/go-live.ts` rather than in the script, for
the reason `ALERT_REGISTRY` lives in `@berelax/shared`: a list only a script can see is a list no test
holds against anything. `apps/web/src/payments-go-live.test.ts` compares every `route` with the route
registry, which is what makes the two absences a recorded finding rather than unfinished work.

An absent route and an unpublished one are **different states** (`missing` and `unpublished`), and the
second is the more dangerous: the page is there and looks finished. A published page whose premises
address is a placeholder is a third (`no_content`), because a page can exist and say nothing.

## Consequences

- The receipt and statement wording cannot be finished. `Y7-descriptor` now carries both questions — what
  the line says and how long it may be — and the receipt's own copy waits on the first.
- `pnpm descriptor-lint` refuses a descriptor literal anywhere outside three declared sources, so the
  descriptor cannot acquire a second home one plausible default at a time.
- Going live is a list a person reads, with every unmet item named. Nothing on it can be fixed by a deploy.
