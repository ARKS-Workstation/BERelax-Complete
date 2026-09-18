import { generateKek } from '@berelax/clinical'
import { fixedClock, GOOGLE_CAPABILITIES, instantFromIso } from '@berelax/core'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  AIRPORT_DECOY_LOCATION,
  AL_ZAHIYAH_LOCATION,
  type BusinessProfileProvider,
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  createFakeSearchConsole,
  GBP_LOCATION_GROUP_ACCOUNT,
  GBP_PERSONAL_ACCOUNT,
  type GbpAccount,
  type GbpLocation,
  type SearchConsoleSite,
} from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  getLocationUnder,
  LOCATION_READ_MASK,
  listLocationsUnder,
  READ_MASK_INCOMPLETE,
  READ_MASK_MISSING,
} from './adapters/business-information.ts'
import { SITE_NOT_LISTED, SITE_NOT_VERIFIED } from './adapters/search-console.ts'
import {
  dedupeByPlaceId,
  enumerateGbpChoices,
  enumerateSearchConsoleChoices,
  PICKER_GUIDANCE,
  PICKER_STATE_FOR_CAUSE,
  type PickerDeps,
  type PickerState,
  parseGbpResourceRef,
  RESOURCE_REF_MALFORMED,
  reviewsPathFor,
  type SelectionActor,
  selectGbpLocation,
  selectSearchConsoleProperty,
} from './capability-resolver.ts'
import { connectionRecord, createMemoryConnectionStore } from './memory-store.ts'
import { createMemoryRefreshLock } from './token-refresh.ts'
import { connectionBinding, sealToken } from './token-store.ts'
import { type DegradationCause, type WithGoogleDeps, withGoogle } from './with-google.ts'

/**
 * G-CONN-05 — the picker, LOCATION_GROUP enumeration, and GSC as a separate selection.
 *
 * The assertion this file exists for is the last one: **`withGoogle` stops degrading once a location is
 * picked.** Everything above it is the reason that assertion is safe rather than accidental — that the
 * listing came from every account rather than the personal one, that it was deduped by `placeId`, that the
 * account was persisted with it, and that picking a listing did not also pick a Search Console property.
 *
 * Every claim is paired with the control that must fail. The two that matter most:
 *
 *   - the read-mask refusals are asserted with a **transport spy at zero calls**, and the control is the
 *     same spy answering once when the mask is right — without it, a guard that rejected everything would
 *     look identical;
 *   - the LOCATION_GROUP case is paired with the hazard it prevents: enumerating only the PERSONAL account
 *     does not report "nothing found", it reports the **wrong listing**, which is the failure that silently
 *     publishes replies against another company's profile.
 */
const KEK = generateKek('v1')
const NOW_ISO = '2026-09-18T10:00:00.000Z'
const CONNECTION_ID = '01920000-0000-7000-8000-0000000005a1'
const OTHER_CONNECTION_ID = '01920000-0000-7000-8000-0000000005b2'
const SUB = '104729518362094771533'
const REFRESH_TOKEN = '1//09-FIXTURE-picker-refresh-token-never-logged'
const ACTOR: SelectionActor = { kind: 'staff', label: 'settings picker (test)' }

const DOMAIN_PROPERTY = 'sc-domain:berelaxmassage.com'
const UNVERIFIED_PROPERTY = 'https://berelax.netlify.app/'

interface Harness {
  readonly deps: PickerDeps
  readonly google: WithGoogleDeps
  readonly store: ReturnType<typeof createMemoryConnectionStore>
  readonly apiFailures: FailureScript
  readonly gscFailures: FailureScript
}

/**
 * One connection with the four capability rows a consent leaves behind — every `resourceRef` null.
 *
 * That is the state this unit starts from and the reason it exists: `completeGoogleConsent` cannot know
 * which listing is the business's, so it registers the capability and leaves the resource for the picker.
 */
