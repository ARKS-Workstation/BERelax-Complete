import { validateFlowDefinition } from '@berelax/core'
import {
  type Actor,
  archivePipelineStage,
  createConnection,
  enrolOnLiveVersion,
  moveCard,
  PIPELINE_AUDIT_ACTIONS,
  PIPELINE_ENROLMENT_PATH,
  PIPELINE_SQLSTATE,
  pipelineRefusalOf,
  publishFlowDefinition,
  readCardHistory,
  readPipelineBoard,
  readPipelineStages,
  reorderPipelineStages,
  type Sql,
  type StageEntryEnroller,
  setFlowActive,
  unconfirmedAssumptionRows,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_NOW_ISO } from './clock.ts'
import { syntheticPerson } from './synthetic.ts'

/**
 * C-AUTO-08 — the pipeline board's ROWS: the order of the columns, the record every move leaves, and the
 * enrolment a stage entry starts through the writer every other trigger uses.
 *
 * `packages/fixtures` is the only package that may import both halves (brief rule 4), and the flow half of
 * this unit is a claim about the pair: `validateFlowDefinition` is pure and lives in `@berelax/core`, the
 * rows live in PostgreSQL and `@berelax/db` writes them, and neither package may import the other. So the
 * real validator is injected into `publishFlowDefinition` exactly as an application would inject it.
 *
 * The browser half — the drag, the keyboard path, the forced 409, axe and the screenshots — is
 * `apps/web/src/pipeline.itest.ts`. Two files because the two halves need different machinery and neither
 * can make the other's claims, which is the split B-UI-03's diary and C-CRM-07's preference centre both
 * take.
 *
 * ## Isolation, and the two things that are PERMANENT
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind (brief
 * rule 12). Everything here is namespaced and narrowed:
 *
 *   - **the contacts** are on the unallocated +971 59 prefix in band 60_501-60_504, which no other suite
 *     uses, and they are removed in `afterAll`;
 *   - **the flows** are `cauto08_*` keys, and `flow_definition` refuses DELETE for every role — so every
 *     version this file publishes is permanent and every version number it asserts is RELATIVE to what it
 *     read first, which is what makes a second run append rather than collide;
 *   - **the fixture stages** are `cauto08_*` keys, and they are ARCHIVED in `afterAll` rather than deleted.
 *     Deleting is not available: a `pipeline_stage_transition` row names the stage it moved a card into,
 *     that log is append-only (ZU002), and the stage reference is ON DELETE RESTRICT — so a stage a card has
 *     ever entered cannot be removed. Archiving is the shape the schema offers, `readPipelineBoard` filters
 *     archived columns out, and a second run of this file un-archives its own three by key. That also keeps
 *     the gapless invariant true, because an archived row keeps its position.
 *
 * The 100 reorders permute the WHOLE vocabulary, because the gapless rule is a property of the table rather
 * than of a subset of it. The order this file found is restored in `afterAll`.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const ACTOR_LABEL = 'Manager (cauto08 fixture)'
const ACTOR: Actor = { kind: 'staff', label: ACTOR_LABEL }
const PUBLISHED_BY = 'cauto08 itest'
const ROLLBACK = 'cauto08 rollback'

/** The three fixture columns, and what each one is here for. */
const STAGES = {
  /** Its entry starts a flow whose live version declares a `pipeline.stage_entered` trigger. */
  entry: 'cauto08_entry',
  /** Its entry names a flow triggered by something else, so the entry is refused by name. */
  wrong: 'cauto08_wrong',
  /** Archived during the suite: the column that goes away under a reader's feet. */
  gone: 'cauto08_gone',
} as const

const FLOWS = {
  onStageEntry: 'cauto08_on_stage_entry',
  wrongTrigger: 'cauto08_wrong_trigger',
} as const

/** Four contacts, in a band no other suite uses. */
const CONTACT_BAND_FIRST = 60_501
const CONTACTS = 4

const AT = new Date(FIXTURE_NOW_ISO)
const LATER = new Date(Date.parse(FIXTURE_NOW_ISO) + 60 * 60 * 1000)
const LATER_STILL = new Date(Date.parse(FIXTURE_NOW_ISO) + 2 * 60 * 60 * 1000)

let sql: Sql
let contactIds: string[] = []
let seededOrder: string[] = []
let templates: {
  readonly templateKey: string
  readonly messageClass: 'transactional' | 'promotional'
}[] = []

const validate = (candidate: unknown) => validateFlowDefinition(candidate, { templates })

const asManager = <T>(
  body: (uow: Parameters<Parameters<typeof withUnitOfWork>[2]>[0]) => Promise<T>,
) => withUnitOfWork(sql, ACTOR, body)

