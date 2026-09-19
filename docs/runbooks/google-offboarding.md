# Runbook — offboarding a Google account

Run this when a person or an agency loses access to the business's Google presence: a staff member
leaves, the marketing agency's engagement ends, the proprietor sells, or a personal Gmail is being
retired in favour of the business account.

This is the checklist from **docs/10 §5**, in the order it has to happen, with the step everybody forgets
given a number of its own. Seven steps. Step 1 is automated; steps 2 to 7 are manual, and each one says
why — there is no API for a Business Profile role change, no API for a Search Console user removal, and
the Cloud IAM and client-secret steps are judgements rather than operations.

**Do not skip to step 2.** Removing somebody's Business Profile access while our stored grant still works
leaves a live OAuth token belonging to an account that no longer has a role — and the symptom is not an
error. It is replies posted under an identity nobody can account for.

---

## What this runbook guarantees, and what it does not

Step 1 does two things that are easy to conflate:

1. **It revokes the grant at Google.** `POST https://oauth2.googleapis.com/revoke` with the stored refresh
   token. After it succeeds, no token issued under that grant works — not the refresh token, not the
   cached access token, not a copy of either in a backup, a log, or somebody's clipboard. **This is the
   step that actually protects the business**, and it is why the revocation happens *before* the erasure.
2. **It zeroises the stored ciphertext.** All five sealed refresh-token columns and all six access-token
   columns go to `NULL` in one statement.

The second step's guarantee is narrower than the word "zeroise" suggests, and the narrowness is worth
knowing before somebody promises otherwise to a client or an auditor.

**What is guaranteed after step 1 completes:**

- No `SELECT` against `google_connections` returns any ciphertext, nonce, wrapped data key, KEK version or
  AAD fingerprint for that row, in any encoding. The integration suite proves it by scanning every row's
  bytes in UTF-8, latin-1, hex and base64 without a key.
- The **wrapped data key** is gone with the ciphertext, so the per-row key cannot be recovered even by
  somebody holding the app KEK.
- A **partial** wipe is impossible: `google_connections_refresh_token_complete` and
  `google_connections_access_token_complete` refuse a row with some columns erased and some not.
- The plaintext token is **dead at Google**, so a recovered copy is worthless.

**What is NOT guaranteed, stated plainly:**

- **The old bytes are still on disk until the row is vacuumed.** `UPDATE … SET ct = NULL` writes a new
  tuple version; the previous version holds the ciphertext inside the heap page until autovacuum reclaims
  it, and the freed space is not overwritten. Nothing here issues `VACUUM FULL`, and even that would not
  guarantee the filesystem or the SSD's flash translation layer had overwritten the old blocks.
- **The bytes are in the WAL**, for as long as WAL retention keeps them, and therefore on any physical
  replica.
- **The bytes are in every backup taken before the disconnect**, for the whole backup retention window.
  There is no step in this runbook that removes them, and inventing one would be worse than saying so.
- **The app KEK is not rotated by a disconnect.** Somebody holding the KEK *and* a pre-disconnect backup
  can still decrypt that token.

So the honest statement is: **zeroisation makes the credential unrecoverable through SQL, and the
revocation makes it worthless if it is recovered any other way.** The revocation is the load-bearing half.
If you need the *bytes* gone as well — a contractual erasure obligation, say — that is a backup-retention
and KEK-rotation exercise, and it is not what step 1 does. Record it as its own task.

---

## Step 1 — Disconnect in admin

**Automated:** yes — `disconnectGoogleConnection` in `packages/google/src/disconnect.ts`.

Disconnect the departing account's connection. In order, the disconnect:

1. opens the stored refresh token and calls `POST https://oauth2.googleapis.com/revoke`;
2. **only if Google accounted for the token**, marks the row `status = 'disconnected'` with
   `status_reason = 'manual'`, NULLs all eleven sealed columns, and appends a `revoked` and a
   `disconnected` event — all in one transaction, so the erasure and its record cannot land separately.

Google answers a revocation in one of three ways, and the third is the one to read carefully:

| Google's answer | What happens | What it means |
|---|---|---|
| `200` | `status_reason = 'manual'`, ciphertext erased | We killed the grant. |
| `400 invalid_token` | `status_reason = 'manual'`, ciphertext erased | The grant was **already** gone. Somebody revoked it before you — worth knowing who has been in the account. |
| anything else (5xx, timeout, quota) | `status_reason = 'revoke_failed'`, **ciphertext retained** | The grant may still be live. |

### If the row says `revoke_failed`

The stored ciphertext is deliberately **kept**, because it is the only credential that can still kill the
grant. Erasing it would leave a live token with full `business.manage` authority over the listing and
nothing in this system able to revoke it. The database refuses that combination outright — see
`google_connections_revoke_retry_keeps_its_token` in migration 0040.

What to do:

1. The disconnect enqueues `google-connection.revoke-retry`, which re-calls the endpoint with backoff for
   roughly a day. Most Google outages resolve inside that. Nothing else is needed.
2. **If the reason is still `revoke_failed` after that**, revoke by hand: the departing account signs in at
   `https://myaccount.google.com/permissions`, finds this application and removes it. **Manual, and
   unavoidable** — a revocation needs either the token (which is the thing that is failing) or the
   account holder, and an account holder who has already left is exactly why you should not let this sit.
3. Run the disconnect again afterwards so the ciphertext is erased and the reason becomes `manual`. A
   second revocation is safe: Google answers it with `invalid_token`, which reads as *already dead*.

**Verify:** the connection reads `Disconnected` in the settings panel, `status_reason` is `manual`, and
the `disconnected` event is in the connection's history with your name on it.

---

## Step 2 — Remove the account from the Business Profile

