import { AppError } from '@berelax/shared'
import { CONTENT_COLLECTIONS } from './collections/index.ts'
import type { ContentField } from './fields.ts'
import { CONTENT_GLOBALS } from './globals/index.ts'

/**
 * The catalogue/CMS boundary, as a check rather than a convention.
 *
 * ADR 0019 draws the line: the catalogue owns price, duration, bookability and the required skill; the
 * CMS owns narrative and SEO copy. The failure it is drawn against is specific and it is not a
 * misunderstanding — it is convenience. A treatment page needs a price beside the prose, the prose is
 * in the CMS, and adding `price_from` to the narrative is one field and saves a join. Then there are
 * two prices, the owner changes one of them, and the page and the till disagree in front of a customer.
 *
 * So the field NAMES the catalogue owns are refused here, in the model, by rule.
 */

/**
 * Words that mean the catalogue owns the value.
 *
 * Matched as whole snake_case tokens, so the realistic spellings are caught — `price_from`,
 * `duration_minutes`, `is_bookable`, `vat_rate` — while `duration` inside a sentence in a help string
 * is not, and a field called `pricing_page_link` is. That last one is deliberate: a link to the pricing
 * page belongs in navigation, not on a narrative document.
 */
export const CATALOGUE_OWNED_TOKENS = [
  'price',
  'prices',
  'pricing',
  'duration',
  'minutes',
  'bookable',
  'bookability',
  'vat',
  'tax',
] as const

/**
 * The four the acceptance names. Kept separate from the list above so widening the list cannot
 * accidentally narrow it: these must always be refused, and `boundary.test.ts` asserts each one by name.
 */
export const CATALOGUE_OWNED_FIELD_NAMES = ['price', 'duration', 'bookable', 'vat'] as const

const TOKEN_PATTERN = new RegExp(`(^|_)(${CATALOGUE_OWNED_TOKENS.join('|')})(_|$)`)

/**
 * `priceFrom`, `price_from` and `VATRate` are the same mistake; normalise before matching.
 *
 * The acronym pass comes first and it is the one that is easy to leave out: `([a-z0-9])([A-Z])` alone
 * leaves `VATRate` as `vatrate`, which no token pattern matches, and `vatRate` would have been caught.
 * A rule that catches the careful spelling and misses the shouted one is worse than no rule.
 */
