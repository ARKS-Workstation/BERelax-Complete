/**
 * A segment definition, compiled to ONE parameterised query over an allowlisted attribute registry.
 *
 * C-AUTO-10. docs/03 §5 asks for segments a campaign can be aimed at, and the acceptance line is
 * specific about the shape: *one parameterised SQL query with a cached count*, and *a fixture segment
 * referencing a clinical table fails validation*. Both halves of that sentence decided this module.
 *
 * ## Why one query, and why the segment is a DOCUMENT rather than SQL
 *
 * A query per term is the obvious implementation and it is wrong here for the reason B-UI-03 proved for
 * the calendar's two axes: separate round trips can disagree with each other, so a contact who booked
 * between the second and the fifth appears in one term's rows and not another's — and a campaign's
 * recipient list is then a set nobody can reproduce. The count a screen shows before somebody presses
 * send has to be the count the send enumerates.
 *
 * And the definition is a document this build COMPILES, never SQL this build stores. A stored SQL string
 * would be a stored injection with a cached count attached, and the one thing a marketing screen must not
 * be able to do is author a `select` over the clinical schema. So:
 *
 *   - every term names an ATTRIBUTE by reference, and {@link SEGMENT_ATTRIBUTES} is a closed set;
 *   - the emitted text is assembled from the registry's own fragments plus `$n` placeholders, so no
 *     operator and no value ever reaches the text;
 *   - the FROM and JOIN list is derived from which registry entries the terms resolved to, so a reference
 *     that resolved to nothing contributes no table to read.
 *
 * ## The clinical refusal, in three layers
 *
 * The acceptance line asks for a fixture segment naming a clinical table to fail VALIDATION, and there
 * are three independent reasons it does. They are three because the first two can each be removed by a
 * plausible edit and the third cannot:
 *
 *   1. {@link parseSegmentAttributeRef} refuses a reference whose schema is not in
 *      {@link SEGMENT_PERMITTED_SCHEMAS}, by name, naming the schema — so
 *      `clinical.contraindication_flag.flag_key` fails with `segment-attribute-outside-the-permitted-schemas`
 *      and the message says which schema it was. This is the layer that exists to give the author of the
 *      mistake a useful answer.
 *   2. The registry is a closed set, so an unregistered reference is refused as
 *      `segment-unknown-attribute` whatever it names. This is the layer that holds for a clinical table
 *      somebody spells without its schema.
 *   3. {@link segmentRegistryFaults} holds every registry ENTRY to the permitted schemas, and
 *      `segment-compile.test.ts` asserts it is empty. This is the layer that holds the day somebody adds
 *      an entry — because layers 1 and 2 are both about what a DEFINITION may say, and neither has
 *      anything to say about what the registry may contain.
 *
 * ## Pure
 *
 * No I/O, no clock, no `Date`. The staleness of a cached count is a comparison between two instants the
 * caller supplies; the recount is `packages/db`'s, because this package may not read a database.
 */
import type { Instant } from '../time.ts'

/** The schemas a segment may read. One, and the list exists so that it can be checked against. */
export const SEGMENT_PERMITTED_SCHEMAS = ['public'] as const
export type SegmentPermittedSchema = (typeof SEGMENT_PERMITTED_SCHEMAS)[number]

/** How many terms one segment may carry. A ceiling, because the emitted query is read in one plan. */
export const SEGMENT_MAX_TERMS = 20

/** The OPEN-QUESTIONS id the cached-count staleness window is provisional until. */
export const SEGMENT_COUNT_STALENESS_OPEN_QUESTION = 'Y9-crm-pipeline'

/**
 * How long a cached count may be before a screen must call it stale.
 *
 * Fifteen minutes, which is C-AUTO-10's own provisional value — *"segment cached-count staleness window
 * 15 minutes with the timestamp shown next to the number rather than hidden"*. It is not a secret default:
 * {@link segmentCountFreshness} returns the age alongside the verdict, so the number and its age are one
 * answer and a screen cannot show the first without the second.
 */
export const SEGMENT_COUNT_STALENESS_SECONDS = 15 * 60

