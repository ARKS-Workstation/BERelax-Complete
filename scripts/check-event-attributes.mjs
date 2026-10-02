#!/usr/bin/env node
/**
 * Every declared event in the markup is an event the taxonomy holds, with the payload its schema requires.
 *
 * A-FIRST-06's collector reads tracking off the element: `data-berelax-event` names the event and one
 * attribute per payload field carries the rest (ADR 0078). That design exists so that *what the site
 * collects* is a set of strings a check can read without running anything — and this is the check. Without
 * it the design is worse than hand-written call sites, because a mistyped attribute is silent in both
 * directions: the page still renders, the button still works, and the event is refused at `/api/collect`
 * as `unknown_event` weeks later, by which time the funnel stage it belonged to has been empty long enough
 * to look like a real figure.
 *
 * ## What it reads, and why it reads the real taxonomy
 *
 * It imports `ANALYTICS_EVENT_NAMES` and `ANALYTICS_EVENT_SCHEMAS` from
 * `packages/shared/src/analytics/taxonomy.ts` and the attribute derivation from
 * `packages/ui/src/analytics/attributes.ts`, which is why this script runs under `tsx`. A copy of either
 * list here would be the second statement of the thing the whole estate is built to state once — and the
 * copy is the one that would go stale, so the check would pass over exactly the markup it exists to refuse.
 * The required attributes per event are therefore DERIVED from each event's own Zod shape, and a value
 * written in the markup is parsed through that field's own schema.
 *
 * ## Seven rules, each with a known-bad fixture
 *
 * `scripts/test-gates.mjs` block 156 breaks one thing per case and requires the rule below BY NAME
 * (ADR 0003) — a bare non-zero exit is satisfied by a syntax error in this file. The rules are listed in
 * {@link RULES}, and the reason there are seven rather than one is that the acceptance line's rule (an
 * unknown event name) is the one a developer is least likely to write: the likelier mistakes are a payload
 * attribute misspelled, a value outside the vocabulary, and an attribute on an element that declares no
 * event at all — each of which produces a tag that looks deployed and collects nothing.
 *
 * The seventh was written because this unit MADE the mistake. `whatsapp_ref_shown`'s payload holds
 * `refCode` and nothing else, every payload schema is a `strictObject`, and the collector adds `path` to
 * every declared interaction — so an element declaring that event produced a payload `/api/collect` refuses
 * whole as `invalid_event_payload`. It rendered, it worked, and it would have produced 400s on a write path
 * nobody reads the body of. `apps/web/e2e/collector.itest.ts` caught it by parsing the posted batch through
 * the server's own envelope; `event-attribute-declares-an-event-with-no-page-field` is what makes it
 * impossible on any surface.
 *
 * ## Why a text scan and not a parser
 *
 * The claim is about what the markup SAYS. A JSX parser would read `data-berelax-event={name}` and report
 * an expression it cannot evaluate, which is the one case this file refuses outright
 * (`event-attribute-is-not-a-literal`): an event name behind an expression is a declaration no static check
 * can read, so it is a defect rather than something to be clever about. Everything else is a literal, and
 * a scan over literals cannot be defeated by a build tool changing its mind about dead code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_EVENT_SCHEMAS,
  isAnalyticsEventName,
} from '../packages/shared/src/analytics/taxonomy.ts'
import {
  declaredPayloadAttributes as attributesForShape,
  COLLECTOR_SUPPLIED_PAYLOAD_FIELDS,
  DECLARED_EVENT_PAGE_FIELDS,
  payloadFieldForAttribute,
  TRACK_ATTRIBUTE_PREFIX,
  TRACK_EVENT_ATTRIBUTE,
  trackPayloadAttribute,
} from '../packages/ui/src/analytics/attributes.ts'

/**
 * One event's Zod shape, narrowed once.
 *
 * Every member of `ANALYTICS_EVENT_SCHEMAS` is a `z.strictObject`, so every one has a `shape`. The
 * narrowing lives here rather than in `packages/ui/src/analytics/attributes.ts` for the reason that
 * file's header gives at length: reaching the registry means importing `zod`, and that module ships to a
 * browser. This script does not, so the validation library is free here and the derivation it feeds —
 * `declaredPayloadFields` — still has exactly one statement, in the module the collector itself reads.
 */