/** A transaction that is always rolled back, for a probe that must leave nothing behind. */
async function probe<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  let carried: T | undefined
  try {
    await sql.begin(async (tx) => {
      carried = await body(tx as unknown as Sql)
      throw new Error(ROLLBACK)
    })
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ROLLBACK) throw err
  }
  return carried as T
}

/** How many audit rows one action has. Read as a DELTA by every caller: `audit_event` only grows. */
async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '0')
}

/** The SQLSTATE a statement raised, or undefined when it did not raise. */
async function sqlstateOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

const contact = (index: number): string => {
  const id = contactIds[index]
  if (id === undefined) throw new Error(`no fixture contact ${index}`)
  return id
}

/**
 * The minimal publishable flow: a trigger and an exit.
 *
 * Deliberately small. The corpus in `packages/core/test/fixtures/flow-definitions` is C-AUTO-06's subject
 * and every document in it is authored around a message class; what this file needs is a graph whose only
 * interesting property is which EVENT starts it, so a two-node document states that and nothing else.
 */
const definitionFor = (key: string, event: string): unknown => ({
  dslVersion: 1,
  key,
  title: `Pipeline fixture flow (${event})`,
  nodes: [
    { id: 'starts', kind: 'trigger', event },
    { id: 'done', kind: 'exit', reason: 'completed' },
  ],
  edges: [{ branch: 'default', from: 'starts', to: 'done' }],
})

/** A deterministic shuffle. A random one that fails once in a hundred runs is a flake, not a test. */
function permutationOf(keys: readonly string[], seed: number): string[] {
  const out = [...keys]
  let state = seed
  for (let i = out.length - 1; i > 0; i -= 1) {
    // A small LCG, stated inline: the numbers do not matter, the reproducibility does.
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    const j = state % (i + 1)
    const a = out[i]
    const b = out[j]
    if (a === undefined || b === undefined) continue
    out[i] = b
    out[j] = a
  }
  return out
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  const rows = await sql<{ template_key: string; message_class: string }[]>`
    select template_key, message_class::text as message_class from message_template
     where is_current = true
  `
  templates = rows.map((row) => ({
    templateKey: row.template_key,
    messageClass: row.message_class as 'transactional' | 'promotional',
  }))

  await sql`
    insert into customer (phone_e164, created_via)
    select '+97159' || lpad((${CONTACT_BAND_FIRST} + g - 1)::text, 7, '0'), 'front_desk'
      from generate_series(1, ${CONTACTS}) as g
    on conflict (phone_e164) do nothing
  `
  const contacts = await sql<{ id: string }[]>`
    select id from customer
     where phone_e164 between ${syntheticPerson(CONTACT_BAND_FIRST).phone}
       and ${syntheticPerson(CONTACT_BAND_FIRST + CONTACTS - 1).phone}
     order by phone_e164
  `
  contactIds = contacts.map((row) => row.id)

  // The two flows, published and active. Relative version numbers throughout: `flow_definition` refuses
  // DELETE, so a second run of this file appends version N+1 rather than colliding.
  for (const [key, event] of [
    [FLOWS.onStageEntry, 'pipeline.stage_entered'],
    [FLOWS.wrongTrigger, 'manual'],
  ] as const) {
    await sql`
      insert into flow (flow_key, title, created_by)
      values (${key}, ${`Pipeline fixture flow ${key}`}, ${PUBLISHED_BY})
      on conflict (flow_key) do nothing
    `
    await asManager((uow) =>
      publishFlowDefinition(
        uow,
        {
          flowKey: key,
          title: `Pipeline fixture flow ${key}`,
          definition: definitionFor(key, event),
          publishedBy: PUBLISHED_BY,
        },
        { validate },
      ),
    )
    await asManager((uow) => setFlowActive(uow, key, true))
  }

  // The three fixture columns, appended after whatever exists so the positions stay 1..n. Un-archived on a
  // second run rather than re-inserted, because the first run's rows are permanent (see the header).
  const [last] = await sql<{ n: number }[]>`
    select coalesce(max(display_order), 0)::int as n from pipeline_stage
  `
  let next = (last?.n ?? 0) + 1
  for (const [name, key] of Object.entries(STAGES)) {
    const flowKey =
      key === STAGES.entry ? FLOWS.onStageEntry : key === STAGES.wrong ? FLOWS.wrongTrigger : null
    const [row] = await sql<{ inserted: boolean }[]>`
      insert into pipeline_stage (stage_key, display_order, description, entry_flow_key)
      values (${key}, ${next}, ${`C-AUTO-08 fixture column (${name}).`}, ${flowKey})
      on conflict (stage_key) do update
         set archived_at = null, entry_flow_key = excluded.entry_flow_key
      returning (xmax = 0) as inserted
    `
    if (row?.inserted === true) next += 1
  }

  seededOrder = (await readPipelineStages(sql)).map((stage) => stage.stageKey)
}, 180_000)