**Automated:** no — the Business Profile API has no user-management surface. Roles are changed in the
Business Profile UI only, and Google imposes a waiting period that no API would shorten.

Two sub-steps, **and the order between them is not negotiable.**

### Step 2a — Transfer Primary Ownership

There is exactly one **Primary Owner** of a listing, and **the Primary Owner cannot be removed.** If the
departing account holds that role, removing them is simply not an option the UI offers, and a runbook that
told you to try would strand you here.

So: transfer Primary Ownership to the business account (`google-admin@berelax.ae`) first. The recipient
must **already** be an Owner or a Manager, and Google imposes a waiting period before a newly added Owner
can be promoted — historically seven days, unverified (docs/10 §5). **That waiting period is why this step
starts the week the offboarding is planned, not on the day somebody leaves.**

If the departing account is only an Owner or a Manager, not the Primary Owner, this sub-step is a
no-op — confirm that in the UI rather than assuming it.

### Step 2b — Remove the account as a Business Profile user

Only now. Remove the departing account from the listing's users.

**Verify:** the listing's user list shows the business account as Primary Owner and does not list the
departing account at all.

---

## Step 3 — Remove from Search Console users

**Automated:** no — the Search Console API exposes no user management, and our grant requests
`webmasters.readonly` deliberately (docs/10 §3), so it could not perform a write here even if one existed.

Remove the departing account from the property's users and permissions.

While you are there: confirm the property is verified by **DNS TXT on Cloudflare** and not only by a
file, a tag or an account-based method belonging to the departing account. Domain verification is the one
method that survives losing any individual Google account — if the property was verified *through* the
account you are removing, removing it takes the SEO history with it.

**Verify:** the departing account is absent from *Settings → Users and permissions*, and the verification
list shows a DNS TXT owner.

---

## Step 4 — Remove from the GA4 property

**Automated:** no — and it will stay that way. docs/10 §7 recommends against building the GA4 Data API at
all: it adds a Sensitive scope for capability the owner already has in the GA4 UI. There is no integration
here to automate from.

Remove the departing account from the GA4 property's access management, at the account and the property
level — access can be granted at either, and removing one leaves the other.

**Verify:** *Admin → Property access management* and *Admin → Account access management* both no longer
list the account.

---

## Step 5 — Remove from Google Cloud project IAM

**Automated:** no — Cloud IAM is outside every API this system holds a grant for, and a token that could
change IAM would be a far larger credential than anything this application should ever store.

**This is the step everybody forgets, and it is the most consequential one after step 1.**

An account with a role on the Cloud project can edit the **OAuth client** and the **consent screen**. That
means it can:

- read or rotate the client secret;
- add its own redirect URI and mint tokens against our client id;
- change the consent screen's publishing status back to **Testing**, which silently gives every refresh
  token a seven-day fuse (docs/10 §4) — a failure that presents weeks later as *"it worked when we tested
  it and stopped the following week"*, with no correlated deploy;
- and remove or revoke the Basic API Access approval the project holds, which took weeks to obtain.

Remove every role the departing account holds on the project, including `Owner`, `Editor`, and any
`roles/serviceusage.*` or `roles/oauthconfig.*` binding. Check **inherited** roles at the organisation and
folder level too: a project-level removal leaves an organisation-level binding in place, and the console
shows the effective role rather than making the inheritance obvious.

**Verify:** *IAM & Admin → IAM* with *Include Google-provided role grants* on, filtered by the account,
returns nothing — at the project **and** at the organisation.

---

## Step 6 — Rotate the client secret

**Automated:** no — rotating the secret is a Cloud console action, and deciding whether to is a judgement
about what the departing account ever saw.

Rotate if the departing account **ever** had access to the OAuth client secret: a role on the Cloud
project (step 5), a copy in a shared password manager, a screenshot in a chat thread, or an environment
file on a laptop they still hold. If you cannot establish that they never saw it, rotate — the cost is one
configuration change and the alternative is a client secret of unknown custody.

Rotating invalidates nothing that is already stored: the client secret authenticates *our application* to
Google's token endpoint, not the grant. Existing refresh tokens keep working once the new secret is
deployed. Update `GOOGLE_OAUTH_CLIENT_SECRET` in production and confirm the next token refresh succeeds
before closing this step.

**Verify:** the old secret is deleted in the Cloud console (not merely superseded), and
`google-connection.liveness` reports the remaining connections alive on its next hourly pass.

---

## Step 7 — Audit the sequence

**Automated:** no — the evidence is automated, the reading of it is not. Confirming that a removal in
Google's UI actually happened cannot be done from here; only our own half is queryable.

Read back what happened, in order, and check it against this runbook:

```sql
select occurred_at, action, actor_label, after_state
from audit_event
where entity_type = 'google_connection'
  and occurred_at >= now() - interval '7 days'
order by occurred_at, id;
```

The `google_connection.revoked` and `google_connection.disconnected` rows are mirrored automatically from
`google_connection_events` by a trigger in the same transaction as the event, and both tables are
append-only — an `UPDATE` against `google_connection_events` raises rather than silently doing nothing.
So the record of step 1 cannot be edited after the fact, including by whoever performed it.

Then confirm, by hand, that no connection is left in an unfinished state:

```sql
select id, google_email, status, status_reason, refresh_token_ct is null as zeroised
from google_connections
order by id;
```

Every offboarded row must read `disconnected` / `manual` / `zeroised = true`. A row reading
`revoke_failed` is step 1 unfinished — go back to it. A row still reading `active` for an account you have
just removed from the listing is the dangerous state this runbook exists to prevent: a live grant with no
role behind it.

Finally, write down what you could not verify. Steps 2 to 6 leave no trace in this system, so the only
record that they happened is the one you make here.