function harness(
  options: {
    readonly accounts?: readonly GbpAccount[]
    readonly locationsByAccount?: Readonly<Record<string, readonly GbpLocation[]>>
    readonly sites?: readonly SearchConsoleSite[]
    readonly connections?: readonly string[]
  } = {},
): Harness {
  const providerLog = createCallLog(() => NOW_ISO)
  const apiFailures = new FailureScript()
  const gscFailures = new FailureScript()
  const oauthFailures = new FailureScript()

  const store = createMemoryConnectionStore()
  for (const id of options.connections ?? [CONNECTION_ID]) {
    store.put(
      connectionRecord({
        id,
        googleSub: id === CONNECTION_ID ? SUB : `${SUB}-${id}`,
        refreshToken: sealToken(
          KEK,
          connectionBinding({
            connectionId: id,
            googleSub: id === CONNECTION_ID ? SUB : `${SUB}-${id}`,
          }),
          REFRESH_TOKEN,
        ),
        consentAt: instantFromIso('2026-09-17T10:00:00.000Z'),
      }),
    )
    for (const capability of GOOGLE_CAPABILITIES) {
      store.putCapability({
        connectionId: id,
        capability,
        resourceRef: null,
        health: 'unknown',
        isPrimary: true,
      })
    }
  }

  const google: WithGoogleDeps = {
    store,
    lock: createMemoryRefreshLock(store),
    oauth: createFakeGoogleOAuth({
      log: providerLog,
      failures: oauthFailures,
      now: () => NOW_ISO,
      sub: SUB,
    }),
    kek: KEK,
    clock: fixedClock(NOW_ISO),
    logger: { log: () => {} },
    newCorrelationId: () => 'corr-picker-0001',
  }

  const fakeOptions = {
    log: providerLog,
    failures: apiFailures,
    now: () => NOW_ISO,
    ...(options.accounts === undefined ? {} : { accounts: options.accounts }),
    ...(options.locationsByAccount === undefined
      ? {}
      : { locationsByAccount: options.locationsByAccount }),
  }

  return {
    google,
    store,
    apiFailures,
    gscFailures,
    deps: {
      google,
      selections: store,
      profile: createFakeBusinessProfile(fakeOptions),
      searchConsole: createFakeSearchConsole({
        log: providerLog,
        failures: gscFailures,
        now: () => NOW_ISO,
        ...(options.sites === undefined ? {} : { sites: options.sites }),
      }),
    },
  }
}

/** A transport that records every call and answers nothing. Its whole job is to stay at zero. */
function transportSpy(): {
  readonly transport: Pick<BusinessProfileProvider, 'listLocations' | 'getLocation'>
  calls: number
} {
  const spy = {
    calls: 0,
    transport: {
      async listLocations() {
        spy.calls += 1
        return []
      },
      async getLocation(): Promise<GbpLocation> {
        spy.calls += 1
        return AL_ZAHIYAH_LOCATION
      },
    },
  }
  return spy
}

/**
 * The selection events only.
 *
 * A token refresh writes a `refreshed` row of its own on the first call of every harness — obtaining the
 * token is what the chokepoint does — so a total count would be a count of two unrelated things. Filtering
 * by the event name is also the stronger assertion: it says *these* rows were written, not that some row was.
 */
function selectionEvents(store: ReturnType<typeof createMemoryConnectionStore>) {
  return store.events().filter((event) => event.event === 'capability_changed')
}

/** Rows that claim a Google call failed. Zero of them is what a refusal by our own code must produce. */
function failureEvents(store: ReturnType<typeof createMemoryConnectionStore>) {
  return store.events().filter((event) => event.event === 'health_check_failed')
}

async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AppError) return error.details['reason']
    throw error
  }
  throw new Error('the call resolved; nothing was rejected')
}

let h: Harness

beforeEach(() => {
  h = harness()
})

