import type { ContentCollection } from '../fields.ts'

/**
 * FAQ entries.
 *
 * `orderable` rather than an editorial `order` number field: the display order is content, but a number
 * an editor types is a number two entries can share, and re-ordering a list of thirty then means
 * retyping thirty of them. Payload maintains the order column itself and drag-and-drop writes it.
 * It is also the reason `CONTENT_FIELD_TYPES` needs no numeric type.
 */
export const FAQ_ENTRIES = {
  slug: 'faq_entries',
  label: 'FAQ entries',
  purpose:
    'One question and its answer. The /faq page and its FAQPage JSON-LD derive from the same rows.',
  titleField: 'question',
  maxVersions: 10,
  orderable: true,
  fields: [
    { name: 'question', type: 'text', label: 'Question', required: true },
    { name: 'answer', type: 'richText', label: 'Answer', required: true },
    {
      name: 'topic',
      type: 'select',
      label: 'Topic',
      options: ['visiting', 'treatments', 'booking', 'health', 'payment'],
      required: true,
    },
  ],
} as const satisfies ContentCollection