afterAll(async () => {
  if (sql === undefined) return
  // Cards first: `customer_pipeline_card` has no delete refusal, and removing them before the contacts
  // keeps the cascade from doing it silently.
  if (contactIds.length > 0) {
    await sql`delete from customer_pipeline_card where customer_id in ${sql(contactIds)}`
    await sql`delete from flow_enrolment where customer_id in ${sql(contactIds)}`
    await sql`delete from customer where id in ${sql(contactIds)}`
  }
  // The order this file found, restored in ONE transaction: the unique constraint and the gapless check are
  // both deferred to commit, so a statement-at-a-time restore outside a transaction would be refused by
  // the first collision.
  if (seededOrder.length > 0) {
    await asManager((uow) => reorderPipelineStages(uow, { order: seededOrder }))
  }
  // Archived, not deleted. A transition names the stage it moved a card into and that log cannot be
  // rewritten, so the reference is ON DELETE RESTRICT — see the header.
  await sql`
    update pipeline_stage set archived_at = now()
     where stage_key in ${sql(Object.values(STAGES))} and archived_at is null
  `
  await sql.end({ timeout: 5 })
})

// ------------------------------------------------------------------------------------------------
// Positions
// ------------------------------------------------------------------------------------------------

describe('acceptance — stage positions are unique and gapless across 100 randomised reorders', () => {
  it('leaves no duplicate and no gap after any of them, each one transactional', async () => {
    const keys = (await readPipelineStages(sql)).map((stage) => stage.stageKey)
    expect(keys.length, 'the vocabulary is worth permuting').toBeGreaterThanOrEqual(6)

    let reorders = 0
    for (let seed = 1; seed <= 100; seed += 1) {
      const order = permutationOf(keys, seed)
      const written = await asManager((uow) => reorderPipelineStages(uow, { order }))
      reorders += 1
      // Read back from the DATABASE rather than trusting the answer: the claim is about the rows.
      const positions = await sql<{ display_order: number; stage_key: string }[]>`
        select display_order, stage_key from pipeline_stage order by display_order
      `
      const orders = positions.map((row) => row.display_order)
      expect(new Set(orders).size, `seed ${seed}: duplicate position`).toBe(orders.length)
      expect(orders, `seed ${seed}: gapped position`).toEqual(
        Array.from({ length: keys.length }, (_, index) => index + 1),
      )
      // And the order asked for is the order written, which is what makes the two assertions above about
      // a reorder rather than about a table nobody changed.
      expect(
        positions.map((row) => row.stage_key),
        `seed ${seed}`,
      ).toEqual(order)
      expect(
        written.map((row) => row.stageKey),
        `seed ${seed}: returned order`,
      ).toEqual(order)
    }
    // The count is the control on the loop: a loop that ran zero times satisfies every assertion in it.
    expect(reorders).toBe(100)

    // The generator has to be able to disagree with itself, or 100 identical permutations would pass.
    // MEASURED rather than assumed: the distinct orders the hundred seeds produce.
    const distinct = new Set(
      Array.from({ length: 100 }, (_, index) => permutationOf(keys, index + 1).join(',')),
    )
    expect(distinct.size, 'the hundred reorders are not the same reorder').toBeGreaterThan(90)
  }, 120_000)

  it('rolls a reorder back whole when the transaction fails after it', async () => {
    const before = (await readPipelineStages(sql)).map((stage) => stage.stageKey)
    const reversed = [...before].reverse()
    let caught: unknown
    try {
      await withUnitOfWork(sql, ACTOR, async (uow) => {
        await reorderPipelineStages(uow, { order: reversed })
        // The positions ARE reversed inside the transaction, which is what makes the rollback below a
        // rollback of something.
        const inside = await readPipelineStages(uow.sql)
        expect(inside.map((stage) => stage.stageKey)).toEqual(reversed)
        throw new Error(ROLLBACK)
      })
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).toBe(ROLLBACK)
    expect((await readPipelineStages(sql)).map((stage) => stage.stageKey)).toEqual(before)
  })

  it('refuses an order that is not a permutation, naming what was wrong with it', async () => {
    const keys = (await readPipelineStages(sql)).map((stage) => stage.stageKey)
    const first = keys[0]
    const second = keys[1]
    if (first === undefined || second === undefined) throw new Error('two stages are needed')

    for (const [order, expectedIn] of [
      [[...keys, first], 'duplicated'],
      [keys.slice(1), 'missing'],
      [[...keys.slice(1), 'cauto08_no_such_stage'], 'unknown'],
    ] as const) {
      let caught: unknown
      try {
        await asManager((uow) => reorderPipelineStages(uow, { order: [...order] }))
      } catch (error) {
        caught = error
      }
      expect(pipelineRefusalOf(caught), expectedIn).toBe('order_is_not_a_permutation')
      const details = (caught as { details: Record<string, string[]> }).details
      expect(details[expectedIn]?.length, expectedIn).toBeGreaterThan(0)
    }
    // The control: the real order is accepted, so the three refusals above are about the ORDER and not
    // about a function that refuses everything.
    await asManager((uow) => reorderPipelineStages(uow, { order: keys }))
    expect((await readPipelineStages(sql)).map((stage) => stage.stageKey)).toEqual(keys)
  })

  it('refuses a gap and a duplicate at the database, for the owner as well', async () => {
    const keys = (await readPipelineStages(sql)).map((stage) => stage.stageKey)
    const victim = keys[0]
    if (victim === undefined) throw new Error('a stage is needed')

    // A gap: one position pushed past the end. ZU003 and not a constraint violation, because the gapless
    // rule is a statement about the TABLE and no CHECK can make it.
    expect(
      await sqlstateOf(() =>
        probe(async (tx) => {
          await tx`update pipeline_stage set display_order = ${keys.length + 5} where stage_key = ${victim}`
          // The check is DEFERRED to commit and this probe rolls back, so it is forced here. Without this
          // line the probe returns cleanly and the assertion reports the trigger as absent — which is a
          // gate reporting success over a statement nothing examined.
          await tx`set constraints all immediate`
        }),
      ),
    ).toBe(PIPELINE_SQLSTATE.positionsNotGapless)

    // A duplicate: the deferred UNIQUE. Deferred, so it arrives at COMMIT — which is what a reorder needs
    // and is also why this probe has to commit to see it.
    expect(
      await sqlstateOf(() =>
        probe(async (tx) => {
          await tx`update pipeline_stage set display_order = 2 where stage_key = ${victim}`
          await tx`select 1`
          // The rollback the probe performs would hide a deferred constraint, so the check is forced here.
          await tx`set constraints all immediate`
        }),
      ),
    ).toBe('23505')

    // The control on both: the table is still 1..n afterwards, so neither probe left anything behind.
    const orders = (await readPipelineStages(sql)).map((stage) => stage.displayOrder)
    expect(orders).toEqual(Array.from({ length: keys.length }, (_, index) => index + 1))
  })
})

