import { can, type FlowTemplateFact, type JourneyDraft } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import type { AdminPrincipal } from '../../../../../../src/session.ts'
import {
  FLOW_PUBLISH_PERMISSION,
  FLOW_READ_PERMISSION,
  type FlowLiveState,
} from '../../api/handler.ts'
import {
  applyEdit,
  builderPathFor,
  builderView,
  directionFrom,
  emptyDraft,
  nextNodeId,
} from './handler.ts'

/**
 * The builder's decidable half, without a server.
 *
 * `flow-builder.itest.ts` makes the claims that need the built application — the picker's `<option>`
 * sets, the save control's `disabled` attribute in the bytes, the enrolment figure, the reload. What is
 * here is everything that is a pure function of a draft, and it is here rather than there for two
 * reasons: it runs in a second rather than in two minutes, and gate block 159 needs a fixture it can
 * break and re-run without a `next build`.
 *
 * The edit algebra is the subject. `applyEdit` is the only way the screen changes a graph, and the
 * cases below are about the four edges it must refuse to NAME rather than refuse to accept — which is
 * C-AUTO-09's acceptance line one layer down from the type that states it (ADR 0081).
 */

const REGISTRY: readonly FlowTemplateFact[] = Object.freeze([
  { templateKey: 'booking.confirmed', messageClass: 'transactional' },
  { templateKey: 'booking.reminder', messageClass: 'transactional' },
  { templateKey: 'review.request', messageClass: 'promotional' },
])

const owner: AdminPrincipal = {
  sessionId: 'session',
  credentialId: 'credential',
  employeeId: 'employee',
  staffReference: 'Fixture principal (unit)',
  role: 'owner',
}
const manager: AdminPrincipal = { ...owner, role: 'manager' }

const LIVE_NOTHING: FlowLiveState = {
  flowId: null,
  title: null,
  isActive: false,
  liveVersion: null,
  enrolmentsOnLiveVersion: 0,
}

const LIVE_PUBLISHED: FlowLiveState = {
  flowId: '00000000-0000-7000-8000-000000000000',
  title: 'A published journey',
  isActive: true,
  liveVersion: 4,
  enrolmentsOnLiveVersion: 17,
}

const form = (fields: Record<string, string>): URLSearchParams => new URLSearchParams(fields)

const edit = (draft: JourneyDraft, fields: Record<string, string>) =>
  applyEdit(draft, form(fields), REGISTRY)

/** A draft with a trigger, a condition and two exits, nothing connected. The shape every case needs. */
function placed(): JourneyDraft {
  let draft = emptyDraft('cauto09_unit', 'A journey under test')
  draft = edit(draft, { op: 'trigger', event: 'manual' }).draft
  draft = edit(draft, { op: 'place', kind: 'condition', fact: 'is_vip', operator: 'is_true' }).draft
  draft = edit(draft, { op: 'place', kind: 'exit', reason: 'completed' }).draft
  draft = edit(draft, { op: 'place', kind: 'exit', reason: 'not_eligible' }).draft
  return draft
}

/** The same draft, fully routed — so every "refused" case has a control that is accepted. */
function routed(): JourneyDraft {
  let draft = placed()
  for (const [outlet, to] of [
    ['entered:default', 'condition_1'],
    ['condition_1:true', 'exit_1'],
    ['condition_1:false', 'exit_2'],
  ] as const) {
    const outcome = edit(draft, { op: 'connect', outlet, to })
    expect(outcome.refusal, `${outlet} -> ${to}`).toBeNull()
    draft = outcome.draft
  }
  return draft
}

const view = (
  draft: JourneyDraft,
  principal: AdminPrincipal,
  live: FlowLiveState,
  direction: 'ltr' | 'rtl' = 'ltr',
) =>
  builderView({
    // Every admin document carries the re-auth banner, so the view cannot be built without its
    // state; `google-reauth-banner.test.ts` is the case that enumerates the renders and refuses one
    // that draws none.
    chrome: { googleReauth: null, returnTo: '/crm/flows/cauto09_unit/builder' },
    flowKey: 'cauto09_unit',
    draft,
    registry: REGISTRY,
    live,
    principal,
    selected: null,
    refusal: null,
    published: null,
    publishRefusal: null,
    direction,
    readAtIso: '2026-10-02T09:00:00.000Z',
  })

