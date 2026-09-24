# Runbook — key and secret rotation

Every secret in `build/secret-inventory.json` points at a heading in this file, and
`pnpm rotation` fails the build if one of them does not exist. So this is the procedure, not a
summary of one: if it is wrong, the rotation is wrong.

**Read this first.** Rotation changes which key is *in use*. It does not reach backwards. See
[What rotation does not cover](#what-rotation-does-not-cover) before you tell anybody an exposure is
closed.

---

## Rotating the clinical KEK

The clinical key-encrypting key wraps one data key per record. Rotating it **re-wraps the data keys
and rewrites no ciphertext**, which is why it is a background job and not an outage: a few dozen bytes
move per record instead of every intake form being re-encrypted.

### Before

- Confirm who is on call. The job is safe to kill, but a half-finished rotation needs somebody to
  notice that it is half-finished.
- Take the baseline checksum. It must be unchanged afterwards:

  ```
  pnpm rotate:kek --verify
  ```

  Record `contentChecksum`. Ignore `rotationChecksum` for now — that one is *supposed* to change,
  because it includes the key version.

  `--verify` decrypts every record in memory to prove it is readable. That is the only operation in
  this system that holds a clinical payload outside a request, so do not run it on a shared screen and
  do not run it in a terminal that is being recorded.

- Check what is on which version:

  ```
  pnpm rotate:kek --plan
  ```

  Every record should be on one version. If they are not, an earlier rotation did not finish; finish
  it before starting another one, because the job carries exactly two keys and cannot re-wrap a third.

### Rotate

1. Generate the new key. 32 random bytes, base64:

   ```
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

2. In the secret store, **move before you replace**:

   | Variable | New value |
   | --- | --- |
   | `CLINICAL_KEK_PREVIOUS` | the current `CLINICAL_KEK` |
   | `CLINICAL_KEK_PREVIOUS_VERSION` | the current `CLINICAL_KEK_VERSION` |
   | `CLINICAL_KEK` | the new key |
   | `CLINICAL_KEK_VERSION` | the next label, e.g. `v2` |

   Setting `CLINICAL_KEK` without moving the old pair to `…_PREVIOUS` is the one mistake that cannot
   be undone by trying again: nothing else in the system holds the old key, and the records still
   sealed with it stop being readable. The version label is not decorative — it is how a row says
   which key opens it.

3. Run it:

   ```
   pnpm rotate:kek
   ```

   It prints one line per record and a summary naming both versions and the record count. It writes
   two `audit_event` rows: `clinical.kek_rotation.started` before the first record moves, and
   `clinical.kek_rotation.completed` at the end. A `started` with no `completed` is the only evidence
   that a rotation was interrupted — the rows themselves look identical either way.

4. **If it dies**, for any reason: run it again. Every record's re-wrap committed on its own, and the
   work queue is the query "rows not yet on the new version", so a second run continues rather than
   restarting. It reports the records an earlier run already moved as `alreadyCurrent`.

### After

```
pnpm rotate:kek --verify
```

- `contentChecksum` **must equal** the baseline. A rotation changes no content; if this moved, stop
  and escalate — do not rotate again on top of it.
- `rotationChecksum` **must differ** from the baseline, because the key version is in it. If it did
  not change, nothing moved.
- Only now remove `CLINICAL_KEK_PREVIOUS` and `CLINICAL_KEK_PREVIOUS_VERSION` from the secret store.
  Keeping them is harmless; removing them early is not.

### If a record will not re-wrap

The job stops, names the record, and leaves everything it already did committed. Two causes:

- **`ClinicalDekUnwrapFailed`** — the supplied previous key is wrong, or that row's identity no longer
  matches the AAD its data key is bound to. The second is a payload that was copied onto another
  customer's row: the AAD is `table | record id | customer id`, so a copy cannot be decrypted and
  cannot be re-wrapped either. That is a security event, not a rotation problem. Quarantine the row
  and resume.
- **`KekVersionNotRetained`** — a row is on a version that is neither the source nor the target, so a
  retired key was discarded too early. The rotation cannot fix it. Find that key.

---

## Rotating the Google token KEK

Same shape, different boundary and a **different key** — `GOOGLE_TOKEN_KEK`. Two keys rather than one
is deliberate: the clinical store is designed to relocate to a UAE-hosted database and takes its key
with it (ADR 0010), and a Google client-secret incident must not force a re-wrap of every clinical
record.

Move `GOOGLE_TOKEN_KEK` to `GOOGLE_TOKEN_KEK_PREVIOUS` exactly as above, then re-wrap every
`public.google_connection.refresh_token_ct` with `rewrapRefreshTokens` from
`packages/google/src/rewrap.ts`. It is idempotent on a second run and stops loudly on a connection
sealed with a third version.

**There is no CLI for this yet** — that function has no caller. Until there is, this rotation is a
one-off script somebody writes on the day, which is a worse position than the clinical one is in. It
is recorded as a NOTE on H-HARD-03 in `build/manifest.yaml`.

A re-wrap does **not** ask the owner to re-consent, and that is the whole reason `refresh_token_kid`
exists: a rotation that needs the owner in a browser is a rotation that never happens, which makes
the key permanent.

---

## Rotating the staff PII KEK

Same shape again, a third boundary and a **third key** — `STAFF_PII_KEK`. It seals the staff bank
accounts (`public.employee_bank_detail.detail_ct`) and the identity-document numbers
(`public.employee_document.number_ct`) of migration 0050. Three keys rather than two for the reason
there are two: an **employment record does not relocate with the clinical store**, so sealing it under
`CLINICAL_KEK` would either strand `employee_bank_detail` the day the clinical schema moves to a
UAE-hosted database (ADR 0010, `Y5-residency`) or require the clinical key to exist in two places.

Move `STAFF_PII_KEK` to `STAFF_PII_KEK_PREVIOUS` and its version label with it, exactly as for the
clinical key, then re-wrap every sealed staff row with `rewrapStaffSecret` from
`packages/hr/src/staff-secret.ts`. It returns **only** the wrapped key and the version label, because
those are the only two columns migration 0050 lets an `UPDATE` touch:

```sql
-- what a re-wrap writes, and all it may write
update employee_bank_detail
   set detail_wrapped_key = :new_wrapped_key, detail_kid = :new_version
 where id = :id and detail_kid = :old_version;
```

The `detail_kid = :old_version` predicate is the optimistic lock: if another run has already moved the
row, the `UPDATE` matches nothing and says so rather than overwriting a key this process does not hold.

Two refusals come from the database and not from the code driving it, so they hold even if that code is
wrong (migration 0050):

- `StaffSealedRowImmutable` (SQLSTATE **ZS002**) — the `UPDATE` touched a column outside
  {`detail_wrapped_key`, `detail_kid`, `superseded_at`}. A re-wrap never rewrites a ciphertext.
- `StaffRewrapDidNotRewrap` (SQLSTATE **ZS003**) — the version label changed and the wrapped key did
  not. That is the bug that labels a row with a key which cannot open it.

**There is no CLI for this yet**, and the estate has **no `kek_version` registry** either, so nothing
refuses a retired key for a new `INSERT` the way `clinical.kek_version` does. Both are recorded as
NOTEs on P-HR-01 in `build/manifest.yaml`. Until they exist this rotation is a script somebody writes
on the day — a worse position than the clinical one, and the same position the Google token KEK is in.
Verify it by reading every row back through `openBankDetail` and `openDocumentNumber` under the new
key before the old one leaves the secret store; a row that will not open names itself
(`StaffSecretOpenFailed`, with the table, the row id and the version and never any part of the payload).

An `Emirates ID cannot be rotated.` If this key is believed to be compromised together with a database
dump, the numbers are disclosed permanently: the people they belong to cannot be issued new ones
because a key leaked. That is why the read path audits every decrypt with a declared purpose and why
there is no plaintext column anywhere in either table — the controls that matter here are the ones
that run before a leak, not the rotation after it.

---

## Rotating a Google refresh token

Not a re-wrap. The token itself is a durable bearer credential for control of the business Google
presence, and replacing it needs the owner to consent again in a browser.

1. Revoke the current grant in the Google account's security settings. The connection reports
   `needs_reauth` from the next refresh attempt onwards.
2. Have the owner walk the consent flow again from the integrations settings page.
3. Confirm the connection is healthy and the capabilities are back.

Use a **separate OAuth client per environment**. Re-consenting repeatedly against the production
client id silently invalidates the oldest refresh tokens — there is a limit of roughly a hundred per
account (docs/10 §4), and nothing warns you.

---

## Rotating the Google OAuth client secret

Google allows two secrets on one client at a time, so this is zero-downtime if it is done in this
order:

1. Add a second secret in the Google Cloud console. Do not delete the first.
2. Set `GOOGLE_OAUTH_CLIENT_SECRET` to the new one and deploy.
3. Confirm a token refresh succeeds.
4. Delete the old secret in the console.

Stored refresh tokens survive: they are bound to the client **id**, not the secret.

---

## Rotating the database credential

Not zero-downtime. A managed-database password change is immediate and drops every open connection,
and the application picks up the new URL only when it is redeployed.

1. Announce it. Trading runs 11:00–02:00 Asia/Dubai, so the window is narrow.
2. Change the password in the DigitalOcean control panel.
3. Update `DATABASE_URL` in the secret store and redeploy.
4. Confirm the application reconnects, and confirm the backup schedule still runs — a backup job
   configured with the old credential fails silently until somebody needs a restore.

The database credential is **not** either KEK. Somebody holding a dump plus this password has the
clinical ciphertext and cannot read it, which is the entire point of the envelope (ADR 0010).

---

## Rotating the Payload secret

Not zero-downtime, in a small way: it signs admin session tokens and password-reset links, so every
session and every unsent reset link dies the moment it changes. Nobody is locked out permanently.

1. Tell the admins they will be signed out.
2. Replace `PAYLOAD_SECRET` and deploy.
3. Sign in again and confirm TOTP still challenges.

---

## Rotating the Sentry DSN

1. Create a new client key in the Sentry project.
2. Replace `SENTRY_DSN` and deploy.
3. Confirm an event arrives, then delete the old key.

A leaked DSN grants write access, not read. The damage is a flooded project, and a flooded project is
one nobody reads.

---

## Rotating the suppression pepper

`SUPPRESSION_PEPPER` is the HMAC key behind `suppression.key_hmac` (C-CRM-04, migration 0064). It is
not a KEK: nothing is encrypted with it, nothing can be decrypted from it, and losing it does not make
a single row unreadable. What it does is make the stored list of opted-out contact details
irreversible, and that is the whole reason it is not in the database.

1. Generate a new pepper and keep the old one:
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.
2. Move the current values into `SUPPRESSION_PEPPER_PREVIOUS` and
   `SUPPRESSION_PEPPER_PREVIOUS_VERSION`, set the new ones in `SUPPRESSION_PEPPER` and
   `SUPPRESSION_PEPPER_VERSION` (bump the label — `v2`), and deploy. Reads consult both peppers, so
   nothing stops matching at this point and there is no window in which a suppressed recipient becomes
   sendable.
3. Re-key what can be re-keyed. `rekeySuppressionKeys` walks `suppression` rows whose `pepper_version`
   is the retired label, finds the plaintext recipient the row is about through
   `customer.phone_e164`, and INSERTs an equivalent row under the new pepper. It is an INSERT and never
   an UPDATE, because the table refuses UPDATE for every role including the owner (ZQ001).
4. Remove `SUPPRESSION_PEPPER_PREVIOUS` only when `rekeySuppressionKeys` reports nothing left to move
   **and** you have accepted step 5.

### What this rotation cannot recover, and why that is the design working

A row whose plaintext recipient this system no longer holds cannot be re-keyed. There is no way round
it and it is not a defect: the table deliberately holds no plaintext, so the only source for a
re-derivation is a `customer` row carrying the same detail. The rows that cannot move are:

- a `hard_bounce` for an address with no `customer` record — `customer` has no email column at all
  (C-CRM-01's NOTE 3), so **no** email suppression can be re-keyed today;
- a `dnc_register` entry for a number that has never booked;
- a suppression for a contact whose `customer` row has since been erased under PDPL, which is the
  case the whole append-only design exists to survive.

So the retired pepper is **retained indefinitely** unless the business accepts losing those entries,
and that acceptance is a decision somebody records rather than a step in a runbook. Do not delete
`SUPPRESSION_PEPPER_PREVIOUS` to tidy the environment: a deleted retired pepper turns every row keyed
under it into a row nothing will ever match, which presents as a promotional message sent to somebody
who opted out — the exact failure this area exists to prevent, arriving months after the change that
caused it, with nothing to point at.

---

## What rotation does not cover

Rotating a KEK changes which key is used **from now on**. It does not reach into anything already
written, and an UPDATE to a live table is a much smaller act than it looks:

- **Backups and snapshots.** Every backup taken before the rotation still holds data keys wrapped
  with the old KEK. Restore one and it needs the old key. So a KEK rotation performed because the key
  was exposed does **not** close the exposure until every backup sealed under it has aged out of
  retention — and until then the old key must be retained to read them, which means it still exists.
  This is the single most important sentence in this runbook.
- **Write-ahead log and replicas.** WAL segments and any standby hold the pre-rotation wrapped keys
  until they are recycled. Point-in-time recovery to a moment before the rotation lands you on the old
  key.
- **Vacuumed heap pages.** An `UPDATE` in PostgreSQL writes a new row version and leaves the old one
  in the page until vacuum reclaims it, and reclaiming it returns the space for reuse rather than
  overwriting it. The old wrapped key is recoverable from the raw device for an unbounded period.
- **Anything that was decrypted.** A rotation re-wraps keys. It says nothing about a payload that has
  already been read — a `--verify` run, a support export, a screenshot.
- **Anything that cannot be reissued.** For `STAFF_PII_KEK` the asymmetry is worse than for the other
  two. A Google refresh token can be revoked and a database password changed, so for those a rotation
  ends the exposure once the backups age out. An Emirates ID, a passport number and an IBAN cannot be
  reissued because a key leaked, so a disclosure of that estate is permanent no matter how promptly the
  key is rotated. The controls that matter for it are the ones that run before a leak: no plaintext
  column, an audited decrypt with a declared purpose, and field-level authorisation.

What rotation **does** give you: after it completes and the old key is destroyed, a *future* dump of
the live database is useless to anybody holding only the old key. That is a real and worthwhile
property. It is not the same as "the exposure is closed".

If a KEK is believed to be **compromised**, rotation is step one of several. The others are: shorten
or purge the backup retention that still depends on it, plan for the WAL, and treat every record that
existed before the rotation as potentially read. Deciding that is an incident, not a runbook step.

### And the other direction

Rotation is also the thing that makes a *routine* key lifetime possible at all. A key that cannot be
rotated cheaply is a key that is never rotated, and a key that is never rotated is one that has been
sitting in every deploy log, CI environment and developer shell for years. `rotatePeriodDays` in
`build/secret-inventory.json` is the declared lifetime for each one.
