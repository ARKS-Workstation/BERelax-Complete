# ADR 0051 — a private document is fetched through one route, against a detached signature

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** W-SYS-14
- **Covers:** docs/01 decision 5 — the authorisation matrix, applied to the documents this build files. The
  bucket split it rests on is docs/08's security boundary, and the adapter half is the prohibition in
  docs/12 against a stub that looks like it works.

## Decision

**Every private document this build produces is registered in one table, fetched through one route, and
authorised by three checks in a fixed order: the staff session, a detached HMAC signature over the document,
and the authorisation matrix. The signature authorises a FETCH and never a principal. A document whose
content is clinical or salary is single-use, and the replay is refused by the DATABASE.**

The signature is verifiable **without the provider**: an HMAC this application computes and checks, carried
in the query string, over a canonical description of the document. The bytes still come out of whichever
storage adapter is configured, and the adapter does not decide who gets them.

## What was there before

`writeTaxDocumentPdf()` took a `path` and called `writeFileSync`. A filed tax invoice — the issuer TRN, the
customer, every line and every figure — was readable by anybody who learned the path, and nothing recorded a
read. `MediaStorage` exposed `put`, `head`, `get` and `list` and no signing verb. There was no document route
to refuse an unsigned request from.

That was not an oversight by one unit. M-TILL-12's NOTE deferred private storage and the signed URL to
M-TILL-13 and M-VAT-11; both went `status: done` and neither ever owned storage — M-TILL-13 built the till,
cash-up and package screens, M-VAT-11 the compliance calendar. W-SYS-05 recorded the absence of an adapter
as `[no-real-media-storage-adapter]`. So the capability was deferred to three finished units and owned by
none, which is the fourth instance of that defect in this build.

## Why a detached HMAC rather than a presigned provider URL

DigitalOcean Spaces presigns the way S3 does, and such a URL can only be checked by the service that holds
the bucket credential. Three consequences, each disqualifying:

1. **Every refusal becomes one third-party 403 with an XML body.** "This link expired" and "somebody is
   guessing" would be the same fact — and the acceptance criterion this unit exists for is precisely that
   they must not be, *because the two are different facts to whoever reads the log: one is a stale link, the
   other is somebody guessing.*
2. **The permission check could not happen at all.** A presigned URL is followed by the browser directly to
   the bucket. Nothing of ours is in that request, so the authorisation matrix never runs — and "a valid
   signature is not permission" is the other acceptance criterion.
3. **There is no real adapter to presign with**, and ADR 0005 forbids `real` outside production anyway. A
   scheme that needed one could not be tested, which under ADR 0002 means it could not be believed.

So the signature is ours. `verify` is a pure function of the query string, the document id in the path and a
key ring this process holds.

## Why an HMAC rather than a stored grant, when M-VAT-11 chose a stored grant

M-VAT-11 built a stored grant for `obligation_evidence`, and its header argues the case well: no fourth
signing secret to rotate at 02:00, revocable by `DELETE`, and the row records who asked. Every one of those
arguments is correct. This unit takes the other side for a different problem, and the difference is worth
stating because the two schemes now sit next to each other in the same codebase.

**The replay defence has to be a database row either way.** A single-use link cannot be enforced by a
read-then-insert in TypeScript: that is two statements, and two concurrent fetches of one forwarded link both
pass the read. Migration 0101's trigger takes `for update` on the register row before it looks, so the check
and the insert are one critical section — 0023's row-locked counter used as a mutex rather than as a
sequence. Given that a row is written on every *followed* link regardless, the stored grant was buying
revocability for a fifteen-minute link at the price of a **write on the path that merely offers a download**.

That price is the deciding argument. A screen listing a customer's six documents mints six links. Under a
stored grant that is six rows, an audit row each, in a transaction, before anybody has clicked anything — and
a link nobody follows is a row nobody collects. Under a signature it is six HMACs and no write at all, and
the first row appears when somebody actually takes a copy. The register then answers "what documents exist"
and the fetch log answers "which copies left", and neither is polluted by intent.

**What is given up, honestly:** a single outstanding link cannot be withdrawn. A signature is valid until it
expires and there is nothing to delete. The answers are to wait out the fifteen minutes, or to rotate with
the retired slot left empty — which kills every outstanding link and is a documented runbook step. A
single-use document does not have this problem: its link is dead the moment somebody follows it.

**`obligation_evidence`'s route is deliberately NOT rewritten.** Its grant table, its mint function and its
403 all work and are tested, and converting them would be a diff across a `done` unit's code to reach a
scheme whose only advantage there is uniformity. What this unit does instead is register
`compliance_evidence` as a document class, so the register is complete and a second producer arriving later
has one place to go. The cost is two schemes for one shape, stated here rather than discovered.

## The order of the three checks, and why each position is load-bearing

**Session, then signature, then matrix.**

The session is first because `guardAdminRoute` never throws and fails closed, so it is safe before the
handler's own `try`; and because an unauthenticated reader gets the 303 to the login screen that every admin
route gives, not a 403 they cannot act on.

The signature is second so that a request carrying none costs no database round trip and learns nothing about
whether the id exists.