describe('the edit algebra places what the palette offers, and names what it does not', () => {
  it('places the trigger once and refuses a second one', () => {
    const draft = edit(emptyDraft('k', 't'), { op: 'trigger', event: 'manual' })
    expect(draft.refusal).toBeNull()
    expect(draft.draft.nodes.map((node) => node.kind)).toEqual(['trigger'])
    expect(edit(draft.draft, { op: 'trigger', event: 'manual' }).refusal).toBe(
      'trigger_already_placed',
    )
  })

  it('refuses a step before the trigger, because a step is something the trigger leads to', () => {
    expect(
      edit(emptyDraft('k', 't'), { op: 'place', kind: 'exit', reason: 'completed' }).refusal,
    ).toBe('trigger_required_first')
  })

  it('names the per-kind refusal rather than reporting a document-level rule', () => {
    const base = edit(emptyDraft('k', 't'), { op: 'trigger', event: 'manual' }).draft
    expect(edit(base, { op: 'place', kind: 'delay', minutes: '0' }).refusal).toBe(
      'minutes_not_offered',
    )
    expect(edit(base, { op: 'place', kind: 'action_tag', tag: 'Not A Tag' }).refusal).toBe(
      'tag_invalid',
    )
    // A boolean fact with a valued operator, and the reverse. The pairing rule, named at the control.
    expect(
      edit(base, { op: 'place', kind: 'condition', fact: 'is_vip', operator: 'equals', value: 'x' })
        .refusal,
    ).toBe('operator_does_not_fit_fact')
    expect(
      edit(base, { op: 'place', kind: 'condition', fact: 'locale', operator: 'is_true' }).refusal,
    ).toBe('operator_does_not_fit_fact')
    expect(edit(base, { op: 'place', kind: 'exit', reason: 'whenever' }).refusal).toBe(
      'reason_not_offered',
    )
    expect(edit(base, { op: 'place', kind: 'not_a_kind' }).refusal).toBe('unknown_kind')
    expect(edit(base, { op: 'nonsense' }).refusal).toBe('unknown_operation')
    // The control: every refusal above is about ITS field, so a legitimate placement is accepted.
    expect(edit(base, { op: 'place', kind: 'delay', minutes: '1440' }).refusal).toBeNull()
  })

  it('binds a message step only to a template of the class the step declares', () => {
    const base = edit(emptyDraft('k', 't'), { op: 'trigger', event: 'manual' }).draft
    // THE acceptance line at the HTTP edge: a promotional step on a transactional template is refused
    // by NAME, and the pair was never offered by the picker in the first place.
    expect(
      edit(base, {
        op: 'place',
        kind: 'action_message',
        class: 'promotional',
        template: 'booking.confirmed',
        channel: 'sms',
      }).refusal,
    ).toBe('template_not_offered')
    // And the reverse, which is the same defect the other way round.
    expect(
      edit(base, {
        op: 'place',
        kind: 'action_message',
        class: 'transactional',
        template: 'review.request',
        channel: 'sms',
      }).refusal,
    ).toBe('template_not_offered')
    // The controls: each class binds to its own templates, and the node carries the class the REGISTRY
    // holds rather than the one the form claimed — so the two cannot disagree.
    const promotional = edit(base, {
      op: 'place',
      kind: 'action_message',
      class: 'promotional',
      template: 'review.request',
      channel: 'sms',
    })
    expect(promotional.refusal).toBeNull()
    expect(promotional.draft.nodes.at(-1)).toMatchObject({
      kind: 'action_message',
      messageClass: 'promotional',
      templateKey: 'review.request',
    })
    const transactional = edit(base, {
      op: 'place',
      kind: 'action_message',
      class: 'transactional',
      template: 'booking.confirmed',
      channel: 'whatsapp',
    })
    expect(transactional.refusal).toBeNull()
    expect(transactional.draft.nodes.at(-1)).toMatchObject({ messageClass: 'transactional' })
    // A key nobody registered, and a class nobody declared.
    expect(
      edit(base, {
        op: 'place',
        kind: 'action_message',
        class: 'promotional',
        template: 'no.such_key',
        channel: 'sms',
      }).refusal,
    ).toBe('template_not_offered')
    expect(
      edit(base, {
        op: 'place',
        kind: 'action_message',
        class: 'urgent',
        template: 'review.request',
        channel: 'sms',
      }).refusal,
    ).toBe('class_not_offered')
  })

  it('numbers a placed node by kind, which is what makes an id lower snake_case and free', () => {
    const draft = placed()
    expect(draft.nodes.map((node) => node.id)).toEqual([
      'entered',
      'condition_1',
      'exit_1',
      'exit_2',
    ])
    expect(nextNodeId(draft, 'exit')).toBe('exit_3')
    expect(builderPathFor('cauto09_unit')).toBe('/crm/flows/cauto09_unit/builder')
  })
})

