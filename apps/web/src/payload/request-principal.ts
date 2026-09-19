import type { CmsPrincipal } from '@berelax/cms'
import { getPayload, type Payload } from 'payload'
import config from '../../payload.config.ts'
import { principalFrom } from './principal.ts'

/**
 * Who is making this HTTP request, according to Payload's own session.
 *
 * `payload.auth({ headers })` is Payload's authentication, not a re-implementation of it: it reads the
 * `payload-token` cookie the admin sets, verifies the signature with the configured secret, checks the
 * session has not expired and loads the row. The alternative — parsing the cookie here — would be a second
 * authentication path, and a second authentication path is one that disagrees with the first about whether
 * a session is still valid.
 *
 * `principalFrom` then narrows the user to a role the F07 matrix knows. A `role` Payload holds that is not
 * in that set is treated as **absent**, because `can(role, …)` deciding on a string the matrix has never
 * heard of is worse than a refusal.
 *
 * There is still no `staff_user` table (see `src/collections/cms-users.ts`), so this is the only session
 * this application has. When one arrives, this function changes and no route's authorisation does.
 */
export async function appPayload(): Promise<Payload> {
  return await getPayload({ config })
}

export async function principalForRequest(request: Request): Promise<CmsPrincipal | null> {
  const payload = await appPayload()
  const { user } = await payload.auth({ headers: request.headers })
  return principalFrom(user)
}
