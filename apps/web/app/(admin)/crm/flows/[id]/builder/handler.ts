import {
  can,
  connectJourneyDraft,
  disconnectJourneyDraft,
  draftDocument,
  type FlowNode,
  type FlowRefusal,
  type FlowTemplateFact,
  freeOutletsOf,
  inletsOf,
  type JourneyDraft,
  journeyDraftVerdict,
  parseJourneyOutletKey,
  placeJourneyNode,
  type Role,
  removeJourneyNode,
  resolveJourneyInlet,
  resolveJourneyOutlet,
  serialiseFlowDefinition,
} from '@berelax/core'
import { readCurrentTemplateClasses, readFlowDefinition, type Sql } from '@berelax/db'
import type { AdminChrome } from '../../../../../../src/components/admin/google-reauth-banner.ts'
import type { AdminPrincipal } from '../../../../../../src/session.ts'
import {
  FLOW_API_SENTENCES,
  FLOW_READ_PERMISSION,
  type FlowLiveState,
  type FlowPublishRefused,
  publishFlowFromApi,
  readFlowLiveState,
} from '../../api/handler.ts'
import {
  BUILDER_FIELDS,
  isPaletteKind,
  nodeFromForm,
  PALETTE_SENTENCES,
  type PaletteRefusal,
  triggerFromForm,
} from './nodes/palette.ts'
import { type BuilderDirection, type BuilderView, renderFlowBuilderHtml } from './render.ts'

/**
 * `/crm/flows/[id]/builder` — the node-graph journey builder (C-AUTO-09, docs/03 §5).
 *
 * The handler rather than the route binding, so `apps/web/src/flow-builder.itest.ts` can drive it
 * directly against a real PostgreSQL; the diary, the pipeline board and the paste form all take the same
 * split for the same reason.
 *
 * ## `[id]` is the flow KEY, and the key is not a uuid
 *
 * `flow_definition`'s primary key is `(flow_id, version)` and `flow` has no other handle an operator
 * types; `readFlowByKey` is the reader every other caller uses. So the segment is the key, which also
 * keeps a uuid out of a URL an operator reads aloud. A key nothing has published yet is a legitimate
 * state and opens an empty draft: `publishFlowDefinition` creates the `flow` row on the first version,
 * so the builder does not need one to exist before anything is drawn.
 *
 * ## The draft lives in the FORM, not in a table
 *
 * Every control posts the whole draft back in a hidden field and the handler returns the next page.
 * There is deliberately no `flow_draft` table, and the reason is C-AUTO-06's: `flow_definition` is
 * append-only and refuses UPDATE (ZF001) precisely so that a published version cannot be edited under
 * the enrolments pinned to it, and the operator's work in progress is therefore *not a version*. A table
 * for it would be a second place a graph lives, with its own concurrency question and its own migration;
 * a hidden field is the whole of what is needed for a screen whose edits are one request each, and this
 * unit allocates no migration as a result.
 *
 * It also makes the acceptance line *"saving and reloading reproduces an identical serialised graph"* a
 * property of ONE structure: what the field carries is the candidate document, `draftDocument` is the
 * identity on it, and `serialiseFlowDefinition` is the one byte form.
 *
 * ## An edit POSTs and the response is the page; only a publish redirects
 *
 * A 303 after every edit would need the draft in the query string, and a graph does not fit in a URL. So
 * an edit answers 200 with the next page — the browser's reload warning is the correct behaviour for
 * work in progress — and a PUBLISH answers 303 to the freshly-read screen, because a publish is the one
 * operation a reload must not repeat: `flow_definition` would take the second one as version N+2.
 *
 * Every form works with scripting disabled. That is what the keyboard-only acceptance line is satisfied
 * by: there is no canvas to trap focus, every control is a native `<button>`, `<select>` or `<input>`,
 * and the graph itself is a `<table>` — see `render.ts` on why the accessible list IS the surface here
 * rather than a fallback beside one.
 */

export interface BuilderDeps {
  readonly sql: Sql
  /** Injected, so the suite can freeze it: the page prints the instant it read the counts at. */
  readonly now: () => Date
}