describe('acceptance — the provisional stages reach the Unconfirmed Assumptions panel', () => {
  it('lists every provisional column, each naming the open question', async () => {
    // Brief rule 15, and C-CRM-01's arrangement for the other two CRM vocabularies: a provisional value
    // that cannot be seen to be provisional is indistinguishable from a configured one. A board column is
    // the most VISIBLE assumption in this system, so it is the one that most needs to be on the panel.
    const rows = await unconfirmedAssumptionRows(sql)
    const stages = rows.filter((row) => row.source === 'pipeline_stage')
    expect(stages.map((row) => row.reference).sort()).toEqual([
      'attended',
      'booked',
      'contacted',
      'lapsed',
      'new_enquiry',
      'repeat',
    ])
    for (const row of stages) {
      expect(row.openQuestionId, row.reference).toBe('Y9-crm-pipeline')
      expect(row.note ?? '', row.reference).not.toBe('')
    }
    // This file's own three columns are NOT provisional and are absent, which is the control: a query with
    // no WHERE clause would list them too.
    expect(stages.map((row) => row.reference)).not.toContain(STAGES.entry)
  })

  it('the control: a column whose flag is cleared leaves the panel', async () => {
    // Otherwise "the panel lists them" is satisfied by a query that lists every row of the table.
    const remaining = await probe(async (tx) => {
      await tx`
        update pipeline_stage
           set is_provisional = false, open_question_id = null, provisional_note = null
         where stage_key = 'booked'
      `
      const listed = await unconfirmedAssumptionRows(tx)
      return listed.filter((row) => row.source === 'pipeline_stage').map((row) => row.reference)
    })
    expect(remaining).not.toContain('booked')
    expect(remaining).toContain('contacted')
    // And the rollback held, so every later suite still sees six provisional columns.
    const after = await unconfirmedAssumptionRows(sql)
    expect(
      after.filter((row) => row.source === 'pipeline_stage').map((row) => row.reference),
    ).toContain('booked')
  })
})