The matrix is third and is never skipped. **A valid signature is not permission.** A receptionist handed a
link to a payslip is refused; so is a marketer handed a link to a tax invoice. The check is
`documentReadRefusal` in `@berelax/core`, which asks `can()` and `canReadFieldGroup()` — the same matrix every
screen uses, not a second table saying who may download what. A second table would disagree, and it would
disagree in the direction where a role keeps a document it lost in the matrix, because a widened matrix is
reviewed and a download table is not.

And the burn-and-audit is **after** all three and **before** the bytes are read, in one transaction. A
download that reached a reader is therefore never one the trail is missing. The cost is the opposite error —
a fetch recorded for bytes that turn out to be absent — which the route answers as a named 404, because an
over-recorded download is a question somebody can ask and an unrecorded one is not.

## Inside the MAC, and the one thing deliberately left out

Signed: the scheme name, the document id, the document class, the expiry, the nonce, the key version — joined
with U+001F, which no field may contain, so the mapping from fields to payload is injective rather than
merely unlikely. `:` and `|` would make `{a, bc}` and `{ab, c}` one payload.

**The document id appears only in the PATH and never as its own query parameter**, and that is a decision
about the test rather than about the scheme. Carrying it as a parameter would let a valid MAC over the wrong
document be named distinctly — which reads like an improvement and is the opposite. If the signature covered
only the expiry and the nonce — *a signature over the wrong thing*, the exact defect the acceptance criterion
names — then swapping the path would still be refused, by the parameter rather than by the MAC, and the case
would report PASS about a broken scheme. With the id in the path alone, the swap can only be caught by the
MAC.

**The MAC is checked before the expiry**, and swapping those two lines is the quiet way to lose the whole
point. MAC first: a signature that verifies and has expired is a stale link — ours, issued, followed too
late. Expiry first: an attacker who guesses a signature and back-dates `exp` is filed as somebody holding a
stale link.

**The storage key is never signed and never travels.** The signature is over the document id; the key is a
path into the private bucket, which `scripts/check-media.mjs` already refuses to let appear in source. A
signed key would put one in a link instead.

## The register, and why it is a table rather than a column per producer

The alternative was a `storage_key` and a `content_hash` on `tax_document`, on `vat_return`, on a payslip
table and on `obligation_evidence` — which is what `obligation_evidence` already is, and is why this unit
exists. Five producers each with a private path is five routes, five permission checks and five chances that
the sixth has none; the deferral chain above is what that looks like after three units.

One register means one route, one permission check, one audit action, and an answer to "what private
documents does this business hold" that is a `SELECT` rather than a survey. There is deliberately **no
`bucket` column**: every row is in the private bucket by definition, and a column able to say `public` is a
column somebody sets to `public`.

`scripts/check-private-documents.mjs` is what makes "one place" a fact rather than a convention: five rules,
each with a known-bad fixture (ADR 0003) — one register writer, one fetch recorder, no production caller of
`writeTaxDocumentPdf`, one signature verifier, and the class catalogue agreeing with the migration. Four of
the five could not be expressed as an import rule or a type. **Rule four was dead when it was written** — its
pattern required a character before `sign`, so it matched `documentSigner.verify` and missed `signer.verify`,
the spelling the route uses — and it was found by probing each rule against a deliberate violation rather
than by reading it. That is the argument for ADR 0003 made from inside this unit.

## The key, and its fourth entry in the secret inventory

`DOCUMENT_URL_SIGNING_SECRET`, with a version label and a retired slot consulted on verification only —
the arrangement `SUPPRESSION_PEPPER` already uses. The version label is **inside** the signature as well as
in the URL, and that is not bookkeeping: without it, a link signed under a key this deployment has rotated
away from is a bad MAC, indistinguishable from a forgery. With it, the refusal is `signature_unknown_key` —
"signed by us, under a key we no longer hold".

Holding the key plus a document id is the ability to *mint* a link. It is not access: the route still refuses
a request with no live staff session and still re-checks the matrix. Either half alone is not the document.

## Consequences somebody has to live with

- **Two link schemes in one codebase.** `obligation_evidence` uses a stored grant and everything else a
  signature. Both are correct for their problem and the boundary is the class `compliance_evidence`. A reader
  looking for "how do document links work" will find two answers, and this ADR is the one that says why.
- **A register row is permanent.** `ZY112` refuses `UPDATE` and `DELETE` for every role including the owner,
  because the register is what an audited download names. A document filed by mistake is a row that stands;
  what changes is that no link is minted for it.
- **`payslip` and `clinical_extract` are declared with no producer.** Nothing renders either today. They are
  in the catalogue anyway, because the class that must be single-use is the one to get right early, and a
  class added by the unit that first needs it would be a class added under deadline. The two classes are
  exercised end to end by the integration suite against registered fixtures, so they are tested rather than
  merely declared.
- **The screen that OFFERS a download does not exist**, so nothing in the product mints a link yet. That is
  named in the manifest as a deferral with an owner rather than left as an implication: this unit builds the
  route, the register, the signature and the refusals, and the unit that builds a document list calls
  `MediaStorage.sign`.
- **`writeTaxDocumentPdf` still exists.** The golden-comparison suite legitimately wants bytes in a file it
  can diff. It is confined by rule to scripts and tests, and the confinement is a gate rather than a comment.
