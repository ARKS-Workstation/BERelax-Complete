import type { ContentCollection } from '../fields.ts'

/**
 * The words beside a treatment. **Not the treatment.**
 *
 * This is the collection the whole unit exists to fence. The catalogue (B-CAT-03) owns price, duration,
 * bookability and the required therapist skill; this owns the prose. The fence is three mechanisms, all
 * derived from the field list below:
 *
 *   - `scripts/check-cms-boundary.mjs` rejects a field named for anything the catalogue owns;
 *   - `documents.ts` derives the rendered document type from this list, so `doc.price` does not compile;
 *   - `catalogue_service_id` is a `uuidRef` — a UUID in a plain text column with **no foreign key**.
 *
 * The missing foreign key is deliberate and is the one that looks like an omission. The catalogue lives
 * in `public` under the hand-written SQL migration chain (ADR 0006); this row lives in the `payload`
 * schema, which Payload migrates on its own release cycle (ADR 0019). A foreign key across that line
 * makes one of them un-deployable without the other: Payload's own migration would have to run inside
 * our transaction, or a catalogue migration that rewrites `service` would be blocked by CMS rows. The
 * reference is therefore checked in application code — `lifecycle.ts` — where it can be checked with a
 * message an editor can act on, rather than as a constraint violation at 23:00.
 */
export const SERVICE_NARRATIVE = {
  slug: 'service_narrative',
  label: 'Treatment narrative',
  purpose:
    'The prose beside a catalogue service. Price, duration, bookability and VAT are the catalogue’s ' +
    'and are read from it at render time.',
  titleField: 'headline',
  maxVersions: 20,
  fields: [
    {
      name: 'catalogue_service_id',
      type: 'uuidRef',
      label: 'Catalogue service',
      required: true,
      help: 'The UUID of the service in the catalogue. There is no foreign key across the schema boundary; see the note on this collection.',
    },
    { name: 'price', type: 'text', label: 'Price' },
    { name: 'slug', type: 'slug', label: 'URL slug', required: true },
    { name: 'headline', type: 'text', label: 'Headline', required: true },
    {
      name: 'promise',
      type: 'textarea',
      label: 'The promise',
      help: 'What the guest leaves with. Never a medical claim — publication lints this against the licence lexicon.',
      required: true,
    },
    { name: 'body', type: 'richText', label: 'Body', required: true },
    {
      name: 'aftercare',
      type: 'textarea',
      label: 'Aftercare note',
      help: 'What to do afterwards. Advice, not instruction.',
    },
    { name: 'seo_title', type: 'text', label: 'Search title' },
    { name: 'seo_description', type: 'textarea', label: 'Search description' },
    {
      name: 'editorial_state',
      type: 'select',
      label: 'Editorial state',
      options: ['live', 'archived'],
      required: true,
      help: 'Archived keeps the page and 301s it, so a guest who already booked can still read what they booked. Unpublishing takes it away, which is why it is refused while future bookings exist.',
    },
  ],
} as const satisfies ContentCollection
