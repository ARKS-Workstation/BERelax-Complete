import { type GoogleCapability, isBusinessProfileCapability } from '@berelax/core'
// Subpath imports, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type { BusinessProfileProvider, SearchConsoleProvider } from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import { enumerateAccounts, holdsLocationsIndependently } from './adapters/account-management.ts'
import {
  type EnumeratedLocation,
  getLocationUnder,
  LOCATION_READ_MASK,
  listLocationsUnder,
} from './adapters/business-information.ts'
import {
  assertSiteSelectable,
  isDomainProperty,
  listSearchConsoleSites,
  siteIsUsable,
} from './adapters/search-console.ts'
import type { GoogleCapabilitySelectionStore } from './connection-store.ts'
import type { DeclaredCapability } from './consumers.ts'
import type { DegradationCause, WithGoogleDeps } from './with-google.ts'
import { withGoogle } from './with-google.ts'

/**
 * The picker: which Google resource each capability serves, and how the owner chooses it.
 *
 * ## What this unit closes
 *
 * `completeGoogleConsent` registers every capability with `resourceRef: null`, because a consent proves the
 * owner ticked the product and says nothing about *which* listing or *which* Search Console property
 * (G-CONN-02). Until a resource is chosen, `withGoogle` degrades every call with `ResourceNotSelected` — so
 * a connection can be perfectly healthy and do nothing at all. This is the step that turns a completed
 * consent into a usable capability, and the claim worth testing end to end is exactly that: `withGoogle`
 * stops degrading once a location is picked.
 *
 * ## Why a business with one location still needs a picker
 *
 * This business has one permanent location — 250 Al Meena Street, Al Zahiyah (docs/13 §2) — so the picker
 * exists to make the *correct* choice unambiguous rather than to support a roadmap. The Google account may
 * administer several accounts and several locations, and "Be Relax" is also the name of an airport spa
 * chain, so a list of titles alone contains two plausible answers. Choosing the wrong one does not fail: it
 * silently publishes replies against another company's listing. Hence the full address on every row, the
 * account each listing was found under, and a re-read from Google before anything is persisted.
 *
 * ## Why the enumeration goes through `withGoogle` too
 *
 * The picker is a consumer, and the chokepoint is what gives it the taxonomy, the correlation id, the
 * declared degraded mode and the row the owner's dashboard renders (docs/10 §2). It needs one thing no other
 * consumer needs — to run before a resource exists — and that is `resource: 'enumerating'`, which is the
 * narrowest possible hole and is documented where it is declared. The alternative was a second path to a
 * token, and a second path to a token is the thing the whole chokepoint exists to prevent: nothing here
 * names an accessor or imports the token store.
 */

/** `details.reason` values a caller branches on. */
export const RESOURCE_REF_MALFORMED = 'google_resource_ref_malformed'
export const PICKER_CHOICE_UNKNOWN = 'google_picker_choice_unknown'
export const PICKER_LISTING_MOVED = 'google_picker_listing_moved'

/**
 * A Business Profile resource, as `resource_ref` stores it.
 *
 * All three fields, and `account` is the one that is easy to think optional. **Business Information v1
 * returns `locations/{l}` while the legacy v4 Reviews path is `accounts/{a}/locations/{l}/reviews`**
 * (docs/10 §7), and the account is not recoverable from the location — it is the thing you enumerated
 * under. A selection that stored only the location would leave the reviews adapter unable to build its own
 * URL, and Reviews is the one capability the whole autoresponder is for.
 *
 * A `type` rather than an `interface`, and that is not a style choice: an interface has no implicit index
 * signature, so it cannot be passed where `Record<string, unknown>` is expected — which is the shape a jsonb
 * column write takes. A type alias of an object literal gets one, so the value that is written and the value
 * that is parsed back are the same declared type rather than two shapes joined by a cast.
 */
export type GbpResourceRef = {
  readonly account: string
  readonly location: string
  readonly placeId: string
}

/**
 * A Search Console resource: a domain or URL-prefix property, and nothing derived from a listing. A type
 * alias for the same reason `GbpResourceRef` is one.
 */
export type GscResourceRef = {
  readonly siteUrl: string
}

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null

