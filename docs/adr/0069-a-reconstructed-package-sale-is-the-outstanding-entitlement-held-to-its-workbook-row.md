# ADR 0069 — a reconstructed package sale is the OUTSTANDING entitlement, held to its workbook row rather than to the catalogue

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** H-MIG-03
- **Covers:** docs/01 decisions — none new. It is the storage-shaped consequence of
  [ADR 0065](0065-a-reconstructed-balance-is-validated-against-the-workbook-and-an-attested-one-is-admitted.md)
  (the workbook is the schema, and an attested balance is admitted) meeting
  [migration 0078](../../packages/db/migrations/0078_package.sql)'s rules for a package sale, and it records
  the provisional answers to **Y8-packages**, **Y9-package-thin** and **Y11-vat-package** that the import
  rests on.

## Decision

**A package liability imported out of H-MIG-02's reconstruction workbook is recorded as the entitlement that
REMAINS, filed on the day the liability enters these books, and held equal to the workbook row that attests
to it — not to the template version it names.**

Concretely, in migration 0119:

1. `package_sale.price_fils` is what is still **outstanding**:
   `price_paid - package_release_through_fils(price_paid, sessions_total, sessions_used)`. Its
   `session_count` is the sessions still available. Its one `package_balance` carries both, with
   `sessions_redeemed = 0` and `released_fils = 0`.
2. `package_sale.trading_date` is the **opening date** — the business day the liability enters these books,
   carried on the owner's sign-off — and never the day the customer paid.
3. `package_sale.expires_on` stops being a GENERATED column. It is **stated** for a reconstruction and
   **derived** for every other sale by a trigger, which refuses a stated date that is not the terms'
   (`ZY253`) and makes the column immutable afterwards (`ZY254`).
4. `ZG002` — the snapshot-matches-the-version rule — is **exempted** for a sale marked `reconstructed` and
   **replaced** by `ZY257`, which holds its liability, session count and expiry to `imported_package_sale`.
   `ZY258` refuses, at COMMIT, a sale carrying the mark that no reconstruction record attests to.
5. The posting is `Dr 3030 Retained earnings / Cr 2050 Deferred revenue — packages` at what is still owed,
   dated on the opening date, `source = 'opening_balance'`. `ZG005` is unchanged and is what makes "no
   output VAT at import" a property of the database.
6. A **fully drawn** package imports as an `imported_package_sale` with **no sale at all**.
7. The owner's sign-off (`import_staging.import_sign_off`) attests to `import_run.source_file_hash`, is
   append-only (`ZY251`), carries the cash actually received, and cannot be recorded unless the file's
   prices sum to that cash exactly (`import_sign_off_reconciles_to_the_cash_received`). `ZY256` walks from
   an imported row's own provenance to the run that produced it and refuses the COMMIT unless that run's
   hash is the one the signature names.

## Why the sale cannot be the package as it was sold

Four rules of 0078 and 0083 are right for a sale the till makes today and cannot express a liability
arriving out of a spreadsheet. The decision above is what is left after each is taken seriously rather than
worked around.

**`ZG009` holds a balance's drawdown equal to the sum of its `package_redemption` rows.** A reconstruction
arrives with sessions already taken and nothing to show for them: they were delivered under the previous
arrangement, against no appointment in this database. Writing them into
`package_balance.sessions_redeemed` means either relaxing `ZG009` — after which a till-sold balance's
drawdown can be moved by a statement that released nothing — or writing `package_redemption` rows, which
post the release through `4020` and `2030` (`ZG008`) and would put **output VAT on a supply made before
this system traded** into a period nobody filed a return for. Both are worse than the entitlement arriving
already netted down, which is what the holder can actually still use.

**`ZG002` holds the sale's price equal to the template version's.** H-MIG-02's workbook says on its face
that the price column is "what this customer handed over, including any discount nobody recorded", and its
committed clean fixture carries a row paid at 95,000 against a configured 100,000. Holding that row to the
catalogue refuses a real liability, which is the one outcome ADR 0065 rules out.

