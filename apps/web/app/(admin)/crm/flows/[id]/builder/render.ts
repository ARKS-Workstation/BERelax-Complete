import type { FlowNode, FlowTemplateFact, JourneyDraft } from '@berelax/core'
import { journeyOutletKey, safeText } from '@berelax/core'
import {
  FLOW_CONDITION_FACTS,
  FLOW_EXIT_REASONS,
  FLOW_TRIGGER_EVENTS,
  isBooleanConditionFact,
  MESSAGE_CHANNELS,
  MESSAGE_CLASSES,
} from '@berelax/shared'
import { tokensCss } from '@berelax/ui'
import {
  ADMIN_BANNER_CSS,
  type AdminChrome,
  renderAdminBanner,
} from '../../../../../../src/components/admin/google-reauth-banner.ts'
import type { FlowLiveState } from '../../api/handler.ts'
import {
  BUILDER_FIELDS,
  CONDITION_OPERATORS,
  messageChoices,
  PALETTE_KINDS,
  PALETTE_LABELS,
  PALETTE_SHARES,
  PALETTE_WHY,
} from './nodes/palette.ts'

/**
 * The journey builder, drawn (C-AUTO-09).
 *
 * Pure: a view in, a document out. No database, no clock — the instant the counts were read at arrives
 * on the view and is printed, which is what lets two repeat captures produce identical screenshots.
 *
 * ## The accessible list IS the graph, and the canvas is what is missing
 *
 * The acceptance line asks that "an accessible list view of the graph is present as a non-canvas
 * fallback" and that every node can be added, selected, connected and deleted keyboard-only. This screen
 * is the list, and there is no canvas beside it: `reactflow` is not in `apps/web/package.json` and
 * adding a dependency is `pnpm deps`' decision rather than this unit's to make quietly. So the graph is a
 * `<table>` of steps and a `<table>` of connections, every edit is a native `<form>` with native
 * controls, and the whole screen works with scripting disabled — which is the strongest form of
 * "keyboard-only" there is, because there is no focus management to get wrong.
 *
 * The manifest carries a NOTE saying the canvas is deferred and naming what it needs. Nothing about the
 * routing guarantee depends on it: the type that makes a misrouting unexpressible is in
 * `@berelax/core`, and a canvas drawn over these same offers would inherit it.
 *
 * ## Why the refusals are printed above the graph and the save control is disabled rather than absent
 *
 * An operator needs to know WHY they cannot save, and a control that has vanished says nothing. So the
 * `<button>` carries `disabled` and the reason is a list of named rules with the node each one is about
 * — `at` on a `FlowRefusal` is a node id or an edge description precisely so this screen can point.
 *
 * ## Colours
 *
 * Every colour is a token (brief rule 11); `pnpm colours` refuses a literal hex outside the token layer.
 */

export interface BuilderOutletView {
  readonly from: string
  readonly branch: string
  readonly kind: string
}

export interface BuilderInletView {
  readonly to: string
  readonly kind: string
}

export interface BuilderRefusalView {
  readonly rule: string
  readonly at: string | null
  readonly detail: string
}

/**
 * `ltr` or `rtl`. A LAYOUT axis rather than a locale — see the note below.
 *
 * `?dir=rtl` re-renders this English document mirrored, which is what the pipeline board, the duplicate
 * queue and the merge preview all do and all record the same reason for: a registry *document* must be
 * served in BOTH locales, which needs an Arabic admin document and the W-SYS-01 shell, so the direction
 * half of the accessibility and screenshot matrices is audited without inventing an Arabic admin
 * surface. It is worth having rather than cosmetic: every inset, border and alignment in `BUILDER_CSS`
 * is written with a logical property, and the mirrored render is the only thing that would catch a
 * physical one.
 */
export type BuilderDirection = 'ltr' | 'rtl'