describe('acceptance — a readMask-less call is refused before the transport sees it', () => {
  it('rejects locations.list with no readMask, with the spy at zero calls', async () => {
    const spy = transportSpy()
    expect(await reasonOf(listLocationsUnder(spy.transport, GBP_PERSONAL_ACCOUNT, undefined))).toBe(
      READ_MASK_MISSING,
    )
    expect(spy.calls).toBe(0)
  })

  it('rejects a partial readMask too, because Google accepts one and answers without the placeId', async () => {
    const spy = transportSpy()
    // The dangerous case: Google returns 200 for this, with no `metadata` and therefore no placeId. The
    // picker would dedupe every location under `undefined` and merge two businesses into one row.
    expect(
      await reasonOf(listLocationsUnder(spy.transport, GBP_PERSONAL_ACCOUNT, ['name', 'title'])),
    ).toBe(READ_MASK_INCOMPLETE)
    expect(spy.calls).toBe(0)
  })

  it('rejects locations.get with no readMask, with the spy at zero calls', async () => {
    const spy = transportSpy()
    expect(
      await reasonOf(
        getLocationUnder(spy.transport, GBP_PERSONAL_ACCOUNT, AL_ZAHIYAH_LOCATION.name, undefined),
      ),
    ).toBe(READ_MASK_MISSING)
    expect(spy.calls).toBe(0)
  })

  it('calls the transport exactly once when the mask is the one this system sends', async () => {
    // The control. A guard that rejected everything would satisfy all three assertions above, and the spy
    // would stay at zero for the wrong reason.
    const spy = transportSpy()
    await listLocationsUnder(spy.transport, GBP_PERSONAL_ACCOUNT, LOCATION_READ_MASK)
    expect(spy.calls).toBe(1)
    await getLocationUnder(
      spy.transport,
      GBP_PERSONAL_ACCOUNT,
      AL_ZAHIYAH_LOCATION.name,
      LOCATION_READ_MASK,
    )
    expect(spy.calls).toBe(2)
  })

  it('is refused by the fake as well, so the adapter is not the only thing standing in the way', async () => {
    // A caller that bypassed the adapter would still not get away with it: the fake answers the way Google
    // does. Without this, the adapter's guard would be the only evidence that the mask is mandatory at all.
    await expect(
      h.deps.profile.listLocations({ parent: GBP_LOCATION_GROUP_ACCOUNT.name }),
    ).rejects.toThrow(AppError)
    await expect(
      h.deps.profile.listLocations({
        parent: GBP_LOCATION_GROUP_ACCOUNT.name,
        readMask: LOCATION_READ_MASK,
      }),
    ).resolves.toHaveLength(1)
  })
})

