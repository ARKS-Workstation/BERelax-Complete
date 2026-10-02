/**
 * The browser collector's public surface (A-FIRST-06).
 *
 * A subpath export — `@berelax/ui/analytics` — and deliberately NOT re-exported from the package barrel.
 * `app/_document/shell.tsx` imports `@berelax/ui`, so anything the barrel names is in the module graph of
 * every route in the application: `build/budgets.json`'s `shared-layout-client-js` budget is an allow-list
 * of exactly two client modules plus 4KB, and a collector reachable from the barrel is a collector every
 * page pays for whether or not it declares a single tracked element. The media islands are a subpath export
 * for the same reason, and `primitives/direction` is imported by its own path rather than through the
 * primitives barrel on the same argument one layer down.
 *
 * Nothing here is a React module, so every file in this directory is typechecked by the ROOT project and
 * driven by the unit suite in `environment: 'node'`. The React boundary that mounts it is
 * `apps/web/app/_analytics/collector.client.tsx`, which is where `next/navigation` is legitimately
 * available: `packages/ui` declares no dependency on `next` and `pnpm deps` is what holds that true.
 */
export {
  COLLECTOR_SUPPLIED_PAYLOAD_FIELDS,
  DECLARED_EVENT_PAGE_FIELDS,
  declaredPayloadAttributes,
  declaredPayloadFields,
  INTERACTION_DEDUPE_MS,
  payloadFieldForAttribute,
  TRACK_ATTRIBUTE_PREFIX,
  TRACK_EVENT_ATTRIBUTE,
  TRACK_REFUSALS,
  type TrackRefusal,
  trackPayloadAttribute,
} from './attributes.ts'
export {
  COLLECTOR_MAX_QUEUED_EVENTS,
  type Collector,
  type CollectorHost,
  createCollector,
  type FlushResult,
  type TrackOutcome,
} from './collector.ts'
export {
  attachDeclaredTracking,
  declaredEventOf,
  declaringElement,
  pageViewEvent,
  TRACK_SELECTOR,
  type TrackableClick,
  type TrackableElement,
  type TrackableRoot,
  type TrackedPage,
  trackDeclaringElement,
} from './use-track.ts'
