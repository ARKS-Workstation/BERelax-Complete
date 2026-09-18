import type { ContentField } from '@berelax/cms'
import type { Field } from 'payload'

/**
 * Turns a content-model descriptor into a Payload field.
 *
 * The descriptors live in `@berelax/cms` and know nothing about Payload; see that package's `fields.ts`
 * for why. This is the only place the two vocabularies meet, which is what keeps the boundary gate able
 * to read one list and the admin able to serve the other.
 */

/** A UUID in any version. The catalogue mints v7 (migration 0002), but this only has to reject prose. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Lower-case, digits and single hyphens. No leading, trailing or doubled hyphen. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * The two validators worth having.
 *
 * A slug reaches a URL and a `catalogue_service_id` reaches a lookup against a table in another schema
 * that has no foreign key to catch a typo (see `collections/service-narrative.ts` in `@berelax/cms`).
 * Those are the two places where a value an editor typed becomes something else's problem, so they are
 * the two that are checked on the way in.
 */
type SimpleValidator = (value: unknown) => true | string

function validatorFor(field: ContentField): SimpleValidator {
  if (field.type === 'slug') {
    return (value: unknown) =>
      typeof value === 'string' && SLUG.test(value)
        ? true
        : 'A slug is lower-case words joined by single hyphens, e.g. “deep-tissue”.'
  }
  return (value: unknown) => {
    if (value === null || value === undefined || value === '') {
      // Presence is `required`'s job. A validator that also rejected empty would report two errors for
      // one mistake and give the editor two things to read.
      return true
    }
    return typeof value === 'string' && UUID.test(value)
      ? true
      : 'This is the UUID of a record in another system — 36 characters, five hyphen-separated groups.'
  }
}

export function toPayloadField(field: ContentField): Field {
  // `help` is read into a local first. `...(field.help === undefined ? {} : { admin: { description:
  // field.help } })` looks equivalent and is not: TypeScript does not narrow `field.help` across the two
  // reads, so the spread's type becomes `admin?: {...} | undefined`, which `exactOptionalPropertyTypes`
  // then refuses against Payload's `admin?: {...}`.
  const help = field.help
  const common = {
    name: field.name,
    label: field.label,
    ...(field.required === true ? { required: true as const } : {}),
    ...(help === undefined ? {} : { admin: { description: help } }),
  }

  switch (field.type) {
    case 'text':
      return { ...common, type: 'text' }
    case 'textarea':
      return { ...common, type: 'textarea' }
    case 'richText':
      return { ...common, type: 'richText' }
    case 'checkbox':
      return { ...common, type: 'checkbox' }
    case 'date':
      return { ...common, type: 'date' }
    case 'select':
      return {
        ...common,
        type: 'select',
        options: [...(field.options ?? [])],
      }
    case 'array':
      return {
        ...common,
        type: 'array',
        fields: (field.of ?? []).map(toPayloadField),
      }
    case 'slug':
      // Indexed and unique because it is the URL. Two documents with the same slug is a page that
      // renders whichever row came back first.
      return {
        ...common,
        type: 'text',
        index: true,
        unique: true,
        validate: validatorFor(field),
      }
    case 'uuidRef':
      // `text`, not `relationship`. A relationship is a foreign key, and this reference crosses a schema
      // boundary whose two halves are migrated separately — see @berelax/cms's boundary rule
      // `catalogue-reference-must-be-a-plain-uuid`, which fails the build if this changes.
      return {
        ...common,
        type: 'text',
        index: true,
        validate: validatorFor(field),
      }
  }
}