describe('acceptance — locations held only under a LOCATION_GROUP account appear in the picker', () => {
  it('finds the business listing, which the PERSONAL account does not return', async () => {
    const view = await enumerateGbpChoices(h.deps, { connectionId: CONNECTION_ID })
    expect(view.state).toBe('ready')
    expect(view.accountsSeen).toBe(2)
    const chosen = view.choices.find(
      (choice) => choice.placeId === AL_ZAHIYAH_LOCATION.metadata.placeId,
    )
    expect(chosen).toBeDefined()
    expect(chosen?.account).toBe(GBP_LOCATION_GROUP_ACCOUNT.name)
    expect(chosen?.accountType).toBe('LOCATION_GROUP')
    // The address, not only the title: it is what tells the two Be Relax rows apart on a screen.
    expect(chosen?.address).toContain('250 Al Meena Street')
    expect(chosen?.address).toContain('Al Zahiyah')
    // And the picker can say WHERE it is held, which is what an owner who cannot find it under their own
    // account needs to be told. The decoy under the personal account is the control.
    expect(chosen?.heldInLocationGroup).toBe(true)
    expect(
      view.choices.find((choice) => choice.placeId === AIRPORT_DECOY_LOCATION.metadata.placeId)
        ?.heldInLocationGroup,
    ).toBe(false)
  })

  it('finds the WRONG listing when only the personal account is enumerated', async () => {
    // The control, and the reason the criterion is worth a line. Enumerating one account does not produce
    // an empty picker — it produces a picker containing an unrelated airport spa also called Be Relax, and
    // selecting that publishes replies against another company's listing.
    const personalOnly = await listLocationsUnder(
      h.deps.profile,
      GBP_PERSONAL_ACCOUNT,
      LOCATION_READ_MASK,
    )
    expect(personalOnly.map((location) => location.placeId)).toEqual([
      AIRPORT_DECOY_LOCATION.metadata.placeId,
    ])
    expect(personalOnly.map((location) => location.placeId)).not.toContain(
      AL_ZAHIYAH_LOCATION.metadata.placeId,
    )
  })

  it('yields exactly one entry for a location returned under both accounts, deduped by placeId', async () => {
    const both = harness({
      locationsByAccount: {
        [GBP_PERSONAL_ACCOUNT.name]: [AL_ZAHIYAH_LOCATION, AIRPORT_DECOY_LOCATION],
        [GBP_LOCATION_GROUP_ACCOUNT.name]: [AL_ZAHIYAH_LOCATION],
      },
    })
    const view = await enumerateGbpChoices(both.deps, { connectionId: CONNECTION_ID })
    const matches = view.choices.filter(
      (choice) => choice.placeId === AL_ZAHIYAH_LOCATION.metadata.placeId,
    )
    expect(matches).toHaveLength(1)
    // Kept the first account `accounts.list` returned, and said where else it was found rather than
    // dropping the fact silently.
    expect(matches[0]?.account).toBe(GBP_PERSONAL_ACCOUNT.name)
    expect(matches[0]?.alsoUnderAccounts).toEqual([GBP_LOCATION_GROUP_ACCOUNT.name])
    // Three listings were returned across the two accounts and two distinct businesses came out.
    expect(view.choices).toHaveLength(2)
  })

  it('does not merge two different placeIds', () => {
    // The control on the dedupe: a key that was constant would collapse every listing into one row, and the
    // assertion above would pass.
    const deduped = dedupeByPlaceId([
      {
        account: GBP_PERSONAL_ACCOUNT.name,
        accountName: GBP_PERSONAL_ACCOUNT.accountName,
        accountType: 'PERSONAL',
        location: AL_ZAHIYAH_LOCATION.name,
        title: AL_ZAHIYAH_LOCATION.title,
        placeId: 'ChIJ-fake-one',
        address: 'somewhere',
        websiteUri: null,
      },
      {
        account: GBP_PERSONAL_ACCOUNT.name,
        accountName: GBP_PERSONAL_ACCOUNT.accountName,
        accountType: 'PERSONAL',
        location: AIRPORT_DECOY_LOCATION.name,
        title: AL_ZAHIYAH_LOCATION.title,
        placeId: 'ChIJ-fake-two',
        address: 'somewhere else',
        websiteUri: null,
      },
    ])
    expect(deduped).toHaveLength(2)
    expect(deduped.every((choice) => choice.alsoUnderAccounts.length === 0)).toBe(true)
    expect(deduped.every((choice) => choice.heldInLocationGroup === false)).toBe(true)
  })
})

