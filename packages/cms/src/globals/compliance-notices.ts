import type { ContentGlobal } from '../fields.ts'

/**
 * The compliance-locked global.
 *
 * These four blocks of copy are the ones a licensing inspector reads. The medical disclaimer is what
 * keeps a description of a massage from reading as a therapeutic claim (ADR 0020); the licence
 * statement names what the business is licensed to do; the complaints procedure is a consumer-protection
 * requirement. They are written in the same admin as every other page, by people who hold
 * `content:write` — and they must not be editable by all of them.
 *
 * So the write permission is `settings:write_compliance`, which in the F07 matrix is the owner alone.
 * An editor can read this global and can see the diff; the save is refused. That refusal is the
 * assertion in `apps/web/src/payload.itest.ts`.
 */
export const COMPLIANCE_NOTICES = {
  slug: 'compliance_notices',
  label: 'Compliance notices',
  purpose:
    'The disclaimer, licence statement and complaints procedure carried by every treatment page. ' +
    'Owner-only, because changing this wording is a licensing act rather than an editorial one.',
  maxVersions: 50,
  writePermission: 'settings:write_compliance',
  fields: [
    {
      name: 'medical_disclaimer',
      type: 'richText',
      label: 'Medical disclaimer',
      required: true,
      help: 'Carried by every treatment page. Its wording is what keeps a description from reading as a therapeutic claim.',
    },
    {
      name: 'licence_statement',
      type: 'textarea',
      label: 'Licence statement',
      required: true,
      help: 'What the business is licensed to do, in the words the licensing authority uses.',
    },
    {
      name: 'complaints_procedure',
      type: 'richText',
      label: 'Complaints procedure',
      required: true,
    },
    {
      name: 'last_reviewed_on',
      type: 'date',
      label: 'Last reviewed',
      help: 'When the owner last checked this wording against the licence. Not a publication date.',
    },
  ],
} as const satisfies ContentGlobal
