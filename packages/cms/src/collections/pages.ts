import type { ContentCollection } from '../fields.ts'

/** Editorial pages: /about, /contact, the legal pages. Prose and nothing operational. */
export const PAGES = {
  slug: 'pages',
  label: 'Pages',
  purpose:
    'Standalone editorial pages — about, contact, the legal set. Rendered by W-SITE-07 under ISR.',
  titleField: 'title',
  maxVersions: 20,
  fields: [
    { name: 'slug', type: 'slug', label: 'URL slug', required: true },
    { name: 'title', type: 'text', label: 'Title', required: true },
    {
      name: 'lede',
      type: 'textarea',
      label: 'Lede',
      help: 'One sentence under the title. Capped at 56ch by the layout, so write it short.',
    },
    { name: 'body', type: 'richText', label: 'Body', required: true },
    { name: 'seo_title', type: 'text', label: 'Search title' },
    { name: 'seo_description', type: 'textarea', label: 'Search description' },
  ],
} as const satisfies ContentCollection