describe('acceptance — an empty accounts list is not a gating error', () => {
  it('resolves HTTP 200 with no accounts to no_profiles_found', async () => {
    const empty = harness({ accounts: [] })
    const view = await enumerateGbpChoices(empty.deps, { connectionId: CONNECTION_ID })
    expect(view.state).toBe('no_profiles_found')
    expect(view.state).not.toBe('access_not_granted')
    expect(view.accountsSeen).toBe(0)
    expect(view.choices).toEqual([])
  })

  it('resolves a refused call to access_not_granted, which is a different state and a different sentence', async () => {
    const view = await (async () => {
      h.apiFailures.failAlways('access_not_granted')
      return enumerateGbpChoices(h.deps, { connectionId: CONNECTION_ID })
    })()
    expect(view.state).toBe('access_not_granted')
    // The substance of "asserted to be a distinct value": not only the enum differs, the instruction to the
    // owner differs. One says sign in with the account that owns the listing; the other says wait for
    // Google. Telling them to wait for an approval that will change nothing is the failure being prevented.
    const empty = PICKER_GUIDANCE['no_profiles_found']
    const refused = PICKER_GUIDANCE['access_not_granted']
    expect(empty).not.toBe(refused)
    expect(empty.toLowerCase()).toContain('sign in with the account that owns the listing')
    expect(empty.toLowerCase()).not.toContain('approv')
    expect(refused.toLowerCase()).toContain('approve')
  })

  it('resolves to ready when there is something to choose', async () => {
    // The control for both: a resolver that answered no_profiles_found always would satisfy the first case.
    expect((await enumerateGbpChoices(h.deps, { connectionId: CONNECTION_ID })).state).toBe('ready')
  })

  it('has a plain-English sentence for every state, and no scope strings anywhere', () => {
    const states: readonly PickerState[] = Object.keys(PICKER_GUIDANCE) as PickerState[]
    expect(states.length).toBeGreaterThan(5)
    for (const state of states) {
      expect(PICKER_GUIDANCE[state].length, state).toBeGreaterThan(30)
      // docs/10 §4: states are shown in plain English, never as scope URLs.
      expect(PICKER_GUIDANCE[state], state).not.toContain('googleapis.com')
    }
    // And the cause table is total, so a new taxonomy class cannot arrive without a state.
    const causes: readonly DegradationCause[] = Object.keys(
      PICKER_STATE_FOR_CAUSE,
    ) as DegradationCause[]
    for (const cause of causes) expect(states).toContain(PICKER_STATE_FOR_CAUSE[cause])
  })
})

describe('acceptance — selecting a location persists account, location and placeId', () => {
  it('fills every Business Profile capability and builds the v4 reviews path from the row alone', async () => {
    const outcome = await selectGbpLocation(h.deps, {
      connectionId: CONNECTION_ID,
      placeId: AL_ZAHIYAH_LOCATION.metadata.placeId,
      actor: ACTOR,
    })
    expect([...outcome.capabilities].sort()).toEqual([
      'gbp_location',
      'gbp_performance',
      'gbp_reviews',
    ])

    const rows = await h.store.capabilitiesFor(CONNECTION_ID)
    const reviews = rows.find((row) => row.capability === 'gbp_reviews')
    expect(reviews?.resourceRef).toEqual({
      account: GBP_LOCATION_GROUP_ACCOUNT.name,
      location: AL_ZAHIYAH_LOCATION.name,
      placeId: AL_ZAHIYAH_LOCATION.metadata.placeId,
    })

    // Built from the stored ref and nothing else — which is the whole reason `account` is persisted, since
    // v1 returns only `locations/{l}` while v4 needs `accounts/{a}/locations/{l}/reviews`.
    const path = reviewsPathFor(reviews?.resourceRef ?? null)
    expect(path).toBe(`${GBP_LOCATION_GROUP_ACCOUNT.name}/${AL_ZAHIYAH_LOCATION.name}/reviews`)
    expect(path).toMatch(/^accounts\/[^/]+\/locations\/[^/]+\/reviews$/)
  })

  it('refuses to build a v4 path from a row missing the account, rather than guessing one', async () => {
    // The control. A path builder that tolerated a missing account would produce `locations/2/reviews`,
    // which 404s at 03:00 on a cron job — and the ref would look complete on the row.
    expect(
      await reasonOf(
        Promise.resolve().then(() =>
          reviewsPathFor({ location: AL_ZAHIYAH_LOCATION.name, placeId: 'ChIJ-fake' }),
        ),
      ),
    ).toBe(RESOURCE_REF_MALFORMED)
    // And an unprefixed location, which is the same value a human would type.
    expect(
      await reasonOf(
        Promise.resolve().then(() =>
          reviewsPathFor({ account: 'accounts/1', location: '2', placeId: 'ChIJ-fake' }),
        ),
      ),
    ).toBe(RESOURCE_REF_MALFORMED)
    expect(() => parseGbpResourceRef(null)).toThrow(AppError)
  })

  it('refuses a placeId that is not in the enumeration, and writes nothing', async () => {
    expect(
      await reasonOf(
        selectGbpLocation(h.deps, {
          connectionId: CONNECTION_ID,
          placeId: 'ChIJ-fake-place-somebody-elses-listing',
          actor: ACTOR,
        }),
      ),
    ).toBe('google_picker_choice_unknown')
    const rows = await h.store.capabilitiesFor(CONNECTION_ID)
    expect(rows.every((row) => row.resourceRef === null)).toBe(true)
    expect(selectionEvents(h.store)).toEqual([])
  })

  it('writes to the connection it was told to, never to another one', async () => {
    // A picker that enumerated under one connection and wrote to another would offer one account's listings
    // and persist them under a different account's grant, which is the failure that reaches a stranger's
    // listing. Two connections exist here; only the named one is touched.
    const two = harness({ connections: [CONNECTION_ID, OTHER_CONNECTION_ID] })
    await selectGbpLocation(two.deps, {
      connectionId: OTHER_CONNECTION_ID,
      placeId: AL_ZAHIYAH_LOCATION.metadata.placeId,
      actor: ACTOR,
    })
    const touched = await two.store.capabilitiesFor(OTHER_CONNECTION_ID)
    const untouched = await two.store.capabilitiesFor(CONNECTION_ID)
    expect(touched.filter((row) => row.resourceRef !== null)).toHaveLength(3)
    expect(untouched.every((row) => row.resourceRef === null)).toBe(true)
  })
})