/** What a term may ask of an attribute. Closed, because an operator is part of the emitted text. */
export const SEGMENT_OPERATORS = [
  'equals',
  'in',
  'at_least',
  'at_most',
  'on_or_before',
  'on_or_after',
  'is_null',
  'is_not_null',
] as const
export type SegmentOperator = (typeof SEGMENT_OPERATORS)[number]

/** What kind of value an attribute compares against. Decides which operators it accepts. */
export type SegmentAttributeType = 'text' | 'boolean' | 'integer' | 'date' | 'instant'

/**
 * One readable attribute of a contact.
 *
 * `sqlExpression` is a fragment over the aliases this module's own FROM list establishes — `c` for
 * `customer`, `v` for the per-contact visit aggregate — and it is the ONLY source of table or column
 * names in the emitted text. `requiresVisitAggregate` is what decides whether the aggregate join is
 * emitted at all, so a segment that does not ask about visits does not pay for the aggregate.
 */
export interface SegmentAttribute {
  readonly schema: string
  readonly table: string
  readonly column: string
  readonly type: SegmentAttributeType
  readonly operators: readonly SegmentOperator[]
  readonly sqlExpression: string
  readonly requiresVisitAggregate: boolean
  /** One sentence for the picker. Plain language, because the picker is a marketing screen. */
  readonly label: string
}

/** `customer.lifecycle_state` and the rest: the closed set a term may name. */
export const SEGMENT_ATTRIBUTES: Readonly<Record<string, SegmentAttribute>> = Object.freeze({
  'customer.lifecycle_state': {
    schema: 'public',
    table: 'customer',
    column: 'lifecycle_state',
    type: 'text',
    operators: ['equals', 'in'],
    sqlExpression: 'c.lifecycle_state',
    requiresVisitAggregate: false,
    label: 'Lifecycle state',
  },
  'customer.acquisition_source': {
    schema: 'public',
    table: 'customer',
    column: 'acquisition_source',
    type: 'text',
    operators: ['equals', 'in'],
    sqlExpression: 'c.acquisition_source',
    requiresVisitAggregate: false,
    label: 'How they found us',
  },
  'customer.locale': {
    schema: 'public',
    table: 'customer',
    column: 'locale',
    type: 'text',
    operators: ['equals', 'in'],
    sqlExpression: 'c.locale',
    requiresVisitAggregate: false,
    label: 'Language',
  },
  'customer.is_vip': {
    schema: 'public',
    table: 'customer',
    column: 'is_vip',
    type: 'boolean',
    operators: ['equals'],
    sqlExpression: 'c.is_vip',
    requiresVisitAggregate: false,
    label: 'VIP',
  },
  'customer.created_at': {
    schema: 'public',
    table: 'customer',
    column: 'created_at',
    type: 'instant',
    operators: ['on_or_before', 'on_or_after'],
    sqlExpression: 'c.created_at',
    requiresVisitAggregate: false,
    label: 'First known to us',
  },
  'appointment.last_completed_trading_date': {
    schema: 'public',
    table: 'appointment',
    column: 'trading_date',
    type: 'date',
    operators: ['on_or_before', 'on_or_after', 'is_null', 'is_not_null'],
    sqlExpression: 'v.last_completed_trading_date',
    requiresVisitAggregate: true,
    label: 'Last completed visit (business day)',
  },
  'appointment.completed_visit_count': {
    schema: 'public',
    table: 'appointment',
    column: 'id',
    type: 'integer',
    operators: ['at_least', 'at_most', 'equals'],
    sqlExpression: 'v.completed_visit_count',
    requiresVisitAggregate: true,
    label: 'Completed visits',
  },
})

export type SegmentAttributeRef = string

/** One condition. `value` is absent for `is_null` and `is_not_null`, which compare against nothing. */
export interface SegmentTerm {
  readonly attribute: SegmentAttributeRef
  readonly operator: SegmentOperator
  readonly value?: unknown
}

/** A segment: a key, a title and terms combined one way. */
export interface SegmentDefinition {
  readonly segmentKey: string
  readonly title: string
  /** `all` is AND, `any` is OR. There is no nesting: see {@link compileSegment}. */
  readonly match: 'all' | 'any'
  readonly terms: readonly SegmentTerm[]
}