/**
 * Reads a stored `resource_ref` back as a Business Profile resource, or refuses.
 *
 * Strict about the prefixes, and deliberately not forgiving. `accounts/1` and `1` are the same account to a
 * human and different strings to a URL builder; accepting both would mean the v4 path is sometimes
 * `accounts/1/locations/2/reviews` and sometimes `1/2/reviews`, and the second one 404s at 03:00 on a cron
 * job. The writer normalises, the reader refuses — one of them has to, and the writer is where the value
 * is still in hand.
 */
export function parseGbpResourceRef(ref: Readonly<Record<string, unknown>> | null): GbpResourceRef {
  const account = nonEmptyString(ref?.['account'])
  const location = nonEmptyString(ref?.['location'])
  const placeId = nonEmptyString(ref?.['placeId'])
  const malformed: string[] = []
  if (account === null || !account.startsWith('accounts/')) malformed.push('account')
  if (location === null || !location.startsWith('locations/')) malformed.push('location')
  if (placeId === null) malformed.push('placeId')
  if (account === null || location === null || placeId === null || malformed.length > 0) {
    throw new AppError(
      'invariant_violated',
      `The stored Business Profile resource is unusable: ${malformed.join(', ')}. It must carry ` +
        'accounts/{account}, locations/{location} and a placeId — the v4 reviews path is built from the ' +
        'first two and the daily health check re-resolves the third (docs/10 §7).',
      { details: { reason: RESOURCE_REF_MALFORMED, malformed } },
    )
  }
  return { account, location, placeId }
}

/** Reads a stored `resource_ref` back as a Search Console property, or refuses. */
export function parseGscResourceRef(ref: Readonly<Record<string, unknown>> | null): GscResourceRef {
  const siteUrl = nonEmptyString(ref?.['siteUrl'])
  if (siteUrl === null) {
    throw new AppError(
      'invariant_violated',
      'The stored Search Console resource carries no siteUrl. A property is identified by ' +
        'sc-domain:example.com or https://example.com/ and by nothing else — it cannot be derived from ' +
        'the Business Profile listing (docs/10 §2).',
      { details: { reason: RESOURCE_REF_MALFORMED, malformed: ['siteUrl'] } },
    )
  }
  return { siteUrl }
}

/**
 * The legacy v4 reviews path, built from the stored reference alone.
 *
 * This function is the reason `account` is persisted, and it takes no arguments beyond the stored ref on
 * purpose: if the path can be built from the row, the row is sufficient, and the reviews adapter never has
 * to re-enumerate accounts to find out where its own location lives. Reviews remaining on `v4` while
 * everything else migrated to `v1` is docs/10 §7's highest-risk dependency, so the one place that knows the
 * shape of its URL is here, next to the parser that guarantees the parts.
 */
export function reviewsPathFor(ref: Readonly<Record<string, unknown>> | null): string {
  const { account, location } = parseGbpResourceRef(ref)
  return `${account}/${location}/reviews`
}

