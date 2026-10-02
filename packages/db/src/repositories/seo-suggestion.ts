import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The SEO suggestion store: the before-state, the after-state, and how the before-state goes back.
 *
 * Migration 0133 is the authority and ADR 0086 is the decision. This module is the only writer, and the
 * reason it is worth having rather than letting a caller assemble the INSERT is the shape of the row: six
 * columns that must agree with each other and with a `publication_record` somebody else wrote, and a
 * caller that got one wrong would produce a suggestion that cannot be rolled back and would not find out.
 *
 * ## What this module cannot do, and that is the point
 *
 * It never publishes. `.dependency-cruiser.cjs`'s `seo-agent-must-not-reach-a-publish-path` keeps the
 * agent's own modules away from the publication chokepoint, and this module is on the other side of that
 * line for a different reason: it writes the state TRANSITION after a publication has happened, and the
 * publication itself goes through `packages/db/src/repositories/publication.ts` under a principal the
 * policy layer has authorised. {@link markSeoSuggestionApplied} takes a `publication_record` id it did not
 * create, and `ZY403` is what refuses one carrying the wrong content hash.
 *
 * ## Why the hash is computed by PostgreSQL and the canonical string by `packages/core`
 *
 * `publicationCanonicalContent` decides what the content IS — region by region, in a form stable under
 * everything that is not an edit — and lives in `packages/core`, which this package may not import (ADR
 * 0001, the dependency runs the other way). `publicationContentHash` hashes it with the server's own
 * `sha256`, which is the ONE implementation of the digest in this build. So the caller canonicalises, this
 * module stores, and nothing recomputes either.
 */

/** Every state a suggestion can be in. A sequence, not a set — see {@link SEO_SUGGESTION_TRANSITIONS}. */
export const SEO_SUGGESTION_STATES = [
  'proposed',
  'refused',
  'approved',
  'applied',
  'rolled_back',
] as const
export type SeoSuggestionState = (typeof SEO_SUGGESTION_STATES)[number]

/**
 * The permitted moves, mirrored from 0133's `ZY402` trigger.
 *
 * A mirror, and the trigger is the authority — so this is here to let a SCREEN grey a button rather than
 * to decide anything, which is the same division `packages/core/src/publication/state-machine.ts` draws
 * against 0093's `ZZ002`. `seo-suggestion.itest.ts` drives every pair in both directions against the real
 * database, which is what holds the two equal.
 *
 * `refused` and `rolled_back` are terminal. A refused suggestion is re-drafted as a NEW row, because what
 * refused it was a lint version and a profile version; re-applying a rolled-back one is a new suggestion,
 * because the before-state of the second apply is what the page says after the rollback.
 */
export const SEO_SUGGESTION_TRANSITIONS: Readonly<
  Record<SeoSuggestionState, readonly SeoSuggestionState[]>
> = Object.freeze({
  proposed: Object.freeze(['approved', 'refused'] as const),
  refused: Object.freeze([] as const),
  approved: Object.freeze(['applied'] as const),
  applied: Object.freeze(['rolled_back'] as const),
  rolled_back: Object.freeze([] as const),
})

/** The SQLSTATEs 0133 raises, so a caller tells one refusal from any other conflict. */
export const SEO_SUGGESTION_SQLSTATE = {
  rollbackUnusable: 'ZY401',
  evidenceImmutable: 'ZY402',
  publishedHashDisagrees: 'ZY403',
} as const

/** The one method a rollback descriptor may name. 0133's `ZY401` holds the set closed. */
export const SEO_ROLLBACK_METHOD = 'publication_revert' as const

/**
 * Every refusal this module raises itself, by name. Two, and each one is raised below.
 *
 * Deliberately not a longer list of plausible refusals: a name nothing can raise is a rule a reader
 * believes exists. The refusals that belong to the DATABASE are not here either — they arrive as the
 * SQLSTATEs in {@link SEO_SUGGESTION_SQLSTATE}, and restating them would be two vocabularies for one set.
 */