const shapeOf = (name) => ANALYTICS_EVENT_SCHEMAS[name].shape

/** The attributes an element declaring `name` has to carry, derived from that event's own schema. */
const declaredPayloadAttributes = (name) => attributesForShape(shapeOf(name))

/**
 * Whether one attribute's literal value satisfies its field's own schema.
 *
 * `true` for a field the event does not have, because "that field is not in this payload" is a DIFFERENT
 * refusal with a different message, and folding the two together would report a missing field as a bad
 * value and send a tag author to the wrong fix.
 */
function payloadValueIsValid(name, field, value) {
  const schema = shapeOf(name)[field]
  if (schema === undefined) return true
  return schema.safeParse(value).success
}

const ROOTS = ['apps', 'packages']
const EXTENSIONS = new Set(['.ts', '.tsx', '.html'])
const SKIP_DIRECTORIES = new Set(['.claude', 'node_modules', 'dist', '.next', 'artifacts'])

/**
 * The rule names a known-bad fixture asserts against, so a case fails BY NAME and not by exit code.
 */
const RULES = {
  notLiteral: 'event-attribute-is-not-a-literal',
  unknownEvent: 'event-attribute-names-an-unknown-event',
  missingPayload: 'event-attribute-missing-a-payload-attribute',
  badValue: 'event-attribute-payload-value-outside-the-schema',
  orphanPayload: 'event-payload-attribute-without-an-event',
  unknownField: 'event-payload-attribute-is-not-a-payload-field',
  noPageField: 'event-attribute-declares-an-event-with-no-page-field',
}

/**
 * Files that carry these attribute names as DATA, exempted by name with the reason.
 *
 * Not a courtesy, and the control is that each one still resolves to a file that EXISTS — the arrangement
 * `scripts/check-egress-guard.mjs` records after two of the existing scans fired on each other's pattern
 * text. The alternative to naming them is rewording prose until a regexp is satisfied, which is appeasing
 * a check rather than fixing one.
 *
 * Note what is NOT here: `apps/web/app/_analytics/collector-fixture.tsx` and
 * `apps/web/app/_book/booking-page.tsx`. Those are the two files that really declare events, and they are
 * scanned like any others — the fixture page is where this check does most of its work.
 */
const EXEMPT = new Map([
  [
    'packages/ui/src/analytics/attributes.ts',
    'the one statement of the attribute vocabulary: it holds the prefix and the event attribute as the ' +
      'constants everything else derives from',
  ],
  [
    'packages/ui/src/analytics/use-track.ts',
    'builds the selector from the attribute and reads it off an element; its subject is the attribute',
  ],
  [
    'packages/ui/src/analytics/attributes.test.ts',
    'drives the derivation over every event in the taxonomy, so it names attributes that no markup has',
  ],
  [
    'packages/ui/src/analytics/use-track.test.ts',
    'drives the reader with deliberately wrong attributes, which is what proves each refusal fires',
  ],
  [
    'apps/web/e2e/collector.itest.ts',
    'names the attribute inside a CSS SELECTOR — `a[data-berelax-event="cta_click"]` — which is how it ' +
      'finds the one declared element on /book. Exempt by name rather than by widening the matcher: a ' +
      'selector and an attribute are the same characters, and a rule taught to tell them apart would be a ' +
      'rule that can be defeated by writing markup that looks like a selector',
  ],
])

/** The one place an attribute may be composed rather than written, and why. */
const EXPRESSION_ALLOWED = new Map()

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) yield full
  }
}

const violations = []
const record = (rule, where, detail) => violations.push({ rule, where, detail })

const lineOf = (text, index) => text.slice(0, index).split('\n').length

/**
 * The attribute text of the element that owns the attribute at `index`.
 *
 * Backwards to the nearest `<` that opens a tag, forwards to the `>` that closes it — tracking quotes and
 * JSX brace depth, because `onClick={() => count > 1}` contains a `>` that does not close anything and an
 * element cut off there would be read as having no payload attributes at all.
 *
 * Returns null when no opening tag can be found, which is the case for an attribute name inside a string
 * in a module that is not markup. A null is reported by the caller rather than skipped: a declaration this
 * function cannot locate is a declaration this check is not reading.
 */