/** A Google Maps link for a chosen listing, so the owner can see what they picked. */
export function mapsLinkFor(placeId: string): string {
  return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`
}

/**
 * What the picker has to say, in plain English rather than as a status code.
 *
 * `no_profiles_found` and `access_not_granted` are the pair this unit exists to keep apart. Both are a
 * screen with no listings on it and they mean opposite things:
 *
 *   - `no_profiles_found` is **HTTP 200 with an empty accounts list** — the API worked and this Google
 *     account administers no Business Profile. The action is *establish which account owns the listing*,
 *     which docs/10 §5 calls the very first task and which is frequently a former marketing agency.
 *   - `access_not_granted` is the Basic API Access application not yet approved: quota sits at 0 QPM and
 *     every call fails however valid the token is (docs/10 §1). The action is *wait, and watch the Cloud
 *     console for 0 → 300*.
 *
 * Reporting the first as the second tells the owner to wait for an approval that will change nothing, for
 * however many weeks it takes somebody to doubt it. So they are different values of a closed union with
 * different guidance, and a test asserts both the value and the guidance differ.
 */
export type PickerState =
  | 'ready'
  | 'no_profiles_found'
  | 'no_verified_property'
  | 'access_not_granted'
  | 'quota_zero'
  | 'listing_not_verified'
  | 'admin_policy_enforced'
  | 'reauth_required'
  | 'not_connected'
  | 'no_selection_yet'
  | 'unavailable'

/**
 * The sentence the settings surface shows for each state. Never a scope string, never an enum (docs/10 §4).
 *
 * A total record, so a new state cannot be added without writing the sentence — and the sentence is the
 * thing the owner acts on, which makes it the part least safe to leave for later.
 */
export const PICKER_GUIDANCE: Readonly<Record<PickerState, string>> = {
  ready: 'Choose the listing for this business. Check the address, not just the name.',
  no_profiles_found:
    'This Google account does not manage any Business Profile. Sign in with the account that owns the ' +
    'listing — it is often a former agency or the person who first set it up — or ask that account to ' +
    'add this one as an owner.',
  // The Search Console equivalent, and a separate sentence rather than a reuse of the one above. An empty
  // property list and an empty listing list are the same *shape* of screen and completely different
  // problems: one is answered in the Business Profile, the other by a DNS TXT record or two minutes in the
  // Search Console UI. Telling the owner about their Business Profile when the SEO agent is what has nothing
  // to read is the same failure this unit's first criterion is about, one layer down.
  no_verified_property:
    'This Google account is not a verified owner of any Search Console property. Either sign in with the ' +
    'account that is, or add this one in Search Console — a property it can merely see returns no data at ' +
    'all, which reads as a site with no traffic rather than as a permission it is missing.',
  access_not_granted:
    'Google has not approved Business Profile API access for this application yet, so the listings ' +
    'cannot be read. Nothing is wrong with the connection and there is nothing to do but wait; review ' +
    'replies are being drafted for you to post by hand in the meantime.',
  quota_zero:
    'Business Profile access is approved but the daily quota is exhausted, so the listings cannot be ' +
    'read until it resets.',
  listing_not_verified:
    'The listing is not verified with Google, so it cannot be read or replied to. Verification is done ' +
    'in the Business Profile, and it is not something this application can do for you.',
  admin_policy_enforced:
    'A Google Workspace administrator has restricted this service for the whole organisation. The ' +
    'administrator has to allow it before anything can be selected.',
  reauth_required:
    'The Google connection needs re-authorising before a listing can be chosen. Your selection is kept ' +
    'when you sign back in with the same account.',
  not_connected: 'No Google account is connected for this capability yet.',
  no_selection_yet: 'Nothing has been chosen for this capability yet.',
  unavailable: 'Google did not answer. Try again in a moment — nothing has been changed.',
}

/**
 * Every degradation cause, mapped to a state. Total, so a new cause forces a decision here.
 *
 * `RateLimited` and `TransientUpstream` do not degrade — `withGoogle` throws them so a queue retries with
 * backoff — so they cannot arrive through the degraded branch. They are mapped anyway, because the
 * alternative is a lookup that can return undefined and a caller that invents a state for it.
 */
export const PICKER_STATE_FOR_CAUSE: Readonly<Record<DegradationCause, PickerState>> = {
  NotConnected: 'not_connected',
  ResourceNotSelected: 'no_selection_yet',
  GoogleReauthRequired: 'reauth_required',
  AccessNotGranted: 'access_not_granted',
  QuotaZero: 'quota_zero',
  ListingNotVerified: 'listing_not_verified',
  AdminPolicyEnforced: 'admin_policy_enforced',
  RateLimited: 'unavailable',
  TransientUpstream: 'unavailable',
}

/**
 * One row of the picker.
 *
 * `alsoUnderAccounts` is what the dedupe dropped rather than nothing at all: a location returned under two
 * accounts is one listing, and the owner is told where else it was found instead of being shown it twice.
 */
export interface PickerChoice extends EnumeratedLocation {
  readonly alsoUnderAccounts: readonly string[]
  readonly mapsUrl: string
  /**
   * True when the listing is held by an account that is not the personal one.
   *
   * Rendered as *"held in a location group"* rather than as an enum. An owner looking at a listing they
   * cannot find under their own Google account needs to be told **where it is**; without that the correct
   * row is the one that looks least familiar, which is the opposite of what the picker is for.
   */
  readonly heldInLocationGroup: boolean
}

export interface GbpPickerView {
  readonly state: PickerState
  readonly guidance: string
  readonly connectionId: string | null
  readonly choices: readonly PickerChoice[]
  /** How many accounts answered, so "one account, no locations" is distinguishable from "no accounts". */
  readonly accountsSeen: number
  /** What is selected today, so the picker can show the current answer rather than an empty form. */
  readonly selected: GbpResourceRef | null
  readonly correlationId: string
}

export interface SiteChoice {
  readonly siteUrl: string
  readonly permissionLevel: string
  /** False for a property the account is listed on but not verified for: it returns no data. */
  readonly selectable: boolean
  readonly isDomainProperty: boolean
}

export interface GscPickerView {
  readonly state: PickerState
  readonly guidance: string
  readonly connectionId: string | null
  readonly choices: readonly SiteChoice[]
  readonly selected: GscResourceRef | null
  readonly correlationId: string
}

/** Who chose. Required, never defaulted: a selection with no actor is an audit row nobody can act on. */
export interface SelectionActor {
  readonly kind: 'staff' | 'system' | 'agent'
  /** A role or a surface, never an invented person's name (the brief's rule 10). */
  readonly label: string
}

export interface PickerDeps {
  /** The chokepoint's dependencies. Every Google call below goes through it. */
  readonly google: WithGoogleDeps
  /** The narrow store seam: it can fill a resource and append an event, and nothing else. */
  readonly selections: GoogleCapabilitySelectionStore
  readonly profile: Pick<BusinessProfileProvider, 'listAccounts' | 'listLocations' | 'getLocation'>
  readonly searchConsole: Pick<SearchConsoleProvider, 'listSites'>
}

/**
 * The capability the enumeration runs as.
 *
 * `gbp_location` rather than `gbp_reviews`: reading locations is what this call does, `localSeoChecker`
 * declares it, and its declared degraded mode — `manual_snapshot` — is the honest answer for a picker that
 * cannot reach Google. Enumerating as `gbp_reviews` would report the review autoresponder as degraded
 * because a settings screen could not list locations.
 */
const ENUMERATION_CAPABILITY: DeclaredCapability = 'gbp_location'

/**
 * Deduplicates locations by `placeId`, keeping the first account that returned each.
 *
 * First in the order `accounts.list` returned, which is Google's own order and therefore stable between
 * two calls. *Which* account is kept matters less than it looks — the v4 reviews path works under any
 * account that manages the location — but it must be **decided** rather than left to whichever account the
 * loop reached last, because the account is persisted and a value that changes between two identical runs
 * is a value nobody can reason about.
 */
export function dedupeByPlaceId(locations: readonly EnumeratedLocation[]): readonly PickerChoice[] {
  const byPlaceId = new Map<string, { choice: EnumeratedLocation; alsoUnder: string[] }>()
  for (const location of locations) {
    const existing = byPlaceId.get(location.placeId)
    if (existing === undefined) {
      byPlaceId.set(location.placeId, { choice: location, alsoUnder: [] })
      continue
    }
    if (existing.choice.account !== location.account) existing.alsoUnder.push(location.account)
  }
  return [...byPlaceId.values()].map(({ choice, alsoUnder }) => ({
    ...choice,
    alsoUnderAccounts: alsoUnder,
    mapsUrl: mapsLinkFor(choice.placeId),
    heldInLocationGroup: holdsLocationsIndependently(choice.accountType),
  }))
}

/** The resource currently selected for a capability, or null. Never throws on a half-written row. */
async function selectedGbpRef(
  deps: PickerDeps,
  connectionId: string | null,
): Promise<GbpResourceRef | null> {
  if (connectionId === null) return null
  const rows = await deps.selections.capabilitiesFor(connectionId)
  const row = rows.find((r) => r.capability === 'gbp_reviews' && r.resourceRef !== null)
  if (row === undefined) return null
  // A stored row that does not parse is reported as "nothing selected" rather than raised: the picker's
  // job is to let somebody fix it, and a screen that throws is a screen that cannot.
  try {
    return parseGbpResourceRef(row.resourceRef)
  } catch {
    return null
  }
}

async function selectedGscRef(
  deps: PickerDeps,
  connectionId: string | null,
): Promise<GscResourceRef | null> {
  if (connectionId === null) return null
  const rows = await deps.selections.capabilitiesFor(connectionId)
  const row = rows.find((r) => r.capability === 'gsc' && r.resourceRef !== null)
  if (row === undefined) return null
  try {
    return parseGscResourceRef(row.resourceRef)
  } catch {
    return null
  }
}

/**
 * Enumerates every account and every location under each, deduped by `placeId`.
 *
 * **Under every account, including the LOCATION_GROUP ones.** That is not a refinement: an account of type
 * `LOCATION_GROUP` holds locations the `PERSONAL` account does not return (docs/10 §7). Enumerating only the
 * personal account is not merely incomplete — against this business's own fixtures it returns the *decoy*,
 * an unrelated airport spa of the same name, and nothing else. So the partial answer is not an empty screen
 * anybody would question; it is a plausible screen with one wrong row on it.
 */
export async function enumerateGbpChoices(
  deps: PickerDeps,
  options: { readonly connectionId?: string } = {},
): Promise<GbpPickerView> {
  const outcome = await withGoogle(
    deps.google,
    ENUMERATION_CAPABILITY,
    async () => {
      const enumeration = await enumerateAccounts(deps.profile)
      if (enumeration.kind === 'no_profiles_found') {
        return { accountsSeen: 0, choices: [] as readonly PickerChoice[] }
      }
      const located: EnumeratedLocation[] = []
      for (const account of enumeration.accounts) {
        located.push(...(await listLocationsUnder(deps.profile, account, LOCATION_READ_MASK)))
      }
      return { accountsSeen: enumeration.accounts.length, choices: dedupeByPlaceId(located) }
    },
    // The one call in this system that runs before a resource exists — it is how one is chosen.
    {
      resource: 'enumerating',
      ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
    },
  )

  if (outcome.kind === 'degraded') {
    const state = PICKER_STATE_FOR_CAUSE[outcome.cause]
    return {
      state,
      guidance: PICKER_GUIDANCE[state],
      connectionId: outcome.connectionId,
      choices: [],
      accountsSeen: 0,
      selected: await selectedGbpRef(deps, outcome.connectionId),
      correlationId: outcome.correlationId,
    }
  }

  // Accounts but no locations is still "no profiles found" from the owner's point of view, and
  // `accountsSeen` is what lets the surface say which of the two happened without a second state nobody
  // has a different sentence for.
  const state: PickerState = outcome.value.choices.length > 0 ? 'ready' : 'no_profiles_found'
  return {
    state,
    guidance: PICKER_GUIDANCE[state],
    connectionId: outcome.connectionId,
    choices: outcome.value.choices,
    accountsSeen: outcome.value.accountsSeen,
    selected: await selectedGbpRef(deps, outcome.connectionId),
    correlationId: outcome.correlationId,
  }
}

/**
 * Enumerates the Search Console properties the connected account can see.
 *
 * Runs as `gsc`, which is a **separate capability on a separate scope** — and that is the ordering fact this
 * unit is asked to prove: Search Console is not gated behind the Business Profile application, so this
 * enumeration succeeds and its selection persists on a connection whose every GBP capability is refused
 * (docs/10 §2 and §9).
 */
export async function enumerateSearchConsoleChoices(
  deps: PickerDeps,
  options: { readonly connectionId?: string } = {},
): Promise<GscPickerView> {
  const outcome = await withGoogle(
    deps.google,
    'gsc',
    async () => listSearchConsoleSites(deps.searchConsole),
    {
      resource: 'enumerating',
      ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
    },
  )

  if (outcome.kind === 'degraded') {
    const state = PICKER_STATE_FOR_CAUSE[outcome.cause]
    return {
      state,
      guidance: PICKER_GUIDANCE[state],
      connectionId: outcome.connectionId,
      choices: [],
      selected: await selectedGscRef(deps, outcome.connectionId),
      correlationId: outcome.correlationId,
    }
  }

  const choices: readonly SiteChoice[] = outcome.value.map((site) => ({
    siteUrl: site.siteUrl,
    permissionLevel: site.permissionLevel,
    selectable: siteIsUsable(site),
    isDomainProperty: isDomainProperty(site.siteUrl),
  }))
  const state: PickerState = choices.some((choice) => choice.selectable)
    ? 'ready'
    : 'no_verified_property'
  return {
    state,
    guidance: PICKER_GUIDANCE[state],
    connectionId: outcome.connectionId,
    choices,
    selected: await selectedGscRef(deps, outcome.connectionId),
    correlationId: outcome.correlationId,
  }
}

/** What a completed selection reports back. */
export interface SelectionOutcome<Ref> {
  readonly connectionId: string
  readonly capabilities: readonly GoogleCapability[]
  readonly resourceRef: Ref
  readonly correlationId: string
}

/**
 * Persists one Business Profile listing as the resource for every Business Profile capability.
 *
 * **One choice fills all three GBP capabilities** — reviews, location and performance — because they are
 * three APIs over one listing. Asking the owner the same question three times is not extra safety: it is
 * three chances to answer differently, and a system whose review replies and consistency check point at
 * different listings is a system that cannot be reasoned about at all. Search Console is *not* in this set,
 * which is the whole point of the next function.
 *
 * The selection is confirmed against Google first, with `locations.get`, and refuses if the `placeId` that
 * comes back is not the one the owner clicked — a listing can be merged or moved between accounts by Google
 * between the enumeration and the click, and persisting the stale answer would store a guess as a fact.
 */
export async function selectGbpLocation(
  deps: PickerDeps,
  args: {
    readonly connectionId: string
    readonly placeId: string
    readonly actor: SelectionActor
  },
): Promise<SelectionOutcome<GbpResourceRef>> {
  const view = await enumerateGbpChoices(deps, { connectionId: args.connectionId })
  if (view.state !== 'ready') {
    throw new AppError(
      'forbidden',
      `The listings cannot be read, so nothing was selected: ${view.guidance}`,
      { details: { reason: view.state, connectionId: args.connectionId } },
    )
  }
  const choice = view.choices.find((candidate) => candidate.placeId === args.placeId)
  if (choice === undefined) {
    throw new AppError(
      'not_found',
      'That listing is not one this Google account manages. Nothing was selected — a placeId that is ' +
        'not in the enumeration is either a stale screen or another business.',
      { details: { reason: PICKER_CHOICE_UNKNOWN, placeId: args.placeId } },
    )
  }

  const confirmed = await withGoogle(
    deps.google,
    ENUMERATION_CAPABILITY,
    async () =>
      getLocationUnder(
        deps.profile,
        { name: choice.account, accountName: choice.accountName, type: choice.accountType },
        choice.location,
        LOCATION_READ_MASK,
      ),
    { resource: 'enumerating', connectionId: args.connectionId },
  )
  if (confirmed.kind === 'degraded') {
    const state = PICKER_STATE_FOR_CAUSE[confirmed.cause]
    throw new AppError('forbidden', `The listing could not be re-read: ${PICKER_GUIDANCE[state]}`, {
      details: { reason: state, connectionId: args.connectionId },
    })
  }
  if (confirmed.value.placeId !== choice.placeId) {
    throw new AppError(
      'conflict',
      'Google returned a different listing for that location than the one on the screen, so nothing ' +
        'was selected. A listing that has been merged or moved has to be chosen again from a fresh list.',
      {
        details: {
          reason: PICKER_LISTING_MOVED,
          chosenPlaceId: choice.placeId,
          returnedPlaceId: confirmed.value.placeId,
        },
      },
    )
  }

  const resourceRef: GbpResourceRef = {
    account: choice.account,
    location: choice.location,
    placeId: choice.placeId,
  }
  // Parsed before it is written, not after. The reader is strict about the `accounts/` and `locations/`
  // prefixes, and the only way to guarantee a row satisfies it is to ask the same question on the way in —
  // otherwise the first thing to notice is the reviews adapter, on a cron job, weeks later.
  parseGbpResourceRef(resourceRef)

  const rows = await deps.selections.capabilitiesFor(args.connectionId)
  const capabilities = rows
    .filter((row) => row.isPrimary && isBusinessProfileCapability(row.capability))
    .map((row) => row.capability)
  if (capabilities.length === 0) {
    throw new AppError(
      'not_found',
      `Connection ${args.connectionId} has no Business Profile capability to select a listing for. A ` +
        'consent registers one per capability, so there is nothing here for a selection to fill.',
      { details: { connectionId: args.connectionId } },
    )
  }

  for (const capability of capabilities) {
    await writeSelection(deps, {
      connectionId: args.connectionId,
      capability,
      resourceRef,
      actor: args.actor,
      correlationId: view.correlationId,
      detail: {
        placeId: choice.placeId,
        account: choice.account,
        location: choice.location,
        title: choice.title,
        accountType: choice.accountType,
      },
    })
  }

  return {
    connectionId: args.connectionId,
    capabilities,
    resourceRef,
    correlationId: view.correlationId,
  }
}

/**
 * Persists one Search Console property as the `gsc` resource, and nothing else.
 *
 * Independent of the listing by construction: it verifies against `sites.list`, writes only the `gsc`
 * capability row, and never reads a Business Profile capability. A test asserts that picking one does not
 * pick the other, in both directions — which is the assertion that would fail the day somebody "helpfully"
 * derives the property from the listing's `websiteUri`.
 */
export async function selectSearchConsoleProperty(
  deps: PickerDeps,
  args: {
    readonly connectionId: string
    readonly siteUrl: string
    readonly actor: SelectionActor
  },
): Promise<SelectionOutcome<GscResourceRef>> {
  // The I/O inside the chokepoint, the decision outside it. Putting `assertSiteSelectable` in the body
  // classified *our own* refusal as an upstream Google failure: the chokepoint maps anything thrown in
  // there through the taxonomy, so "you are not verified on that property" came back as
  // `TransientUpstream` with its reason discarded, and wrote a failure row onto the owner's connection
  // dashboard for something Google did not do.
  const listed = await withGoogle(
    deps.google,
    'gsc',
    async () => listSearchConsoleSites(deps.searchConsole),
    { resource: 'enumerating', connectionId: args.connectionId },
  )
  if (listed.kind === 'degraded') {
    const state = PICKER_STATE_FOR_CAUSE[listed.cause]
    throw new AppError(
      'forbidden',
      `The Search Console properties could not be read, so nothing was selected: ${PICKER_GUIDANCE[state]}`,
      { details: { reason: state, connectionId: args.connectionId } },
    )
  }
  const verified = assertSiteSelectable(listed.value, args.siteUrl)

  const resourceRef: GscResourceRef = { siteUrl: verified.siteUrl }
  parseGscResourceRef(resourceRef)

  await writeSelection(deps, {
    connectionId: args.connectionId,
    capability: 'gsc',
    resourceRef,
    actor: args.actor,
    correlationId: listed.correlationId,
    detail: {
      siteUrl: verified.siteUrl,
      permissionLevel: verified.permissionLevel,
      propertyKind: isDomainProperty(verified.siteUrl) ? 'domain' : 'url_prefix',
    },
  })

  return {
    connectionId: args.connectionId,
    capabilities: ['gsc'],
    resourceRef,
    correlationId: listed.correlationId,
  }
}

/**
 * The write, and the append-only row that records who chose what.
 *
 * `capability_changed` is 0016's vocabulary for this, and the event is mirrored into `audit_event` by a
 * trigger in the same transaction — so the actor and the chosen `placeId` or `siteUrl` reach the global
 * audit log without this code writing to two tables. The detail carries the correlation id, so the three
 * rows one Business Profile choice produces are recognisable as one action by a human rather than as three.
 *
 * Nothing in the detail can be a token: the keys are named here, and a CHECK constraint refuses the
 * forbidden ones outright, because rows reach query logs, `pg_stat_statements`, backups and pg-boss
 * payloads (docs/10 §4).
 */
async function writeSelection(
  deps: PickerDeps,
  args: {
    readonly connectionId: string
    readonly capability: GoogleCapability
    readonly resourceRef: Readonly<Record<string, unknown>>
    readonly actor: SelectionActor
    readonly correlationId: string
    readonly detail: Readonly<Record<string, unknown>>
  },
): Promise<void> {
  await deps.selections.selectCapabilityResource({
    connectionId: args.connectionId,
    capability: args.capability,
    resourceRef: args.resourceRef,
    verifiedAt: deps.google.clock.now(),
  })
  await deps.selections.appendEvent({
    connectionId: args.connectionId,
    googleSub: null,
    event: 'capability_changed',
    actorKind: args.actor.kind,
    actorLabel: args.actor.label,
    detail: {
      capability: args.capability,
      source: 'picker',
      correlationId: args.correlationId,
      ...args.detail,
    },
  })
}
