# ADR 0072 — the consent floor is a REFUSAL, and the migration ledger stages a keyed digest rather than the number

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** H-MIG-04
- **Covers:** docs/01 decisions — none new. It is the enforcement-shaped record of docs/11 §7's rule
  ("imports with `marketing_consent = false` on every reconstructed record, without exception") and of
  docs/04 §5 and §8 (the opt-in proof TDRA requires before a promotional send, and the exact wording shown,
  stored and hashed), and it is the enforcement-shaped consequence of
  [ADR 0014](0014-phone-first-customer-identity.md) (the number is the identity)
  meeting [migration 0056](../../packages/db/migrations/0056_consent.sql)'s append-only consent log, and it
  records the decided answer to **Y9-import-ledger**, which
  [ADR 0061](0061-an-import-is-resumable-per-row-and-provenance-is-a-reference.md) left open for this unit.

## Decision

**Three things, and the first two are one decision seen from two sides.**

1. **The consent floor is the ABSENCE of a consent row, and it is enforced as a refusal.** A GRANTED
   `consent` row whose `capture_source` is `'import'` is refused by the database (`ZY271`, migration 0121)
   for every purpose that gates a send. No `marketing_consent` column is added anywhere.
2. **A reconstructed contact list stages a KEYED DIGEST of the number and never the number.**
   `import_row.payload` carries `HMAC-SHA256(json(value), SUPPRESSION_PEPPER)` under this unit's own key
   kinds, plus the pepper's label, the consent claim as a boolean, and — for a line that could not be read
   — the reason. The plaintext lives in exactly one place, `customer.phone_e164`.
3. **E.164 for identity is a different question from E.164 for sending.** `e164IdentityResult` in
   `@berelax/core` normalises a landline and a toll-free line to their `+971` form and reports them as
   unmessageable; `normalisePhoneResult` beside it goes on refusing them, because its callers are send
   paths.

## Why the floor is a refusal and not a flag

docs/11 §7 states the rule and nothing enforced it. The obvious implementation is the one H-MIG-04's own
manifest entry describes — `marketing_consent = false` with no option on the importer to change it — and it
is wrong twice.

**There is no such column, and adding one would be the defect.** Migration 0056 made consent an
append-only log of (channel × purpose × instant × wording version), for reasons its own header gives at
length. In that model "no marketing consent" is the absence of a row: not a `false`, and specifically not a
`withdrawn` row either, because nobody withdrew anything and nobody was ever asked — 0056's own comment on
`consent_kind` says a row claiming nothing happened "is a row a later reader treats as a decision". A
boolean beside the log would be a second statement of what the log already holds, and the first time the
two disagreed the flag is the one a send path would read, because it is the cheaper read.

**An importer's options type is not where a rule like this can be kept.** "The importer exposes no option
to change this" is a true and useful claim about one module, and it is falsifiable by a later unit, a job, a
one-off `psql` session or a corrected re-import, none of which touch that module. The only enforceable
statement of an absence is a refusal.

What makes an imported grant false is worth being precise about, because the precision is what keeps the
rule narrow. `consent_wording` holds only the statements this system published and SHOWED; 0056 requires a
grant to name one (`consent_grant_carries_its_wording`); and a contact rebuilt from a chat thread was shown
none of them. So an imported grant is a record claiming words were read that nobody displayed — which is
exactly the artefact docs/04 §5 says TDRA asks a promotional sender to produce, and exactly the one that
would not survive being asked about. The rule therefore reads the purposes from
`consent_purpose.is_send_gating` rather than listing them again, `clinical_processing` and `photography` are
untouched, and a WITHDRAWAL captured by an import is permitted, because it only ever restricts sending and a
list saying "these people asked us to stop" must be importable without argument.

## Why the ledger stages a digest

`Y9-import-ledger` was recorded by H-MIG-01 with a provisional answer — "stage a minimised payload rather
than delete evidence later" — and the question handed to this unit, because it is the first importer to
carry personal data. The facts it turns on:

- `import_row.payload` is kept for ever. It is append-only (`ZY192`) and no role holds DELETE anywhere in
  `import_staging`, by design: the payload is the copy of row 214 that was actually imported, and it is what
  an imported figure rests on when it disagrees with what somebody believes.
- `payload` is `jsonb`, and none of C-CRM-10's five catalogue probes can see inside one. So a phone number
  there is not retained against an obligation. It is **unreachable**: an erasure cannot remove it and the
  coverage check cannot even report it.

For a package liability the minimised payload is a real answer, because the payload is a set of figures and
the identifier is one field of it. For a contact list the payload IS the identifier, so minimising the
fields is not enough and the number does not go in at all.