export interface BuilderRequest {
  /** Read by the route, never here: this file stays a reading of the draft (the calendar's rule). */
  readonly chrome: AdminChrome
  readonly flowKey: string
  readonly principal: AdminPrincipal
  readonly searchParams: URLSearchParams
  /** Absent on a GET. The posted form on a POST. */
  readonly form?: URLSearchParams
}

/** Everything the builder refuses, as a value: its own reasons plus the palette's. */
export const BUILDER_REFUSALS = [
  'forbidden',
  'unreadable_request',
  'unknown_operation',
  /** A journey has one trigger, offered once. */
  'trigger_already_placed',
  'trigger_required_first',
  /** The edge named is not one this draft offered. The misrouting, stopped at the HTTP edge. */
  'edge_not_offered',
  'node_not_offered',
  'node_limit_reached',
  /** Save was pressed on a graph the one verdict refuses. */
  'draft_not_publishable',
] as const
export type BuilderRefusal = (typeof BUILDER_REFUSALS)[number] | PaletteRefusal

export const BUILDER_SENTENCES: Readonly<Record<BuilderRefusal, string>> = {
  ...PALETTE_SENTENCES,
  forbidden: 'Your role may not open the journey builder.',
  unreadable_request: 'That is not an edit this builder could have sent. Reload the journey.',
  unknown_operation: 'That is not an edit this builder can make.',
  trigger_already_placed: 'A journey has exactly one way in, and this one already has it.',
  trigger_required_first:
    'Add the way in first. Every other step is something the trigger leads to, so a journey with no ' +
    'trigger has nothing to route.',
  edge_not_offered:
    'That connection was not one this journey offered. An exit has no way out, the trigger cannot be ' +
    'routed into, a branch only exists on the step that declares it, and a branch that already has a ' +
    'connection is not offered again.',
  node_not_offered: 'There is no such step in this journey.',
  node_limit_reached: 'A journey holds at most 60 steps.',
  draft_not_publishable:
    'This journey is not publishable yet, so nothing was published. Every rule it breaks is listed ' +
    'above the graph.',
}

/** The most nodes a draft may hold — the schema's ceiling, read rather than restated. */
const MAX_NODES = 60

/** The draft a blank journey starts from: a key, a title, and nothing drawn. */
export const emptyDraft = (flowKey: string, title: string): JourneyDraft => ({
  key: flowKey,
  title,
  nodes: [],
  edges: [],
})

/**
 * The draft the request carried, or null.
 *
 * Null for "nothing was posted", which is a GET. A field that is not a readable draft is a REFUSAL and
 * not an empty draft, because silently starting over is how an operator's afternoon disappears.
 */
export function draftFromField(value: string | null): JourneyDraft | 'unreadable' | null {
  if (value === null || value.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return 'unreadable'
  }
  if (typeof parsed !== 'object' || parsed === null) return 'unreadable'
  const candidate = parsed as Record<string, unknown>
  const { key, title, description, nodes, edges } = candidate
  if (typeof key !== 'string' || typeof title !== 'string') return 'unreadable'
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return 'unreadable'
  /*
    The nodes and edges are carried through WITHOUT being re-typed here, and that is deliberate rather
    than lax. A draft is a candidate document by construction: `journeyDraftVerdict` runs the one
    judgement over it before anything is published, and `freeOutletsOf` reads only the kinds and the
    declared branches. Re-validating the shape here would be a second schema — and the version that
    disagreed with zod would be this one.
  */
  return {
    key,
    title,
    ...(typeof description === 'string' && description !== '' ? { description } : {}),
    nodes: nodes as readonly FlowNode[],
    edges: edges as readonly {
      readonly from: string
      readonly to: string
      readonly branch: string
    }[],
  }
}

