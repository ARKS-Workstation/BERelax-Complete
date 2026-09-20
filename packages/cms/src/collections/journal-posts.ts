import type { ContentCollection } from '../fields.ts'

/**
 * The journal.
 *
 * `byline` is optional and starts empty on purpose. docs/09 §4 wants an author byline for E-E-A-T, and
 * a byline is the name of a real person — so it is a field an admin fills in, never a value this build
 * invents. An unattributed post is correct; an attributed one that names nobody real is not.
 *
 * ## Why three of these fields are optional here and required to publish
 *
 * `byline`, `reviewed_by` and `published_on` are all optional on the *collection*, and
 * `assertJournalPostPublishable` (`publication.ts`) refuses to publish a post missing any of them. That
 * split is deliberate and it is the only shape that works: `required: true` in Payload is enforced on every
 * save, so a draft could not be saved at all until somebody had a name to put in it — and the field exists
 * precisely because nobody has one yet. A draft may be incomplete; a published post may not.
 *
 * `health_topic` is the editor's declaration, not the decision. The lint also reads the copy through
 * G-REV-03's escalation lexicon, so a post about pain or injury is health-adjacent whether or not the box
 * was ticked: the post that most needs the disclaimer is the one whose author did not think of it as health
 * copy.
 */
export const JOURNAL_POSTS = {
  slug: 'journal_posts',
  label: 'Journal posts',
  purpose: 'Long-form editorial. Drives /journal and /journal/[slug].',
  titleField: 'title',
  maxVersions: 20,
  fields: [
    { name: 'slug', type: 'slug', label: 'URL slug', required: true },
    { name: 'title', type: 'text', label: 'Title', required: true },
    { name: 'standfirst', type: 'textarea', label: 'Standfirst' },
    { name: 'body', type: 'richText', label: 'Body', required: true },
    { name: 'published_on', type: 'date', label: 'Publication date' },
    {
      name: 'byline',
      type: 'text',
      label: 'Byline',
      help: 'The name of the person who wrote it. Leave empty until there is a real one to put here.',
    },
    {
      name: 'reviewed_by',
      type: 'text',
      label: 'Reviewed by',
      help:
        'The name of the person who checked this copy before it went out. Not the author: a reviewer ' +
        'who is the author reviews nothing. Required to publish; leave empty until somebody has.',
    },
    {
      name: 'health_topic',
      type: 'checkbox',
      label: 'Health topic',
      help:
        'Tick this when the post touches health — pain, injury, pregnancy, a condition. A post that ' +
        'does will not publish until the medical disclaimer in Compliance notices has been written.',
    },
    { name: 'seo_title', type: 'text', label: 'Search title' },
    { name: 'seo_description', type: 'textarea', label: 'Search description' },
  ],
} as const satisfies ContentCollection
