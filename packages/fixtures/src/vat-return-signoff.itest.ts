import { can, ROLES } from '@berelax/core'
import type { Sql } from '@berelax/db'
import { createConnection, vatReturnSigningRoles } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * M-VAT-08 — who may sign a VAT return, asserted against core's permission matrix.
 *
 * ## Why this file exists at all, and why it is here rather than in `packages/db`
 *
 * The roles that may sign are written down ONCE, in `vat_return_signing_roles()` (migration 0095), because
 * that is the list the CHECK on `vat_return_sign_off.signatory_role` enforces and a refusal has to be able
 * to name it. The roles that hold `vat_return:prepare` are written down once as well, in
 * `packages/core/src/access/permissions.ts`, where F07's matrix is tested.
 *
 * Those are two statements of one fact, and a second statement of a fact drifts. The day somebody widens
 * `vat_return:prepare` to the manager in core, the database would go on refusing them — and the symptom
 * would be a screen offering an action that fails, in the one area of the system where the action is a
 * statement to the FTA.
 *
 * Nothing else could compare them. `packages/db` may never import `packages/core` (`pnpm boundaries`), so
 * the database half cannot see the matrix and the matrix cannot see the database. `packages/fixtures` may
 * depend on both, which is what makes it the home for a pair test — the arrangement `vat201.itest.ts`,
 * `package-redemption.itest.ts` and `period-close.itest.ts` already use, for the same reason.
 *
 * ## What it does NOT do
 *
 * It does not exercise the refusal. `packages/db/src/services/vat-return-signoff.itest.ts` drives all eight
 * roles through `signOffVatReturn` against a real return and requires `ZY053` for the six that may not sign
 * and acceptance for the two that may. This file is only about the two lists agreeing — and about the
 * readable list really being the enforced one, which is the second case: a function nothing references would
 * be a list that agreed with core and refused nobody.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

beforeAll(() => {
  sql = createConnection({ url, max: 2 })
})

afterAll(async () => {
  await sql.end()
})

describe('the database and core agree about who may sign a VAT return', () => {
  it('permits exactly the roles holding vat_return:prepare, for all eight roles', async () => {
    const permittedByDatabase = await vatReturnSigningRoles(sql)

    // Per role, and driven from core's OWN role set rather than from a list retyped here. A pair of sorted
    // arrays compared in one assertion would also pass if both were empty; this says, for each of the eight
    // roles individually, that the two answers are the same answer.
    for (const role of ROLES) {
      expect(
        permittedByDatabase.includes(role),
        `${role}: the database ${permittedByDatabase.includes(role) ? 'permits' : 'refuses'} a VAT ` +
          `return signature and core ${can(role, 'vat_return:prepare') ? 'grants' : 'denies'} ` +
          'vat_return:prepare. Those are two statements of one fact and they have drifted — widen or ' +
          'narrow BOTH, in core/src/access/permissions.ts and in migration 0095 (a later migration ' +
          'replacing vat_return_signing_roles()).',
      ).toBe(can(role, 'vat_return:prepare'))
    }

    // The vacuity floors, both directions. ADR 0002: a matrix that granted the permission to nobody, or a
    // function that returned every role, would satisfy the loop above perfectly.
    expect(permittedByDatabase).toEqual(['accountant', 'owner'])
    expect(ROLES.filter((role) => can(role, 'vat_return:prepare')).length).toBe(2)
    expect(ROLES.filter((role) => !can(role, 'vat_return:prepare')).length).toBe(6)
    // And the two the acceptance criterion names by name, stated rather than inferred from the counts.
    expect(can('receptionist', 'vat_return:prepare')).toBe(false)
    expect(can('therapist', 'vat_return:prepare')).toBe(false)
  })

  it('enforces that list on the sign-off row, so the readable list is the refusing one', async () => {
    // A list nothing references would agree with core and refuse nobody. The CHECK's own definition is read
    // out of the catalogue and must name the function.
    const [constraint] = await sql<{ definition: string }[]>`
      select pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      where t.relname = 'vat_return_sign_off'
        and c.conname = 'vat_return_sign_off_role_may_sign'
    `
    expect(constraint?.definition).toContain('vat_return_signing_roles()')

    // The control: the scan reads a real constraint definition and is not matching an empty string — the
    // same read over a constraint that does NOT reference the function comes back without it.
    const [other] = await sql<{ definition: string }[]>`
      select pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      where t.relname = 'vat_return_sign_off'
        and c.conname = 'vat_return_sign_off_capacity_known'
    `
    expect(other?.definition).toContain('capacity')
    expect(other?.definition).not.toContain('vat_return_signing_roles()')
  })
})
