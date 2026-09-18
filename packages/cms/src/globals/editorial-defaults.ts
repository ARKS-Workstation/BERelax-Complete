import type { ContentGlobal } from '../fields.ts'

/**
 * The ordinary global, and the control for the compliance-locked one.
 *
 * Without a global an editor CAN write, "an editor cannot mutate the compliance-locked global" is
 * satisfied by an access layer that refuses everything — which is the failure mode ADR 0003 is about.
 * This one holds the fallback search copy and the journal's index blurb, and `content:write` is enough.
 */
export const EDITORIAL_DEFAULTS = {
  slug: 'editorial_defaults',
  label: 'Editorial defaults',
  purpose:
    'Fallback search title and description, and the blurb at the top of the journal index. Editorial, ' +
    'so anybody with content:write may change it.',
  maxVersions: 20,
  writePermission: 'content:write',
  fields: [
    { name: 'default_seo_title', type: 'text', label: 'Fallback search title', required: true },
    {
      name: 'default_seo_description',
      type: 'textarea',
      label: 'Fallback search description',
      required: true,
    },
    { name: 'journal_index_blurb', type: 'textarea', label: 'Journal index blurb' },
  ],
} as const satisfies ContentGlobal
