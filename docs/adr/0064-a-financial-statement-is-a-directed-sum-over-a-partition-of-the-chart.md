# ADR 0064 — a financial statement is a directed sum over a PARTITION of the chart, computed at read time

- **Status:** accepted
- **Date:** 2026-09-29
- **Unit:** R-REP-02
- **Covers:** docs/01 decisions — none; this is the mechanism behind "P&L, balance sheet and cash flow tied
  to the ledger", and it stands on ADR 0017 (the append-only journal), ADR 0007 (integer fils, gross
  authoritative), ADR 0053 (a report over a closed period proves it read as of the lock) and ADR 0060 (the
  reporting schema is derived and keyed on `business_day`)

## Decision

**Three things, and the first is what makes the other two checkable.**

1. **No statement line holds a figure of its own.** Every line is a directed sum — `sum(debit) - sum(credit)`
   or its negation — over a named set of account codes, and the lines of the balance sheet are a total,
   disjoint **partition of the whole chart**. There is no adjustment, no line derived from another line's
   total, and no figure entered anywhere. `assets - (liabilities + equity)` is therefore the trial-balance
   identity, which `0018_ledger.sql`'s deferred constraint trigger already guarantees for every role.
2. **The statements are computed from `journal_line` at read time and are NOT materialised in the
   `reporting` schema.**
3. **The claim "tied to the ledger" is met by two independent counts, not by the identities.** Each line
   names its account codes so a caller can read the raw `journal_line` rows and add them up; and a census
   over the same window — a count and two sums taken with **no reference to any account set** — says whether
   the lines account for every row. The identities are necessary and are nowhere near sufficient, for the
   reason the next section gives.

## Why the balance sheet balancing proves almost nothing, and what does

The obvious reading of "the balance sheet balances" is that it is the check. It is not, and the gap is
exact rather than rhetorical.

Write `d(A)` for an account's `debits - credits`. Summed over every account, `d` is zero, because the
journal cannot hold an entry whose sides disagree. Now take ANY total, disjoint partition of the chart into
"assets", "liabilities" and "equity", read each asset line debit-less-credit and each liability and equity
line credit-less-debit. Then

    assets - liabilities - equity = Σ_all d(A) = 0

**whatever is in which section.** File the tips-payable liability under assets and the sheet still balances
to the fil: the account leaves one side and joins the other with its sign already flipped by the section's
own direction, so the two changes cancel. `packages/core/src/reporting/statements.test.ts` does exactly
that and asserts the zero, with total assets reading 0 where 50,000 was the truth.

So the identity is a check on the PARTITION — on nothing being dropped and nothing counted twice — and on
nothing else. Two further things are therefore rules with names of their own, and each is broken
deliberately in `scripts/test-gates.mjs` block 142:

- **`statement-line-claims-accounts-of-one-type`** and
  **`statement-line-direction-matches-its-declared-sense`.** A line declares whether it reports its
  accounts' own side (`natural`) or the opposite (`inverted`), and the rule checks the direction against the
  ACCOUNT TYPE. `inverted` is not a loophole: a cash-flow line over an asset is inverted because cash spent
  on stock is an outflow and the stock account was debited, and equity's `costs_since_the_books_opened` is
  inverted because an expense reduces what the owner is owed. What the rule refuses is a line whose
  direction and declaration disagree, which is what a misfiling looks like.
- **the census.** An account posted to that no line claims leaves the sheet balancing — the account is
  simply absent from both sides — and is invisible to every identity. It is visible only against a count
  taken without the layout, which is why `statementLedgerCensus` has no `group by`, no `having` and no join
  to `account`.

## Why the earnings since the books opened are an equity LINE

Nothing in this build posts a year-end closing entry, so the profit since inception sits in the revenue and
expense accounts rather than in `3030`. A balance sheet whose equity section held only the three `3xxx`
accounts would be out by exactly that profit, and the tempting repairs are both worse than the line:

- **post a closing entry.** That is a real accounting decision with a date, an authoriser and a period, and
  a reporting unit inventing one would write to the append-only journal to make its own output tidy.
- **plug the difference.** A "retained earnings" figure computed as `assets - liabilities - posted equity`
  is the one line on the sheet that cannot be wrong, and it makes the balance check vacuous by
  construction — the failure this whole record is against.

So equity carries `revenue_since_the_books_opened` and `costs_since_the_books_opened`, each a directed sum
over accounts like every other line, each drillable to its rows. Two lines rather than one because a line
claiming both revenue and expense accounts has two types and no single direction to check.

**The articulation is then exact rather than nearly exact.** "Net profit equals the movement in retained
earnings" is true only while nothing is posted straight to `3030`; a closing entry moves profit out of the
revenue accounts and into that account, so the movement and the profit differ by precisely what was posted.
The identity asserted is therefore `movement - netProfit - directEquityPostings = 0`, which holds always,
with `directEquityPostings` reported on the statement and asserted at zero for the fixture month. A report
whose headline claim is true only under a condition nobody states is a report that will one day be wrong
with nothing failing.

