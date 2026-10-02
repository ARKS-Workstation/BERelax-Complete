import {
  classedMessageStep,
  conditionStep,
  delayStep,
  exitStep,
  type FlowNode,
  type FlowTemplateFact,
  stageStep,
  tagStep,
  templateChoicesFor,
  templateRefFor,
} from '@berelax/core'
import {
  FLOW_CONDITION_FACTS,
  FLOW_EXIT_REASONS,
  FLOW_TRIGGER_EVENTS,
  isBooleanConditionFact,
  MESSAGE_CHANNELS,
  MESSAGE_CLASSES,
  type MessageClass,
} from '@berelax/shared'

/**
 * The palette: what an operator may add to a journey, and how a posted form becomes a node.
 *
 * One module per concern of the builder, and this is the concern the acceptance line's second half lives
 * in: *"the action node's template picker lists only templates whose message_class matches the node's
 * declared class"*. {@link messageChoices} is `templateChoicesFor` from `@berelax/core` and nothing else
 * — the same function whose RETURN TYPE is the only thing `classedMessageStep` accepts. So the list the
 * screen renders and the set of bindings the type permits are one value, and there is no filter in a
 * view that could be forgotten.
 *
 * ## Why a posted template key is resolved rather than trusted
 *
 * A form posts strings and a type does not cross HTTP. So {@link nodeFromForm} does not build a message
 * node out of the posted class and the posted key; it asks `templateRefFor(registry, class, key)` for a
 * reference, and `null` is the refusal. A body naming `booking.confirmed` under `promotional` therefore
 * stops here with `template_not_offered`, and the same graph sent straight to `/crm/flows/api` stops
 * there with `flow-dsl-message-class-mismatch`. Both layers, which is what the acceptance asks for.
 *
 * ## No message copy, no invented vocabulary
 *
 * Every value an operator can choose comes from a closed list this build already has: the trigger events
 * are `FLOW_TRIGGER_EVENTS`, the facts `FLOW_CONDITION_FACTS`, the channels `MESSAGE_CHANNELS`, the exit
 * reasons `FLOW_EXIT_REASONS`, and the templates are KEYS from `message_template`. Nothing here is a
 * message body, a therapist's name or a tag somebody made up — the tag and the stage are typed by the
 * operator and carried verbatim, and the stage is checked against `pipeline_stage` by `moveCard` at the
 * one moment it can be (C-AUTO-06's NOTE, C-AUTO-08's `stage_archived`).
 */

/** The kinds the palette offers. The trigger is not among them: a journey has exactly one, added once. */
export const PALETTE_KINDS = [
  'delay',
  'condition',
  'action_message',
  'action_tag',
  'action_stage',
  'split',
  'exit',
] as const
export type PaletteKind = (typeof PALETTE_KINDS)[number]

export const isPaletteKind = (value: string): value is PaletteKind =>
  (PALETTE_KINDS as readonly string[]).includes(value)

/** What the palette calls each kind on the screen. A `Record`, so a new kind has to be named. */
export const PALETTE_LABELS: Readonly<Record<PaletteKind, string>> = {
  delay: 'Wait',
  condition: 'Ask a question',
  action_message: 'Send a message',
  action_tag: 'Tag the contact',
  action_stage: 'Move the pipeline card',
  split: 'Split the audience',
  exit: 'End the journey',
}

/** Why each kind exists, printed beside it, so the palette explains itself to whoever reads it. */
export const PALETTE_WHY: Readonly<Record<PaletteKind, string>> = {
  delay: 'Hold the contact for a number of minutes before the next step.',
  condition: 'Answer one fact about the contact and route the two answers separately.',
  action_message: 'Send one template on one channel. The class comes from the template.',
  action_tag: 'Write a tag onto the contact.',
  action_stage: 'Move the contact’s card into a pipeline column.',
  split: 'Divide the audience by weight, so two treatments can be compared.',
  exit: 'Finish, with the reason a report will read.',
}