**The obvious alternative was to stage the number and accept that the ledger is not erasable**, which is
what the provisional answer permits. It fails on the thing C-CRM-10 claims: an erasure "replaces the CRM
identity with a stable pseudonym", and that claim would be false for every imported customer, silently,
with the coverage check green because no probe reads a `jsonb` column. The second alternative — a retention
period on the ledger, or a redaction of the payload — needs a migration and a decision nobody has made
about how long migration evidence may be kept, and `ZY192` permits no UPDATE, so a redaction is a new
migration either way.

The digest is the answer that needs no migration and loses nothing the ledger is for. It answers both
questions the ledger has to answer — "is this the same row I already imported" and "which customer did line
214 become" — and stops answering only "what number was on line 214", which the file itself answers and
which the business holds anyway. It is also a position this build has already taken: C-CRM-10 keeps
`suppression.key_hmac` through an erasure on purpose, because a keyed digest of a number discloses nothing
and deleting it would make the person messageable again.

It is peppered for 0064's reason, unchanged: the UAE mobile space is small enough to enumerate
exhaustively, so an unpeppered hash of a mobile number is a phone number with extra steps.

## Why `contact_hmac` is called `_hmac`

`CREDENTIAL_COLUMN_PATTERN` in `packages/db/src/privacy-coverage.ts` matches a column name ending `_hmac`,
so C-CRM-10's fourth probe enumerates this column and the erasure engine REFUSES to run until
`rights-policy.ts` classifies it. A column called `phone_digest` would have been invisible to all five
probes — which is the accident `Y9-import-ledger` is about, arriving one level up. The name is the thing
that makes the decision reviewable by somebody who never reads this file.

## Why identity and SMS targeting are separated

H-MIG-04's acceptance names two local Abu Dhabi spellings that must normalise: `052 510 8633` and
`02 557 6533`. The second is a landline, and `normalisePhoneResult` refuses it by name
(`landline_not_an_sms_target`) — correctly, because every caller of that function is a send path or an OTP
path, and a code sent to a landline is a customer waiting for a message that is never coming.

A customer whose contact number is a landline is still a customer, their record is still keyed on the
number, and `customer.phone_e164`'s CHECK accepts `+97125576533` perfectly happily. Widening
`normalisePhoneResult` would have made every send path attempt an SMS to a landline; refusing the row would
have dropped real customers out of the list; repairing the number into mobile shape would have put a
balance on somebody else's record. So the two answers are separated, the digit FOLDING is shared
(`phoneTokens`, so there are two readings of a UAE number in this repository and not three), and
`identityAgreesWithSendNormaliser` plus a census holds the two functions in the only relationships they are
allowed to have.

## Consequences somebody will have to live with

- **A pepper rotation costs idempotence.** The framework decides "already imported" on the content hash of
  the payload, so a re-import after a rotation stages different digests and applies every line again. No
  duplicate customer and no consent either way — the unique index on `customer.phone_e164` is the real
  dedup and the digest is only the forecast — but the ledger gains a second record per line, saying
  `matched`. Asserted directly in `packages/fixtures/src/customer-import.itest.ts` rather than left as a
  caveat.
- **The customers importer is not in `IMPORTERS`.** A registered importer is constructed in a module-level
  frozen array and can have read nothing; this one needs the pepper (a secret, reaching the application
  through `packages/config`, which `packages/migration` may not import) and the normaliser (in
  `@berelax/core`, which it may not import either). Built without them it would have to stage the plaintext
  or throw. The door is `scripts/migrate-contacts.mjs`, and `registry.ts` says so where somebody enumerating
  the registry will see it.
- **An imported contact's record stops resolving to a person after an erasure**, because the digest is
  recomputed from `customer.phone_e164`. That is the decision working rather than a limitation: the evidence
  that an import happened survives, and the identifier does not.
- **A lawfully collected external opt-in list now needs a migration.** docs/11 §7 contemplates "a one-time
  opt-in campaign only if your lawyer confirms a lawful basis for it". Under `ZY271` that import requires
  the external wording to be published as a `consent_wording` version and this trigger to be dropped or
  narrowed. That is the intended cost: a mass import of marketing consent should be a migration somebody
  argues for, not an INSERT.
- **No name, no locale and no note is imported**, and a contact list holds all three. `customer.display_name`
  stays null until an admin enters one (ADR 0020), the locale stays the column's default because a guess
  would be a preference nobody stated, and free prose about a person staged into a ledger nothing can erase
  is the estate this whole decision is about. If the business wants the names, it is a column on the file
  and a decision about ADR 0020 — recorded as deferred rather than guessed.