describe('acceptance — GSC is selected independently of the listing', () => {
  it('selects a Search Console property and leaves every Business Profile capability unselected', async () => {
    const outcome = await selectSearchConsoleProperty(h.deps, {
      connectionId: CONNECTION_ID,
      siteUrl: DOMAIN_PROPERTY,
      actor: ACTOR,
    })
    expect(outcome.resourceRef).toEqual({ siteUrl: DOMAIN_PROPERTY })

    const rows = await h.store.capabilitiesFor(CONNECTION_ID)
    expect(rows.find((row) => row.capability === 'gsc')?.resourceRef).toEqual({
      siteUrl: DOMAIN_PROPERTY,
    })
    // The point of the criterion: picking one does not pick the other.
    for (const capability of ['gbp_reviews', 'gbp_location', 'gbp_performance'] as const) {
      expect(rows.find((row) => row.capability === capability)?.resourceRef, capability).toBeNull()
    }
  })

  it('and the other direction: selecting a listing does not select a property', async () => {
    await selectGbpLocation(h.deps, {
      connectionId: CONNECTION_ID,
      placeId: AL_ZAHIYAH_LOCATION.metadata.placeId,
      actor: ACTOR,
    })
    const rows = await h.store.capabilitiesFor(CONNECTION_ID)
    expect(rows.find((row) => row.capability === 'gsc')?.resourceRef).toBeNull()
    // Not even though the listing carries a websiteUri that looks exactly like a URL-prefix property. That
    // resemblance is the trap: a `websiteUri` is a display field and a property is a verified resource.
    expect(AL_ZAHIYAH_LOCATION.websiteUri).toBe('https://berelaxmassage.com/')
  })

  it('refuses a property the account is listed on but not verified for', async () => {
    expect(
      await reasonOf(
        selectSearchConsoleProperty(h.deps, {
          connectionId: CONNECTION_ID,
          siteUrl: UNVERIFIED_PROPERTY,
          actor: ACTOR,
        }),
      ),
    ).toBe(SITE_NOT_VERIFIED)
    const rows = await h.store.capabilitiesFor(CONNECTION_ID)
    expect(rows.find((row) => row.capability === 'gsc')?.resourceRef).toBeNull()
  })

  it('refuses a property the account cannot see at all, with a different reason', async () => {
    // Distinct from the unverified case on purpose: one needs a different Google account, the other needs
    // two minutes in the Search Console UI, and one sentence for both leaves the owner unable to tell.
    expect(
      await reasonOf(
        selectSearchConsoleProperty(h.deps, {
          connectionId: CONNECTION_ID,
          siteUrl: 'https://not-ours.example/',
          actor: ACTOR,
        }),
      ),
    ).toBe(SITE_NOT_LISTED)
  })

  it('reports no_verified_property when nothing in the list can read data, not no_profiles_found', async () => {
    // The Search Console half of the first criterion. An account listed on a property it cannot read is one
    // screen away from an account that manages no Business Profile, and the two need different actions —
    // so the state differs and, more importantly, so does the sentence. Reusing the listing sentence here
    // would send the owner to their Business Profile to fix their website's search data.
    const unverifiedOnly = harness({
      sites: [{ siteUrl: UNVERIFIED_PROPERTY, permissionLevel: 'siteUnverifiedUser' }],
    })
    const view = await enumerateSearchConsoleChoices(unverifiedOnly.deps, {
      connectionId: CONNECTION_ID,
    })
    expect(view.state).toBe('no_verified_property')
    expect(view.guidance).not.toBe(PICKER_GUIDANCE['no_profiles_found'])
    expect(view.guidance.toLowerCase()).toContain('search console')
    expect(view.guidance.toLowerCase()).not.toContain('business profile')
    // The control: the shipped fixture list does contain a usable property, so the state above is about the
    // list rather than about an enumeration that never works.
    expect(
      (await enumerateSearchConsoleChoices(h.deps, { connectionId: CONNECTION_ID })).state,
    ).toBe('ready')
  })

  it('marks the unverified property unselectable in the picker and the verified ones selectable', async () => {
    const view = await enumerateSearchConsoleChoices(h.deps, { connectionId: CONNECTION_ID })
    expect(view.state).toBe('ready')
    expect(view.choices.map((choice) => choice.selectable)).toEqual([true, true, false])
    expect(view.choices[0]?.isDomainProperty).toBe(true)
    expect(view.choices[1]?.isDomainProperty).toBe(false)
  })
})