/** The field names the builder's forms post. One statement, read by the renderer and the handler. */
export const BUILDER_FIELDS = {
  draft: 'draft',
  operation: 'op',
  kind: 'kind',
  nodeId: 'node',
  /**
   * An outlet, as ONE field: `node:branch`, spelled by `journeyOutletKey` in `@berelax/core`.
   *
   * One field because an outlet is a PAIR and a `<select>` has one value. Two fields is what the first
   * version had, and the branch then never arrived from the control that was supposed to carry it.
   */
  outlet: 'outlet',
  to: 'to',
  /** `rtl` mirrors the layout. A direction axis rather than a locale — `render.ts` says why. */
  direction: 'dir',
  title: 'title',
  event: 'event',
  minutes: 'minutes',
  fact: 'fact',
  operator: 'operator',
  value: 'value',
  messageClass: 'class',
  templateKey: 'template',
  channel: 'channel',
  tag: 'tag',
  stage: 'stage',
  shares: 'shares',
  reason: 'reason',
  note: 'note',
} as const

/** Every reason the palette cannot build the node a form asked for, as a value. */
export const PALETTE_REFUSALS = [
  'unknown_kind',
  'event_not_offered',
  'minutes_not_offered',
  'fact_not_offered',
  'operator_does_not_fit_fact',
  'class_not_offered',
  /** The posted key is not a template of the posted class. The misrouting, refused at the HTTP edge. */
  'template_not_offered',
  'channel_not_offered',
  'tag_invalid',
  'stage_invalid',
  'shares_not_offered',
  'reason_not_offered',
  'note_too_long',
] as const
export type PaletteRefusal = (typeof PALETTE_REFUSALS)[number]

export const PALETTE_SENTENCES: Readonly<Record<PaletteRefusal, string>> = {
  unknown_kind: 'That is not a step this builder can add.',
  event_not_offered: 'Choose one of the events a journey can start on.',
  minutes_not_offered: 'A wait is a whole number of minutes, from 1 to 259,200 (180 days).',
  fact_not_offered: 'Choose one of the facts a condition can answer.',
  operator_does_not_fit_fact:
    'A yes-or-no fact takes “is true” or “is false” and no value; a fact that holds a value takes ' +
    '“equals” or “does not equal” and a value.',
  class_not_offered: 'Choose whether this message is transactional or promotional.',
  template_not_offered:
    'That template is not of the class this step declares, so it was never offered for it. The class ' +
    'is fixed on the template (C-AUTO-01) — change the step’s class, or choose a template of this one.',
  channel_not_offered: 'Choose a channel this build can send on.',
  tag_invalid: 'A tag is lower snake_case, 1 to 48 characters.',
  stage_invalid: 'A pipeline column is lower snake_case, 1 to 48 characters.',
  shares_not_offered: 'Choose one of the share splits offered.',
  reason_not_offered: 'Choose the reason a report should read for this ending.',
  note_too_long: 'A note is at most 200 characters.',
}

/** The splits the palette offers, each summing to 1000 per mille so the node is shape-valid as built. */
export const PALETTE_SHARES: readonly {
  readonly id: string
  readonly label: string
  readonly branches: readonly { readonly label: string; readonly weightPerMille: number }[]
}[] = [
  {
    id: 'half',
    label: 'Two halves (500 / 500)',
    branches: [
      { label: 'share_1', weightPerMille: 500 },
      { label: 'share_2', weightPerMille: 500 },
    ],
  },
  {
    id: 'tenth',
    label: 'A tenth held back (100 / 900)',
    branches: [
      { label: 'share_1', weightPerMille: 100 },
      { label: 'share_2', weightPerMille: 900 },
    ],
  },
  {
    id: 'thirds',
    label: 'Three ways (333 / 333 / 334)',
    branches: [
      { label: 'share_1', weightPerMille: 333 },
      { label: 'share_2', weightPerMille: 333 },
      { label: 'share_3', weightPerMille: 334 },
    ],
  },
]

/** The condition operators, with the wording the screen uses. Derived from the pairing rule, not typed. */
export const CONDITION_OPERATORS: readonly {
  readonly id: 'is_true' | 'is_false' | 'equals' | 'not_equals'
  readonly label: string
  readonly needsValue: boolean
}[] = [
  { id: 'is_true', label: 'is true', needsValue: false },
  { id: 'is_false', label: 'is false', needsValue: false },
  { id: 'equals', label: 'equals', needsValue: true },
  { id: 'not_equals', label: 'does not equal', needsValue: true },
]

