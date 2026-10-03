import type { Sql } from '../connection.ts'
import type { FlowDefinitionValidator } from '../repositories/flow.ts'

/**
 * The three stock journeys, as `flow` and `flow_definition` rows (C-AUTO-11).
 *
 * ## Why the documents are INJECTED
 *
 * `composeJourney` lives in `@berelax/core` (`automation/journeys.ts`) and this package may not import
 * it: the dependency runs core <- db and never back (brief rule 4). So the composed documents arrive as
 * an argument, exactly as `publishFlowDefinition` takes its validator — and with NO validator this
 * function refuses rather than writing. An unvalidated definition in `flow_definition` is a flow that
 * fails when it runs, days later, for the enrolments that were pinned to it.
 *
 * ## Why seeding twice writes nothing the second time
 *
 * `flow_definition` is append-only (ZF001): the only way to change a flow is to publish version N+1. So
 * a seeder that published unconditionally would add a version on every `pnpm seed` — and the acceptance
 * line is that *"seeding twice from clean yields byte-identical enrolment and message rows"*, which it
 * cannot if the live version keeps moving: every enrolment pins the version that was live when it
 * arrived, so two seeds would leave two cohorts pinned to two documents.
 *
 * The idempotence is therefore a COMPARISON and not an `on conflict`: the canonical bytes of the live
 * version are compared with the canonical bytes of the composed document, and a publish happens only
 * when they differ. `jsonb` normalises key order, so the comparison is made over the stored jsonb
 * rendered back to a canonical string rather than over the raw text — which is the same reason
 * `flow_definition.definition`'s own comment gives for the form being invariant under normalisation.
 *
 * ## Why the flows are ACTIVE
 *
 * `flow.is_active` defaults to FALSE, because publishing a version is drawing a flow and enabling it is
 * a separate decision. The seed makes these three active on purpose: the fixture salon exists to
 * demonstrate the engine, and three journeys nobody can be enrolled on demonstrate nothing. Two of them
 * send no message at all (no approved copy exists), and the third binds a `draft` template the choke
 * point refuses — so an active flow here cannot reach a customer.
 */

/** One journey, as the seeder needs it: the key, the title and the document. */
export interface StockFlowSeed {
  readonly flowKey: string
  readonly title: string
  /** The composed `FlowDefinition`, as `@berelax/core` produced it. */
  readonly definition: unknown
}

export interface SeedFlowsInput {
  readonly flows: readonly StockFlowSeed[]
  /** `validateFlowDefinition` from `@berelax/core`. Absent means refuse, never "nothing to check". */
  readonly validate?: FlowDefinitionValidator
  readonly publishedAtIso: string
  /** Who the seed records as the publisher. The SURFACE, stated rather than invented. */
  readonly publishedBy?: string
}

export interface SeedFlowsResult {
  /** Flows whose live version already held these bytes, so nothing was written. */
  readonly unchanged: readonly string[]
  /** Flows a version was published for. */
  readonly published: readonly string[]
}

const SEED_PUBLISHER = 'Fixture seed'

/**
 * Writes the three stock journeys, or refuses.
 *
 * Returns which flows were published and which were already current, so a loader can report a figure and
 * a test can assert that a second seed published nothing.
 */
export async function seedStockFlows(sql: Sql, input: SeedFlowsInput): Promise<SeedFlowsResult> {
  const { validate } = input
  if (validate === undefined) {
    throw new Error(
      'seedStockFlows was called with no validator, so nothing would have checked the documents it is ' +
        'about to make permanent. `flow_definition` is append-only, so an invalid version cannot be ' +
        'edited out — it can only be superseded, after every enrolment pinned to it has failed. Pass ' +
        'validateFlowDefinition from @berelax/core.',
    )
  }

  const unchanged: string[] = []
  const published: string[] = []

  for (const flow of input.flows) {
    const verdict = validate(flow.definition)
    if (!verdict.ok) {
      throw new Error(
        `The composed journey "${flow.flowKey}" is not a valid flow definition: ` +
          `${verdict.refusals.map((refusal) => `${refusal.rule}${refusal.at === null ? '' : ` at ${refusal.at}`}`).join('; ')}. ` +
          'Refusing to seed rather than writing a document the publish path would have rejected.',
      )
    }
    if (verdict.facts.key !== flow.flowKey) {
      throw new Error(
        `The composed journey for "${flow.flowKey}" says its own key is "${verdict.facts.key}". ` +
          '`flow_definition` holds no key column — the flow row is the key — so the database cannot ' +
          'catch this, and the symptom is a flow whose published document says it is a different flow.',
      )
    }

    // The flow row first, and its lock: `publishFlowDefinition` takes the same lock in the same order,
    // so a seed running beside a publish cannot deadlock against it.
    const [row] = await sql<{ id: string }[]>`
      insert into flow (flow_key, title, is_active, created_by, created_at, updated_at)
      values (${flow.flowKey}, ${flow.title}, true, ${input.publishedBy ?? SEED_PUBLISHER},
              ${input.publishedAtIso}::timestamptz, ${input.publishedAtIso}::timestamptz)
      on conflict (flow_key) do update set is_active = true, updated_at = excluded.updated_at
      returning id::text as id
    `
    if (row === undefined) throw new Error(`could not ensure the flow row for ${flow.flowKey}`)

    // The live version, compared to the candidate by POSTGRES rather than by this function.
    //
    // `jsonb = jsonb` is structural: it ignores key order and whitespace, which is exactly the
    // comparison wanted here and exactly what a string comparison of two serialisations would get
    // wrong — `flow_definition.definition`'s own comment says the canonical form is invariant under
    // jsonb normalisation, and this is the one place that invariance is relied on. Compared and not
    // counted: a version count says how many times the seed has run, not whether the document changed.
    const [live] = await sql<{ version: number; same: boolean }[]>`
      select version, definition = ${sql.json(flow.definition as never)} as same
        from flow_definition
       where flow_id = ${row.id}::uuid
       order by version desc
       limit 1
    `

    if (live?.same === true) {
      unchanged.push(flow.flowKey)
      continue
    }

    await sql`
      insert into flow_definition
        (flow_id, version, dsl_version, definition, published_by, published_at)
      values (
        ${row.id}::uuid,
        ${(live?.version ?? 0) + 1},
        ${verdict.facts.dslVersion},
        ${sql.json(flow.definition as never)},
        ${input.publishedBy ?? SEED_PUBLISHER},
        ${input.publishedAtIso}::timestamptz
      )
    `
    published.push(flow.flowKey)
  }

  return { unchanged, published }
}