export interface BuilderView {
  /**
   * The Google re-auth banner's state, on every admin document without exception.
   *
   * `apps/web/src/google-reauth-banner.test.ts` enumerates the admin renders and refuses one that
   * draws no banner: an operator on a screen that cannot tell them the connection is broken is the
   * failure G-CONN-07 exists to remove, and a journey builder is exactly a screen somebody works in
   * for a long time. This unit shipped without it and that case named the file.
   */
  readonly chrome: AdminChrome
  readonly flowKey: string
  readonly path: string
  readonly direction: BuilderDirection
  /** The whole draft, as the bytes every form posts back. The builder's only state. */
  readonly draftJson: string
  readonly draft: JourneyDraft
  readonly registry: readonly FlowTemplateFact[]
  readonly live: FlowLiveState
  readonly outlets: readonly BuilderOutletView[]
  readonly inlets: readonly BuilderInletView[]
  readonly selected: string | null
  readonly canPublish: boolean
  readonly mayPublishByRole: boolean
  readonly refusals: readonly BuilderRefusalView[]
  /** The canonical bytes, when the draft is publishable. What "reloading reproduces" is asserted on. */
  readonly canonical: string | null
  readonly refusal: { readonly name: string; readonly sentence: string } | null
  readonly publishRefusal: {
    readonly name: string
    readonly sentence: string
    readonly rules: readonly string[]
  } | null
  readonly published: { readonly version: number; readonly remaining: number } | null
  readonly readAtIso: string
}

const BUILDER_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 72rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  h2 { font-size: 1.125rem; margin: var(--space-7) 0 var(--space-3); }
  h3 { font-size: 1rem; margin: var(--space-5) 0 var(--space-2); }
  p { margin: 0 0 var(--space-5); }
  .card, .state, .refusal, .done {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-5);
  }
  .state, .refusal, .done {
    background: var(--color-surface-sand);
    border-color: var(--color-border);
    border-inline-start-width: var(--space-2);
  }
  table { width: 100%; border-collapse: collapse; margin: 0 0 var(--space-5); }
  caption { text-align: start; font-weight: 600; padding: 0 0 var(--space-2); }
  th, td {
    text-align: start;
    padding: var(--space-3);
    border-block-end: 1px solid var(--color-hairline);
    vertical-align: top;
  }
  tr[aria-selected="true"] td { background: var(--color-surface-sand); }
  form { display: grid; gap: var(--space-3); }
  form.row {
    grid-auto-flow: column;
    grid-auto-columns: max-content;
    align-items: end;
    gap: var(--space-3);
  }
  label { display: grid; gap: var(--space-2); font-weight: 600; }
  input[type="text"], input[type="number"], select {
    font: inherit;
    padding: var(--space-3);
    min-height: 3rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface);
    color: var(--color-ink);
  }
  button {
    font: inherit;
    font-weight: 600;
    min-height: 3rem;
    padding: var(--space-3) var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-ink);
    color: var(--color-ground);
    justify-self: start;
  }
  button.quiet { background: var(--color-surface); color: var(--color-ink); }
  button[disabled] {
    background: var(--color-surface);
    color: var(--color-ink-muted);
    border-style: dashed;
  }
  fieldset {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    padding: var(--space-3) var(--space-5) var(--space-5);
    margin: 0 0 var(--space-5);
  }
  legend { font-weight: 600; padding: 0 var(--space-2); }
  ul.rules { margin: 0; padding-inline-start: var(--space-5); }
  ul.rules li { margin: 0 0 var(--space-2); }
  code, pre { font-family: ui-monospace, monospace; }
  pre {
    margin: 0;
    padding: var(--space-3);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--color-ground);
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-1);
    font-size: 0.875rem;
  }
  .empty { color: var(--color-ink-muted); }
  .muted { color: var(--color-ink-muted); font-weight: 400; }
