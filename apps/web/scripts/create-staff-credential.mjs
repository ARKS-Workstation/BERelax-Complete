#!/usr/bin/env node
/**
 * Creates the first staff credential — the account that opens the OPERATIONAL admin.
 *
 * ## This is not the CMS account, and the distinction is the whole point
 *
 * There are two admins. `/admin` is Payload, which holds pages, journal posts, FAQ entries and media, and
 * authenticates against `cms_user`. Everything else — the till, the checkout, the calendar, the month
 * reconciliation, the five HR screens, compliance, CRM, reports — is the `(admin)` route group, and it
 * authenticates against `staff_credential` + `staff_session` with scrypt and a mandatory second factor
 * (ADR 0009). A `cms_user` row opens neither of those doors; `pnpm cms:user` is the other script.
 *
 * ## Why no account exists until somebody runs this
 *
 * `packages/fixtures/src/admin-principal.ts` states it: `Y8-staff` is open, the handover supplied a
 * headcount and nineteen photographs and no names, contact details or credentials, so `packages/db/src/seed`
 * creates no `staff_credential` row and migration 0090 seeds none. Brief rule 15 — a plausible admin
 * account is indistinguishable from a configured one, and an account nobody configured is an account
 * nobody rotates. The consequence is the acceptance criterion rather than a limitation: a deployment with
 * no staff row refuses every login.
 *
 * This script is how a deployment stops being in that state, deliberately, once.
 *
 * ## It refuses to be a back door
 *
 * The login path cannot create an account and no screen can either — `clients/[id]`, `hr/*` and the rest
 * read staff, they do not credential them. So this is the only way in, which is exactly why it is narrow:
 *
 *  - it refuses when `staff_credential` already holds a row, so it cannot be used to add a second account
 *    around whatever policy the first one is subject to;
 *  - the password comes from `STAFF_PASSWORD` and never an argument, because an argument is in the shell
 *    history and in every other process list on the box;
 *  - it enrols a TOTP factor whenever the role requires one, and refuses rather than creating an account
 *    that could never complete a login;
 *  - it prints the enrolment URI (which the operator must have, to add the factor) and never the password.
 *
 * ## What it writes
 *
 * An `employee` row and a `staff_credential` row, in that order, the same two inserts
 * `createFixturePrincipal` makes — because the schema is the schema, and a bootstrap that wrote a shape
 * the suite does not exercise would be a shape nothing proves. No session: the operator signs in.
 *
 * Usage: `STAFF_PASSWORD=… pnpm staff:credential --reference "Owner" [--role owner]`
 */
import { generateSecret, hashPassword, totpEnrolmentUri } from '@berelax/auth'
import { loadConfig } from '@berelax/config'
// `ROLES` and not a local list: the F07 set is declared once, and a script carrying its own copy would
// accept a role the matrix does not know. `isRole` is not core's — it is `@berelax/cms`'s, and importing
// the CMS package to validate a STAFF role would tie the two admins together for a one-line check.
import { ROLES, requiresTotp } from '@berelax/core'
import { createConnection } from '@berelax/db'

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

const reference = flag('reference') ?? process.env['STAFF_REFERENCE']
const role = flag('role') ?? process.env['STAFF_ROLE'] ?? 'owner'
const password = process.env['STAFF_PASSWORD']

if (reference === undefined || reference.trim().length === 0) {
  console.error(
    '--reference is required: the `employee.staff_reference` this credential belongs to. It is a label, ' +
      'not a name — brief rule 10 keeps names of people out of this repository, and `Y8-staff` means ' +
      'there is no roster to pick from yet.',
  )
  process.exit(1)
}
if (!ROLES.includes(role)) {
  console.error(`--role must be one of the F07 roles (${ROLES.join(', ')}); "${role}" is not one.`)
  process.exit(1)
}
if (password === undefined || password.length < 16) {
  console.error(
    'STAFF_PASSWORD is required and must be at least 16 characters. It is read from the environment ' +
      'rather than an argument because an argument is in the shell history and in every other process ' +
      'list on the box. `assertPasswordPolicy` enforces 12 with a lower, an upper and a digit; 16 is the ' +
      'floor below which a password was not generated.',
  )
  process.exit(1)
}

const sql = createConnection({ url: loadConfig().DATABASE_URL, max: 1 })

try {
  const [existing] = await sql`select count(*)::text as n from staff_credential`
  if (existing.n !== '0') {
    console.error(
      `staff_credential already holds ${existing.n} row(s), so this script refuses. It bootstraps the ` +
        'FIRST credential only. A second account is a decision about who may hold one, and this script ' +
        'is not where that decision belongs.',
    )
    process.exit(1)
  }

  /*
   * TOTP is enrolled whenever the role demands it, and the absence of a factor for such a role is refused
   * rather than written: `resolveLoginStage` answers `totp_enrolment_required` and STOPS, so a credential
   * created without one for an `owner` is an account that can never sign in. Creating it would look like
   * success.
   */
  const needsTotp = requiresTotp(role)
  const totpSecret = needsTotp ? generateSecret() : null

  const [employee] = await sql`
    insert into employee (staff_reference, employed_from)
    values (${reference}, now()::date)
    returning id
  `
  if (employee === undefined) throw new Error('Inserting the employee row returned nothing.')

  const [credential] = await sql`
    insert into staff_credential (employee_id, role, password_hash, totp_secret)
    values (${employee.id}::uuid, ${role}, ${await hashPassword(password)}, ${totpSecret})
    returning id
  `
  if (credential === undefined) throw new Error('Inserting the staff credential returned nothing.')

  console.log(
    `Created the first staff credential: role ${role}, reference ${JSON.stringify(reference)}.`,
  )
  console.log('The password is not printed here.')
  if (totpSecret !== null) {
    console.log(
      `TOTP_ENROLMENT_URI ${totpEnrolmentUri({
        secretBase32: totpSecret,
        accountName: reference,
        issuer: 'BE RELAX',
      })}`,
    )
    console.log(
      'That URI is the second factor. It is printed once, it is the only copy, and the account cannot ' +
        'sign in without it — add it to an authenticator app before closing this output.',
    )
  }
} finally {
  await sql.end({ timeout: 5 })
}