/** The `<` of the tag that owns the attribute at `index`. `-1` when the attribute is not in markup. */
function openingTagStart(text, index) {
  for (let at = index; at >= 0; at -= 1) {
    if (text[at] === '<' && /[A-Za-z]/.test(text[at + 1] ?? '')) return at
  }
  return -1
}

/** The `>` that closes the tag opened at `start`, skipping quotes and JSX braces. `-1` when there is none. */
function closingAngle(text, start) {
  let depth = 0
  let quote = null
  for (let at = start + 1; at < text.length; at += 1) {
    const char = text[at]
    if (quote !== null) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
    } else if (char === '>' && depth === 0) {
      return at
    }
  }
  return -1
}

function elementAround(text, index) {
  const start = openingTagStart(text, index)
  if (start === -1) return null
  const end = closingAngle(text, start)
  if (end === -1) return null
  return { start, end, text: text.slice(start, end) }
}

/** Every `data-berelax-…="literal"` in one element's attribute text, by attribute name. */
function literalAttributes(elementText) {
  const found = new Map()
  const pattern = new RegExp(`(${TRACK_ATTRIBUTE_PREFIX}[a-z-]+)="([^"]*)"`, 'g')
  for (const match of elementText.matchAll(pattern)) {
    const [, name, value] = match
    if (name !== undefined && value !== undefined) found.set(name, value)
  }
  return found
}

/** Every `data-berelax-…={expression}` in one element's attribute text, by attribute name. */
function expressionAttributes(elementText) {
  const found = []
  const pattern = new RegExp(`(${TRACK_ATTRIBUTE_PREFIX}[a-z-]+)=\\{`, 'g')
  for (const match of elementText.matchAll(pattern)) {
    if (match[1] !== undefined) found.push(match[1])
  }
  return found
}

/** Every payload field any event in the taxonomy has, so a misspelled attribute is a named refusal. */
const KNOWN_PAYLOAD_ATTRIBUTES = new Set(
  ANALYTICS_EVENT_NAMES.flatMap((name) => [...declaredPayloadAttributes(name)]),
)

let scanned = 0
let declarations = 0