export function normaliseFieldName(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

export function isCatalogueOwnedFieldName(name: string): boolean {
  return TOKEN_PATTERN.test(normaliseFieldName(name))
}

/**
 * Field names that hold a cross-boundary reference.
 *
 * `catalogue_service_id`, `therapist_id`. Each must be declared `uuidRef` — a UUID in a plain text
 * column. A Payload `relationship` would be a foreign key, and a foreign key across this line couples
 * two migration lifecycles that do not run together; see `collections/service-narrative.ts`.
 */
const CROSS_BOUNDARY_REFERENCE = /(^|_)(catalogue_[a-z0-9_]*id|[a-z0-9_]*service_id|therapist_id)$/

export function isCrossBoundaryReference(name: string): boolean {
  return CROSS_BOUNDARY_REFERENCE.test(normaliseFieldName(name))
}

/** Name-shaped fields. `therapist_narrative` may carry none of them; see that collection's note. */
const NAME_SHAPED = /(^|_)(name|names|surname|forename|firstname|lastname)(_|$)/

export function isNameShapedFieldName(name: string): boolean {
  return NAME_SHAPED.test(normaliseFieldName(name))
}

export interface BoundaryViolation {
  readonly rule:
    | 'no-catalogue-field-in-cms'
    | 'catalogue-reference-must-be-a-plain-uuid'
    | 'therapist-narrative-carries-no-name'
  readonly where: string
  readonly message: string
}

/** Descriptor and Payload-config field shapes overlap on the two properties this walk needs. */
interface WalkableField {
  readonly name?: unknown
  readonly type?: unknown
  readonly fields?: unknown
  readonly of?: unknown
  readonly tabs?: unknown
  readonly blocks?: unknown
}

/** A tab is not a field and has no name of its own; its `fields` are one level down. */
function tabFieldArrays(tabs: unknown): readonly (readonly unknown[])[] {
  if (!Array.isArray(tabs)) return []
  const out: (readonly unknown[])[] = []
  for (const tab of tabs) {
    if (tab === null || typeof tab !== 'object') continue
    const fields = (tab as WalkableField).fields
    if (Array.isArray(fields)) out.push(fields)
  }
  return out
}

/** The three keys Payload nests under, plus tabs. `of` is this package's own array-row key. */
function nestedFieldArrays(field: WalkableField): readonly (readonly unknown[])[] {
  const out: (readonly unknown[])[] = []
  for (const key of ['fields', 'of', 'blocks'] as const) {
    const nested = field[key]
    if (Array.isArray(nested)) out.push(nested)
  }
  return [...out, ...tabFieldArrays(field.tabs)]
}

/**
 * Every field in a tree, including the ones nesting hides.
 *
 * Payload nests fields under `fields` (group, array, row, collapsible), `tabs` and `blocks`, and a
 * boundary check that only looked at the top level would be satisfied by `{ name: 'commercials', type:
 * 'group', fields: [{ name: 'price' }] }`. That is not a hypothetical spelling — it is the tidy one.
 */
export function* walkFields(
  fields: readonly unknown[],
  path: readonly string[] = [],
): Generator<{ readonly field: WalkableField; readonly path: readonly string[] }> {
  for (const raw of fields) {
    if (raw === null || typeof raw !== 'object') continue
    const field = raw as WalkableField
    const name = typeof field.name === 'string' ? field.name : ''
    const here = name === '' ? path : [...path, name]
    yield { field, path: here }
    for (const nested of nestedFieldArrays(field)) yield* walkFields(nested, here)
  }
}

export interface BoundarySubject {
  readonly slug: string
  readonly fields: readonly unknown[]
}

/**
 * Judges a collection, a global, or a Payload config's `collections` entry.
 *
 * Deliberately structural rather than typed to `ContentCollection`: the same function runs over the
 * hand-written descriptors in this package AND over the config Payload actually generated, and the
 * second of those is the one that would contain a field a plugin added. See
 * `scripts/check-cms-boundary.mjs`.
 */
export function boundaryViolations(
  subjects: readonly BoundarySubject[],
): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = []

  for (const subject of subjects) {
    for (const { field, path } of walkFields(subject.fields)) {
      const name = typeof field.name === 'string' ? field.name : ''
      if (name === '') continue
      const where = `${subject.slug}.${path.join('.')}`

      if (isCatalogueOwnedFieldName(name)) {
        violations.push({
          rule: 'no-catalogue-field-in-cms',
          where,
          message:
            `field '${name}' — price, duration, bookability and VAT belong to the catalogue ` +
            '(B-CAT-03) and are read from it at render time. A second copy here is the one that ' +
            'goes stale.',
        })
      }

      if (isCrossBoundaryReference(name) && field.type !== 'uuidRef' && field.type !== 'text') {
        violations.push({
          rule: 'catalogue-reference-must-be-a-plain-uuid',
          where,
          message:
            `field '${name}' is declared '${String(field.type)}' — a cross-boundary reference is a ` +
            'UUID in a plain text column with no foreign key, because the catalogue and the CMS ' +
            'schemas are migrated on separate cycles.',
        })
      }

      if (subject.slug === 'therapist_narrative' && isNameShapedFieldName(name)) {
        violations.push({
          rule: 'therapist-narrative-carries-no-name',
          where,
          message:
            `field '${name}' — a therapist has no display name until an admin sets one, and the ` +
            'place it is set is the employee record. A second home for it is the one that reaches a ' +
            'public page unapproved.',
        })
      }
    }
  }

  return violations
}

/** Every shipped collection and global, in the shape `boundaryViolations` walks. */
export function shippedSubjects(): readonly BoundarySubject[] {
  return [
    ...CONTENT_COLLECTIONS.map((collection) => ({
      slug: collection.slug,
      fields: collection.fields as readonly ContentField[],
    })),
    ...CONTENT_GLOBALS.map((global) => ({
      slug: global.slug,
      fields: global.fields as readonly ContentField[],
    })),
  ]
}

export function assertBoundary(subjects: readonly BoundarySubject[]): void {
  const violations = boundaryViolations(subjects)
  if (violations.length === 0) return
  throw new AppError(
    'invariant_violated',
    violations.map((v) => `[${v.rule}] ${v.where}: ${v.message}`).join('\n'),
    { details: { violations: violations.length } },
  )
}