export const SEGMENT_RULES = [
  'segment-attribute-outside-the-permitted-schemas',
  'segment-unknown-attribute',
  'segment-operator-not-permitted-for-attribute',
  'segment-value-wrong-type',
  'segment-value-list-is-empty',
  'segment-no-terms',
  'segment-too-many-terms',
  'segment-key-not-lower-snake-case',
  'segment-registry-entry-outside-the-permitted-schemas',
] as const
export type SegmentRule = (typeof SEGMENT_RULES)[number]

export interface SegmentRefusal {
  readonly rule: SegmentRule
  /** Which term, as `terms.<index>`, or null for a refusal about the whole document. */
  readonly at: string | null
  readonly detail: string
}

/** A parameterised query. `text` carries `$1…$n`; `values` are bound by the driver and never spliced. */
export interface SegmentQuery {
  readonly text: string
  readonly values: readonly unknown[]
}

export type SegmentCompilation =
  | {
      readonly ok: true
      /** The contact ids. One statement. */
      readonly rows: SegmentQuery
      /** The count of the same set, from the same compilation. See {@link compileSegment}. */
      readonly count: SegmentQuery
    }
  | { readonly ok: false; readonly refusals: readonly SegmentRefusal[] }

const refusal = (rule: SegmentRule, at: string | null, detail: string): SegmentRefusal => ({
  rule,
  at,
  detail,
})

/**
 * A reference split into schema, table and column.
 *
 * Two segments means the `public` schema, which is how every attribute in the registry is written; three
 * means the schema was stated. Stating it is the only way to name another schema, and naming another
 * schema is refused — so this function is layer 1 of the three the header describes.
 */
export function parseSegmentAttributeRef(ref: string): {
  readonly schema: string
  readonly table: string
  readonly column: string
} | null {
  const parts = ref.split('.')
  if (parts.length === 2) {
    const [table, column] = parts as [string, string]
    return { schema: 'public', table, column }
  }
  if (parts.length === 3) {
    const [schema, table, column] = parts as [string, string, string]
    return { schema, table, column }
  }
  return null
}

const isPermittedSchema = (schema: string): boolean =>
  (SEGMENT_PERMITTED_SCHEMAS as readonly string[]).includes(schema)

/**
 * Every registry ENTRY that names a schema a segment may not read. Empty, and asserted to be.
 *
 * Layer 3, and the one that is not about a definition at all. Layers 1 and 2 both answer "what may a
 * term say"; neither has anything to say about what somebody adds to {@link SEGMENT_ATTRIBUTES}, and an
 * entry for `clinical.contraindication_flag.flag_key` would make every refusal above pass while the
 * compiler emitted a join into the clinical schema. So the registry is checked too, in the direction the
 * other two cannot see.
 */
export function segmentRegistryFaults(
  attributes: Readonly<Record<string, SegmentAttribute>> = SEGMENT_ATTRIBUTES,
): readonly SegmentRefusal[] {
  return Object.entries(attributes)
    .filter(([, attribute]) => !isPermittedSchema(attribute.schema))
    .map(([ref, attribute]) =>
      refusal(
        'segment-registry-entry-outside-the-permitted-schemas',
        ref,
        `The attribute "${ref}" is registered against the "${attribute.schema}" schema, and a segment ` +
          `may read only ${SEGMENT_PERMITTED_SCHEMAS.join(', ')}. A marketing screen that can select on ` +
          'a clinical field can enumerate who has that field set, which is a special-category disclosure ' +
          'made by a recipient list rather than by a message. The entry must be removed; there is no ' +
          'narrowing of it that is safe.',
      ),
    )
}

/** Which operators each attribute type may be asked with. The second half of the operator rule. */
const OPERATORS_BY_TYPE: Readonly<Record<SegmentAttributeType, readonly SegmentOperator[]>> = {
  text: ['equals', 'in', 'is_null', 'is_not_null'],
  boolean: ['equals'],
  integer: ['equals', 'at_least', 'at_most', 'is_null', 'is_not_null'],
  date: ['equals', 'on_or_before', 'on_or_after', 'is_null', 'is_not_null'],
  instant: ['on_or_before', 'on_or_after', 'is_null', 'is_not_null'],
}