/** The next free id for a kind: `delay_1`, `delay_2`. Lower snake_case, which the node id regex wants. */
export function nextNodeId(draft: JourneyDraft, kind: string): string {
  const taken = new Set(draft.nodes.map((node) => node.id))
  for (let index = 1; index <= MAX_NODES + 1; index += 1) {
    const candidate = `${kind}_${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `${kind}_x`
}

const isPaletteRefusal = (value: unknown): value is BuilderRefusal =>
  typeof value === 'string' && Object.hasOwn(BUILDER_SENTENCES, value)

export interface EditOutcome {
  readonly draft: JourneyDraft
  readonly refusal: BuilderRefusal | null
  /** The node the operator is working on, so the screen can keep it selected across an edit. */
  readonly selected: string | null
}

/**
 * One edit, applied to the draft the form carried.
 *
 * Pure, and exported so `flow-builder.itest.ts` can drive the edit algebra without a server — the HTTP
 * half of this unit's claims needs a server, the algebra does not.
 *
 * The edge cases are not cases: `connect` resolves the posted strings against `freeOutletsOf` and
 * `inletsOf` and refuses `edge_not_offered` when nothing matches, which is the ONE place an untyped body
 * becomes a typed edge. There is deliberately no branch that builds an outlet out of the body's own
 * fields.
 */
type EditHandler = (
  draft: JourneyDraft,
  form: URLSearchParams,
  registry: readonly FlowTemplateFact[],
  selected: string | null,
) => EditOutcome

const editSelect: EditHandler = (draft, _form, _registry, selected) => {
  const node = draft.nodes.find((candidate) => candidate.id === selected)
  return node === undefined
    ? { draft, refusal: 'node_not_offered', selected: null }
    : { draft, refusal: null, selected: node.id }
}

const editTrigger: EditHandler = (draft, form, _registry, selected) => {
  if (draft.nodes.some((node) => node.kind === 'trigger')) {
    return { draft, refusal: 'trigger_already_placed', selected }
  }
  const node = triggerFromForm(form, 'entered')
  if (isPaletteRefusal(node)) return { draft, refusal: node, selected }
  return { draft: placeJourneyNode(draft, node), refusal: null, selected: node.id }
}

const editPlace: EditHandler = (draft, form, registry, selected) => {
  // The trigger first, because every other step is something the trigger leads to: a draft with no way
  // in has nothing to route, and the first thing an operator would then have to do is delete and redraw.
  if (!draft.nodes.some((node) => node.kind === 'trigger')) {
    return { draft, refusal: 'trigger_required_first', selected }
  }
  if (draft.nodes.length >= MAX_NODES) return { draft, refusal: 'node_limit_reached', selected }
  const kind = (form.get(BUILDER_FIELDS.kind) ?? '').trim()
  if (!isPaletteKind(kind)) return { draft, refusal: 'unknown_kind', selected }
  const node = nodeFromForm(form, nextNodeId(draft, kind), registry)
  if (isPaletteRefusal(node)) return { draft, refusal: node, selected }
  return { draft: placeJourneyNode(draft, node), refusal: null, selected: node.id }
}

/**
 * The ONE place an untyped body becomes a typed edge.
 *
 * The posted strings are resolved against `freeOutletsOf` and `inletsOf` — the same two functions the
 * screen's two `<select>`s were filled from — and `edge_not_offered` is what nothing matching means.
 * There is deliberately no branch that builds an outlet out of the body's own fields: that branch is the
 * misrouting this unit exists to remove, and an edge out of an exit, into the trigger, on an undeclared
 * branch or onto a branch that already has one all arrive here as the same `null`.
 */
const editConnect: EditHandler = (draft, form, _registry, selected) => {
  const { from, branch } = parseJourneyOutletKey((form.get(BUILDER_FIELDS.outlet) ?? '').trim())
  const outlet = resolveJourneyOutlet(draft, from, branch)
  const inlet = resolveJourneyInlet(draft, form.get(BUILDER_FIELDS.to))
  if (outlet === null || inlet === null) return { draft, refusal: 'edge_not_offered', selected }
  return { draft: connectJourneyDraft(draft, outlet, inlet), refusal: null, selected: outlet.from }
}

const editDisconnect: EditHandler = (draft, form, _registry, selected) => {
  const { from, branch } = parseJourneyOutletKey((form.get(BUILDER_FIELDS.outlet) ?? '').trim())
  const exists = draft.edges.some((edge) => edge.from === from && edge.branch === branch)
  return exists
    ? { draft: disconnectJourneyDraft(draft, from, branch), refusal: null, selected: from }
    : { draft, refusal: 'edge_not_offered', selected }
}

const editDelete: EditHandler = (draft, _form, _registry, selected) => {
  const id = (selected ?? '').trim()
  if (!draft.nodes.some((node) => node.id === id)) {
    return { draft, refusal: 'node_not_offered', selected: null }
  }
  // `removeJourneyNode` takes the node's edges with it, in one operation — a delete that removed only
  // the node would leave `flow-dsl-dangling-edge`, a refusal about the builder's own bookkeeping.
  return { draft: removeJourneyNode(draft, id), refusal: null, selected: null }
}

/** One handler per operation. A table, so an operation nobody wrote a handler for cannot be dispatched. */
const EDITS: Readonly<Record<string, EditHandler>> = {
  select: editSelect,
  trigger: editTrigger,
  place: editPlace,
  connect: editConnect,
  disconnect: editDisconnect,
  delete: editDelete,
}

/**
 * One edit, applied to the draft the form carried.
 *
 * Pure, and exported so `flow-builder.itest.ts` can drive the edit algebra without a server — the HTTP
 * half of this unit's claims needs a server, the algebra does not.
 */
export function applyEdit(
  draft: JourneyDraft,
  form: URLSearchParams,
  registry: readonly FlowTemplateFact[],
): EditOutcome {
  const operation = (form.get(BUILDER_FIELDS.operation) ?? '').trim()
  const selected = form.get(BUILDER_FIELDS.nodeId)
  const handler = Object.hasOwn(EDITS, operation) ? EDITS[operation] : undefined
  return handler === undefined
    ? { draft, refusal: 'unknown_operation', selected }
    : handler(draft, form, registry, selected)
}

/** The path the builder posts to, derived from the key so the two cannot disagree. */
export const builderPathFor = (flowKey: string): string =>
  `/crm/flows/${encodeURIComponent(flowKey)}/builder`

/**
 * The view the renderer draws, assembled from the draft, the verdict and the live state.
 *
 * One function, called by the GET and by every POST, so the screen cannot show a different thing after
 * an edit from what it shows on a reload — which is the only way the reload acceptance line can hold.
 */
export function builderView(input: {
  readonly chrome: AdminChrome
  readonly flowKey: string
  readonly draft: JourneyDraft
  readonly registry: readonly FlowTemplateFact[]
  readonly live: FlowLiveState
  readonly principal: AdminPrincipal
  readonly selected: string | null
  readonly refusal: BuilderRefusal | null
  readonly published: { readonly version: number; readonly remaining: number } | null
  readonly publishRefusal: FlowPublishRefused | null
  readonly direction: BuilderDirection
  readonly readAtIso: string
}): BuilderView {
  const verdict = journeyDraftVerdict(input.draft, { templates: input.registry })
  const refusals: readonly FlowRefusal[] = verdict.ok ? [] : verdict.refusals
  return {
    chrome: input.chrome,
    flowKey: input.flowKey,
    path: builderPathFor(input.flowKey),
    direction: input.direction,
    draftJson: JSON.stringify(draftDocument(input.draft)),
    draft: input.draft,
    registry: input.registry,
    live: input.live,
    outlets: freeOutletsOf(input.draft).map((outlet) => ({
      from: outlet.from,
      branch: outlet.branch,
      kind: outlet.kind,
    })),
    inlets: inletsOf(input.draft).map((inlet) => ({ to: inlet.to, kind: inlet.kind })),
    selected: input.selected,
    /**
     * The save control's state, and it is the VERDICT and not a judgement of its own.
     *
     * The acceptance line: "an invalid intermediate state leaves save disabled in the UI and is refused
     * by the API with a named error". Both halves read `journeyDraftVerdict`, so they cannot answer
     * differently about one graph.
     */
    canPublish: verdict.ok && can(input.principal.role satisfies Role, 'campaign:send'),
    mayPublishByRole: can(input.principal.role satisfies Role, 'campaign:send'),
    refusals: refusals.map((refusal) => ({
      rule: refusal.rule,
      at: refusal.at,
      detail: refusal.detail,
    })),
    canonical: verdict.ok ? serialiseFlowDefinition(verdict.definition) : null,
    refusal:
      input.refusal === null
        ? null
        : { name: input.refusal, sentence: BUILDER_SENTENCES[input.refusal] },
    publishRefusal:
      input.publishRefusal === null
        ? null
        : {
            name: input.publishRefusal.refusal,
            sentence: input.publishRefusal.sentence,
            rules: input.publishRefusal.rules,
          },
    published: input.published,
    readAtIso: input.readAtIso,
  }
}

const page = (html: string, status = 200): Response =>
  new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cached. A cached builder outlives the journey: it would draw a graph somebody has already
      // published over, and the enrolment count beside the save control would be a figure from before.
      'cache-control': 'no-store',
      vary: 'Cookie',
    },
  })

const forbidden = (): Response =>
  new Response(`${FLOW_API_SENTENCES.forbidden}\n`, {
    status: 403,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      vary: 'Cookie',
    },
  })

/** `GET` — the builder, opened on the live version if there is one and on an empty draft if not. */
export async function handleBuilderRead(
  request: BuilderRequest,
  deps: BuilderDeps,
): Promise<Response> {
  if (!can(request.principal.role satisfies Role, FLOW_READ_PERMISSION)) return forbidden()
  const { sql } = deps
  const registry = await readCurrentTemplateClasses(sql)
  const live = await readFlowLiveState(sql, request.flowKey)
  const opened = await openingDraft(sql, request.flowKey, live)
  const published = publishedFromQuery(request.searchParams)
  return page(
    renderFlowBuilderHtml(
      builderView({
        flowKey: request.flowKey,
        draft: opened,
        registry,
        live,
        principal: request.principal,
        selected: request.searchParams.get(BUILDER_FIELDS.nodeId),
        refusal: null,
        published,
        publishRefusal: null,
        direction: directionFrom(request.searchParams),
        chrome: request.chrome,
        readAtIso: deps.now().toISOString(),
      }),
    ),
  )
}

/**
 * The draft a GET opens on.
 *
 * The LIVE version's document when there is one, read through `readFlowDefinition` — so opening the
 * builder on a published journey shows what is published rather than a blank screen. Nothing is pinned
 * or moved by reading it: a draft is not a version, and the enrolments on the live version keep their
 * pin whatever happens here (C-AUTO-06, ZF002).
 */
async function openingDraft(sql: Sql, flowKey: string, live: FlowLiveState): Promise<JourneyDraft> {
  if (live.liveVersion === null) return emptyDraft(flowKey, live.title ?? flowKey)
  const row = await readFlowDefinition(sql, flowKey, live.liveVersion)
  const document = row?.definition
  if (typeof document !== 'object' || document === null) {
    return emptyDraft(flowKey, live.title ?? flowKey)
  }
  const stored = draftFromField(JSON.stringify(document))
  return stored === null || stored === 'unreadable'
    ? emptyDraft(flowKey, live.title ?? flowKey)
    : stored
}

/**
 * `rtl` only when it was asked for, from either the query or the posted form.
 *
 * A query parameter may NEVER choose a principal, a role or a permission (W-SYS-11, and a
 * repository-wide scan refuses it) — and this one chooses none of those. It flips the layout of a
 * document whose content is identical either way, which is what makes it a safe thing to take from a
 * URL and the reason the pipeline board and the duplicate queue both do.
 */
export function directionFrom(params: URLSearchParams, form?: URLSearchParams): BuilderDirection {
  return params.get(BUILDER_FIELDS.direction) === 'rtl' ||
    form?.get(BUILDER_FIELDS.direction) === 'rtl'
    ? 'rtl'
    : 'ltr'
}

/** `?published=N&remaining=M` carried back across the publish redirect. Numbers only, never a sentence. */
function publishedFromQuery(
  params: URLSearchParams,
): { readonly version: number; readonly remaining: number } | null {
  const version = Number(params.get('published'))
  const remaining = Number(params.get('remaining'))
  if (!Number.isInteger(version) || version < 1) return null
  return { version, remaining: Number.isInteger(remaining) && remaining >= 0 ? remaining : 0 }
}

/** `POST` — one edit, or the publish. */
export async function handleBuilderWrite(
  request: BuilderRequest,
  deps: BuilderDeps,
): Promise<Response> {
  if (!can(request.principal.role satisfies Role, FLOW_READ_PERMISSION)) return forbidden()
  const form = request.form
  if (form === undefined) return page('', 400)
  const { sql } = deps
  const registry = await readCurrentTemplateClasses(sql)
  const live = await readFlowLiveState(sql, request.flowKey)

  const carried = draftFromField(form.get(BUILDER_FIELDS.draft))
  if (carried === 'unreadable') {
    return renderWith(request, deps, {
      registry,
      live,
      draft: emptyDraft(request.flowKey, live.title ?? request.flowKey),
      refusal: 'unreadable_request',
      selected: null,
      publishRefusal: null,
      status: 400,
    })
  }
  const draft = carried ?? emptyDraft(request.flowKey, live.title ?? request.flowKey)

  if ((form.get(BUILDER_FIELDS.operation) ?? '') === 'publish') {
    return await publish(request, deps, { draft, registry, live, form })
  }

  const outcome = applyEdit(draft, form, registry)
  return renderWith(request, deps, {
    registry,
    live,
    draft: outcome.draft,
    refusal: outcome.refusal,
    selected: outcome.selected,
    publishRefusal: null,
    // 422 for a refused edit, 200 for one that landed. A status rather than only a sentence, so the
    // suite can tell "the builder refused this" from "the builder did it" without reading the HTML.
    status: outcome.refusal === null ? 200 : 422,
  })
}

/**
 * Save.
 *
 * The verdict decides, and it is the same verdict the save control's `disabled` attribute came from — so
 * a graph whose save control was disabled and which was posted anyway is refused here by name rather
 * than slipping through a screen that had already decided. A publish that lands answers 303, because a
 * reload must not write version N+2.
 */
async function publish(
  request: BuilderRequest,
  deps: BuilderDeps,
  context: {
    readonly draft: JourneyDraft
    readonly registry: readonly FlowTemplateFact[]
    readonly live: FlowLiveState
    readonly form: URLSearchParams
  },
): Promise<Response> {
  const verdict = journeyDraftVerdict(context.draft, { templates: context.registry })
  if (!verdict.ok) {
    return renderWith(request, deps, {
      registry: context.registry,
      live: context.live,
      draft: context.draft,
      refusal: 'draft_not_publishable',
      selected: null,
      publishRefusal: null,
      status: 422,
    })
  }
  const outcome = await publishFlowFromApi(deps.sql, request.principal, {
    flowKey: request.flowKey,
    title: context.draft.title,
    definition: draftDocument(context.draft),
  })
  if (!outcome.ok) {
    return renderWith(request, deps, {
      registry: context.registry,
      live: context.live,
      draft: context.draft,
      refusal: null,
      selected: null,
      publishRefusal: outcome,
      status: outcome.status,
    })
  }
  const direction = directionFrom(request.searchParams, context.form)
  const destination =
    `${builderPathFor(request.flowKey)}?published=${outcome.version}` +
    `&remaining=${outcome.enrolmentsRemainingOnPreviousVersion}` +
    (direction === 'rtl' ? `&${BUILDER_FIELDS.direction}=rtl` : '')
  return new Response(null, {
    status: 303,
    headers: { location: destination, 'cache-control': 'no-store', vary: 'Cookie' },
  })
}

/** One render path for every POST answer, so no two of them can print a different screen. */
function renderWith(
  request: BuilderRequest,
  deps: BuilderDeps,
  input: {
    readonly registry: readonly FlowTemplateFact[]
    readonly live: FlowLiveState
    readonly draft: JourneyDraft
    readonly refusal: BuilderRefusal | null
    readonly selected: string | null
    readonly publishRefusal: FlowPublishRefused | null
    readonly status: number
  },
): Response {
  return page(
    renderFlowBuilderHtml(
      builderView({
        flowKey: request.flowKey,
        draft: input.draft,
        registry: input.registry,
        live: input.live,
        principal: request.principal,
        selected: input.selected,
        refusal: input.refusal,
        published: null,
        publishRefusal: input.publishRefusal,
        direction: directionFrom(request.searchParams, request.form),
        chrome: request.chrome,
        readAtIso: deps.now().toISOString(),
      }),
    ),
    input.status,
  )
}