**`package_sale.trading_date` references `business_day`.** Those rows are generated over a rolling horizon
and a closed date is deliberately ABSENT (migration 0011), so a historical purchase date usually has no row
— and inventing one is inventing opening hours for a day nobody recorded (brief rule 15). `ZL004` and
`period_lock` say the same thing from the ledger's side: nothing may be dated before the books open except
an opening balance or a reversal, and nothing at all inside a closed period.

**`expires_on` was derived from the terms.** The validity was an assumption when these packages were sold —
Y9-package-policy is still open — so H-MIG-02 asks a person for the expiry rather than deriving it, and
0083's `ZG010` refuses a redemption against this exact column. A derived date would silently restate a term
the customer agreed to, in the one place the front desk reads to decide whether to honour it.

## The alternatives, and the specific way each fails

**Relax `ZG009` for a flag.** Add `package_balance.opening_sessions_redeemed`, subtract it before comparing
with the redemptions, and import the package as sold with its drawdown pre-filled. This was built first and
it works; it was rejected for two reasons. It rewrites another unit's constraint function, so a defect in
the replacement silently removes M-TILL-10's guarantee that a drawdown has a delivered treatment behind it —
and `ZG009` is also raised by `package_release_through_fils` in 0083, so moving its definition makes one
private code's live raise sites span two migrations, which `pnpm sqlstate` refuses as one code standing for
two rules. The netted-down sale needs none of that: `ZG009`, `ZG006`, `ZG010` and `ZG005` are untouched and
hold for a reconstruction exactly as they do for a till sale.

**Import the package as sold and release the consumed part with a second entry.** `ZG005` pins the sale's
own entry to a credit of `2050` by exactly the price, so the already-delivered part has to come back out in
an entry of its own. That is expressible, and it means the liability account is right only after two entries
per row and the balance the front desk reads is wrong in between. It also leaves `package_balance` showing
six sessions available when three were taken, which is a liability error at the desk rather than in a report.

**Refuse the rows that do not fit.** A reconstruction whose price is not the template price, whose expiry is
not six months after purchase, or whose sessions are partly used would be rejected and sent back for
correction. There is nothing to correct: the business sold a package at a discount nobody recorded, under
terms nobody wrote down, and the customer took three sessions. Refusing leaves a real liability off the
balance sheet and turns the customer away at the desk, which is the failure ADR 0065 is about.

**Create a `package_template_version` per reconstruction**, priced and counted to match the row, so `ZG002`
holds by construction. The current version of a template is `max(version)` (0078, deliberately, with no
pointer), so this makes one customer's reconstruction the version the till offers for sale — and the
alternative, a template key per reconstruction, invents the product (brief rule 15).

**Keep the liability out of `package_sale` entirely**, in a reconstruction table of its own. Then nothing the
front desk uses knows about it: M-TILL-10 draws down `package_balance`, so the customer walks in with a card
and the system has never heard of their entitlement. The liability report would be right and the business
would not work.

## What this does not decide

**Whether the date of supply on a prepaid package is the sale or the redemption.** [UNVERIFIED]
**Y11-vat-package**, provisionally the redemption, which is 0078's and 0083's answer and is the strictest
safe one. Nothing here depends on it beyond inheriting it: if the answer moves to the sale, what changes is
`ZG005`'s predicate and the two postings it governs, and no table in 0119 changes — a reconstruction would
then credit output VAT on the part already delivered, which is a question for whoever answers it and not a
schema change.

**What the business actually sells as a package.** **Y8-packages** and Y9-package-catalogue are unanswered,
so no template, price, session count, validity or balance is seeded anywhere in this unit, and
`artifacts/migration/package-liability.json` ships with every figure null.

**Whether an attested balance should be honoured more than once.** **Y9-package-thin**'s provisional answer
is "honour once on evidence, logged", and this unit implements the logging half:
`imported_package_sale.admitted_on_attestation` is GENERATED from the evidence kind, so the flag cannot
disagree with it, and it is visible on the customer record (`customer_package_attestation`) and in the
liability report (`imported_package_liability`). Nothing in this unit enforces "once": there is no second
redemption to refuse until a holder presents one, and a limit imposed here would be a policy nobody has
stated.
