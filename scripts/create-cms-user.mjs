#!/usr/bin/env node
/**
 * Creates the first CMS admin account, which nothing else can.
 *
 * ## Why this is needed at all
 *
 * `apps/web/src/collections/cms-users.ts` restricts `create` to `role === 'owner'` — deliberately, because
 * "an account created, a role changed or an account removed is the most consequential change in this
 * admin". That rule is correct and it is also a bootstrap problem: on a fresh deployment there is no owner
 * to satisfy it, and nothing in `pnpm seed` writes a `cms_user` row.
 *
 * Payload's own first-user screen is the other way in, and it is fine. This script exists for the case
 * that screen cannot serve: a deployment where somebody has to be given working credentials rather than
 * invited to invent them, and where the password therefore has to be set deliberately rather than typed
 * into a browser once and lost.
 *
 * ## It refuses to be a back door
 *
 * The access rule is bypassed by Payload's Local API, which is exactly why this has to be narrow:
 *
 *  - it refuses when the collection already holds a user, so it cannot be used to add a second account
 *    around the owner-only rule — after the first account, accounts are created in the admin, by an owner,
 *    where the audit hook records it;
 *  - it takes the password from `CMS_USER_PASSWORD` and never from an argument, because an argument is in
 *    the shell history and in the process list of every other process on the box;
 *  - it prints the email and the role and never the password.
 *
 * Usage: `CMS_USER_PASSWORD=… pnpm cms:user --email someone@example.com [--role owner]`
 */
import { getPayload } from 'payload'
import config from '../apps/web/payload.config.ts'

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

const email = flag('email')
const role = flag('role') ?? 'owner'
const password = process.env['CMS_USER_PASSWORD']

if (email === undefined || !email.includes('@')) {
  console.error('--email is required and must be an address.')
  process.exit(1)
}
if (password === undefined || password.length < 16) {
  console.error(
    'CMS_USER_PASSWORD is required and must be at least 16 characters. It is read from the environment ' +
      'rather than an argument because an argument is in the shell history and in every other process ' +
      'list on the box. This account can change compliance-locked settings; 16 is a floor below which a ' +
      'password was not generated, rather than an opinion about entropy.',
  )
  process.exit(1)
}

const payload = await getPayload({ config })

const existing = await payload.count({ collection: 'cms_user' })
if (existing.totalDocs > 0) {
  console.error(
    `cms_user already holds ${existing.totalDocs} account(s), so this script refuses. It bootstraps the ` +
      'FIRST account only: after that, accounts are created in the admin by an owner, where the audit ' +
      'hook records who did it. Use the admin, or reset a password there.',
  )
  process.exit(1)
}

await payload.create({ collection: 'cms_user', data: { email, role, password } })

console.log(
  `Created the first CMS account: ${email} (role ${role}). The password is not printed here.`,
)
process.exit(0)