describe('acceptance — an edge the draft never offered cannot be named', () => {
  it('refuses an edge the draft never offered, in all four shapes', () => {
    /*
      A draft with a FREE outlet on purpose, and that is the whole strength of this case.

      The first version used `routed()`, where every outlet is taken — so a handler that quietly fell
      back to "the first free outlet" when resolution failed would find none and refuse anyway, and the
      case passed over a bug it was written to catch. Gate case 159r is exactly that fixture and it
      reported "exited zero; nothing was rejected", which is how the weakness was found. With a spare
      step placed and unconnected there IS something to fall back to, so the refusal has to be a
      decision rather than an accident — and `toEqual(draft.edges)` below is what says no edge was
      drawn.
    */
    const draft = edit(routed(), { op: 'place', kind: 'delay', minutes: '60' }).draft
    expect(draft.nodes.map((node) => node.id)).toContain('delay_1')
    const shapes: readonly (readonly [string, Record<string, string>])[] = [
      ['out of an exit', { op: 'connect', outlet: 'exit_1:default', to: 'condition_1' }],
      ['into the trigger', { op: 'connect', outlet: 'condition_1:true', to: 'entered' }],
      [
        'on a branch the kind does not declare',
        { op: 'connect', outlet: 'condition_1:default', to: 'exit_1' },
      ],
      ['a second edge on one branch', { op: 'connect', outlet: 'entered:default', to: 'exit_1' }],
    ]
    for (const [what, fields] of shapes) {
      const outcome = edit(draft, fields)
      expect(outcome.refusal, what).toBe('edge_not_offered')
      // And nothing was recorded: a refusal that still mutated the draft would be the defect wearing
      // a name.
      expect(outcome.draft.edges, what).toEqual(draft.edges)
    }
    // The control: an edge the draft DOES offer is accepted, so the four above are about those four
    // shapes and not about a handler that refuses every connection. The spare step's own outlet is the
    // one that was free throughout, which is what makes the four refusals above decisions.
    const connected = edit(draft, { op: 'connect', outlet: 'delay_1:default', to: 'exit_1' })
    expect(connected.refusal).toBeNull()
    expect(connected.draft.edges).toHaveLength(draft.edges.length + 1)
    expect(edit(draft, { op: 'disconnect', outlet: 'condition_1:true' }).refusal).toBeNull()
  })

  it('takes every edge with the node it deletes, so no delete can leave a dangling edge', () => {
    const draft = routed()
    const deleted = edit(draft, { op: 'delete', node: 'condition_1' })
    expect(deleted.refusal).toBeNull()
    expect(deleted.draft.nodes.map((node) => node.id)).toEqual(['entered', 'exit_1', 'exit_2'])
    expect(deleted.draft.edges).toEqual([])
    expect(edit(draft, { op: 'delete', node: 'no_such_node' }).refusal).toBe('node_not_offered')
  })

  it('selects a node that exists and refuses one that does not', () => {
    const draft = placed()
    expect(edit(draft, { op: 'select', node: 'exit_2' }).selected).toBe('exit_2')
    expect(edit(draft, { op: 'select', node: 'exit_9' }).refusal).toBe('node_not_offered')
  })
})

