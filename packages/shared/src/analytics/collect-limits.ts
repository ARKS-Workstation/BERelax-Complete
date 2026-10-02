/**
 * The three facts about `/api/collect` that a BROWSER has to know, with no Zod anywhere near them.
 *
 * ## Why this is a module of its own and not three lines of `collect.ts`
 *
 * It was three lines of `collect.ts`, and `pnpm budgets` refused it with a number. `collect.ts` imports
 * `zod` — it is the envelope — and A-FIRST-06's collector imports the caps, so the whole validation
 * library and (through the package barrel) every schema in `@berelax/shared` arrived in the client bundle:
 * **98,927 bytes gzipped against a 3,072-byte budget**, on a module whose entire job is to post a few
 * hundred bytes of JSON. The symptom was invisible in every other check — it typechecked, it worked, and
 * the only thing that noticed was the byte count.
 *
 * So the LIMITS are data and live here, where nothing is imported at all, and the SCHEMAS stay in
 * `collect.ts`, which re-exports these so no consumer changes and there is no second statement of any
 * number. The split is along the one line that matters to a browser: a constant is a few bytes and a
 * validator is a library.
 *
 * ## And why the collector does not validate in the browser at all
 *
 * The same measurement answers that question too. Membership in the taxonomy and the shape of a payload
 * are decided in exactly one place and it is the SERVER — `parseAnalyticsEvent` behind `/api/collect`,
 * which answers `unknown_event` and `invalid_event_payload` by name. A copy of that judgement in the
 * browser would be a second statement of it shipped to a cache, so the stale copy would be the one
 * deployed for as long as a visitor's bundle lived. What makes a mis-declared tag impossible in the first
 * place is `scripts/check-event-attributes.mjs`, which reads the real schemas at BUILD time, where a
 * validation library costs nothing.
 */

/** The one path the collector posts to. Written once, so a rename cannot leave the client behind. */
export const COLLECT_PATH = '/api/collect'

/**
 * The largest body `/api/collect` will read, in bytes.
 *
 * 64 KiB, and the figure is A-FIRST-05's acceptance line's. It is generous for fifty events of a few
 * hundred bytes each, and that headroom is deliberate: the cap exists to bound what an anonymous internet
 * caller can make the server parse, not to be a budget a real page has to fit inside.
 *
 * The collector reads it because the alternative is posting a body the route refuses whole — the largest
 * validated event is about 2.2KB, so fifty of them are roughly 115KB, and a batch split only by COUNT
 * would lose every event in it to `body_too_large`.
 */
export const COLLECT_MAX_BODY_BYTES = 65_536

/**
 * The most events one batch may carry.
 *
 * Fifty, from A-FIRST-05's acceptance line. The collector batches and flushes on `visibilitychange`, so a
 * queue longer than this is split into more than one request rather than refused — which is why a cap here
 * costs a real client nothing and bounds the work one request can ask for. It is also the collector's own
 * queue ceiling, derived rather than chosen (`COLLECTOR_MAX_QUEUED_EVENTS`).
 */
export const COLLECT_MAX_BATCH_EVENTS = 50
