import type { ContentCollection } from '../fields.ts'

/**
 * The journal.
 *
 * `byline` is optional and starts empty on purpose. docs/09 §4 wants an author byline for E-E-A-T, and
 * a byline is the name of a real person — so it is a field an admin fills in, never a value this build
 * invents. An unattributed post is correct; an attributed one that names nobody real is not.
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
    { name: 'seo_title', type: 'text', label: 'Search title' },
    { name: 'seo_description', type: 'textarea', label: 'Search description' },
  ],
} as const satisfies ContentCollection
