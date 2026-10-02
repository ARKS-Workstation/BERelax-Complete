import { can, type Permission, type Role, validateFlowDefinition } from '@berelax/core'
import {
  countEnrolmentsOnVersion,
  type FlowWriteRefusal,
  flowRefusalOf,
  publishFlowDefinition,
  readCurrentTemplateClasses,
  readFlowByKey,
  readLiveFlowVersion,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import type { AdminPrincipal } from '../../../../../src/session.ts'

/**
 * `POST /crm/flows/api` — the ONE writer of `flow_definition`, and the layer that refuses a misrouting
 * sent by something that never saw a type (C-AUTO-09).
 *
 * The builder's save control posts here and so does a script; there is one function and one set of named
 * refusals, which is what makes the acceptance line's "refused in the UI and again at the API" one rule
 * applied twice rather than two rules that happen to agree today.
 *
 * ## Why this exists at all when the builder's types make misrouting unexpressible
 *
 * A type stops at the process boundary. `packages/core`'s `classedMessageStep` cannot be called with a
 * template of the other class, and that is the whole claim C-AUTO-09's acceptance line makes — but an
 * HTTP body is `unknown`, and a caller with `curl` is not holding a `TemplateRef`. So the body goes
 * through `validateFlowDefinition` with the registry read from `message_template`, which refuses
 * `flow-dsl-message-class-mismatch` by name. The acceptance line asks for exactly this pair and calls
 * the second half "an API test bypassing the UI".
 *
 * ## It does not send anything, and that is a design constraint rather than an observation
 *
 * Publishing a journey writes a document. Every message the journey eventually sends is C-AUTO-07's
 * interpreter step, which goes through `sendMessage` in `packages/messaging` — the one choke point
 * (C-AUTO-04), with consent, suppression, the frequency cap and the staging guard behind it. Nothing
 * here touches a transport, imports a provider or enqueues a send, so the journey this screen publishes
 * cannot acquire a second send path: `pnpm send-chokepoint` is the check that says so.
 *
 * ## Two permissions, not one
 *
 * `campaign:read` opens the builder and `campaign:send` publishes, both through the F07 matrix in
 * `@berelax/core`. The split is the one the matrix already draws: `manager` holds `campaign:read` and
 * `segment:write` and NOT `campaign:send`, so the floor manager can look at a journey and the marketer
 * or the owner is who commits one. Publishing a journey is authorising every message it will ever send,
 * which is the authority `campaign:send` names; no new permission is invented for it, because a
 * permission added here would be a permission every role's literal would have to be revisited for.
 */

/** Opening the builder, or reading a journey back. The weaker of the two. */
export const FLOW_READ_PERMISSION: Permission = 'campaign:read'

/**
 * Publishing a version — which authorises every message the journey will send.
 *
 * `campaign:send` and not `template:write`: a template is words somebody approves, and a journey is the
 * decision to send them to people on a schedule. The matrix grants it to `owner`, `marketer` and
 * `system`, and withholds it from `manager`, `receptionist`, `therapist`, `accountant` and `auditor`.
 */
export const FLOW_PUBLISH_PERMISSION: Permission = 'campaign:send'

/** Every reason this endpoint refuses, as a value. A caller branches on these, never on prose. */
export const FLOW_API_REFUSALS = [
  /** The body is not JSON, or not an object with the three fields. */
  'unreadable_request',
  'forbidden',
  /** `flowKey` is absent or not a flow key. Checked here so the refusal names the field. */
  'flow_key_invalid',
  'title_invalid',
  /** The definition was refused. `rules` carries the DSL rule names, which is the acceptance's "named". */
  'definition_invalid',
] as const
export type FlowApiRefusal = (typeof FLOW_API_REFUSALS)[number] | FlowWriteRefusal

/** What the caller is told for each refusal. A `Record`, so a new name has to be worded. */
export const FLOW_API_SENTENCES: Readonly<Record<FlowApiRefusal, string>> = {
  unreadable_request:
    'That is not a publish this endpoint can read. It takes JSON with a flowKey, a title and a ' +
    'definition.',
  forbidden: 'Your role may not publish a journey.',
  flow_key_invalid: 'A flow key is lower snake_case, 1-64 characters.',
  title_invalid: 'A journey needs a title of 1 to 80 characters.',
  definition_invalid:
    'The definition was refused. Every rule it broke is named in `rules`, and the builder refuses the ' +
    'same graph before the save control is enabled.',
  flow_not_found: 'There is no such journey.',
  definition_not_validated:
    'No validator reached the publish, so nothing checked the document. Refused rather than published: ' +
    'an unvalidated definition is a journey that fails days later, for the enrolments pinned to it.',
  definition_key_does_not_match_flow:
    'The document declares a different flow key from the one it is being published to, and ' +
    'flow_definition holds no key column, so nothing downstream could tell the two apart afterwards.',
  flow_not_active: 'That journey is not accepting new enrolments.',
  flow_has_no_published_version: 'That journey has no published version.',
  enrolment_not_found: 'There is no such enrolment.',
  enrolment_not_active: 'That enrolment has already ended.',
  flow_enrolment_cap_reached: 'That journey is already at its active-enrolment ceiling.',
}

const FLOW_KEY = /^[a-z][a-z0-9_]{0,63}$/

/**
 * The HTTP status each refusal answers with, as a table.
 *
 * A table rather than a conditional, for the pipeline board's reason: 422 for a document that is
 * well-formed and wrong is the status a script branches on, and a conditional is where the one case that
 * matters comes to share a branch with something else. 400 is "I could not read that", 403 is "not your
 * role", 404 is "no such thing", 409 is a race, and 422 is "I read it and it is not publishable".
 */
export const FLOW_API_STATUS: Readonly<Record<FlowApiRefusal, number>> = {
  unreadable_request: 400,
  forbidden: 403,
  flow_key_invalid: 400,
  title_invalid: 400,
  definition_invalid: 422,
  flow_not_found: 404,
  definition_not_validated: 500,
  definition_key_does_not_match_flow: 422,
  flow_not_active: 409,
  flow_has_no_published_version: 404,
  enrolment_not_found: 404,
  enrolment_not_active: 409,
  flow_enrolment_cap_reached: 409,
}

export interface FlowPublishOutcome {
  readonly ok: true
  readonly flowKey: string
  readonly version: number
  readonly nodeCount: number
  /** How many ACTIVE enrolments stay on the version this one supersedes. The figure the builder states. */
  readonly enrolmentsRemainingOnPreviousVersion: number
}

export interface FlowPublishRefused {
  readonly ok: false
  readonly refusal: FlowApiRefusal
  readonly sentence: string
  readonly status: number
  /** The DSL rule names, when the validator is what refused. Empty otherwise. */
  readonly rules: readonly string[]
  /** `<rule> at <node or edge>` for each refusal, so the builder can point at the node. */
  readonly detail: readonly string[]
}

const refuse = (
  refusal: FlowApiRefusal,
  rules: readonly string[] = [],
  detail: readonly string[] = [],
): FlowPublishRefused => ({
  ok: false,
  refusal,
  sentence: FLOW_API_SENTENCES[refusal],
  status: FLOW_API_STATUS[refusal],
  rules,
  detail,
})

/**
 * The validator, with the registry read from the database, built per call.
 *
 * Per call and not cached, because the class of a template is a row somebody can supersede
 * (C-AUTO-01's `reclassify_template` writes a new version), and a cached registry is how a publish comes
 * to be judged against a classification that is no longer current.
 */
export async function flowValidatorFor(
  sql: Sql,
): Promise<(candidate: unknown) => ReturnType<typeof validateFlowDefinition>> {
  const templates = await readCurrentTemplateClasses(sql)
  return (candidate: unknown) => validateFlowDefinition(candidate, { templates })
}

export interface FlowPublishRequest {
  readonly flowKey: unknown
  readonly title: unknown
  readonly definition: unknown
}

/**
 * Publishes one version, or refuses by name.
 *
 * The order is the design: the role first, then the two fields this endpoint owns the shape of, then the
 * document — which is `publishFlowDefinition`'s judgement and not a second opinion formed here. The
 * repository raises an `AppError` carrying a named refusal, and `flowRefusalOf` reads it back, so a
 * refusal the database made and a refusal this file made reach the caller in one shape.
 */
export async function publishFlowFromApi(
  sql: Sql,
  principal: AdminPrincipal,
  request: FlowPublishRequest,
): Promise<FlowPublishOutcome | FlowPublishRefused> {
  if (!can(principal.role satisfies Role, FLOW_PUBLISH_PERMISSION)) return refuse('forbidden')
  const { flowKey, title } = request
  if (typeof flowKey !== 'string' || !FLOW_KEY.test(flowKey)) return refuse('flow_key_invalid')
  if (typeof title !== 'string' || title.trim().length === 0 || title.trim().length > 80) {
    return refuse('title_invalid')
  }

  const validate = await flowValidatorFor(sql)
  // Judged here as well as inside the publish, and the reason is the SHAPE of the answer rather than
  // distrust: the repository reports `definition_invalid` with the rule names in an error's details, and
  // the builder needs `<rule> at <node>` per refusal to point at the node the operator has to fix. One
  // extra pure call over a document already in memory, and the publish still makes its own judgement —
  // so removing this changes what the screen can say and not whether a bad document can land.
  const verdict = validate(request.definition)
  if (!verdict.ok) {
    return refuse(
      'definition_invalid',
      verdict.refusals.map((refusal) => refusal.rule),
      verdict.refusals.map((refusal) => `${refusal.rule} at ${refusal.at ?? 'the document'}`),
    )
  }

  try {
    const published = await withUnitOfWork(
      sql,
      { kind: 'staff', label: FLOW_BUILDER_ACTOR_LABEL },
      (uow) =>
        publishFlowDefinition(
          uow,
          {
            flowKey,
            title: title.trim(),
            definition: request.definition,
            publishedBy: principal.staffReference,
          },
          { validate },
        ),
    )
    return {
      ok: true,
      flowKey: published.flowKey,
      version: published.version,
      nodeCount: published.nodeCount,
      enrolmentsRemainingOnPreviousVersion: published.activeEnrolmentsOnPreviousVersion,
    }
  } catch (error) {
    const named = flowRefusalOf(error)
    if (named !== null) {
      const details = (isAppError(error) ? error.details : undefined) as
        | { readonly rules?: readonly string[]; readonly detail?: readonly string[] }
        | undefined
      return refuse(named, details?.rules ?? [], details?.detail ?? [])
    }
    throw error
  }
}

/**
 * The actor every publish is recorded under, as a SURFACE and never a name.
 *
 * `published_by` on the row is the principal's `staffReference` — the employment record's internal
 * handle, which names no person (ADR 0020) — and the audit actor is this label, exactly as the pipeline
 * board records `Pipeline board`. Stated rather than invented: brief rule 15.
 */
export const FLOW_BUILDER_ACTOR_LABEL = 'Journey builder'

export interface FlowLiveState {
  readonly flowId: string | null
  readonly title: string | null
  readonly isActive: boolean
  readonly liveVersion: number | null
  /**
   * ACTIVE enrolments on the live version, counted in SQL.
   *
   * The figure C-AUTO-09's fourth acceptance line is about: "the displayed count of enrolments that will
   * remain on the current version equals the live enrolment row count (asserted against the database,
   * not a cached figure)". Counted through `countEnrolmentsOnVersion`, which counts in SQL and never
   * through a capped reader — brief rule 12's recorded failure, where a delta read through a `limit`
   * pinned at the limit and three changes read as zero.
   *
   * ACTIVE rather than all: an enrolment that has already completed is not going anywhere, and counting
   * every row would make the one figure an operator uses to decide whether to publish grow every time
   * the journey ran.
   */
  readonly enrolmentsOnLiveVersion: number
}

/** What the builder needs to know about the flow it is editing. Null version means nothing is published. */
export async function readFlowLiveState(sql: Sql, flowKey: string): Promise<FlowLiveState> {
  const flow = await readFlowByKey(sql, flowKey)
  if (flow === null) {
    return {
      flowId: null,
      title: null,
      isActive: false,
      liveVersion: null,
      enrolmentsOnLiveVersion: 0,
    }
  }
  const liveVersion = await readLiveFlowVersion(sql, flowKey)
  const enrolmentsOnLiveVersion =
    liveVersion === null
      ? 0
      : await countEnrolmentsOnVersion(sql, flow.id, liveVersion, { activeOnly: true })
  return {
    flowId: flow.id,
    title: flow.title,
    isActive: flow.isActive,
    liveVersion,
    enrolmentsOnLiveVersion,
  }
}
