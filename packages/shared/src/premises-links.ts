/**
 * The address as one line, and the two links every consumer of it builds.
 *
 * docs/09 §4 lists "map embed, directions link" as *derived* outputs of the `premises` row, beside the
 * footer NAP and `/contact`. Derived means built from the row on every render — and built in **one**
 * place, because a map link assembled independently in a footer, on `/spa` and in `/api/facts` is three
 * copies of one URL, and the one that is wrong is the one nobody clicks.
 *
 * ## Why this lives in `shared` rather than in `ui` or in `db`
 *
 * Three packages need the same answer: `@berelax/ui` renders the links in the NAP block, `apps/web`
 * publishes them in `/api/facts`, and neither may import the other. `packages/db` may not import
 * `packages/core`, and `packages/ui` may not import `packages/db`, so the only package all of them may
 * depend on is this one (`.dependency-cruiser.cjs`: `shared` is the leaf).
 *
 * ## Why there is no WhatsApp link builder
 *
 * There is no canonical WhatsApp number (Y1-nap): docs/13 §3 records two, the prototype's and the live
 * site's, and `premises.phone_whatsapp` holds a placeholder `is_placeholder_text()` refuses. A
 * `wa.me/<number>` builder would exist to be called, and the first caller would pass the placeholder
 * and publish `wa.me/WHATSAPP-PENDING-Y1-NAP` — or, far worse, somebody would "fix" it by picking one of
 * the two candidates. The absence is the design. See `packages/db/src/seed/premises.ts`.
 */

/**
 * The parts of an address a link needs, named as the `premises` columns are.
 *
 * A structural type rather than an import from `@berelax/db`: `shared` may import nothing internal, and
 * the read path hands these fields straight across. Every optional field is `string | null` rather than
 * absent, because that is what a nullable column reads as and a consumer that has to handle both
 * `undefined` and `null` handles neither.
 */
export interface PostalAddress {
  readonly addressLine1: string
  readonly addressLine2: string | null
  readonly floor: string | null
  readonly area: string
  readonly emirate: string
  readonly countryCode: string
}

/**
 * The address as the lines a reader sees, in the order docs/13 §2 prints it, empty parts dropped.
 *
 * A list rather than a string, because the two consumers need different separators: an `<address>`
 * element wants line breaks and a map query wants commas. Building one from the other is a `join`; going
 * the other way is a parse.
 *
 * `floor` follows `addressLine2` rather than preceding it because the row merges the building reference
 * and the sector code into one column, and there is nowhere to put the floor between them. docs/13 §2
 * prints the floor before the sector; nothing downstream depends on that ordering, and inventing a column
 * for one token would be worse than the reordering.
 *
 * The country code is **not** here. Nobody writes "AE" under an Abu Dhabi address, and this is the list a
 * footer sets; {@link addressOneLine} appends it, because a geocoder resolves better with it.
 */
export function addressLines(address: PostalAddress): readonly string[] {
  return [
    address.addressLine1,
    address.addressLine2,
    address.floor,
    address.area,
    address.emirate,
  ].filter((part): part is string => part !== null && part.trim() !== '')
}

/** The address as one comma-separated line, country code included: what a map query wants. */
export function addressOneLine(address: PostalAddress): string {
  return [...addressLines(address), address.countryCode]
    .filter((part) => part.trim() !== '')
    .join(', ')
}

/**
 * Where the map link and the directions link point.
 *
 * Google Maps' documented URL API rather than an embed `iframe` src: an embed needs an API key, loads a
 * third-party origin before the page is interactive, and cannot be opened by a crawler or an assistant.
 * A link works in every context, including the one that matters most here — a phone, where it hands off
 * to the installed Maps application.
 */
const MAPS_SEARCH = 'https://www.google.com/maps/search/'
const MAPS_DIRECTIONS = 'https://www.google.com/maps/dir/'

/**
 * What identifies the premises to a map.
 *
 * `placeId` is the precise answer and `null` until Y2-gbp-status is resolved — docs/13 §6 records the
 * Google Business Profile status as unknown, so `premises.google_place_id` is NULL and nothing invents
 * one. The address is the fallback, and it is a good one: a text query for the full address resolves to
 * the building. Latitude and longitude are deliberately absent from the row for the same reason
 * (`packages/db/src/seed/premises.ts`): a plausible coordinate would drop the pin on the wrong building
 * and nothing on the page would say it was a guess.
 */
export interface MapTarget extends PostalAddress {
  readonly googlePlaceId: string | null
}

/**
 * The link that shows where the premises is.
 *
 * `query` carries the address even when a `place_id` is present, because Google's URL API requires it:
 * `query_place_id` is documented as a refinement of `query`, and a request with the id alone is ignored.
 */
export function mapLinkFor(target: MapTarget): string {
  const params = new URLSearchParams({ api: '1', query: addressOneLine(target) })
  if (target.googlePlaceId !== null) params.set('query_place_id', target.googlePlaceId)
  return `${MAPS_SEARCH}?${params.toString()}`
}

/**
 * The link that routes a customer to the door.
 *
 * A different URL from the map link and not a variation of it: the map answers "where is this" and the
 * directions answer "how do I get there from where I am", which is the one a customer on the Corniche
 * actually taps. No `origin` is set — the caller's device knows where it is and we do not.
 */
export function directionsLinkFor(target: MapTarget): string {
  const params = new URLSearchParams({ api: '1', destination: addressOneLine(target) })
  if (target.googlePlaceId !== null) params.set('destination_place_id', target.googlePlaceId)
  return `${MAPS_DIRECTIONS}?${params.toString()}`
}

/**
 * A phone number as a `tel:` URI.
 *
 * E.164 with nothing added, so `tel:` plus the stored value and no punctuation. The display form is a
 * separate rendering of the same number, and a `tel:` built from it — with its spaces — is a link some
 * dialers truncate at the first space.
 */
export function telLinkFor(e164: string): string {
  return `tel:${e164}`
}

/**
 * E.164 split into the spacing this market reads, for display only.
 *
 * A UAE landline groups as `+971 <area> <3> <4>` and a mobile as `+971 <5x> <3> <4>`. No example is
 * spelled here: the repository's own grep gate (`packages/db/src/seed/premises.test.ts`) fails on this
 * business's numbers appearing outside the seed, and a doc comment is exactly the place a second copy of
 * one survives every correction to the database.
 *
 * Never stored, never compared, never dialled: `premises` holds one spelling of a number (E.164, ADR
 * 0014) and this is a rendering of it, so there is no second value to keep in step. It is here rather
 * than in the component because `/api/facts` publishes both forms — an assistant quoting a number
 * should quote the one a person would read out.
 *
 * Returns the input unchanged for anything that is not a UAE number in E.164, which includes the
 * WhatsApp placeholder: a formatter that rearranged `WHATSAPP-PENDING-Y1-NAP` into something
 * number-shaped would defeat the whole point of the placeholder.
 */
export function formatUaePhone(e164: string): string {
  const match = /^\+971(\d)(\d+)$/.exec(e164)
  if (match === null) return e164
  const [, first, rest] = match
  if (first === undefined || rest === undefined) return e164
  // Mobile prefixes are two digits (5x), landline area codes one (2 for Abu Dhabi). The remaining
  // seven digits are grouped 3 + 4, which is how both are printed in docs/13 §3.
  const isMobile = first === '5'
  const prefix = isMobile ? `${first}${rest.slice(0, 1)}` : first
  const digits = isMobile ? rest.slice(1) : rest
  if (digits.length !== 7) return e164
  return `+971 ${prefix} ${digits.slice(0, 3)} ${digits.slice(3)}`
}