// ------------------------------------------------------------------------------------------------
// The move and its record
// ------------------------------------------------------------------------------------------------

describe('acceptance — a move writes a transition with actor, from, to and timestamp', () => {
  it('records the first entry with no from-stage, and the next move with one', async () => {
    const customerId = contact(0)
    const entry = await asManager((uow) =>
      moveCard(uow, { customerId, toStageKey: 'new_enquiry', actor: ACTOR, at: AT }),
    )
    expect(entry.fromStageKey).toBeNull()
    expect(entry.toStageKey).toBe('new_enquiry')

    const moved = await asManager((uow) =>
      moveCard(uow, { customerId, toStageKey: 'contacted', actor: ACTOR, at: LATER }),
    )
    expect(moved.fromStageKey).toBe('new_enquiry')

    const history = await readCardHistory(sql, customerId)
    expect(history).toHaveLength(2)
    const [newest, oldest] = history
    expect(newest?.fromStageKey).toBe('new_enquiry')
    expect(newest?.toStageKey).toBe('contacted')
    expect(newest?.actorKind).toBe('staff')
    expect(newest?.actorLabel).toBe(ACTOR.label)
    expect(newest?.occurredAtIso).toBe(LATER.toISOString())
    expect(oldest?.fromStageKey).toBeNull()
    expect(oldest?.occurredAtIso).toBe(AT.toISOString())

    // The card agrees with the newest transition, to the instant. That equality is what the deferred
    // trigger checks, and asserting it here is what makes the trigger's test below about a real rule.
    const [card] = await sql<{ stage_key: string; stage_entered_at: Date }[]>`
      select stage_key, stage_entered_at from customer_pipeline_card where customer_id = ${customerId}
    `
    expect(card?.stage_key).toBe('contacted')
    expect(card?.stage_entered_at.toISOString()).toBe(LATER.toISOString())
  })

  it('audits the card change by trigger, with the actor the move named', async () => {
    const customerId = contact(1)
    const [before] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
       where entity_type = 'customer_pipeline_card' and entity_id = ${customerId}
    `
    await asManager((uow) =>
      moveCard(uow, { customerId, toStageKey: 'new_enquiry', actor: ACTOR, at: AT }),
    )
    // A DELTA, never a total: `audit_event` is append-only (ADR 0008, brief rule 9).
    const rows = await sql<{ actor_kind: string; actor_label: string; action: string }[]>`
      select actor_kind, actor_label, action from audit_event
       where entity_type = 'customer_pipeline_card' and entity_id = ${customerId}
       order by occurred_at desc limit 1
    `
    const [after] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
       where entity_type = 'customer_pipeline_card' and entity_id = ${customerId}
    `
    expect(Number(after?.n) - Number(before?.n)).toBe(1)
    expect(rows[0]?.action).toBe('customer_pipeline_card.changed')
    // The actor the repository put into the transaction-local settings, read back off the audit row. Not
    // `system`: a move attributed to nobody is the failure the trigger arm of the register exists to stop.
    expect(rows[0]?.actor_kind).toBe('staff')
    expect(rows[0]?.actor_label).toBe(ACTOR.label)
  })

  it('refuses a move into the column the card is already in', async () => {
    const customerId = contact(1)
    let caught: unknown
    try {
      await asManager((uow) =>
        moveCard(uow, { customerId, toStageKey: 'new_enquiry', actor: ACTOR, at: LATER }),
      )
    } catch (error) {
      caught = error
    }
    expect(pipelineRefusalOf(caught)).toBe('card_already_in_stage')
  })

  it('refuses a move into an archived column, which is the 409 the board reverts on', async () => {
    // Through the exported writer rather than by hand: an archive is what the 409 the board reverts on
    // comes FROM, so the path that performs it is the one that has to be exercised. Archiving by raw SQL
    // here would leave `archivePipelineStage` an export nothing in this build has ever run.
    const auditBefore = await auditCount(PIPELINE_AUDIT_ACTIONS.stageArchived)
    await asManager((uow) => archivePipelineStage(uow, { stageKey: STAGES.gone, at: LATER }))
    // A DELTA, never a total: `audit_event` is append-only (ADR 0008, brief rule 9).
    expect((await auditCount(PIPELINE_AUDIT_ACTIONS.stageArchived)) - auditBefore).toBe(1)

    // Archiving it twice is refused by name rather than being a silent no-op, and an absent column is a
    // different refusal — the two are told apart because the remedies are different.
    let twice: unknown
    try {
      await asManager((uow) => archivePipelineStage(uow, { stageKey: STAGES.gone, at: LATER }))
    } catch (error) {
      twice = error
    }
    expect(pipelineRefusalOf(twice)).toBe('stage_archived')
    let absent: unknown
    try {
      await asManager((uow) =>
        archivePipelineStage(uow, { stageKey: 'cauto08_no_such_stage', at: LATER }),
      )
    } catch (error) {
      absent = error
    }
    expect(pipelineRefusalOf(absent)).toBe('stage_not_found')
    let caught: unknown
    try {
      await asManager((uow) =>
        moveCard(uow, { customerId: contact(1), toStageKey: STAGES.gone, actor: ACTOR, at: LATER }),
      )
    } catch (error) {
      caught = error
    }
    expect(pipelineRefusalOf(caught)).toBe('stage_archived')
    // The control: the same move into a column that is NOT archived is accepted, so the refusal is about
    // `archived_at` and not about the column being this file's.
    const accepted = await asManager((uow) =>
      moveCard(uow, { customerId: contact(1), toStageKey: 'booked', actor: ACTOR, at: LATER }),
    )
    expect(accepted.toStageKey).toBe('booked')
  })
})