for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (EXEMPT.has(file)) continue
    const text = readFileSync(file, 'utf8')
    if (!text.includes(TRACK_ATTRIBUTE_PREFIX)) continue
    scanned += 1

    // Pass one: every element that declares an event.
    const declaredElements = []
    const eventPattern = new RegExp(`${TRACK_EVENT_ATTRIBUTE}=`, 'g')
    for (const match of text.matchAll(eventPattern)) {
      const at = match.index ?? 0
      const element = elementAround(text, at)
      const where = `${file}:${lineOf(text, at)}`
      if (element === null) {
        record(
          RULES.notLiteral,
          where,
          `${TRACK_EVENT_ATTRIBUTE} appears outside any element this scan can read, so what it declares ` +
            'is not checkable. Declare it on an element, or exempt the file by name with a reason.',
        )
        continue
      }
      declaredElements.push(element)
      const literals = literalAttributes(element.text)
      const name = literals.get(TRACK_EVENT_ATTRIBUTE)
      if (name === undefined) {
        record(
          RULES.notLiteral,
          where,
          `${TRACK_EVENT_ATTRIBUTE} is not a double-quoted literal here. An event name behind an ` +
            'expression is a declaration no static check can read, so the whole of this gate stops ' +
            'applying to it — which is the one failure the declarative design exists to prevent.',
        )
        continue
      }
      declarations += 1
      if (!isAnalyticsEventName(name)) {
        record(
          RULES.unknownEvent,
          where,
          `"${name}" is not an event in the measurement taxonomy, which holds ` +
            `${ANALYTICS_EVENT_NAMES.join(', ')}. Adding one is a committed diff in ` +
            'packages/shared/src/analytics/taxonomy.ts carrying a Zod schema, because an event nothing ' +
            'validates is a partition of rows no reporting query can read.',
        )
        continue
      }
      const missingPageFields = DECLARED_EVENT_PAGE_FIELDS.filter(
        (field) => shapeOf(name)[field] === undefined,
      )
      if (missingPageFields.length > 0) {
        record(
          RULES.noPageField,
          where,
          `${name} has no ${missingPageFields.join(', ')} field, so it cannot be declared on an element: ` +
            'the collector adds that field to every declared interaction, every payload schema is a ' +
            'strictObject, and an extra property is refused as invalid_event_payload - a tag that ' +
            'renders, works, and produces a 400 nobody is watching. Raise it through trackCollectorEvent ' +
            'instead, which is where the events that are not page-located belong.',
        )
        continue
      }
      for (const attribute of declaredPayloadAttributes(name)) {
        if (literals.has(attribute)) continue
        record(
          RULES.missingPayload,
          where,
          `${name} declares a payload field this element does not carry: ${attribute} is absent. The ` +
            `required set is derived from the event's own schema and is ` +
            `${declaredPayloadAttributes(name).join(', ')}; ` +
            `${COLLECTOR_SUPPLIED_PAYLOAD_FIELDS.join(' and ')} are the collector's and are never ` +
            'declared on an element.',
        )
      }
      for (const [attribute, value] of literals) {
        if (attribute === TRACK_EVENT_ATTRIBUTE) continue
        const field = payloadFieldForAttribute(attribute)
        if (field === null) continue
        if (!KNOWN_PAYLOAD_ATTRIBUTES.has(attribute)) {
          record(
            RULES.unknownField,
            where,
            `${attribute} is not a payload attribute of any event in the taxonomy. The ones that exist ` +
              `are ${[...KNOWN_PAYLOAD_ATTRIBUTES].sort().join(', ')}. An attribute nothing reads is a ` +
              'payload field a tag author believes is being collected.',
          )
          continue
        }
        if (payloadValueIsValid(name, field, value)) continue
        record(
          RULES.badValue,
          where,
          `${attribute}="${value}" is refused by ${name}'s own schema for ${field}. The value is parsed ` +
            'through that field in packages/shared/src/analytics/taxonomy.ts, so this is the vocabulary ' +
            'the catalogue and the funnel actually have rather than a list kept here.',
        )
      }
    }

    // Pass two: a payload attribute on an element that declares no event. Dead markup that collects
    // nothing, and the likeliest way a call to action comes to be half-tracked.
    const payloadPattern = new RegExp(`${TRACK_ATTRIBUTE_PREFIX}[a-z-]+=`, 'g')
    for (const match of text.matchAll(payloadPattern)) {
      const at = match.index ?? 0
      const attribute = (match[0] ?? '').slice(0, -1)
      if (attribute === TRACK_EVENT_ATTRIBUTE) continue
      const element = elementAround(text, at)
      if (element === null) continue
      if (declaredElements.some((declared) => declared.start === element.start)) continue
      record(
        RULES.orphanPayload,
        `${file}:${lineOf(text, at)}`,
        `${attribute} is on an element that declares no ${TRACK_EVENT_ATTRIBUTE}, so nothing reads it. ` +
          'The payload attributes are fields OF an event; one on its own is a control somebody believes ' +
          'is tracked and is not.',
      )
    }

    for (const attribute of declaredElements.flatMap((element) =>
      expressionAttributes(element.text),
    )) {
      if (EXPRESSION_ALLOWED.has(file)) continue
      // The event attribute itself has already been reported by pass one, which has the line number.
      // Reporting it twice would make one mistake look like two and send a reader to the wrong fix.
      if (attribute === TRACK_EVENT_ATTRIBUTE) continue
      record(
        RULES.notLiteral,
        file,
        `${attribute} is composed from an expression. The whole of this gate is a scan over literals: a ` +
          'value behind an expression is invisible to it, so the element would be declared and unchecked.',
      )
    }
  }
}

/*
 * The controls, first, because every assertion above is a difference against a derived set and a
 * difference against nothing is empty.
 *
 * Three things are checked about the SCANNER rather than about the tree, and each one of them has been
 * wrong in a sibling gate in this repository: an allowance pointed at a file that no longer exists, a
 * derived set that came back empty, and a scan that read no files at all. Any of those passes silently.
 */
