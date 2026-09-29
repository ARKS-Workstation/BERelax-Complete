# ADR 0059 — an opaque category code is a property of the whole payload, not of the code

- **Status:** accepted
- **Date:** 2026-09-29
- **Unit:** A-MEAS-01
- **Covers:** docs/01 decisions — none; decision 14 is recorded in ADR 0018 and this is its mechanism,
  standing on ADR 0021 (a service is style × treatment) and ADR 0046 (one funnel vocabulary, one tuple)

## Decision

Five things, and the first one is the only one that was obvious.

1. **Every catalogue thing reaches an external analytics payload as an opaque code**, from one table in
   `packages/core/src/analytics/category-codes.ts`. Codes match `^[A-Z]+_[0-9]{2,}$` and carry no
   natural-language token of what they stand for.

2. **The mapping is total by COMPILATION, and written out rather than derived.** `CatalogueRefKey` is a
   template-literal union over `TREATMENT_STYLES`, `TREATMENT_KEYS` and `SERVICE_DURATIONS`, so
   `CATEGORY_CODE_BY_REF` is a `Record` with no index signature and no default: a fifth duration fails
   `pnpm typecheck` naming that file. The 44 entries are literal, not generated from a counter.

3. **The payload is an ALLOWLIST projection, and every drop is counted.** `buildEgressPayload` walks
   `EGRESS_PAYLOAD_FIELDS` and copies what it names; everything else is returned as a counted
   `EgressDroppedField`.

4. **A figure is carried only for the terminal funnel stage.** Every other event type gets no `valueFils`
   and no `currency`, and the refusal is a counted drop.

5. **The guard is never handed a name.** `CatalogueRef` carries keys and enum members only — no
   `internalName`, `publicDisplayName`, `menuLabel` or `templateKey` — and the branded `EgressPayload` is
   minted by exactly one cast, inside the builder.

## Why the code alone is not the claim

This is the part that decided the unit, and it is not what the acceptance line looks like at first reading.

The 32 prices of docs/13 §4 are **public**. So a `price_viewed` event carrying
`categoryCode: 'SVV_11'` and `valueFils: 32000` hands over one row of the mapping, and a few hundred such
events hand over the menu. The guard would then be substituting an opaque code while transmitting a key to
it, and every assertion about the code's opacity would still pass. Opacity is therefore a property of the
whole payload, which is why the value rule lives beside the builder rather than in a comment beside the
codes — and why the enumerating test asserts the strong form, that **nothing** appears in a serialised
payload except a closed permitted vocabulary, rather than the weak form that no health term does. The weak
form also holds for a payload that leaked a service name instead.

The same reasoning is why `MASSAGE_01` is a worked example in the suite rather than a joke: it satisfies
`^[A-Z]+_[0-9]{2,}$` perfectly. A shape pattern says a code has no lower case and ends in digits; it cannot
say the letters mean nothing. The opacity assertion — zero token overlap against a vocabulary **derived**
from the enums — is a second mechanism, and the first version of that control in the test listed
`MASSAGE_01` as something the pattern should refuse and was wrong.

## Why the assignment is committed source rather than a secret

Anybody with this repository can read which code is which. Pretending otherwise would be theatre, and the
honest consequence is the value rule above: what protects the mapping is that the wire carries no second
signal to correlate a code against, not that the table is hidden.

## Why a prepaid bundle is one category

`package_template.template_key` is an owner-authored snake_case string (migration 0078's
`package_template_key_is_snake_case`), so the set of keys is **open**. A mapping over it could never be
total, and a guard whose mapping can be incomplete has to either throw on a live push or fall back to a
default — and the default is the leak, because it is the branch nobody tests and the one that eventually
carries the key "for debugging". So `CatalogueRef`'s `package_template` member carries nothing at all: the
payload says a bundle was bought and nothing about which one. Where the treatment matters to the push, the
caller has a `variant` ref for it.

`price_on_request` takes the same treatment for a different reason. Its identity in the database is
`menu_label`, which is the public name this unit exists to keep off the wire, so the ref carries the
**footprint** — `shape ?? 'not_modelled'`, which migration 0032's
`price_on_request_shape_matches_modelling` makes a total and name-free projection of a row.

## Why the drops are returned rather than discarded

A projection that drops quietly cannot be told from one that was never handed the field. ADR 0018 makes the
same argument one layer up about ref-capture rate. Here it is the difference between "the dispatcher had
nothing else" and "the dispatcher tried to send a customer's intake answers and the guard removed them" —
the second is an incident, and an incident with no count is one nobody sees.

## Consequences

- **A sixth payload field is a committed diff to one tuple**, and a field added to the builder's candidate
  without being added to that tuple is dropped and counted rather than carried. That is the failure
  direction chosen on purpose: silently dropping a field somebody wanted is a bug report, and silently
  carrying one is a disclosure.
- **The terminal stage's value is an accepted residual.** A settled document's total spans every
  appointment, add-on and bundle on it and includes VAT, so it is not a menu cell — and a conversion push
  with no value is not worth making. This is the one place a figure and a code travel together, and it is
  recorded here rather than left to be rediscovered.
- **A ninth funnel stage moves the dispatchable set and the value rule with it.** `EGRESS_EVENT_TYPES` *is*
  `FUNNEL_STAGES` and the rule reads `FUNNEL_TERMINAL_STAGE`, so there is no second list to update;
  `scripts/check-egress-guard.mjs` refuses a funnel-stage literal in the guard so the derivation cannot
  quietly become a copy.
- **`packages/core` cannot see a catalogue row, so the seeded half is asserted in `packages/fixtures`.**
  `egress-catalogue.itest.ts` holds `enumerateCatalogueRefs()` equal to `service`, `service_variant`,
  `price_on_request` and `package_template` in both directions. Without it the enumerating test iterates a
  list this build wrote about itself, which is ADR 0002's defect.
- **The adapters A-MEAS-03 writes must accept the branded type and declare themselves.** The brand is a
  phantom `unique symbol`, so no object literal satisfies it, and the scan asserts the one mint is inside
  the builder. `DECLARED_ADAPTERS` in that scan is empty today: the day a module names
  `google-analytics.com` or `connect.facebook.net` it has to say so in a diff.