describe('acceptance — a stage change with no transition row is impossible', () => {
  it('raises ZU001 for a bare UPDATE, for the owner as well', async () => {
    const customerId = contact(0)
    // The known-bad fixture the acceptance line names, run against a real PostgreSQL as the OWNER — the
    // role the revokes do not cover, and the one that moves a card by hand at 02:00.
    expect(
      await sqlstateOf(() =>
        probe(async (tx) => {
          await tx`
            update customer_pipeline_card
               set stage_key = 'repeat', stage_entered_at = ${LATER_STILL}
             where customer_id = ${customerId}
          `
          // DEFERRED to commit, and this probe rolls back — so the check is forced here. That the refusal
          // arrives at COMMIT rather than at the statement is the whole design: the log cannot be written
          // before the card it describes exists, so there is no ordering a bare UPDATE could satisfy.
          await tx`set constraints all immediate`
        }),
      ),
    ).toBe(PIPELINE_SQLSTATE.moveUnrecorded)

    // The control: the SAME update with the matching transition row is accepted. Without it the assertion
    // above would also hold for a trigger that refused every update to this table.
    expect(
      await sqlstateOf(() =>
        probe(async (tx) => {
          await tx`
            update customer_pipeline_card
               set stage_key = 'repeat', stage_entered_at = ${LATER_STILL}
             where customer_id = ${customerId}
          `
          await tx`
            insert into pipeline_stage_transition
              (customer_id, from_stage_key, to_stage_key, actor_kind, actor_label, occurred_at)
            values (${customerId}, 'contacted', 'repeat', 'staff', ${ACTOR_LABEL}, ${LATER_STILL})
          `
          await tx`set constraints all immediate`
        }),
      ),
    ).toBeUndefined()
  })

  it('is not satisfied by an OLDER transition into the same column', async () => {
    // The equality on the instant, which is the part of the rule that is easy to leave out. A card moved
    // back to a column it has visited before would otherwise be accepted on the strength of the earlier
    // row, and the board's history would be missing a move nobody can see is missing.
    const customerId = contact(2)
    await asManager((uow) =>
      moveCard(uow, { customerId, toStageKey: 'new_enquiry', actor: ACTOR, at: AT }),
    )
    await asManager((uow) =>
      moveCard(uow, { customerId, toStageKey: 'contacted', actor: ACTOR, at: LATER }),
    )
    expect(
      await sqlstateOf(() =>
        probe(async (tx) => {
          await tx`
            update customer_pipeline_card
               set stage_key = 'new_enquiry', stage_entered_at = ${LATER_STILL}
             where customer_id = ${customerId}
          `
          await tx`set constraints all immediate`
        }),
      ),
    ).toBe(PIPELINE_SQLSTATE.moveUnrecorded)
  })

  it('leaves an UPDATE that does not touch the stage alone', async () => {
    // Otherwise the trigger refuses every unrelated write to the row, starting with `set_updated_at`'s —
    // and the merge's re-point, which changes the customer id and nothing else.
    expect(
      await sqlstateOf(() =>
        probe(async (tx) => {
          await tx`
            update customer_pipeline_card set updated_at = now() where customer_id = ${contact(0)}
          `
          await tx`set constraints all immediate`
        }),
      ),
    ).toBeUndefined()
  })

  it('refuses UPDATE and DELETE on the transition log, for the owner as well', async () => {
    const customerId = contact(0)
    expect(
      await sqlstateOf(() =>
        probe(
          (tx) => tx`
            update pipeline_stage_transition set actor_label = 'edited' where customer_id = ${customerId}
          `,
        ),
      ),
    ).toBe(PIPELINE_SQLSTATE.transitionImmutable)
    expect(
      await sqlstateOf(() =>
        probe((tx) => tx`delete from pipeline_stage_transition where customer_id = ${customerId}`),
      ),
    ).toBe(PIPELINE_SQLSTATE.transitionImmutable)
    // The control: a SELECT over the same rows works, so the two refusals are about the operation and not
    // about rows the probe cannot see.
    expect((await readCardHistory(sql, customerId)).length).toBeGreaterThan(0)
  })
})

