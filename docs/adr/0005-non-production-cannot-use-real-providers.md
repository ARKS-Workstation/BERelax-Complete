# ADR 0005 — non-production cannot use a real provider

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** F03

## Context

Two unrecoverable accidents are possible in this system:

1. **A staging run messages real clients.** You cannot un-send an SMS to someone else's client, and
   for a massage business a misdirected appointment message is a confidentiality incident, not an
   embarrassment.
2. **A development environment burns real Google refresh tokens.** Google invalidates the *oldest*
   refresh token past roughly 100 live tokens per account per OAuth client
   ([docs/10 §4](../10-google-connection.md)). A developer re-consenting fifty times against the
   production client id silently kills production's token.

The manifest's original acceptance criterion for F03 was "separate OAuth client id per environment
enforced by config schema". That is a naming convention, and a convention cannot be enforced by a
schema — nothing stops someone pasting the production id into the staging variable.

## Decision

The configuration schema **refuses to parse** when any provider is set to `real` and
`APP_ENV !== 'production'`. Providers default to `fake`. The refusal names every offending key at
once.

```
SMS_PROVIDER=real is refused when APP_ENV=staging. Only production may use real providers.
```

Separately, the **staging send guard** (`packages/messaging/src/send-guard.ts`) means that even a
correctly configured fake cannot reach an arbitrary recipient outside production: a message goes to a
named `OUTBOUND_ALLOWLIST` entry or it is **diverted to the local outbox**, where it stays inspectable.
`OUTBOUND_ALLOWLIST` must be empty in production, where it would otherwise silently restrict delivery.

Both are **structural, not settings**. There is no flag that disables either, because any flag that
can be switched off eventually is — the same reasoning that keeps consent, quiet hours and suppression
in code ([docs/01 decision 11](../01-scope-and-decisions.md)).

## Why this is stronger than the criterion it replaces

A per-environment client id reduces the blast radius of a mistake. Refusing `real` outside production
removes the mistake. The acceptance criterion in `build/manifest.yaml` was updated to the stronger
form rather than quietly satisfied by the weaker one — see
[docs/12 §4](../12-autonomous-delivery.md) on drift control.

The per-environment client id is still documented in `.env.example`, because it remains correct
practice for production and preview builds.

## Consequence

Every provider adapter added in H02 implements `Transport` and is wrapped by
`createGuardedTransport`. Nothing may call a provider SDK directly, and a diverted message returns
`{ kind: 'diverted', reason, outboxRef }` — never a bare success. That satisfies
[docs/12 §1](../12-autonomous-delivery.md): *a stub must never look like it works*.