const VALUELESS_OPERATORS: readonly SegmentOperator[] = ['is_null', 'is_not_null']

function valueFaultOf(
  term: SegmentTerm,
  attribute: SegmentAttribute,
  at: string,
): SegmentRefusal | null {
  if (VALUELESS_OPERATORS.includes(term.operator)) return null
  const { value } = term
  if (term.operator === 'in') {
    if (!Array.isArray(value)) {
      return refusal(
        'segment-value-wrong-type',
        at,
        `"in" compares against a list and this term's value is ${typeof value}.`,
      )
    }
    if (value.length === 0) {
      return refusal(
        'segment-value-list-is-empty',
        at,
        'An empty "in" list matches nobody, and a segment that matches nobody by accident is a campaign ' +
          'that reports a successful send to zero recipients. Removing the term is the way to say ' +
          '"no restriction".',
      )
    }
    const wrong = value.find((item) => typeof item !== 'string')
    if (wrong !== undefined) {
      return refusal(
        'segment-value-wrong-type',
        at,
        `Every item of an "in" list must be text; this list contains a ${typeof wrong}.`,
      )
    }
    return null
  }
  const expected: Readonly<Record<SegmentAttributeType, string>> = {
    text: 'string',
    boolean: 'boolean',
    integer: 'number',
    date: 'string',
    instant: 'number',
  }
  if (typeof value !== expected[attribute.type]) {
    return refusal(
      'segment-value-wrong-type',
      at,
      `${attribute.label} is a ${attribute.type} attribute, so its value must be a ` +
        `${expected[attribute.type]} and this term's is a ${typeof value}. A coerced value is how a ` +
        'segment comes to mean something other than what its author read on the screen.',
    )
  }
  if (attribute.type === 'integer' && !Number.isInteger(value)) {
    return refusal(
      'segment-value-wrong-type',
      at,
      `${attribute.label} is a count and ${String(value)} is not a whole number. A fractional count ` +
        'means the caller handed over an average, and an average compared against a row count is a ' +
        'recipient list nobody can reproduce.',
    )
  }
  return null
}