// ------------------------------------------------------------------------------------------------
// The read
// ------------------------------------------------------------------------------------------------

describe('acceptance — the whole board is ONE query', () => {
  it('reads every column and every card in a single statement', async () => {
    // Counted rather than asserted by reading the source, which is B-UI-03's device: a wrapper around the
    // tagged template counts every statement the reader issues, and one is the answer.
    let statements = 0
    const counting = ((...args: Parameters<Sql>) => {
      statements += 1
      return (sql as (...inner: Parameters<Sql>) => unknown)(...args)
    }) as unknown as Sql
    const board = await readPipelineBoard(counting)
    expect(statements).toBe(1)
    expect(board.columns.length).toBeGreaterThanOrEqual(6)
    expect(board.cardCount).toBeGreaterThan(0)

    // The control on the counter, so "one" is a measurement rather than a constant: a second read is a
    // second statement and the counter sees it.
    await readPipelineStages(counting)
    expect(statements).toBe(2)

    // And the board's own arithmetic agrees with the columns it carries, so `cardCount` is not a figure
    // computed somewhere else.
    expect(board.cardCount).toBe(
      board.columns.reduce((total, column) => total + column.cards.length, 0),
    )
  })

  it('leaves an archived column and its cards off the board, and orders by position', async () => {
    const board = await readPipelineBoard(sql)
    expect(board.columns.map((column) => column.stageKey)).not.toContain(STAGES.gone)
    const orders = board.columns.map((column) => column.displayOrder)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
    // The control: a column that is NOT archived is on the board, so the filter is about `archived_at`.
    expect(board.columns.map((column) => column.stageKey)).toContain(STAGES.entry)
  })

  it('leaves a merged-away contact off the board', async () => {
    // One person, two records, one of them merged away: without the filter the board draws both, and a
    // drag on the wrong one moves a card nothing else reads. Probed inside a transaction that is rolled
    // back, because `merge_record` is append-only for every role (ZT001) and a row written here would
    // outlive the contacts this file removes.
    const survivor = contact(0)
    const loser = contact(2)
    const board = await probe(async (tx) => {
      await tx`
        insert into merge_record
          (survivor_customer_id, loser_customer_id, merged_at, actor_kind, actor_label, authority,
           reason, score_per_mille, phone_agreement, label_agreement, field_resolutions)
        values (${survivor}, ${loser}, ${LATER_STILL}, 'staff', ${ACTOR_LABEL},
                'operator_confirmed', 'C-AUTO-08 fixture: the board must not draw a tombstone', 960,
                'identical', 'identical', '[]'::jsonb)
      `
      return await readPipelineBoard(tx)
    })
    const drawn = board.columns.flatMap((column) => column.cards.map((card) => card.customerId))
    expect(drawn).not.toContain(loser)
    // The control, in the same read: the survivor IS drawn, so the filter removed the tombstone rather
    // than everything.
    expect(drawn).toContain(survivor)
    // And the rollback held: the loser is back on the board afterwards.
    const after = await readPipelineBoard(sql)
    expect(
      after.columns.flatMap((column) => column.cards.map((card) => card.customerId)),
    ).toContain(loser)
  })
})

// ------------------------------------------------------------------------------------------------
// Stage entry and the enrolment API
// ------------------------------------------------------------------------------------------------

