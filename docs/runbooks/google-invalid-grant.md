---
id: google-invalid-grant
title: Google invalid_grant: the refresh token has stopped working
unit: H-HARD-06
trigger_kind: external
trigger: A Google call has failed with invalid_grant, so the stored refresh token no longer works and every Google capability is unavailable until somebody consents again.
first_action_heading: 1-confirm-it-is-invalid_grant-and-not-a-quota
first_action: Confirm the failure really is invalid_grant and not a quota, an unapproved allowlist or an unverified listing, because only invalid_grant needs a human to consent again.
owner: owner
escalation: Re-consent is a human act at Google and nothing in this build can perform it; there is nobody else who can, because the Google account is the owner's.
alerts: (none)
env: GOOGLE_PROVIDER, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
---

# Runbook — Google `invalid_grant`

## What `invalid_grant` is, and what it is not

`invalid_grant` means the **refresh token** is no longer usable. The documented causes are a token that
was revoked, one that expired, and — the one that catches people — a token issued by an OAuth client
still in *Testing* publication status, which Google ages out after seven days.
`packages/providers/src/failure.ts` lists it alongside the five other Google failures it is routinely
mistaken for, and telling them apart is the whole of section 1, because only this one needs a person at
a browser.

There is no read-only variant of the scope this build holds, so a working refresh token is a durable
bearer credential for control of the business's Google presence. That is why `pnpm chokepoint` exists
and why nothing in this runbook asks you to copy a token anywhere.

## 1. Confirm it is `invalid_grant` and not a quota

```
psql "$DATABASE_URL" -c "select id, google_email, status, status_reason, last_ok_at, last_checked_at from google_connections order by updated_at desc"
```

| `status_reason` names | What it is | Does a human have to consent again? |
|---|---|---|
| `invalid_grant` | The refresh token is dead. | **Yes.** Section 2. |
| `quota_exhausted` | A daily API quota is at zero. | No. It resets. |
| `access_not_granted` | The Business Profile API allowlist is not approved. | No. That is an application to Google. |
| `not_verified` | The listing is not verified with Google. | No. That is a verification, not a grant. |
| `admin_policy_enforced` | A Workspace admin has restricted the service. | No. That is an admin setting. |

`apps/worker/src/jobs/google-connection-health.ts` is the pass that sets `status` and `status_reason`,
so the row is the system's own reading rather than an interpretation of a log line. A connection in
`needs_reauth` is this case; `revoked` and `disconnected` are deliberate and are
[the offboarding runbook](google-offboarding.md).

## 2. Re-consent, which only a person can do

1. **Do not delete the connection row.** Its ciphertext is what the revoke retry needs, and a row parked
   in a failed-revoke state must keep it. Deleting the row loses the audit trail of a grant that
   existed, and `google_reviews.connection_id` is `ON DELETE RESTRICT` anyway, so the delete will be
   refused and the refusal will look like a different bug.
2. **Re-consent through the admin screen**, with the Google account that owns the Business Profile. The
   OAuth client id and secret are unchanged; it is the user's grant that has lapsed, not the client.
3. **Check the scopes that came back.** `granted_scopes` on the row is what was actually granted, and a
   re-consent that dropped a scope presents later as one capability failing rather than as a consent
   problem. `google_capabilities` is what resolves a capability to a connection.
4. **`last_ok_at` moving** is the confirmation. A `status` of `active` with an old `last_ok_at` is a row
   somebody set and nothing has exercised.

## 3. While it is broken

Everything Google-shaped is unavailable and the build is designed for that rather than surprised by it:
reviews are not fetched, the Business Profile is not read, and the Search Console snapshot does not run.
`apps/worker/src/jobs/google-reauth-notify.ts` is what tells somebody, through
`google_reauth_notice`, so the state is surfaced rather than discovered.

Two things not to do:

- **Do not rotate the OAuth client secret to "fix" it.** The client secret is not the problem, and
  rotating it invalidates every other grant issued under that client. `docs/runbooks/key-rotation.md`
  owns that procedure and it is a different incident.
- **Do not set `GOOGLE_PROVIDER=fake` to clear the errors.** The fake succeeds, which marks the
  connection healthy against a provider that is not Google, and the real grant stays dead with nothing
  saying so.

## 4. If the token was revoked deliberately

Then this is not an incident: somebody offboarded an account, and
[the offboarding runbook](google-offboarding.md) is the procedure — including the five steps in Google's
own consoles that nothing in this build can verify. `apps/worker/src/jobs/google-revoke-retry.ts` is
what retries a revoke this system could not complete, and its id is recorded so an operator reading
`pgboss.job` can see which disconnect asked.

## What this build cannot tell you

**Which of the three causes of `invalid_grant` it was.** Google's response does not distinguish a revoked
token from an expired one from a Testing-status token aged out at seven days, and this build records what
it was told rather than a guess. If the OAuth client is still in Testing, expect this runbook every week
until it is published — and that is a Google console setting, recorded under `Y13-pentest`'s neighbours
in [OPEN-QUESTIONS](../OPEN-QUESTIONS.md) rather than anything in this repository.