describe('acceptance — every selection writes an event naming the actor and what was chosen', () => {
  it('writes one capability_changed row per capability filled, with the placeId', async () => {
    await selectGbpLocation(h.deps, {
      connectionId: CONNECTION_ID,
      placeId: AL_ZAHIYAH_LOCATION.metadata.placeId,
      actor: ACTOR,
    })
    const events = selectionEvents(h.store)
    expect(events).toHaveLength(3)
    for (const event of events) {
      expect(event.event).toBe('capability_changed')
      expect(event.connectionId).toBe(CONNECTION_ID)
      expect(event.actorKind).toBe('staff')
      expect(event.actorLabel).toBe(ACTOR.label)
      expect(event.detail?.['placeId']).toBe(AL_ZAHIYAH_LOCATION.metadata.placeId)
      // One owner action, three rows: the correlation id is what makes them recognisable as one.
      expect(event.detail?.['correlationId']).toBe('corr-picker-0001')
    }
    expect(events.map((event) => event.detail?.['capability']).sort()).toEqual([
      'gbp_location',
      'gbp_performance',
      'gbp_reviews',
    ])
    // Nothing that looks like a token reaches a row; the memory store refuses the same keys the CHECK does.
    expect(JSON.stringify(events)).not.toContain(REFRESH_TOKEN)
  })

  it('writes one row naming the siteUrl for a Search Console selection', async () => {
    await selectSearchConsoleProperty(h.deps, {
      connectionId: CONNECTION_ID,
      siteUrl: DOMAIN_PROPERTY,
      actor: ACTOR,
    })
    const events = selectionEvents(h.store)
    expect(events).toHaveLength(1)
    expect(events[0]?.detail?.['siteUrl']).toBe(DOMAIN_PROPERTY)
    expect(events[0]?.detail?.['propertyKind']).toBe('domain')
    expect(events[0]?.actorLabel).toBe(ACTOR.label)
  })

  it('writes no row when nothing was selected, and does not blame Google for our own refusal', async () => {
    // Two controls in one. A ledger that recorded every attempt would make "an event was written" true
    // whatever happened, and the audit log would claim a selection that never took place.
    //
    // And the second assertion is the one that caught a real defect while this unit was being written: the
    // verification originally ran INSIDE the `withGoogle` body, so *our* refusal — the account is not
    // verified on that property — was classified as `TransientUpstream` and wrote a `health_check_failed`
    // row onto the owner's connection dashboard. The dashboard would have shown a Google failure for a
    // decision Google was not involved in.
    await reasonOf(
      selectSearchConsoleProperty(h.deps, {
        connectionId: CONNECTION_ID,
        siteUrl: UNVERIFIED_PROPERTY,
        actor: ACTOR,
      }),
    )
    expect(selectionEvents(h.store)).toEqual([])
    expect(failureEvents(h.store)).toEqual([])
  })
})