describe('acceptance — stage entry enrols through the same enrolment API as any other trigger', () => {
  it('holds the reference `@berelax/db` publishes, not a copy of it', () => {
    // A wrapper around the right function passes every behavioural test and fails this. It is the
    // acceptance line's "no bespoke path" stated as an identity, which is the only form of it that cannot
    // drift.
    expect(PIPELINE_ENROLMENT_PATH.enrol).toBe(enrolOnLiveVersion)
  })

  it('creates an enrolment pinned to the live version when a card enters the column', async () => {
    const customerId = contact(3)
    const [before] = await sql<{ n: string }[]>`
      select count(*)::text as n from flow_enrolment
       where customer_id = ${customerId}
         and flow_id = (select id from flow where flow_key = ${FLOWS.onStageEntry})
    `
    const outcome = await asManager((uow) =>
      moveCard(uow, { customerId, toStageKey: STAGES.entry, actor: ACTOR, at: AT }),
    )
    expect(outcome.enrolment).not.toBeNull()

    const rows = await sql<{ definition_version: number; created_by: string; status: string }[]>`
      select definition_version, created_by, status::text as status from flow_enrolment
       where customer_id = ${customerId}
         and flow_id = (select id from flow where flow_key = ${FLOWS.onStageEntry})
    `
    expect(rows.length - Number(before?.n)).toBe(1)
    const [live] = await sql<{ version: number }[]>`
      select max(d.version)::int as version from flow_definition d
        join flow f on f.id = d.flow_id where f.flow_key = ${FLOWS.onStageEntry}
    `
    // Pinned to the version that was live, which is `enrolOnLiveVersion`'s whole job — asserted RELATIVELY
    // because a second run of this file publishes another version.
    expect(outcome.enrolment?.pinnedVersion).toBe(live?.version)
    expect(rows.at(-1)?.definition_version).toBe(live?.version)
    expect(rows.at(-1)?.status).toBe('active')

    // The control: a column that names NO flow starts none, so the enrolment above is the column's doing.
    const none = await asManager((uow) =>
      moveCard(uow, { customerId, toStageKey: 'attended', actor: ACTOR, at: LATER }),
    )
    expect(none.enrolment).toBeNull()
  })

  it('refuses a column whose flow is not triggered by a stage entry, and rolls the move back with it', async () => {
    const customerId = contact(3)
    const [stageBefore] = await sql<{ stage_key: string }[]>`
      select stage_key from customer_pipeline_card where customer_id = ${customerId}
    `
    let caught: unknown
    try {
      await asManager((uow) =>
        moveCard(uow, { customerId, toStageKey: STAGES.wrong, actor: ACTOR, at: LATER_STILL }),
      )
    } catch (error) {
      caught = error
    }
    expect(pipelineRefusalOf(caught)).toBe('stage_entry_flow_not_triggered_by_stage_entry')
    // The move went back with the refusal, which is what one transaction means: the card is where it was
    // and the log carries no row claiming it moved.
    const [stageAfter] = await sql<{ stage_key: string }[]>`
      select stage_key from customer_pipeline_card where customer_id = ${customerId}
    `
    expect(stageAfter?.stage_key).toBe(stageBefore?.stage_key)
    expect((await readCardHistory(sql, customerId)).map((row) => row.toStageKey)).not.toContain(
      STAGES.wrong,
    )
  })

  it('carries a refusal from the enrolment writer out unchanged, never swallowing it', async () => {
    /*
      What makes the per-flow enrolment limit apply here the moment C-AUTO-07 adds it.

      The cap does not exist yet — C-AUTO-06's NOTE says the per-flow cap, the already-enrolled outcome and
      the idempotency of a trigger are C-AUTO-07's, and its provisional line names the figure (5,000 active
      enrolments per flow). Inventing it here would be inventing a threshold nobody has agreed and putting
      it in the wrong unit. What IS assertable is the property the cap needs: a refusal raised by the
      enrolment writer travels out of `moveCard` with its own name attached, and the move goes back with it.
      A path that caught the refusal and carried on would pass every other case in this file.
    */
    const customerId = contact(2)
    const [stageBefore] = await sql<{ stage_key: string }[]>`
      select stage_key from customer_pipeline_card where customer_id = ${customerId}
    `
    const refusing: StageEntryEnroller = () => {
      throw Object.assign(new Error('too many active enrolments on this flow'), {
        details: { refusal: 'flow_enrolment_cap_reached' },
      })
    }
    let caught: unknown
    try {
      await asManager((uow) =>
        moveCard(
          uow,
          { customerId, toStageKey: STAGES.entry, actor: ACTOR, at: LATER_STILL },
          { enrol: refusing },
        ),
      )
    } catch (error) {
      caught = error
    }
    expect(pipelineRefusalOf(caught)).toBe('stage_entry_flow_refused')
    expect((caught as Error).message).toContain('too many active enrolments')
    const [stageAfter] = await sql<{ stage_key: string }[]>`
      select stage_key from customer_pipeline_card where customer_id = ${customerId}
    `
    expect(stageAfter?.stage_key).toBe(stageBefore?.stage_key)

    // The control: the SAME move with the real writer is accepted, so the refusal above is the injected
    // enroller's and not a property of the column.
    const accepted = await asManager((uow) =>
      moveCard(uow, { customerId, toStageKey: STAGES.entry, actor: ACTOR, at: LATER_STILL }),
    )
    expect(accepted.enrolment).not.toBeNull()
  })
})
