// Subpath import, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type { BusinessProfileProvider, GbpAccount, GbpAccountType } from '@berelax/providers/google'

/**
 * Account Management v1 — `accounts.list`, and the two facts about it that shape the picker.
 *
 * **An empty list is HTTP 200.** A Google account that administers no Business Profile at all answers
 * successfully with nothing in it (docs/10 §7). That is not a gating error and must never be reported as
 * one: *"we cannot reach your profiles yet, Google has not approved us"* and *"this Google account
 * administers no profiles"* need completely different actions from the owner — one is a wait, the other is
 * *you signed in with the wrong account, or the listing is held by a former agency* (docs/10 §5, the very
 * first task). `enumerateAccounts` below keeps them apart by construction, and the caller cannot collapse
 * them because they are different values of a closed union.
 *
 * **`LOCATION_GROUP` accounts hold locations the `PERSONAL` account does not return.** So the picker
 * enumerates under *every* account it is given, which is `business-information.ts`'s job. Enumerating only
 * the personal account is the mistake, and its symptom is "no locations found" against an account that can
 * see the listing perfectly well in the Business Profile UI.
 *
 * Nothing in this module names a token. The access token belongs to `withGoogle`, which is what obtains it,
 * classifies the failure and writes the row the owner's dashboard renders.
 */

/** Every account type the real API returns. A closed union, so an unexpected value is a parse error. */
export const GBP_ACCOUNT_TYPES: readonly GbpAccountType[] = [
  'PERSONAL',
  'LOCATION_GROUP',
  'ORGANIZATION',
  'USER_GROUP',
]

/**
 * The result of asking which accounts exist.
 *
 * Two shapes, not one array plus a comment. `no_profiles_found` is a *successful* answer with a meaning,
 * and a bare empty array would leave every caller free to decide what it meant — which is how it ends up
 * rendered as an error somewhere and as an empty picker somewhere else.
 */
export type AccountEnumeration =
  | { readonly kind: 'accounts'; readonly accounts: readonly GbpAccount[] }
  | { readonly kind: 'no_profiles_found'; readonly accounts: readonly [] }

/**
 * Lists every account the consenting Google account administers.
 *
 * The transport is the provider port: a real adapter would talk to
 * `mybusinessaccountmanagement.googleapis.com`, and the fake answers in the same shape. Either way the
 * call happens inside `withGoogle`, so a refusal is classified once and degrades once.
 */
export async function enumerateAccounts(
  transport: Pick<BusinessProfileProvider, 'listAccounts'>,
): Promise<AccountEnumeration> {
  const accounts = await transport.listAccounts()
  if (accounts.length === 0) return { kind: 'no_profiles_found', accounts: [] }
  return { kind: 'accounts', accounts }
}

/**
 * True for an account type whose locations the personal account does not necessarily return.
 *
 * Used only to explain a picker row to a human — *"held in a location group"* — because an owner looking
 * at a listing they cannot find under their own account needs to be told where it is, not shown an enum.
 */
export function holdsLocationsIndependently(type: GbpAccountType): boolean {
  return type !== 'PERSONAL'
}