describe('acceptance — withGoogle stops degrading once a location is picked', () => {
  it('degrades with ResourceNotSelected before, and resolves the resource after', async () => {
    const before = await withGoogle(h.google, 'gbp_reviews', async () => 'unreachable')
    expect(before.kind).toBe('degraded')
    if (before.kind !== 'degraded') throw new Error('unreachable')
    expect(before.cause).toBe('ResourceNotSelected')
    expect(before.mode).toBe('draft_only')

    await selectGbpLocation(h.deps, {
      connectionId: CONNECTION_ID,
      placeId: AL_ZAHIYAH_LOCATION.metadata.placeId,
      actor: ACTOR,
    })

    const after = await withGoogle(h.google, 'gbp_reviews', async (context) => {
      // The body now receives the resource, which is the whole point: a consumer never resolves one itself.
      expect(context.resourceRef).toEqual({
        account: GBP_LOCATION_GROUP_ACCOUNT.name,
        location: AL_ZAHIYAH_LOCATION.name,
        placeId: AL_ZAHIYAH_LOCATION.metadata.placeId,
      })
      return reviewsPathFor(context.resourceRef)
    })
    expect(after.kind).toBe('ok')
    if (after.kind !== 'ok') throw new Error('unreachable')
    expect(after.value).toBe(
      `${GBP_LOCATION_GROUP_ACCOUNT.name}/${AL_ZAHIYAH_LOCATION.name}/reviews`,
    )
  })

  it('still degrades for the capability nobody selected, which is how the two stay independent', async () => {
    await selectGbpLocation(h.deps, {
      connectionId: CONNECTION_ID,
      placeId: AL_ZAHIYAH_LOCATION.metadata.placeId,
      actor: ACTOR,
    })
    const gsc = await withGoogle(h.google, 'gsc', async () => 'unreachable')
    expect(gsc.kind).toBe('degraded')
    if (gsc.kind !== 'degraded') throw new Error('unreachable')
    expect(gsc.cause).toBe('ResourceNotSelected')
    expect(gsc.mode).toBe('disabled')
  })

  it('reports not_connected for a connection that does not serve the capability', async () => {
    // Naming a connection narrows what the call can see; it can never widen it. A connection id nothing
    // holds degrades rather than resolving somebody else's row.
    const view = await enumerateGbpChoices(h.deps, {
      connectionId: '01920000-0000-7000-8000-00000000ffff',
    })
    expect(view.state).toBe('not_connected')
    expect(view.guidance).toBe(PICKER_GUIDANCE['not_connected'])
    expect(view.choices).toEqual([])
  })
})