export const SEO_SUGGESTION_REFUSALS = [
  /** A state move the sequence does not permit, refused before a `seq` is consumed. */
  'seo_suggestion_transition_not_permitted',
  /** The suggestion named does not exist. */
  'seo_suggestion_absent',
] as const
export type SeoSuggestionRefusal = (typeof SEO_SUGGESTION_REFUSALS)[number]

function refuse(
  refusal: SeoSuggestionRefusal,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new AppError('invariant_violated', message, { details: { ...details, refusal } })
}

/** The named refusal carried on an error this module raised, or null. */
export function seoSuggestionRefusalOf(err: unknown): SeoSuggestionRefusal | null {
  if (!(err instanceof AppError)) return null
  const refusal = (err.details as { refusal?: unknown } | undefined)?.refusal
  return typeof refusal === 'string' &&
    (SEO_SUGGESTION_REFUSALS as readonly string[]).includes(refusal)
    ? (refusal as SeoSuggestionRefusal)
    : null
}

/** The SQLSTATE a driver error carries, or null. */
export function seoSuggestionSqlstateOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

/** One region of published copy, as `publicationCanonicalContent` is given them. */
export interface SuggestionRegion {
  readonly region: string
  readonly text: string
}

export interface SeoSuggestionRow {
  readonly id: string
  readonly runId: string
  readonly surface: string
  readonly state: SeoSuggestionState
  readonly beforeRegions: readonly SuggestionRegion[]
  readonly beforeContentSha256: string
  readonly afterRegions: readonly SuggestionRegion[]
  readonly afterContentSha256: string
  readonly rollbackDescriptor: Readonly<Record<string, unknown>>
  readonly lintVersion: string
  readonly lintTermsChecked: number
  readonly refusedRules: readonly string[]
  readonly llmProvider: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costFils: number
  readonly appliedRecordId: string | null
  readonly rolledBackRecordId: string | null
  readonly proposedAtIso: string
}

const ROW_COLUMNS = `
  id,
  run_id                as "runId",
  surface,
  state,
  before_regions        as "beforeRegions",
  before_content_sha256 as "beforeContentSha256",
  after_regions         as "afterRegions",
  after_content_sha256  as "afterContentSha256",
  rollback_descriptor   as "rollbackDescriptor",
  lint_version          as "lintVersion",
  lint_terms_checked    as "lintTermsChecked",
  refused_rules         as "refusedRules",
  llm_provider          as "llmProvider",
  input_tokens          as "inputTokens",
  output_tokens         as "outputTokens",
  cost_fils             as "costFils",
  applied_record_id     as "appliedRecordId",
  rolled_back_record_id as "rolledBackRecordId",
  proposed_at           as "proposedAtIso"
`

/**
 * One row, with `cost_fils` narrowed from the driver's string.
 *
 * `fils_nonneg` is an `int8` domain and `postgres.js` hands an `int8` back as a STRING, because a bigint
 * past 2^53 cannot survive a `number`. A per-suggestion cost cannot be that large, so the narrowing is
 * safe — and it is done HERE, once, rather than at each call site: the defect it prevents is a caller
 * adding two costs and getting `'3''4'`, which is a plausible-looking total nothing would refuse.
 */
const asRow = (row: Record<string, unknown>): SeoSuggestionRow => ({
  id: String(row['id']),
  runId: String(row['runId']),
  surface: String(row['surface']),
  state: row['state'] as SeoSuggestionState,
  beforeRegions: row['beforeRegions'] as readonly SuggestionRegion[],
  beforeContentSha256: String(row['beforeContentSha256']),
  afterRegions: row['afterRegions'] as readonly SuggestionRegion[],
  afterContentSha256: String(row['afterContentSha256']),
  rollbackDescriptor: row['rollbackDescriptor'] as Readonly<Record<string, unknown>>,
  lintVersion: String(row['lintVersion']),
  lintTermsChecked: Number(row['lintTermsChecked']),
  refusedRules: row['refusedRules'] as readonly string[],
  llmProvider: String(row['llmProvider']),
  inputTokens: Number(row['inputTokens']),
  outputTokens: Number(row['outputTokens']),
  costFils: Number(row['costFils']),
  appliedRecordId: row['appliedRecordId'] === null ? null : String(row['appliedRecordId']),
  rolledBackRecordId: row['rolledBackRecordId'] === null ? null : String(row['rolledBackRecordId']),
  proposedAtIso: new Date(row['proposedAtIso'] as string | Date).toISOString(),
})

