import type { ContentCollection } from '../fields.ts'

/**
 * Guest testimonials.
 *
 * `consent_recorded` is required and is checked at publication, not at render: a quote from a guest is
 * personal data, and the question "did they agree to this being public?" has to have been answered
 * before it can be. Attribution is initials, never a full name — the same reason as
 * `therapist_narrative`.
 */
export const TESTIMONIALS = {
  slug: 'testimonials',
  label: 'Testimonials',
  purpose: 'A guest’s own words, attributed by initials, published only with recorded consent.',
  titleField: 'quote',
  maxVersions: 10,
  fields: [
    { name: 'quote', type: 'textarea', label: 'Quote', required: true },
    {
      name: 'attribution_initials',
      type: 'text',
      label: 'Attribution (initials)',
      help: 'Initials only, e.g. “A.K.”. Never a full name.',
    },
    {
      name: 'catalogue_service_id',
      type: 'uuidRef',
      label: 'Treatment referred to',
      help: 'Optional. The catalogue service the quote is about. No foreign key across the boundary.',
    },
    {
      name: 'consent_recorded',
      type: 'checkbox',
      label: 'Publication consent recorded',
      required: true,
      help: 'Must be true to publish. The record of the consent itself lives with the guest, not here.',
    },
    { name: 'published_on', type: 'date', label: 'Publication date' },
  ],
} as const satisfies ContentCollection