/** Every refusal a definition earns, all at once — an operator fixing a segment needs the list. */
export function validateSegmentDefinition(
  definition: SegmentDefinition,
): readonly SegmentRefusal[] {
  const out: SegmentRefusal[] = [...segmentRegistryFaults()]

  if (!/^[a-z][a-z0-9_]{0,63}$/.test(definition.segmentKey)) {
    out.push(
      refusal(
        'segment-key-not-lower-snake-case',
        null,
        `"${definition.segmentKey}" is not a segment key. The key is what a campaign names and what ` +
          'customer_segment_key_is_lower_snake_case refuses, so a definition that cannot be stored is ' +
          'refused here rather than at the insert.',
      ),
    )
  }

  if (definition.terms.length === 0) {
    out.push(
      refusal(
        'segment-no-terms',
        null,
        'A segment with no terms is every contact in the database. That is a legitimate thing to want ' +
          'and an illegitimate thing to arrive at by deleting the last term, so it has to be written ' +
          'rather than defaulted to.',
      ),
    )
  }
  if (definition.terms.length > SEGMENT_MAX_TERMS) {
    out.push(
      refusal(
        'segment-too-many-terms',
        null,
        `${definition.terms.length} terms, and the ceiling is ${SEGMENT_MAX_TERMS}. The emitted query is ` +
          'read in one plan and a segment nobody can read is a recipient list nobody reviews.',
      ),
    )
  }

  definition.terms.forEach((term, index) => {
    const at = `terms.${index}`
    const parsed = parseSegmentAttributeRef(term.attribute)
    if (parsed === null) {
      out.push(
        refusal(
          'segment-unknown-attribute',
          at,
          `"${term.attribute}" is not an attribute reference. A reference is <table>.<column>, or ` +
            '<schema>.<table>.<column> where the schema is stated.',
        ),
      )
      return
    }
    // Layer 1, and it comes BEFORE the registry lookup deliberately: `clinical.contraindication_flag.flag_key`
    // is both outside the permitted schemas and unregistered, and the refusal a reader needs is the one
    // that names the schema. The other order would answer "unknown attribute" about a reference whose
    // problem is exactly that it is known.
    if (!isPermittedSchema(parsed.schema)) {
      out.push(
        refusal(
          'segment-attribute-outside-the-permitted-schemas',
          at,
          `"${term.attribute}" reads the "${parsed.schema}" schema, and a segment may read only ` +
            `${SEGMENT_PERMITTED_SCHEMAS.join(', ')}. The clinical schema is the one this refusal exists ` +
            'for: a recipient list selected on a contraindication is a special-category disclosure made ' +
            'by the list rather than by the message, and it would leave no trace in any message record. ' +
            'There is no narrowing of such a term that is safe, so it is refused rather than scoped.',
        ),
      )
      return
    }
    const attribute = SEGMENT_ATTRIBUTES[term.attribute]
    if (attribute === undefined) {
      out.push(
        refusal(
          'segment-unknown-attribute',
          at,
          `"${term.attribute}" is not one of the attributes a segment may select on ` +
            `(${Object.keys(SEGMENT_ATTRIBUTES).join(', ')}). The set is closed, which is what makes the ` +
            'emitted query unable to name a table nobody allowed.',
        ),
      )
      return
    }
    if (
      !attribute.operators.includes(term.operator) ||
      !OPERATORS_BY_TYPE[attribute.type].includes(term.operator)
    ) {
      out.push(
        refusal(
          'segment-operator-not-permitted-for-attribute',
          at,
          `${attribute.label} may be asked with ${attribute.operators.join(', ')}, not with ` +
            `"${term.operator}". The operator is part of the emitted text, so an unlisted one is a ` +
            'fragment this module would have to compose rather than look up.',
        ),
      )
      return
    }
    const valueFault = valueFaultOf(term, attribute, at)
    if (valueFault !== null) out.push(valueFault)
  })

  return out
}

/** The `$n` fragment and the value one term contributes. */
function fragmentFor(
  attribute: SegmentAttribute,
  term: SegmentTerm,
  nextIndex: number,
): { readonly text: string; readonly values: readonly unknown[] } {
  const expression = attribute.sqlExpression
  switch (term.operator) {
    case 'is_null':
      return { text: `${expression} is null`, values: [] }
    case 'is_not_null':
      return { text: `${expression} is not null`, values: [] }
    case 'in':
      return { text: `${expression} = any($${nextIndex})`, values: [term.value] }
    case 'equals':
      return { text: `${expression} = $${nextIndex}`, values: [term.value] }
    case 'at_least':
      return { text: `${expression} >= $${nextIndex}`, values: [term.value] }
    case 'at_most':
      return { text: `${expression} <= $${nextIndex}`, values: [term.value] }
    case 'on_or_before':
      return { text: `${expression} <= $${nextIndex}`, values: [term.value] }
    case 'on_or_after':
      return { text: `${expression} >= $${nextIndex}`, values: [term.value] }
  }
}

/**
 * The per-contact visit aggregate, emitted only when a term asks about visits.
 *
 * A LATERAL rather than a correlated subquery per term, because the two terms that read it —
 * `last_completed_trading_date` and `completed_visit_count` — must be derived from the SAME scan. Two
 * correlated subqueries over `appointment` are two reads, and a contact whose visit completes between
 * them has a last-visit date with no visit behind it.
 *
 * `status = 'completed'` and nothing else. A no-show is not a visit and a cancellation is not a visit,
 * and C-AUTO-11's win-back arithmetic rests on this being the only reading of "last visit" in the build.
 */
const VISIT_AGGREGATE = `
    left join lateral (
      select max(a.trading_date) as last_completed_trading_date,
             count(*) as completed_visit_count
        from appointment a
        join booking b on b.id = a.booking_id
       where b.customer_id = c.id and a.status = 'completed'
    ) v on true`

