# Runbook — admin access: the first credential, enrolment, and revocation

**W-SYS-11. See [ADR 0039](../adr/0039-the-admin-session-is-an-opaque-token.md) for why none of this is
code.**

A fresh deployment has **no staff accounts**, and there is no default account, no development bypass and no
environment variable that stands in for one. Every sign-in is refused until somebody performs step 2 below.
That is intentional: a built-in account is one nobody rotates because nobody knows it exists.

This document contains **no credential**. Every value below is generated at the moment it is used, by the
person doing it, and nothing in this repository has ever held one.

---

## 1. Before you start

You need:

- a psql connection to the production database as the **owner** role (not `berelax_app`, which cannot
  `INSERT` into `staff_credential` — see step 5);
- the `staff_reference` of the employment record the credential is for. It already exists:
  `select id, staff_reference, employed_from from employee order by staff_reference;`. It is an internal
  handle such as `Therapist 07`, never a person's name (ADR 0020);
- for any role that requires a second factor — **owner, manager, accountant, auditor** — the person
  themselves, with their phone, at the keyboard. You cannot enrol a factor on somebody's behalf and then
  tell them the secret: a shared seed is not a second factor.

> **Do not pick the role for convenience.** `owner` holds every permission including
> `content:publish` and the ability to mint other accounts. Give the narrowest role that lets the person do
> their job; `receptionist` and `therapist` need no second factor and cover the front desk and the
> treatment rooms.

---

## 2. Create the first credential

Generate the password hash and, if the role needs one, the TOTP seed **on the machine, in a shell, and pipe
nothing into a file**:

```
# In the repository, with the workspace installed.
node --input-type=module -e "
  import { hashPassword, generateSecret, totpEnrolmentUri } from '@berelax/auth'
  const password = process.argv[1]
  console.log('password_hash:', await hashPassword(password))
  const secret = generateSecret()
  console.log('totp_secret: ', secret)
  console.log('enrol at:    ', totpEnrolmentUri({
    secretBase32: secret, accountName: process.argv[2], issuer: 'BE RELAX',
  }))
" "<the password the person just chose>" "<their staff_reference>"
```

The password must satisfy `assertPasswordPolicy`: at least 12 characters, with a lowercase letter, an
uppercase letter and a digit. `hashPassword` refuses anything weaker, which is the check happening at the
right moment.

Then insert, substituting the two values:

```sql
insert into staff_credential (employee_id, role, password_hash, totp_secret)
select id, 'owner', '<password_hash>', '<totp_secret>'
  from employee where staff_reference = '<their staff_reference>';
```

Omit `totp_secret` (or pass `null`) for a role that does not require one. For a role that **does** —
owner, manager, accountant, auditor — a null seed means the person reaches
`totp_enrolment_required` at sign-in and **cannot get past it**. There is deliberately no control on that
screen to continue without a code.

Have the person scan the `otpauth://` URI into their authenticator **before** you close the shell, and have
them confirm the app shows a code. Then clear your scrollback.

---

## 3. Check it, and check the refusal

Sign in at `/login` with the staff reference and password. A role with a factor will be asked for a code on
a second screen; a role without one arrives straight at the destination.

Then confirm the two refusals, because a login that works tells you nothing about whether the guard does:

- request any admin path with no cookie — `/compliance`, say — and expect **303** to `/login`;
- sign in, then edit one character of the `berelax_admin` cookie and reload: expect **303** again. The
  token hashes to a value no row holds, so it names nothing.

---

## 4. Revoke access

Ending somebody's access is one statement:

```sql
delete from staff_credential where employee_id =
  (select id from employee where staff_reference = '<their staff_reference>');
```

`staff_session.credential_id` is `ON DELETE CASCADE`, so **every session it granted ends with it** — there
is no separate "sign them out everywhere" step and no revocation list to remember. The next request they
make resolves to no row.

The `employee` row is **not** deleted and must not be: employment is a period (`employed_until`), the
employment record is what the rota and the payroll read, and `staff_credential.employee_id` is
`ON DELETE RESTRICT` specifically so that removing a person's employment record cannot silently take the
record of their access with it.

To end one device's session without revoking the credential:

```sql
update staff_session set revoked_at = now()
 where credential_id = (select id from staff_credential where employee_id =
   (select id from employee where staff_reference = '<their staff_reference>'));
```

---

## 5. Why the application role cannot do any of this

`berelax_app` holds `select, insert, update, delete` on both tables — it must, or nobody could sign in. What
it does **not** have is a screen: nothing in `apps/web` creates, alters or removes a credential, and no
route reads `totp_secret` except the login's own verification.

That is a deliberate gap, not an omission. An account-management screen is the highest-privilege surface in
the system — it decides what every other screen permits — and building it needed a session to protect it,
which is what W-SYS-11 has only just landed. Until a unit owns that screen, minting an account is a
statement somebody types with a record of having typed it.

`berelax_readonly` and `berelax_clinical` can read **neither** table:

```sql
select has_table_privilege('berelax_readonly', 'staff_credential', 'SELECT');  -- false
select has_table_privilege('berelax_clinical', 'staff_credential', 'SELECT');  -- false
```

Both are asserted by `apps/web/src/session.itest.ts`. If either answers `true`, stop and fix the grant
before creating any account: `staff_credential` holds a password hash and a second-factor seed, which is the
one pair that turns a reporting credential into an administrative one.

---

## 6. If the TOTP seed is disclosed

Treat it as a compromised second factor, not a compromised account — the password is unaffected.

1. Generate a fresh seed (step 2) and `update staff_credential set totp_secret = '<new>',
   totp_last_counter = null where employee_id = …`. Resetting the counter is required: the new seed's
   counters start from the current window and a stale high-water mark would refuse valid codes.
2. End their sessions (step 4, the `update`).
3. Have the person re-scan. The old entry in their authenticator will keep producing codes that no longer
   verify, so have them delete it or they will meet a refusal they cannot explain.

The seed is stored in a readable column, and ADR 0039 states why it is not sealed under `STAFF_PII_KEK` —
in short, that key has no rotation command, and an authentication secret behind an unrotatable key is worse
than one behind a revoked grant. Treat this table as a credential store.