describe('acceptance — save is enabled by the ONE verdict and by the role, and by nothing else', () => {
  it('disables save while the graph is invalid and enables it when it is not', () => {
    const incomplete = view(placed(), owner, LIVE_NOTHING)
    expect(incomplete.canPublish).toBe(false)
    // Named, so the screen can point at the node rather than saying "invalid".
    expect(incomplete.refusals.map((refusal) => refusal.rule)).toContain(
      'flow-analysis-condition-branch-missing',
    )
    expect(incomplete.canonical).toBeNull()

    const complete = view(routed(), owner, LIVE_NOTHING)
    expect(complete.refusals).toEqual([])
    expect(complete.canPublish).toBe(true)
    // The canonical bytes exist exactly when the draft is publishable, because they are a property of
    // a valid document.
    expect(complete.canonical).toContain('"key": "cauto09_unit"')
  })

  it('disables save for a role that may open the builder and may not publish', () => {
    const asManager = view(routed(), manager, LIVE_NOTHING)
    // The graph is fine; the role is not. Both halves are reported separately, so the screen can say
    // which one it is instead of printing "not publishable" for two different reasons.
    expect(asManager.refusals).toEqual([])
    expect(asManager.canPublish).toBe(false)
    expect(asManager.mayPublishByRole).toBe(false)
    const asOwner = view(routed(), owner, LIVE_NOTHING)
    expect(asOwner.canPublish).toBe(true)
    expect(asOwner.mayPublishByRole).toBe(true)
  })

  it('splits the two permissions the way the F07 matrix already does', () => {
    // Asserted against `can()` rather than against a literal list of roles: the matrix is
    // `@berelax/core`'s and a list here would be a second statement of it. What this pins is the CHOICE
    // of the two permissions, which is this unit's decision (ADR 0081).
    expect(FLOW_READ_PERMISSION).toBe('campaign:read')
    expect(FLOW_PUBLISH_PERMISSION).toBe('campaign:send')
    // The split is a real split: a role holds one and not the other, or choosing two permissions
    // instead of one bought nothing.
    expect(can('manager', FLOW_READ_PERMISSION)).toBe(true)
    expect(can('manager', FLOW_PUBLISH_PERMISSION)).toBe(false)
    expect(can('marketer', FLOW_PUBLISH_PERMISSION)).toBe(true)
    expect(can('owner', FLOW_PUBLISH_PERMISSION)).toBe(true)
    // And neither is granted to a role with no marketing authority at all.
    for (const role of ['receptionist', 'therapist', 'auditor'] as const) {
      expect(can(role, FLOW_READ_PERMISSION), role).toBe(false)
      expect(can(role, FLOW_PUBLISH_PERMISSION), role).toBe(false)
    }
  })

  it('offers the live enrolment figure it was given, and derives the next version from it', () => {
    const published = view(routed(), owner, LIVE_PUBLISHED)
    // The figure is the one the caller counted in SQL. The view does not count, cache or adjust it:
    // "not a cached figure" is a property of where it comes from, and this is the assertion that says
    // the view is a conduit.
    expect(published.live.enrolmentsOnLiveVersion).toBe(17)
    expect(published.live.liveVersion).toBe(4)
    const fresh = view(routed(), owner, LIVE_NOTHING)
    expect(fresh.live.liveVersion).toBeNull()
    expect(fresh.live.enrolmentsOnLiveVersion).toBe(0)
  })

  it('takes the direction from the request and from nowhere else', () => {
    // A LAYOUT axis rather than a locale, and the one query parameter this screen reads. It chooses no
    // principal, no role and no permission — W-SYS-11's scan is about those — and the content is
    // identical either way, which is what makes it safe to take from a URL.
    expect(directionFrom(new URLSearchParams('dir=rtl'))).toBe('rtl')
    expect(directionFrom(new URLSearchParams(''))).toBe('ltr')
    expect(directionFrom(new URLSearchParams('dir=sideways'))).toBe('ltr')
    // And it survives an edit, or the layout would flip under the operator mid-draw.
    expect(directionFrom(new URLSearchParams(''), new URLSearchParams('dir=rtl'))).toBe('rtl')
    expect(view(routed(), owner, LIVE_NOTHING, 'rtl').direction).toBe('rtl')
    expect(view(routed(), owner, LIVE_NOTHING).direction).toBe('ltr')
  })

  it('carries the whole draft as the bytes every form posts back, and they reparse', () => {
    const published = view(routed(), owner, LIVE_PUBLISHED)
    const reparsed = JSON.parse(published.draftJson) as { nodes: unknown[]; edges: unknown[] }
    expect(reparsed.nodes).toHaveLength(4)
    expect(reparsed.edges).toHaveLength(3)
    // The field is the candidate DOCUMENT and not a private model, which is what makes "save, reload,
    // identical serialised graph" a property of one structure.
    expect(published.draftJson).toContain('"dslVersion":1')
  })
})
