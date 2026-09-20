import {
  assertCmsCopyCompliant,
  assertJournalPostPublishable,
  JOURNAL_POSTS,
  type JournalPostForPublication,
} from '@berelax/cms'
import type { CompliancePolicy } from '@berelax/core'
import { isAppError } from '@berelax/shared'
import type { CollectionBeforeChangeHook } from 'payload'
import { APIError } from 'payload'
import { richTextToPlainText } from '../cms/rich-text.ts'

/**
 * The guard on publishing a journal post.
 *
 * The rules are `@berelax/cms`'s `publication.ts`, with the reasoning; this file is the wiring. It runs on
 * `beforeChange` and only when the save would leave the document **published**, which is the whole shape of
 * the decision: a draft may be missing its bylines — the byline field exists precisely because nobody has a
 * name to put in it yet — and a published post may not.
 *
 * `beforeChange` rather than `afterChange`, for the reason `service-narrative.ts` gives one file along: an
 * `afterChange` hook that threw would refuse the mutation only by rolling back a transaction that had already
 * fired every other hook, including the audit one, which would then record a change that was undone.
 *
 * ## Why it reads two things out of the database
 *
 * The **disclaimer** (`compliance_notices.medical_disclaimer`) decides whether health-adjacent copy may be
 * published at all, and the **compliance policy** (`regulatory_profile_current`) is the term list the
 * banned-claims lint reads. Neither can be a constant: the first is content the owner writes, and the second
 * is the answer to Y1-licence, which is a row so that the answer reaches the lint without a deploy.
 *
 * A failure to read either is **not** treated as permission. `readCompliancePolicy` throwing means the
 * profile could not be read, and publishing copy that no lexicon has judged is the outcome this whole gate
 * exists to prevent — so the refusal is the error itself, surfaced to the editor as a 409.
 */

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nullableText(value: unknown): string | null {
  const found = textOf(value).trim()
  return found === '' ? null : found
}

/** The document as the publication lint sees it. `body` is Lexical and is flattened for the lint. */
export function postForPublication(
  data: Readonly<Record<string, unknown>>,
): JournalPostForPublication {
  return {
    slug: textOf(data['slug']),
    title: textOf(data['title']),
    standfirst: nullableText(data['standfirst']),
    bodyText: richTextToPlainText(data['body']),
    byline: nullableText(data['byline']),
    reviewedBy: nullableText(data['reviewed_by']),
    publishedOn: nullableText(data['published_on']),
    healthTopicDeclared: data['health_topic'] === true,
  }
}

/**
 * The compliance policy in force, read through a **dynamic** import.
 *
 * Not a style choice. `scripts/check-cms-boundary.mjs` loads `apps/web/payload.config.ts` with Node's
 * strip-only TypeScript loader, so it can examine the config `buildConfig` actually generates rather than the
 * descriptors alone — and this module is reachable from that config, because it is a collection hook. A
 * **static** `import { readCompliancePolicy } from '@berelax/db'` therefore drags `packages/db/src/audit.ts`
 * into that loader, which refuses its TypeScript parameter property with
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` — and `pnpm cms` fails with a SyntaxError two packages away from
 * anything this unit changed. It was found exactly that way.
 *
 * Imported where it is used instead: inside a hook that runs only in the application, where the full
 * TypeScript toolchain is present.
 */
async function policyFor(): Promise<CompliancePolicy> {
  const [{ readCompliancePolicy }, { factsRuntime }] = await Promise.all([
    import('@berelax/db'),
    import('../facts/runtime.ts'),
  ])
  const row = await readCompliancePolicy(factsRuntime().sql)
  return {
    bannedClaimTerms: row.bannedClaimTerms,
    permittedPublicTitles: row.permittedPublicTitles,
    medicalClaimsPermitted: row.medicalClaimsPermitted,
  }
}

/**
 * Refuses a publish that would put unpublishable copy on the site.
 *
 * `data` and not `originalDoc`: the rules are about what is *being saved*, and a post whose byline is being
 * deleted in the same save that publishes it must be refused on the new value.
 */
export const guardJournalPostPublication: CollectionBeforeChangeHook = async ({
  data,
  originalDoc,
  req,
}) => {
  const record = data as Readonly<Record<string, unknown>>
  const nextStatus =
    typeof record['_status'] === 'string'
      ? record['_status']
      : ((originalDoc as { readonly _status?: string } | undefined)?._status ?? null)
  if (nextStatus !== 'published') return data

  const post = postForPublication(record)
  try {
    const global = await req.payload.findGlobal({
      slug: 'compliance_notices' as never,
      depth: 0,
      ...(req.transactionID === undefined ? {} : { req }),
    })
    const disclaimer = richTextToPlainText(
      (global as Readonly<Record<string, unknown>>)['medical_disclaimer'],
    ).trim()
    assertJournalPostPublishable(post, { disclaimer: disclaimer === '' ? null : disclaimer })
    assertCmsCopyCompliant(
      [
        {
          where: `${JOURNAL_POSTS.slug}/${post.slug}`,
          text: [post.title, post.standfirst ?? '', post.bodyText].join('\n'),
        },
      ],
      await policyFor(),
    )
  } catch (error) {
    // A named refusal becomes the 409 the admin shows, carrying the rule names so an editor is told which
    // field to fix. Anything else is rethrown untouched: swallowing an unexpected error here would turn a
    // genuine bug into "this post has no byline", which is a message somebody would believe.
    if (!isAppError(error)) throw error
    throw new APIError(error.message, 409, error.details, true)
  }
  return data
}