const problems = []
for (const [file, reason] of EXEMPT) {
  if (reason.length === 0) problems.push(`${file} is exempt with no reason`)
  try {
    statSync(file)
  } catch {
    problems.push(
      `${file} is exempt from this scan and does not exist. A renamed or deleted file leaves the ` +
        'exemption pointed at nothing, which is how an allowance outlives the thing it was written for.',
    )
  }
}
if (ANALYTICS_EVENT_NAMES.length === 0) {
  problems.push(
    'the taxonomy came back empty, so every name would be unknown and nothing is checked',
  )
}
if (KNOWN_PAYLOAD_ATTRIBUTES.size === 0) {
  problems.push(
    'no event in the taxonomy derived a single payload attribute, so the derivation read nothing and ' +
      'both the missing-attribute and unknown-field rules are vacuous',
  )
}
// The derivation itself, in both directions, against the one field name every reader of this gate knows:
// `cta_click` carries `target` and the collector supplies `path`.
if (trackPayloadAttribute('refCode') !== `${TRACK_ATTRIBUTE_PREFIX}ref-code`) {
  problems.push(
    'trackPayloadAttribute no longer kebab-cases a camelCase field, so an attribute the markup carries ' +
      'and the attribute the collector looks for are two different strings',
  )
}
if (!KNOWN_PAYLOAD_ATTRIBUTES.has(trackPayloadAttribute('target'))) {
  problems.push(
    `${trackPayloadAttribute('target')} is not in the derived set, so the derivation is not reading the ` +
      "events' schemas",
  )
}
for (const supplied of COLLECTOR_SUPPLIED_PAYLOAD_FIELDS) {
  if (KNOWN_PAYLOAD_ATTRIBUTES.has(trackPayloadAttribute(supplied))) {
    problems.push(
      `${trackPayloadAttribute(supplied)} is required of an element and is supplied by the collector. ` +
        'Every declaration in the tree would then be reported as missing an attribute it must not carry.',
    )
  }
}
for (const field of DECLARED_EVENT_PAGE_FIELDS) {
  if (!COLLECTOR_SUPPLIED_PAYLOAD_FIELDS.includes(field)) {
    problems.push(
      `${field} is added to every declared interaction and is not in the collector-supplied list, so the ` +
        'checker would require an element to declare an attribute the collector then overwrites',
    )
  }
}
if (DECLARED_EVENT_PAGE_FIELDS.length === 0) {
  problems.push(
    'no field is added to a declared interaction, so the page-field rule can never fire and an event ' +
      "whose schema refuses the collector's own field would be declarable",
  )
}
if (declarations === 0) {
  problems.push(
    'not one declared event was found in apps or packages. The scan examined nothing, which is a passing ' +
      'check that has never been seen to do anything (ADR 0002) — if tracking has genuinely been removed, ' +
      'remove this gate rather than leaving it green over an empty set.',
  )
}

if (problems.length > 0) {
  console.error('The event-attribute scanner did not read what it thinks it read:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(`\n${problems.length} problem(s).`)
  process.exit(1)
}

if (violations.length > 0) {
  console.error('Declared event attributes that the taxonomy refuses:\n')
  for (const violation of violations) {
    console.error(`  ${violation.rule}`)
    console.error(`    ${violation.where}  ${violation.detail}`)
  }
  console.error(
    `\n${violations.length} violation(s). A declared event the taxonomy does not hold is refused by ` +
      '/api/collect as unknown_event, which is a tag that looks deployed and collects nothing — so it is ' +
      'a build failure here instead (A-FIRST-06, ADR 0078).',
  )
  process.exit(1)
}

console.log(
  `Every declared event attribute is in the taxonomy: ${declarations} declaration(s) across ${scanned} ` +
    `file(s) in ${ROOTS.join(', ')}, checked against ${ANALYTICS_EVENT_NAMES.length} event(s) and ` +
    `${KNOWN_PAYLOAD_ATTRIBUTES.size} derived payload attribute(s), with ${EXEMPT.size} file(s) exempt ` +
    'because the attribute names are their subject.',
)