/**
 * The templates offered for one class — the picker's list AND the binding's type, from one call.
 *
 * A one-line wrapper on purpose. It is the single place the screen gets its options from, so a reviewer
 * can see that nothing else filters the registry, and `flow-builder.itest.ts` asserts the rendered
 * `<option>` set equals this function's answer for both classes.
 */
export function messageChoices<C extends MessageClass>(
  registry: readonly FlowTemplateFact[],
  messageClass: C,
): readonly { readonly templateKey: string; readonly messageClass: C }[] {
  return templateChoicesFor(registry, messageClass)
}

const VOCABULARY_VALUE = /^[a-z][a-z0-9_]{0,47}$/
const MAX_NOTE = 200
const MAX_MINUTES = 180 * 24 * 60

const text = (form: URLSearchParams, field: string): string => (form.get(field) ?? '').trim()

/** The note the form carried, or a refusal, or nothing. Optional everywhere, so it is resolved once. */
function noteFrom(form: URLSearchParams): { readonly note?: string } | PaletteRefusal {
  const value = text(form, BUILDER_FIELDS.note)
  if (value === '') return {}
  if (value.length > MAX_NOTE) return 'note_too_long'
  return { note: value }
}

const isRefusal = (value: unknown): value is PaletteRefusal =>
  typeof value === 'string' && (PALETTE_REFUSALS as readonly string[]).includes(value)

/**
 * The trigger node a form asked for, or a named refusal.
 *
 * Separate from {@link nodeFromForm} because a trigger is not a palette step: a journey has exactly one
 * and the builder offers it once, which is the same reason `composeJourney` takes it as its own field.
 */
export function triggerFromForm(form: URLSearchParams, id: string): FlowNode | PaletteRefusal {
  const event = text(form, BUILDER_FIELDS.event)
  if (!(FLOW_TRIGGER_EVENTS as readonly string[]).includes(event)) return 'event_not_offered'
  const note = noteFrom(form)
  if (isRefusal(note)) return note
  return {
    id,
    kind: 'trigger',
    event: event as (typeof FLOW_TRIGGER_EVENTS)[number],
    ...note,
  }
}

/** One kind's builder: the fields it reads, the refusals it names, and the typed step it reaches. */
type KindBuilder = (
  form: URLSearchParams,
  id: string,
  note: { readonly note?: string },
  registry: readonly FlowTemplateFact[],
) => FlowNode | PaletteRefusal

const buildDelay: KindBuilder = (form, id, note) => {
  const minutes = Number(text(form, BUILDER_FIELDS.minutes))
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
    return 'minutes_not_offered'
  }
  return delayStep({ minutes, ...note }).node(id)
}

const buildCondition: KindBuilder = (form, id, note) => {
  const fact = text(form, BUILDER_FIELDS.fact)
  if (!(FLOW_CONDITION_FACTS as readonly string[]).includes(fact)) return 'fact_not_offered'
  const operator = text(form, BUILDER_FIELDS.operator)
  const chosen = CONDITION_OPERATORS.find((candidate) => candidate.id === operator)
  if (chosen === undefined) return 'operator_does_not_fit_fact'
  /*
    The pairing rule is `isBooleanConditionFact`'s, READ rather than restated: a yes-or-no fact takes the
    two boolean operators and no value, a fact that holds a value takes the other two and a value. The
    schema refuses the mismatch by name as well (`flow-dsl-condition-operator-does-not-fit-fact`), and
    refusing it here is what lets the screen say which control is wrong instead of printing a
    document-level rule after the save control was already disabled for a different reason.
  */
  if (isBooleanConditionFact(fact) === chosen.needsValue) return 'operator_does_not_fit_fact'
  const value = text(form, BUILDER_FIELDS.value)
  if (chosen.needsValue && (value === '' || value.length > 64)) return 'operator_does_not_fit_fact'
  return conditionStep({
    test: {
      fact: fact as (typeof FLOW_CONDITION_FACTS)[number],
      operator: chosen.id,
      ...(chosen.needsValue ? { value } : {}),
    },
    ...note,
  }).node(id)
}

/**
 * THE line, and the reason this module exists as its own file.
 *
 * A posted key becomes a {@link TemplateRef} only under the class the REGISTRY holds for it, so a body
 * asking for a promotional node bound to `booking.confirmed` resolves to `null` here and is refused by
 * name — and the picker never offered the pair, because the picker is `messageChoices`, which is the
 * same function whose return type `classedMessageStep` is the only acceptor of.
 */
