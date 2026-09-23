import type { Sql } from '../connection.ts'
import type { SqlFragment, TherapistExclusion } from '../repositories/eligibility.ts'

/**
 * Composable therapist exclusions for the availability path (C-CRM-01).
 *
 * ## Why these are separately named predicates and not `where` clauses
 *
 * `therapistPoolCtes` (B-AVAIL-04) is the one place the question "may this therapist take this
 * appointment" is answered, and more than one unit needs to add a reason to it. Two agents each
 * inlining a condition into the same `where` is the merge that keeps one of them: the conflict resolves
 * cleanly, both lines look deliberate, and the filter that was dropped fails nothing — an availability
 * query that offers a therapist it should not offer returns MORE slots, which no assertion about
 * "returns slots" can see.
 *
 * So an exclusion is a value: a {@link TherapistExclusion}, which is M-VAT-10's seam and now the one
 * shape both units use. `queries/availability.ts` composes a LIST of them in `availabilityExclusions`,
 * so adding one is adding an array element at a single call site, and a dropped one is a dropped element
 * rather than a vanished clause. Every exclusion applies; none can mask another.
 *
 * ## Why this one reports NO reason
 *
 * The pool's `reason` column (`not_employed`, `missing_skill`, …) is an explanation that travels: it
 * reaches `AvailabilityFacts.excluded[].reason` and from there any caller that renders "why can I not
 * book". A do-not-pair exclusion reported that way would tell the customer which therapist will not work
 * with them, which is the disclosure the flag exists to prevent and is also a fact about an employee. So
 * `reason` is `null` — the nullable half of the field M-VAT-10's obligation fills in — and
 * `composedExclusions` removes the candidate instead of labelling it. There is then no row and no label
 * to leak, which is a stronger claim than "every reader remembers to hide it".
 *
 * That is also why the two reason lists (`EXCLUSION_REASONS` in `repositories/eligibility.ts`,
 * `ELIGIBILITY_EXCLUSION_REASONS` in `@berelax/core`) are untouched by this unit.
 *
 * An exclusion whose predicate matches nobody removes nobody, which is the direction absence has to fail
 * in: an availability query asked without a customer must offer the whole roster, not none of it.
 */

/**
 * The per-customer therapist do-not-pair exclusion.
 *
 * Removes every therapist a manager has recorded as not to be paired with this customer
 * (`customer_therapist_do_not_pair`, migration 0053), counting only ACTIVE rows — a lifted flag is
 * history and must not go on excluding anybody.
 *
 * `customerId` is `string | null` rather than optional, so a caller has to say which it means.
 * **`null` excludes nobody**: the admin calendar asking who is working on Thursday is not a query about
 * a customer, and the safe answer there is the whole roster. `= null::uuid` is never true, so the
 * `exists` is false for every candidate — the empty set, not every row, which is the failure direction
 * that matters. It is also why the predicate is an `exists` and not an `in`: `exists` is false rather
 * than NULL when the subquery finds nothing, and `composedExclusions` treats a NULL predicate as
 * excluding the candidate.
 *
 * `when` is written against `c`, the candidate row, which is `employee` in the candidate CTE and
 * `tp_candidate` in the `case`. `c.id` is the employee id in both.
 */
export function doNotPairExclusion(
  sql: Sql,
  args: { readonly customerId: string | null },
): TherapistExclusion {
  return {
    name: 'customer_do_not_pair',
    // Excluded, and no reason reported. See TherapistExclusion.reason and this file's header: naming
    // this exclusion would tell the customer which therapist declined them.
    reason: null,
    when: sql`
      exists (
        select 1
          from customer_therapist_do_not_pair dnp
         where dnp.lifted_at is null
           and dnp.customer_id = ${args.customerId}::uuid
           and dnp.employee_id = c.id
      )
    ` as SqlFragment,
  }
}

/**
 * The therapists in `therapistIds` that these exclusions remove — the WRITE side of the same list.
 *
 * The availability read is a memo; the booking transaction is the write. A tuple assembled from a page
 * rendered before a flag was recorded would otherwise commit the pairing a manager refused, and the
 * customer would learn about it from the therapist. `readEligibleTherapists` cannot answer this: it is
 * the port (`EligibilityQueryInput` deliberately carries no exclusions, so the pure implementation can
 * never be handed a reason its answer shape may not carry), which is exactly why this asks the
 * exclusions themselves rather than widening the port.
 *
 * The same `TherapistExclusion` values serve both paths, so the rule is written once. `from employee c`
 * supplies the alias their `when` is documented against.
 *
 * One statement per exclusion, and the list is short. A single statement with one arm per exclusion
 * would be `composedExclusions` rebuilt for two rows, and the loop cannot silently skip one.
 */
export async function therapistsExcludedBy(
  sql: Sql,
  args: {
    readonly therapistIds: readonly string[]
    readonly exclusions: readonly TherapistExclusion[]
  },
): Promise<ReadonlySet<string>> {
  const excluded = new Set<string>()
  if (args.therapistIds.length === 0) return excluded
  const ids = [...args.therapistIds]
  for (const exclusion of args.exclusions) {
    const rows = await sql<{ id: string }[]>`
      select c.id
        from employee c
       where c.id = any(${ids}::uuid[])
         and (${exclusion.when})
    `
    for (const row of rows) excluded.add(row.id)
  }
  return excluded
}