/**
 * One segment, as one parameterised query — and the count of the same set, from the same compilation.
 *
 * Two queries are returned and they are not two readings: `count` is `select count(*) from (<rows>)`, so
 * the number a screen shows before somebody presses send and the set the send enumerates are the same
 * WHERE clause by construction. That is what the acceptance line's "cached count equals a live recount"
 * is asserted against, and a separately written count query is the shape that drifts.
 *
 * There is no nesting and no `not`. `match: 'all' | 'any'` over a flat term list is what a segment screen
 * can render and an operator can read, and a nested boolean tree is a thing nobody reviews before sending
 * to it. A segment that genuinely needs one is two segments.
 */
export function compileSegment(definition: SegmentDefinition): SegmentCompilation {
  const refusals = validateSegmentDefinition(definition)
  if (refusals.length > 0) return { ok: false, refusals }

  const values: unknown[] = []
  const fragments: string[] = []
  let needsVisitAggregate = false

  for (const term of definition.terms) {
    // Non-null by construction: `validateSegmentDefinition` returned nothing, so every reference resolved.
    const attribute = SEGMENT_ATTRIBUTES[term.attribute] as SegmentAttribute
    if (attribute.requiresVisitAggregate) needsVisitAggregate = true
    const fragment = fragmentFor(attribute, term, values.length + 1)
    fragments.push(fragment.text)
    values.push(...fragment.values)
  }

  const joiner = definition.match === 'all' ? ' and ' : ' or '
  const where = fragments.map((fragment) => `(${fragment})`).join(joiner)
  // An erased contact is never a recipient. Not a term an author can remove: 0085 pseudonymises the
  // phone number, so a send would go to the `erased-...` placeholder — and a campaign that counted them
  // would report a recipient total nobody could reach.
  const rowsText =
    `select c.id as "customerId"\n      from customer c${needsVisitAggregate ? VISIT_AGGREGATE : ''}` +
    `\n     where c.erased_at is null and (${where})\n     order by c.id`

  return {
    ok: true,
    rows: { text: rowsText, values },
    count: {
      text: `select count(*)::int as "count" from (\n${rowsText}\n    ) as matched`,
      values,
    },
  }
}

/** The canonical byte form of a definition, so a stored segment is comparable with a committed one. */
export function serialiseSegmentDefinition(definition: SegmentDefinition): string {
  return JSON.stringify({
    segmentKey: definition.segmentKey,
    title: definition.title,
    match: definition.match,
    terms: definition.terms.map((term) => ({
      attribute: term.attribute,
      operator: term.operator,
      ...(term.value === undefined ? {} : { value: term.value }),
    })),
  })
}

export type SegmentCountFreshness =
  | { readonly kind: 'never_counted' }
  | {
      readonly kind: 'fresh' | 'stale'
      readonly count: number
      readonly countedAt: Instant
      readonly ageSeconds: number
      readonly stalenessCeilingSeconds: number
    }

/**
 * Whether a cached count may still be shown as current, and how old it is either way.
 *
 * The age is returned on BOTH verdicts on purpose. C-AUTO-10's provisional answer is that the timestamp
 * is *"shown next to the number rather than hidden"*, and a function that returned only `fresh` would let
 * a screen satisfy the letter of that by printing a reassuring word. A caller that has the verdict has
 * the age, so there is nothing for a screen to omit without omitting the number too.
 *
 * `never_counted` is its own answer and is not a zero. A segment nobody has counted and a segment that
 * matches nobody are different facts, and the second one is a reason not to send.
 */
export function segmentCountFreshness(input: {
  readonly cachedCount: number | null
  readonly cachedCountAt: Instant | null
  readonly at: Instant
  readonly stalenessCeilingSeconds?: number
}): SegmentCountFreshness {
  if (input.cachedCount === null || input.cachedCountAt === null) return { kind: 'never_counted' }
  const stalenessCeilingSeconds = input.stalenessCeilingSeconds ?? SEGMENT_COUNT_STALENESS_SECONDS
  const ageSeconds = (input.at - input.cachedCountAt) / 1000
  return {
    kind: ageSeconds >= stalenessCeilingSeconds ? 'stale' : 'fresh',
    count: input.cachedCount,
    countedAt: input.cachedCountAt,
    ageSeconds,
    stalenessCeilingSeconds,
  }
}