const buildMessage: KindBuilder = (form, id, note, registry) => {
  const messageClass = text(form, BUILDER_FIELDS.messageClass)
  if (!(MESSAGE_CLASSES as readonly string[]).includes(messageClass)) return 'class_not_offered'
  const channel = text(form, BUILDER_FIELDS.channel)
  if (!(MESSAGE_CHANNELS as readonly string[]).includes(channel)) return 'channel_not_offered'
  const template = templateRefFor(
    registry,
    messageClass as MessageClass,
    text(form, BUILDER_FIELDS.templateKey),
  )
  if (template === null) return 'template_not_offered'
  return classedMessageStep({
    messageClass: template.messageClass,
    template,
    channel: channel as (typeof MESSAGE_CHANNELS)[number],
    ...note,
  }).node(id)
}

const buildTag: KindBuilder = (form, id, note) => {
  const tag = text(form, BUILDER_FIELDS.tag)
  if (!VOCABULARY_VALUE.test(tag)) return 'tag_invalid'
  return tagStep({ tag, ...note }).node(id)
}

const buildStage: KindBuilder = (form, id, note) => {
  const stage = text(form, BUILDER_FIELDS.stage)
  if (!VOCABULARY_VALUE.test(stage)) return 'stage_invalid'
  return stageStep({ stage, ...note }).node(id)
}

/**
 * A split, built from one of the offered share sets rather than through `splitStep`.
 *
 * `splitStep`'s `const L` type parameter is what carries a split's branch LABELS into the edge map, and
 * a label chosen at runtime has no literal type to carry — so the typed constructor has nothing to add
 * here. The node is the same shape, and every label comes from {@link PALETTE_SHARES} above, so nothing
 * unchecked reaches it. What the type does is in the composer; what the offer does is here.
 */
const buildSplit: KindBuilder = (form, id, note) => {
  const shares = PALETTE_SHARES.find(
    (candidate) => candidate.id === text(form, BUILDER_FIELDS.shares),
  )
  if (shares === undefined) return 'shares_not_offered'
  return {
    id,
    kind: 'split',
    branches: shares.branches.map((branch) => ({ ...branch })),
    ...note,
  }
}

const buildExit: KindBuilder = (form, id, note) => {
  const reason = text(form, BUILDER_FIELDS.reason)
  if (!(FLOW_EXIT_REASONS as readonly string[]).includes(reason)) return 'reason_not_offered'
  return exitStep({ reason: reason as (typeof FLOW_EXIT_REASONS)[number], ...note }).node(id)
}

/**
 * One builder per kind, as a total `Record` over {@link PALETTE_KINDS}.
 *
 * A table rather than a `switch`, so a kind added to the list without a builder is a TYPE error instead
 * of a `default` branch that refuses it at runtime — the `default` arm of the switch this replaced was
 * unreachable and therefore untestable, which is the shape ADR 0002 is about.
 */
const BUILDERS: Readonly<Record<PaletteKind, KindBuilder>> = {
  delay: buildDelay,
  condition: buildCondition,
  action_message: buildMessage,
  action_tag: buildTag,
  action_stage: buildStage,
  split: buildSplit,
  exit: buildExit,
}

/**
 * The node a posted form asked for, or a named refusal — never a node built from unchecked strings.
 *
 * Every branch goes through the typed step constructor in `@berelax/core` rather than assembling an
 * object here, so the node this returns is one `composeJourney` could have produced. That is not a style
 * preference: `action_message` reaches `classedMessageStep`, whose template argument is a `TemplateRef`,
 * and the only way to hold one is `templateRefFor` — so the misrouting has no path through this function
 * either.
 */
export function nodeFromForm(
  form: URLSearchParams,
  id: string,
  registry: readonly FlowTemplateFact[],
): FlowNode | PaletteRefusal {
  const kind = text(form, BUILDER_FIELDS.kind)
  if (!isPaletteKind(kind)) return 'unknown_kind'
  const note = noteFrom(form)
  if (isRefusal(note)) return note
  return BUILDERS[kind](form, id, note, registry)
}