export interface InsertSeoSuggestionInput {
  readonly runId: string
  readonly surface: string
  /** `proposed`, or `refused` with the rules that refused it. Nothing else may be inserted. */
  readonly state: 'proposed' | 'refused'
  readonly beforeRegions: readonly SuggestionRegion[]
  /** `publicationContentHash` of `publicationCanonicalContent(beforeRegions)`. */
  readonly beforeContentSha256: string
  readonly afterRegions: readonly SuggestionRegion[]
  readonly afterContentSha256: string
  readonly lintVersion: string
  readonly lintTermsChecked: number
  /** Non-empty exactly when `state` is `refused`; 0133's CHECK refuses the other three combinations. */
  readonly refusedRules: readonly string[]
  readonly llmProvider: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costFils: number
  readonly proposedAt: Date
}

/**
 * Writes one suggestion, with the rollback descriptor DERIVED rather than accepted.
 *
 * The descriptor is built here, from the surface on the input, and there is no parameter for it. That is
 * the whole reason this function exists rather than a caller writing the INSERT: a descriptor is the one
 * field whose being wrong is invisible until somebody needs a rollback, and a caller that could pass one
 * could pass another surface's. `ZY401` would catch a mismatched surface, and `ZY401` catching it means a
 * suggestion was lost at the moment it was drafted — which is a worse outcome than not being able to make
 * the mistake.
 *
 * `state` is narrowed to the two an INSERT may carry. The other three are reached by transition, each of
 * which needs evidence this function does not have.
 */
export async function insertSeoSuggestion(
  sql: Sql,
  input: InsertSeoSuggestionInput,
): Promise<SeoSuggestionRow> {
  const descriptor = { method: SEO_ROLLBACK_METHOD, surface: input.surface }
  /*
   * `as never` on the two region arrays, which is `leave.ts`' and `merge.ts`' spelling of the same thing:
   * `postgres.js`'s `JSONValue` admits an object with an index signature and not a plain array, so an
   * array of records needs the escape hatch. It is a cast on the SERIALISATION and not on the data — the
   * values are `SuggestionRegion` by the parameter type — which is the distinction that makes it safe
   * here and would not make it safe on the row that comes back.
   */
  const [row] = await sql<Record<string, unknown>[]>`
    insert into seo_suggestion (
      run_id, surface, state, before_regions, before_content_sha256, after_regions,
      after_content_sha256, rollback_descriptor, lint_version, lint_terms_checked, refused_rules,
      llm_provider, input_tokens, output_tokens, cost_fils, proposed_at
    ) values (
      ${input.runId}::uuid, ${input.surface}, ${input.state}, ${sql.json([...input.beforeRegions] as never)},
      ${input.beforeContentSha256}, ${sql.json([...input.afterRegions] as never)},
      ${input.afterContentSha256}, ${sql.json(descriptor)}, ${input.lintVersion},
      ${input.lintTermsChecked}, ${[...input.refusedRules]}, ${input.llmProvider},
      ${input.inputTokens}, ${input.outputTokens}, ${input.costFils}, ${input.proposedAt}
    )
    returning ${sql.unsafe(ROW_COLUMNS)}
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'the seo_suggestion insert returned no row')
  }
  return asRow(row)
}

/** One suggestion by id, or null. */
export async function seoSuggestionById(sql: Sql, id: string): Promise<SeoSuggestionRow | null> {
  const [row] = await sql<Record<string, unknown>[]>`
    select ${sql.unsafe(ROW_COLUMNS)} from seo_suggestion where id = ${id}::uuid
  `
  return row === undefined ? null : asRow(row)
}

/** The queue an admin screen reads: what is waiting for a decision, newest first. */
export async function openSeoSuggestions(
  sql: Sql,
  limit = 50,
): Promise<readonly SeoSuggestionRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select ${sql.unsafe(ROW_COLUMNS)} from seo_suggestion
    where state in ('proposed', 'approved')
    order by proposed_at desc, id desc
    limit ${limit}
  `
  return rows.map(asRow)
}