## Why the cash flow is INDIRECT

Because the movement in every account nets to zero, the movement in cash is minus the movement of
everything else. The cash flow is therefore the movement in every NON-cash account, partitioned into named
lines: no classification of individual entries, no allocation, no rounding.

**The direct method is what this replaced, and it does not survive an ordinary banking run.**
`Dr bank 90, Dr fees 10, Cr drawer 100` has one cash line whose counterparts span an operating cost and
another cash account, so its amount has to be split pro rata — a rounding rule inside a statement whose
acceptance line says "to the fils". A transfer between two cash accounts is the same problem in its pure
form, and in the indirect form it simply does not arise: neither account is in the partition, so no line
moves. `packages/fixtures/src/statements.itest.ts` banks 50,000 from the drawer and asserts exactly that.

Depreciation is an operating add-back on `1110` and the purchase is investing on `1100`, which is the
standard presentation and also the only arithmetically honest one here: reading the movement in the NET book
value as investing would report a month with no purchases as an investing inflow the size of the charge.

**Cash and cash equivalents are the drawer, the petty-cash float and the bank account, and the two clearing
accounts are deliberately excluded.** Both hold money the business has earned and does not yet hold, so
counting them would make "cash at the end of the period" a figure nobody can check against a bank
statement — the one thing that figure is for — and the maturity that would justify including them is not in
the ledger, because nothing records when a processor settles. The set is stated once and read twice, and
`cash-flow-cash-accounts-are-the-balance-sheet-cash-line` holds the two readers equal.

## Why this is not in the `reporting` schema

ADR 0060 keys everything in `reporting` on `business_day.trading_date` and states that a fact added later
inherits the rule "whether or not its author knew it existed". `journal_entry.entry_date` deliberately has
**no** foreign key to `business_day`, and `0018_ledger.sql` says why: the journal must be able to record the
rent for a month containing days the premises were shut. A statement materialised in `reporting` would
therefore either drop those entries — revenue and cost leaving a statement in silence, which is the failure
`reporting.assert_business_day_keys` exists to refuse one subject along — or be the first relation in that
schema not keyed on a trading date.

Two smaller reasons point the same way. A figure in `reporting` is never fresher than the last refresh, and
ADR 0060 lists that as a cost it accepts because "the reporting schema is never the place to answer an
operational question" — but a balance sheet for a closed period must be reproducible to the fil at any
instant, which is the opposite requirement. And ADR 0053 requires a closed-period report to read at the
period's own dates and CARRY a census of what was written afterwards; a materialised snapshot of a filed
figure is a second statement of it, and the two would disagree the first time a period was reopened.

**Consequence to live with:** the statements are recomputed on every read, and the read is four aggregates
over `journal_line` plus one per drilled line. There is no per-period cache and no snapshot table. If a
later unit needs one — an accountant's signed pack, say — it is a stored artefact with a content hash, the
shape ADR 0044 already settled for a filed VAT return, and not a materialised view.

## What this costs

- **No migration and no private SQLSTATE.** This unit adds no schema. Everything it needs is already
  refused by the database: `ZL001` for an edit to the journal, `ZL002` for a posting into a closed period,
  `ZE001`/`ZE002` for closing a period that does not balance or still holds unposted documents. A private
  code is for a refusal with a runbook answer (ADR 0043, 0061), and every refusal a statement can meet
  already has one. The migration number 0114 and the band ZY201-ZY210 allocated to this unit are released
  unused.
- **The statement layout is a second statement of the chart.** Unavoidable — a grouping is not derivable
  from account numbers — so it arrives with the check that holds the two equal in the same commit:
  `balance-sheet-claims-every-account-in-the-chart-exactly-once`, over the chart itself rather than over a
  copy of it. A chart with an account the layout does not claim is a failing test, not a missing line.
- **The grouping is provisional against Y8-coa**, which asks for the existing chart *and* what the
  accountant expects monthly. The second half is this layout, including which accounts count as cash. The
  marker is on every statement set built, and answering it is a regrouping rather than a re-derivation.
- **There is no current / non-current split and no computed tax.** The split needs a maturity per balance
  that the journal does not record, and a guessed one produces a statutory-looking subtotal nobody can
  derive from the rows. Corporate tax appears only if something was posted to the corporate tax accounts:
  docs/04 §4 gives 9% above AED 375,000 with elective Small Business Relief, and a rate applied in a
  reporting module would be this codebase filing a return by arithmetic.
- **Every figure is a `bigint` and none is a `Fils`.** `packages/core/src/money.ts` caps `Fils` at
  `Number.MAX_SAFE_INTEGER`, and `packages/db/src/queries/trial-balance.ts` records what a `number` did to
  a cumulative ledger position: a ledger holding 2^53 + 1 fils on each side reported a difference of -4
  fils, out of nothing, because the two sides round independently. A statement over the same columns would
  inherit it exactly.
