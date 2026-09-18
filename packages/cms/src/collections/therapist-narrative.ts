import type { ContentCollection } from '../fields.ts'

/**
 * The words about a therapist. **Never the therapist's name.**
 *
 * A therapist has no display name until an admin sets one, and the place an admin sets it is the
 * employee record — not here. A `display_name` field on this collection would be a second home for it,
 * and the second home is the one that ends up on a public page with a name nobody agreed to publish.
 * Photography consent and naming consent are separate decisions and both belong to the employee record.
 *
 * `scripts/check-cms-boundary.mjs` rejects any name-shaped field on this collection by rule, so the
 * paragraph above is not the only thing holding it.
 */
export const THERAPIST_NARRATIVE = {
  slug: 'therapist_narrative',
  label: 'Therapist narrative',
  purpose:
    'Prose about a therapist — approach, training, languages. Carries no name: the display name lives ' +
    'on the employee record and is absent until an admin sets it.',
  titleField: 'approach',
  maxVersions: 20,
  fields: [
    {
      name: 'therapist_id',
      type: 'uuidRef',
      label: 'Therapist',
      required: true,
      help: 'The UUID of the employee record. No foreign key across the schema boundary.',
    },
    {
      name: 'approach',
      type: 'textarea',
      label: 'Approach',
      required: true,
      help: 'How they work, in their own words where possible. This is what appears on the card.',
    },
    { name: 'narrative', type: 'richText', label: 'Narrative' },
    {
      name: 'languages',
      type: 'array',
      label: 'Languages spoken',
      of: [{ name: 'language', type: 'text', label: 'Language', required: true }],
    },
  ],
} as const satisfies ContentCollection