/**
 * Moves a suggestion to the next state, checking the move against the sequence first.
 *
 * The check is here as well as in the trigger, and that is not belt-and-braces: a rejected UPDATE on a
 * table whose state machine is a trigger produces a driver error with a SQLSTATE, which a caller has to
 * translate before it can tell "not permitted" from "the row is gone". Asking first makes the ordinary
 * refusal a named one. The trigger is still the authority — it is what holds when somebody writes the
 * UPDATE by hand, which is the only form in which the claim is a fact rather than a signature (ADR 0063's
 * argument, one subject along).
 */
async function moveState(
  sql: Sql,
  id: string,
  to: SeoSuggestionState,
  columns: { readonly appliedRecordId?: string; readonly rolledBackRecordId?: string } = {},
): Promise<SeoSuggestionRow> {
  return await sql.begin(async (tx) => {
    const [current] = await tx<{ state: SeoSuggestionState }[]>`
      select state from seo_suggestion where id = ${id}::uuid for update
    `
    if (current === undefined) {
      refuse('seo_suggestion_absent', `There is no seo_suggestion ${id}.`, { id })
    }
    if (!SEO_SUGGESTION_TRANSITIONS[current.state].includes(to)) {
      refuse(
        'seo_suggestion_transition_not_permitted',
        `Suggestion ${id} is ${current.state} and may not move to ${to}. The permitted moves from ` +
          `${current.state} are ${SEO_SUGGESTION_TRANSITIONS[current.state].join(', ') || 'none'}.`,
        { id, from: current.state, to },
      )
    }
    const [row] = await tx<Record<string, unknown>[]>`
      update seo_suggestion
      set state = ${to},
          applied_record_id = coalesce(${columns.appliedRecordId ?? null}::uuid, applied_record_id),
          rolled_back_record_id =
            coalesce(${columns.rolledBackRecordId ?? null}::uuid, rolled_back_record_id)
      where id = ${id}::uuid
      returning ${tx.unsafe(ROW_COLUMNS)}
    `
    if (row === undefined) {
      throw new AppError('invariant_violated', `the seo_suggestion ${id} update returned no row`)
    }
    return asRow(row)
  })
}

/** A human approved the drafted copy. No publication yet — approving is not applying. */
export async function approveSeoSuggestion(sql: Sql, id: string): Promise<SeoSuggestionRow> {
  return await moveState(sql, id, 'approved')
}

/** The lint or the response screen refused it. Terminal: a refused suggestion is re-drafted as a new row. */
export async function refuseSeoSuggestion(sql: Sql, id: string): Promise<SeoSuggestionRow> {
  return await moveState(sql, id, 'refused')
}

/**
 * The publication control plane published it, as the record given.
 *
 * `ZY403` refuses a record whose `content_sha256` is not this suggestion's `after_content_sha256`, which
 * is what makes "the content published was the content approved" a database fact.
 */
export async function markSeoSuggestionApplied(
  sql: Sql,
  id: string,
  publicationRecordId: string,
): Promise<SeoSuggestionRow> {
  return await moveState(sql, id, 'applied', { appliedRecordId: publicationRecordId })
}

/**
 * The stored before-state went back, as the record given.
 *
 * `ZY403` refuses a record whose `content_sha256` is not this suggestion's `before_content_sha256`. A
 * rollback that lands on anything else is not a rollback, and the screen would show it as reverted.
 */
export async function markSeoSuggestionRolledBack(
  sql: Sql,
  id: string,
  revertRecordId: string,
): Promise<SeoSuggestionRow> {
  return await moveState(sql, id, 'rolled_back', { rolledBackRecordId: revertRecordId })
}

/** How many suggestions one run produced, by state. For the run's own report and for a delta assertion. */
export async function seoSuggestionCountsForRun(
  sql: Sql,
  runId: string,
): Promise<Readonly<Record<string, number>>> {
  const rows = await sql<{ state: string; n: string }[]>`
    select state, count(*)::text as n from seo_suggestion where run_id = ${runId}::uuid group by state
  `
  return Object.fromEntries(rows.map((row) => [row.state, Number(row.n)]))
}
