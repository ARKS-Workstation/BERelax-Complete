// Subpath import, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type {
  SearchConsoleProvider,
  SearchConsoleSite,
  SitePermissionLevel,
} from '@berelax/providers/google'
import { AppError } from '@berelax/shared'

/**
 * Search Console — `sites.list`, and the reason this is a *separate selection* rather than a derivation.
 *
 * ## Why the property cannot be inferred from the Business Profile listing
 *
 * It is the substance of this unit's third criterion and it is not a technicality:
 *
 *   - **The identifier is a different kind of thing.** A Search Console property is
 *     `sc-domain:berelaxmassage.com` (a domain property, verified by DNS) or `https://berelaxmassage.com/`
 *     (a URL-prefix property). Those are two *separate properties* with separate data, and neither is
 *     derivable from a `placeId`. A listing's `websiteUri` is the closest thing available and it is a
 *     display field: it may carry a tracking query string, a `www.` the property does not use, or the old
 *     domain.
 *   - **It is frequently a different Google account.** docs/10 §2 models one-to-many for exactly this:
 *     *"the account that owns the GBP listing is frequently not the account verified on the Search Console
 *     property"* — the listing was claimed on one Gmail, the website was built by somebody else.
 *   - **It is not gated the way Business Profile is.** Search Console needs only the API enabled and the
 *     account to have property access, so **the SEO agent can be fully functional while GBP access is
 *     pending** (docs/10 §2 and §9). Deriving one selection from the other would couple the capability that
 *     works on launch day to the one that is waiting weeks for an application review.
 *
 * So: two capabilities, two selections, and a connection whose every GBP capability is refused can still
 * have a verified `gsc` resource.
 */

/** `details.reason` on each refusal. */
export const SITE_NOT_LISTED = 'google_site_not_listed'
export const SITE_NOT_VERIFIED = 'google_site_not_verified'

/**
 * Permission levels that can actually read Search Analytics.
 *
 * `siteRestrictedUser` is included: it reads the data with some UI features withheld, which is a Search
 * Console concern rather than an API one. `siteUnverifiedUser` is not — the property is *listed* for the
 * account and returns nothing, so a report built on it is a page of zeroes that reads as a collapse in
 * traffic rather than as a misconfiguration.
 */
export const USABLE_SITE_PERMISSIONS: readonly SitePermissionLevel[] = [
  'siteOwner',
  'siteFullUser',
  'siteRestrictedUser',
]

export function siteIsUsable(site: SearchConsoleSite): boolean {
  return USABLE_SITE_PERMISSIONS.includes(site.permissionLevel)
}

/** True for a domain property — the shape that survives the loss of any one Google account (docs/10 §5). */
export function isDomainProperty(siteUrl: string): boolean {
  return siteUrl.startsWith('sc-domain:')
}

export async function listSearchConsoleSites(
  transport: Pick<SearchConsoleProvider, 'listSites'>,
): Promise<readonly SearchConsoleSite[]> {
  return transport.listSites()
}

/**
 * Confirms a chosen property against a list Google returned, and refuses two cases that look identical.
 *
 * *Not listed* means the consenting account cannot see the property at all — almost always the wrong
 * account, which is the first thing docs/10 §5 says to establish. *Listed but unverified* means the right
 * account with the wrong role, which the owner fixes in the Search Console UI by adding themselves. One
 * needs a different consent; the other needs two minutes and no re-consent. Reporting both as *"cannot
 * select that property"* would leave the owner with no way to tell which.
 *
 * **Pure, and separate from the call that fetched the list on purpose.** It first ran inside the
 * `withGoogle` body and that was wrong in a way worth recording: the chokepoint classifies anything thrown
 * in the body as an upstream Google failure, so *"you are not verified on that property"* came back as
 * `TransientUpstream` with its own reason code discarded — and wrote a failure row onto the owner's
 * connection dashboard for a refusal Google had nothing to do with. The I/O belongs inside the chokepoint;
 * the decision about what came back belongs outside it.
 */
export function assertSiteSelectable(
  sites: readonly SearchConsoleSite[],
  siteUrl: string,
): SearchConsoleSite {
  const site = sites.find((candidate) => candidate.siteUrl === siteUrl)
  if (site === undefined) {
    throw new AppError(
      'not_found',
      `The Search Console property ${siteUrl} is not one this Google account can see. Check which ` +
        'account is a verified owner of the property — it is often not the one that owns the Business ' +
        'Profile listing (docs/10 §2).',
      { details: { reason: SITE_NOT_LISTED, siteUrl, listed: sites.length } },
    )
  }
  if (!siteIsUsable(site)) {
    throw new AppError(
      'forbidden',
      `This Google account is listed on ${siteUrl} but is not verified on it, so it can read no data ` +
        'from it. Add the account as an owner or full user in Search Console and select it again — a ' +
        'property selected in this state returns zero rows, which reads as a collapse in traffic.',
      {
        details: {
          reason: SITE_NOT_VERIFIED,
          siteUrl,
          permissionLevel: site.permissionLevel,
        },
      },
    )
  }
  return site
}