`

/** The hidden field every form carries: the whole draft, which is the builder's only state. */
const draftField = (view: BuilderView): string =>
  `<input type="hidden" name="${BUILDER_FIELDS.draft}" value="${safeText(view.draftJson)}">` +
  // The direction travels with every edit. Without it the first POST would answer in `ltr` and the
  // layout would flip under the operator mid-edit — which is also what would make a mirrored
  // screenshot of a post-edit page quietly un-mirrored.
  (view.direction === 'rtl'
    ? `<input type="hidden" name="${BUILDER_FIELDS.direction}" value="rtl">`
    : '')

/** What a node IS, in one readable line, derived from the node and never from a second description. */
export function describeNode(node: FlowNode): string {
  switch (node.kind) {
    case 'trigger':
      return `starts on ${node.event}`
    case 'delay':
      return `waits ${node.minutes} minute${node.minutes === 1 ? '' : 's'}`
    case 'condition':
      return `asks whether ${node.test.fact} ${node.test.operator}${
        node.test.value === undefined ? '' : ` ${node.test.value}`
      }`
    case 'action_message':
      return `sends ${node.templateKey} (${node.messageClass}) by ${node.channel}`
    case 'action_tag':
      return `tags ${node.tag}`
    case 'action_stage':
      return `moves the card to ${node.stage}`
    case 'split':
      return `splits ${node.branches
        .map((branch) => `${branch.label} ${branch.weightPerMille}‰`)
        .join(', ')}`
    case 'exit':
      return `ends as ${node.reason}`
    default:
      return 'unknown'
  }
}

function stepsTable(view: BuilderView): string {
  if (view.draft.nodes.length === 0) {
    return (
      '<p class="empty">Nothing is drawn yet. Add the way in below: every other step is something the ' +
      'trigger leads to.</p>'
    )
  }
  return (
    '<table><caption>The steps in this journey</caption><thead><tr>' +
    '<th scope="col">Step</th><th scope="col">Kind</th><th scope="col">What it does</th>' +
    '<th scope="col">Note</th><th scope="col">Select</th><th scope="col">Delete</th>' +
    '</tr></thead><tbody>' +
    view.draft.nodes
      .map(
        (node) =>
          `<tr aria-selected="${node.id === view.selected ? 'true' : 'false'}">` +
          `<th scope="row"><code>${safeText(node.id)}</code></th>` +
          `<td>${safeText(node.kind)}</td>` +
          `<td>${safeText(describeNode(node))}</td>` +
          `<td>${node.note === undefined ? '<span class="empty">—</span>' : safeText(node.note)}</td>` +
          `<td><form method="post" action="${view.path}">${draftField(view)}` +
          `<input type="hidden" name="${BUILDER_FIELDS.operation}" value="select">` +
          `<input type="hidden" name="${BUILDER_FIELDS.nodeId}" value="${safeText(node.id)}">` +
          `<button type="submit" class="quiet">Select ${safeText(node.id)}</button>` +
          '</form></td>' +
          `<td><form method="post" action="${view.path}">${draftField(view)}` +
          `<input type="hidden" name="${BUILDER_FIELDS.operation}" value="delete">` +
          `<input type="hidden" name="${BUILDER_FIELDS.nodeId}" value="${safeText(node.id)}">` +
          `<button type="submit" class="quiet">Delete ${safeText(node.id)}</button>` +
          '</form></td></tr>',
      )
      .join('') +
    '</tbody></table>'
  )
}

function edgesTable(view: BuilderView): string {
  if (view.draft.edges.length === 0) {
    return '<p class="empty">No connections yet.</p>'
  }
  return (
    '<table><caption>The connections in this journey</caption><thead><tr>' +
    '<th scope="col">From</th><th scope="col">Branch</th><th scope="col">To</th>' +
    '<th scope="col">Disconnect</th></tr></thead><tbody>' +
    view.draft.edges
      .map(
        (edge) =>
          `<tr><th scope="row"><code>${safeText(edge.from)}</code></th>` +
          `<td><code>${safeText(edge.branch)}</code></td>` +
          `<td><code>${safeText(edge.to)}</code></td>` +
          `<td><form method="post" action="${view.path}">${draftField(view)}` +
          `<input type="hidden" name="${BUILDER_FIELDS.operation}" value="disconnect">` +
          `<input type="hidden" name="${BUILDER_FIELDS.outlet}" ` +
          `value="${safeText(journeyOutletKey(edge.from, edge.branch))}">` +
          '<button type="submit" class="quiet">Disconnect ' +
          `${safeText(edge.from)} ${safeText(edge.branch)}</button></form></td></tr>`,
      )
      .join('') +
    '</tbody></table>'
  )
}

/**
 * The connect control: two `<select>`s whose options are the OFFERS and nothing else.
 *
 * This is the acceptance line's first half made visible. The "from" list is `freeOutletsOf` — so an exit
 * contributes nothing, a branch that already has a connection is gone, and a branch a kind does not
 * declare was never there — and the "to" list is `inletsOf`, which never holds the trigger. A misrouting
 * is therefore not a thing the operator can select, and the handler resolves what was posted against the
 * same two functions, so a crafted body cannot name one either.
 */
function connectControl(view: BuilderView): string {
  if (view.outlets.length === 0 || view.inlets.length === 0) {
    return (
      '<p class="empty">Nothing can be connected yet: a connection needs a step with a free way out ' +
      'and a step that can receive one.</p>'
    )
  }
  return (
    `<form method="post" action="${view.path}" class="row">${draftField(view)}` +
    `<input type="hidden" name="${BUILDER_FIELDS.operation}" value="connect">` +
    '<label for="builder-outlet">Connect from' +
    `<select id="builder-outlet" name="${BUILDER_FIELDS.outlet}" required>` +
    view.outlets
      .map(
        (outlet) =>
          `<option value="${safeText(journeyOutletKey(outlet.from, outlet.branch))}">` +
          `${safeText(outlet.from)} (${safeText(outlet.kind)}) — ${safeText(outlet.branch)}</option>`,
      )
      .join('') +
    '</select></label>' +
    '<label for="builder-to">to' +
    `<select id="builder-to" name="${BUILDER_FIELDS.to}" required>` +
    view.inlets
      .map(
        (inlet) =>
          `<option value="${safeText(inlet.to)}">${safeText(inlet.to)} ` +
          `(${safeText(inlet.kind)})</option>`,
      )
      .join('') +
    '</select></label>' +
    '<button type="submit">Connect</button>' +
    '</form>'
  )
}

function triggerControl(view: BuilderView): string {
  if (view.draft.nodes.some((node) => node.kind === 'trigger')) {
    return (
      '<p class="empty">The way in is drawn. A journey has exactly one, which is why this control is ' +
      'offered once.</p>'
    )
  }
  return (
    `<form method="post" action="${view.path}" class="row">${draftField(view)}` +
    `<input type="hidden" name="${BUILDER_FIELDS.operation}" value="trigger">` +
    '<label for="builder-event">Start this journey on' +
    `<select id="builder-event" name="${BUILDER_FIELDS.event}" required>` +
    FLOW_TRIGGER_EVENTS.map(
      (event) => `<option value="${safeText(event)}">${safeText(event)}</option>`,
    ).join('') +
    '</select></label>' +
    '<button type="submit">Add the way in</button>' +
    '</form>'
  )
}

/**
 * The palette: one `<fieldset>` and one `<form>` per card, so no control is ever shared between two.
 *
 * `action_message` expands into TWO cards, one per message class, and that is the acceptance line rather
 * than a layout choice. A single card with a class `<select>` and a template `<select>` filtered from it
 * needs a script, and a picker that is only correct once a script has run is a picker that is wrong with
 * scripting off. Two cards are correct in both states — and the first version of this file put both
 * classes in ONE form, which posted `class` and `template` twice and made the promotional picker
 * decorative; `flow-builder.itest.ts`'s keyboard pass is what found it.
 */
function paletteForms(view: BuilderView): string {
  return PALETTE_CARDS.flatMap((card) =>
    card.kind === 'action_message'
      ? MESSAGE_CLASSES.map((messageClass) => messageCard(view, messageClass))
      : [simpleCard(view, card.kind)],
  ).join('')
}

/** The cards, in palette order. A list so the message card's expansion is visible in one place. */
const PALETTE_CARDS: readonly { readonly kind: (typeof PALETTE_KINDS)[number] }[] =
  PALETTE_KINDS.map((kind) => ({ kind }))

function card(
  view: BuilderView,
  body: {
    legend: string
    why: string
    fields: string
    kind: string
    submit: string
    suffix: string
  },
): string {
  return (
    `<fieldset><legend>${safeText(body.legend)}</legend>` +
    `<p class="muted">${safeText(body.why)}</p>` +
    `<form method="post" action="${view.path}" class="row">${draftField(view)}` +
    `<input type="hidden" name="${BUILDER_FIELDS.operation}" value="place">` +
    `<input type="hidden" name="${BUILDER_FIELDS.kind}" value="${safeText(body.kind)}">` +
    body.fields +
    `<label for="builder-note-${safeText(body.suffix)}">Note` +
    `<input type="text" id="builder-note-${safeText(body.suffix)}" ` +
    `name="${BUILDER_FIELDS.note}" maxlength="200"></label>` +
    `<button type="submit">${safeText(body.submit)}</button>` +
    '</form></fieldset>'
  )
}

function simpleCard(view: BuilderView, kind: (typeof PALETTE_KINDS)[number]): string {
  return card(view, {
    legend: PALETTE_LABELS[kind],
    why: PALETTE_WHY[kind],
    fields: kindFields(kind),
    kind,
    submit: `Add ${PALETTE_LABELS[kind].toLowerCase()}`,
    suffix: kind,
  })
}

/**
 * The message card for ONE class: its own form, its own channel control, its own picker.
 *
 * The acceptance line is *"the action node's template picker lists only templates whose message_class
 * matches the node's declared class"*, and this is where it is satisfied — by DERIVATION. The options
 * come from `messageChoices(registry, class)`, which is `templateChoicesFor` from `@berelax/core`, which
 * is the same function whose return TYPE is the only thing `classedMessageStep` accepts. A list that
 * showed more could not produce a reference for the extra rows, so the screen and the type cannot drift
 * into disagreeing about which bindings are legal.
 */
function messageCard(view: BuilderView, messageClass: (typeof MESSAGE_CLASSES)[number]): string {
  const choices = messageChoices(view.registry, messageClass)
  if (choices.length === 0) {
    return (
      `<fieldset><legend>${safeText(PALETTE_LABELS.action_message)} (${messageClass})</legend>` +
      `<p class="empty">No ${safeText(messageClass)} template is current, so no ` +
      `${safeText(messageClass)} step can be added.</p></fieldset>`
    )
  }
  const fields =
    `<input type="hidden" name="${BUILDER_FIELDS.messageClass}" value="${messageClass}">` +
    `<label for="builder-channel-${messageClass}">Channel` +
    `<select id="builder-channel-${messageClass}" name="${BUILDER_FIELDS.channel}" required>` +
    MESSAGE_CHANNELS.map(
      (value) => `<option value="${safeText(value)}">${safeText(value)}</option>`,
    ).join('') +
    '</select></label>' +
    `<label for="builder-template-${messageClass}">${safeText(messageClass)} template` +
    `<select id="builder-template-${messageClass}" name="${BUILDER_FIELDS.templateKey}" ` +
    `data-message-class="${messageClass}" required>` +
    choices
      .map(
        (choice) =>
          `<option value="${safeText(choice.templateKey)}">${safeText(choice.templateKey)}</option>`,
      )
      .join('') +
    '</select></label>'
  return card(view, {
    legend: `${PALETTE_LABELS.action_message} (${messageClass})`,
    why: `${PALETTE_WHY.action_message} This card offers the ${messageClass} templates only.`,
    fields,
    kind: 'action_message',
    submit: `Add ${messageClass} message`,
    suffix: `message-${messageClass}`,
  })
}

function kindFields(kind: (typeof PALETTE_KINDS)[number]): string {
  switch (kind) {
    case 'delay':
      return (
        '<label for="builder-minutes">Minutes' +
        `<input type="number" id="builder-minutes" name="${BUILDER_FIELDS.minutes}" ` +
        'min="1" max="259200" step="1" required value="1440"></label>'
      )
    case 'condition':
      return (
        '<label for="builder-fact">Fact' +
        `<select id="builder-fact" name="${BUILDER_FIELDS.fact}" required>` +
        FLOW_CONDITION_FACTS.map(
          (fact) =>
            `<option value="${safeText(fact)}">${safeText(fact)}` +
            `${isBooleanConditionFact(fact) ? ' (yes or no)' : ' (holds a value)'}</option>`,
        ).join('') +
        '</select></label>' +
        '<label for="builder-operator">Operator' +
        `<select id="builder-operator" name="${BUILDER_FIELDS.operator}" required>` +
        CONDITION_OPERATORS.map(
          (operator) =>
            `<option value="${operator.id}">${safeText(operator.label)}` +
            `${operator.needsValue ? ' (needs a value)' : ''}</option>`,
        ).join('') +
        '</select></label>' +
        '<label for="builder-value">Value, for an operator that needs one' +
        `<input type="text" id="builder-value" name="${BUILDER_FIELDS.value}" maxlength="64">` +
        '</label>'
      )
    case 'action_message':
      // Unreachable: `paletteForms` expands this kind into `messageCard` per class, which has its own
      // fields. Returning empty rather than throwing, because a kind added to the list and not to this
      // switch must render a card with no fields rather than take the screen down.
      return ''
    case 'action_tag':
      return (
        '<label for="builder-tag">Tag' +
        `<input type="text" id="builder-tag" name="${BUILDER_FIELDS.tag}" required ` +
        'maxlength="48" pattern="[a-z][a-z0-9_]*"></label>'
      )
    case 'action_stage':
      return (
        '<label for="builder-stage">Pipeline column' +
        `<input type="text" id="builder-stage" name="${BUILDER_FIELDS.stage}" required ` +
        'maxlength="48" pattern="[a-z][a-z0-9_]*"></label>'
      )
    case 'split':
      return (
        '<label for="builder-shares">Shares' +
        `<select id="builder-shares" name="${BUILDER_FIELDS.shares}" required>` +
        PALETTE_SHARES.map(
          (share) => `<option value="${share.id}">${safeText(share.label)}</option>`,
        ).join('') +
        '</select></label>'
      )
    case 'exit':
      return (
        '<label for="builder-reason">Reason' +
        `<select id="builder-reason" name="${BUILDER_FIELDS.reason}" required>` +
        FLOW_EXIT_REASONS.map(
          (reason) => `<option value="${safeText(reason)}">${safeText(reason)}</option>`,
        ).join('') +
        '</select></label>'
      )
    default:
      return ''
  }
}

/**
 * The save control, and the enrolment figure beside it.
 *
 * The figure is the acceptance line: *"before saving an edit to a published flow, the displayed count of
 * enrolments that will remain on the current version equals the live enrolment row count"*. It is
 * counted in SQL per request by `countEnrolmentsOnVersion` and printed here; nothing caches it, which is
 * the other half of that line.
 */
function saveControl(view: BuilderView): string {
  const remaining = view.live.enrolmentsOnLiveVersion
  const live = view.live.liveVersion
  const standing =
    live === null
      ? '<p>Nothing is published for this journey yet, so this will be version 1 and no enrolment is ' +
        'pinned to anything.</p>'
      : `<p><strong data-enrolments-remaining="${remaining}">${remaining}</strong> active ` +
        `enrolment${remaining === 1 ? '' : 's'} will remain on version ` +
        `<strong data-live-version="${live}">${live}</strong> after this edit is saved. A published ` +
        'version is never edited — saving appends version ' +
        `${live + 1}, and every enrolment already running keeps the document it was pinned to.</p>`
  const reason = view.mayPublishByRole
    ? 'This journey is not publishable yet. The rules it breaks are listed above.'
    : 'Your role may open the builder and may not publish a journey.'
  return (
    `<div class="state">${standing}` +
    `<form method="post" action="${view.path}">${draftField(view)}` +
    `<input type="hidden" name="${BUILDER_FIELDS.operation}" value="publish">` +
    `<button type="submit" data-save ${view.canPublish ? '' : 'disabled'}>` +
    `Save as version ${live === null ? 1 : live + 1}</button>` +
    (view.canPublish ? '' : `<p class="muted">${safeText(reason)}</p>`) +
    '</form></div>'
  )
}

function refusalList(view: BuilderView): string {
  if (view.refusals.length === 0) {
    return (
      '<p class="done" data-publishable="true">This journey is publishable: every step leads ' +
      'somewhere, every branch is routed, and every message step names a template of its own class.</p>'
    )
  }
  return (
    '<div class="refusal" data-publishable="false"><p><strong>Not publishable yet.</strong> ' +
    `${view.refusals.length} rule${view.refusals.length === 1 ? '' : 's'} to fix:</p>` +
    '<ul class="rules">' +
    view.refusals
      .map(
        (refusal) =>
          `<li><code data-rule="${safeText(refusal.rule)}">${safeText(refusal.rule)}</code>` +
          `${refusal.at === null ? '' : ` at <code>${safeText(refusal.at)}</code>`} — ` +
          `${safeText(refusal.detail)}</li>`,
      )
      .join('') +
    '</ul></div>'
  )
}

export function renderFlowBuilderHtml(view: BuilderView): string {
  return [
    '<!doctype html>',
    `<html lang="en" dir="${view.direction}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's brand-collision rule, scanned by `apps/web/src/seo/brand.test.ts`.
    '<title>Journey builder — CRM admin</title>',
    `<style>${tokensCss()}${ADMIN_BANNER_CSS}${BUILDER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    `<h1>Journey builder: <code>${safeText(view.flowKey)}</code></h1>`,
    `<p>Read at ${safeText(view.readAtIso)}. This screen draws a journey and publishes it as a new ` +
      'version; it never edits a published one, because the enrolments already running are pinned to ' +
      'the version they started on.</p>',
    view.published === null
      ? ''
      : `<p class="done"><strong>Saved as version ${view.published.version}.</strong> ` +
        `${view.published.remaining} active enrolment` +
        `${view.published.remaining === 1 ? '' : 's'} remain on the version it supersedes.</p>`,
    view.refusal === null
      ? ''
      : `<p class="refusal" data-refusal="${safeText(view.refusal.name)}">` +
        `<strong>That edit was refused.</strong> ${safeText(view.refusal.sentence)}</p>`,
    view.publishRefusal === null
      ? ''
      : `<p class="refusal" data-publish-refusal="${safeText(view.publishRefusal.name)}">` +
        `<strong>Not published.</strong> ${safeText(view.publishRefusal.sentence)}` +
        (view.publishRefusal.rules.length === 0
          ? ''
          : ` Rules: ${safeText(view.publishRefusal.rules.join(', '))}.`) +
        '</p>',
    '<h2>What this journey is</h2>',
    refusalList(view),
    saveControl(view),
    '<h2>The graph</h2>',
    stepsTable(view),
    edgesTable(view),
    '<h2>Connect two steps</h2>',
    `<div class="card">${connectControl(view)}</div>`,
    '<h2>The way in</h2>',
    `<div class="card">${triggerControl(view)}</div>`,
    '<h2>Add a step</h2>',
    paletteForms(view),
    '<h2>The serialised graph</h2>',
    view.canonical === null
      ? '<p class="empty">A journey is serialised once it is publishable, because the canonical bytes ' +
        'are a property of a valid document.</p>'
      : `<pre data-canonical>${safeText(view.canonical)}</pre>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}
