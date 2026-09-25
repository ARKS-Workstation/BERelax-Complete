import { type FlowDefinition, validateFlowDefinition } from '@berelax/core'
import {
  type Actor,
  countEnrolmentsOnVersion,
  createConnection,
  endFlowEnrolment,
  enrolOnLiveVersion,
  FLOW_AUDIT_ACTIONS,
  flowRefusalOf,
  publishFlowDefinition,
  readEnrolmentPinnedDefinition,
  readFlowByKey,
  readFlowDefinition,
  readLiveFlowVersion,
  type Sql,
  setFlowActive,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CORPUS_TEMPLATES,
  INVALID_FLOW_FIXTURES,
  VALID_FLOW_FIXTURES,
} from '../../core/test/fixtures/flow-definitions/index.ts'
import { FIXTURE_NOW_ISO } from './clock.ts'
import { syntheticPerson } from './synthetic.ts'

/**
 * C-AUTO-06 — publishing a version, and the pinning rule that answers the hardest question in the module:
 * four hundred people are mid-flow and the owner edits the flow.
 *
 * `packages/fixtures` is the only package that may import both halves (brief rule 4), and every claim here
 * is a claim about the pair: `validateFlowDefinition` is pure and lives in `@berelax/core`, the rows live in
 * PostgreSQL and `@berelax/db` writes them, and neither package may import the other. So the real
 * validator is INJECTED into `publishFlowDefinition` exactly as an application would inject it — if the
 * mirror type in the repository ever stopped matching, this file would not compile.
 *
 * ## Isolation, and why nothing here asserts an absolute version number
 *
 * `flow_definition` refuses DELETE for every role including the owner, so the versions this file publishes
 * are permanent (ADR 0008, brief rules 9 and 12). Three consequences, all deliberate:
 *
 *   - the flow keys are namespaced to this file, so no other suite's flow is touched;
 *   - every version number is read from the database first and asserted RELATIVELY (`published.version ===
 *     before + 1`), so the second run of this suite against the same database appends instead of colliding;
 *   - every enrolment count is narrowed to this file's own flow id and counted in SQL.
 *
 * The four hundred contacts are removed in `afterAll`. They are on the unallocated +971 59 prefix in a band
 * no other suite uses, and `customer-identity.itest.ts` clears the whole `customer` table — which is
 * exactly why `flow_enrolment.customer_id` cascades rather than restricts (0070's comment).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const ACTOR: Actor = { kind: 'staff', label: 'Manager (fixture)' }
const PUBLISHED_BY = 'cauto06 itest'

/** One key per concern, all namespaced to this file. */
const KEYS = {
  versioning: 'cauto06_versioning',
  pinning: 'cauto06_pinning',
  refusals: 'cauto06_refusals',
  inactive: 'cauto06_inactive',
  /**
   * A flow this file NEVER publishes to, so it has no version on any run.
   *
   * It cannot be `inactive`: `flow_definition` refuses DELETE, so a flow this file publishes to keeps its
   * versions for ever and "has no published version" would be true on the first run of the suite and false
   * on every run after it — brief rule 12's hazard, inflicted by this file on itself.
   */
  unpublished: 'cauto06_unpublished',
} as const

/** The band the four hundred contacts live in. Outside every band listed in `synthetic.ts`'s callers. */
const CONTACT_BAND_FIRST = 60_001
/** Both instants come from the fixture clock, so `ends_after_it_starts` is asserted rather than hoped. */
const ENROLLED_AT = new Date(FIXTURE_NOW_ISO)
const ENDED_AT = new Date(Date.parse(FIXTURE_NOW_ISO) + 60 * 60 * 1000)
const ENROLMENTS = 400

let sql: Sql
let contactIds: string[] = []

const asManager = <T>(
  body: (uow: Parameters<Parameters<typeof withUnitOfWork>[2]>[0]) => Promise<T>,
) => withUnitOfWork(sql, ACTOR, body)

/** The real validator, with the template registry read from the database. Injected, never re-implemented. */
let templates: {
  readonly templateKey: string
  readonly messageClass: 'transactional' | 'promotional'
}[]
const validate = (candidate: unknown) => validateFlowDefinition(candidate, { templates })

/** A definition from the committed corpus, re-keyed to one of this file's flows. */
const corpus = (fragment: string, key: string): unknown => {
  const fixture = [...VALID_FLOW_FIXTURES, ...INVALID_FLOW_FIXTURES].find((candidate) =>
    candidate.file.includes(fragment),
  )
  if (fixture === undefined) throw new Error(`no corpus fixture matching ${fragment}`)
  return { ...(fixture.document as Record<string, unknown>), key }
}

/** The corpus document with one extra node, so an edit is visibly a different graph. */
const edited = (fragment: string, key: string, nodeId: string): unknown => {
  const document = corpus(fragment, key) as Record<string, unknown>
  const nodes = [...(document['nodes'] as Record<string, unknown>[])]
  const edges = [...(document['edges'] as Record<string, unknown>[])]
  // Spliced in front of the first exit's predecessor: a tag node on the way to the end, which changes the
  // node SET without changing whether the flow is publishable.
  const tail = nodes.find((node) => node['kind'] === 'exit')
  if (tail === undefined) throw new Error('the corpus document has no exit to splice before')
  nodes.push({ id: nodeId, kind: 'action_tag', tag: 'edited_in_version_two' })
  const intoTail = edges.findIndex((edge) => edge['to'] === tail['id'])
  const replaced = edges[intoTail] as Record<string, unknown>
  edges[intoTail] = { ...replaced, to: nodeId }
  edges.push({ branch: 'default', from: nodeId, to: tail['id'] })
  return { ...document, edges, nodes }
}

async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '0')
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  // The registry the corpus is authored against, READ from the database rather than restated here: the
  // class of a template is `message_template`'s to state (C-AUTO-01), and a hand-written registry in a
  // test is how a class check comes to pass against a class nothing holds.
  const rows = await sql<{ template_key: string; message_class: string }[]>`
    select template_key, message_class::text as message_class
      from message_template
     where is_current = true
  `
  templates = rows.map((row) => ({
    templateKey: row.template_key,
    messageClass: row.message_class as 'transactional' | 'promotional',
  }))

  // The four hundred contacts, in one statement. Generated in SQL and PAIRED with `syntheticPerson` below,
  // so the two cannot drift into a band another suite owns.
  await sql`
    insert into customer (phone_e164, created_via)
    select '+97159' || lpad((${CONTACT_BAND_FIRST} + g - 1)::text, 7, '0'), 'front_desk'
      from generate_series(1, ${ENROLMENTS}) as g
    on conflict (phone_e164) do nothing
  `
  const contacts = await sql<{ id: string; phone_e164: string }[]>`
    select id, phone_e164 from customer
     where phone_e164 between ${syntheticPerson(CONTACT_BAND_FIRST).phone}
       and ${syntheticPerson(CONTACT_BAND_FIRST + ENROLMENTS - 1).phone}
     order by phone_e164
  `
  contactIds = contacts.map((row) => row.id)
})

afterAll(async () => {
  if (sql === undefined) return
  for (const key of Object.values(KEYS)) {
    await sql`delete from flow_enrolment where flow_id in (select id from flow where flow_key = ${key})`
  }
  if (contactIds.length > 0) await sql`delete from customer where id in ${sql(contactIds)}`
  await sql.end({ timeout: 5 })
})

describe('acceptance — the corpus is authored against the template estate that exists', () => {
  it('agrees with message_template on every key it names', async () => {
    const actual = new Map(
      templates.map((template) => [template.templateKey, template.messageClass]),
    )
    for (const template of CORPUS_TEMPLATES) {
      expect(actual.get(template.templateKey), `${template.templateKey} is registered`).toBe(
        template.messageClass,
      )
    }
    // The control: the registry read from the database is not empty and not all one class, so the class
    // rule has something to disagree about. `review.request` is the only promotional template the seed
    // creates, which is why every promotional node in the corpus names it.
    expect(templates.length).toBeGreaterThanOrEqual(CORPUS_TEMPLATES.length)
    expect(actual.get('review.request')).toBe('promotional')
    expect(actual.get('booking.confirmed')).toBe('transactional')
  })
})

describe('acceptance — publishing an edit creates version N+1', () => {
  it('appends a version, writes one audit row, and leaves the previous document alone', async () => {
    const before = (await readLiveFlowVersion(sql, KEYS.versioning)) ?? 0
    const auditBefore = await auditCount(FLOW_AUDIT_ACTIONS.published)

    const first = await asManager((uow) =>
      publishFlowDefinition(
        uow,
        {
          definition: corpus('valid-01-post-visit', KEYS.versioning),
          flowKey: KEYS.versioning,
          publishedBy: PUBLISHED_BY,
          title: 'Versioning probe',
        },
        { validate },
      ),
    )
    expect(first.version).toBe(before + 1)
    expect(first.activeEnrolmentsOnPreviousVersion).toBe(0)

    const second = await asManager((uow) =>
      publishFlowDefinition(
        uow,
        {
          definition: edited('valid-01-post-visit', KEYS.versioning, 'edited_step'),
          flowKey: KEYS.versioning,
          publishedBy: PUBLISHED_BY,
          title: 'Versioning probe',
        },
        { validate },
      ),
    )
    expect(second.version).toBe(first.version + 1)
    expect(second.nodeCount).toBe(first.nodeCount + 1)
    expect(await readLiveFlowVersion(sql, KEYS.versioning)).toBe(second.version)

    // A DELTA, never a total: `audit_event` only grows (brief rules 9 and 12).
    expect((await auditCount(FLOW_AUDIT_ACTIONS.published)) - auditBefore).toBe(2)

    // Version N is untouched by the publish of N+1 — asserted on the document, not on a row count, which
    // is the whole claim an enrolment's pin rests on. Read back through the repository rather than by a
    // hand-written select, so the reader a consumer will use is the reader this is asserted through.
    const stored = await readFlowDefinition(sql, KEYS.versioning, first.version)
    if (stored === null) throw new Error('version N was not readable back')
    expect(stored.version).toBe(first.version)
    expect(stored.nodeCount).toBe(first.nodeCount)
    expect((stored.definition as FlowDefinition).nodes.map((node) => node.id)).not.toContain(
      'edited_step',
    )
  })

  it('refuses a publish with no validator injected — fail closed', async () => {
    const refused = await asManager((uow) =>
      publishFlowDefinition(
        uow,
        {
          definition: corpus('valid-01-post-visit', KEYS.refusals),
          flowKey: KEYS.refusals,
          publishedBy: PUBLISHED_BY,
          title: 'Refusal probe',
        },
        {},
      ),
    ).catch((error: unknown) => error)
    expect(flowRefusalOf(refused)).toBe('definition_not_validated')
  })

  it('refuses a document whose own key is another flow', async () => {
    const refused = await asManager((uow) =>
      publishFlowDefinition(
        uow,
        {
          definition: corpus('valid-01-post-visit', 'some_other_flow'),
          flowKey: KEYS.refusals,
          publishedBy: PUBLISHED_BY,
          title: 'Refusal probe',
        },
        { validate },
      ),
    ).catch((error: unknown) => error)
    expect(flowRefusalOf(refused)).toBe('definition_key_does_not_match_flow')
  })
})

describe('acceptance — the three refusals, at the publish path', () => {
  const cases = [
    { fragment: 'cycle-with-no-bounded-exit', rule: 'flow-analysis-cycle-has-no-bounded-exit' },
    { fragment: 'dead-end-node', rule: 'flow-analysis-non-terminal-node-has-no-outgoing-edge' },
    {
      fragment: 'accumulated-delay-over-the-maximum',
      rule: 'flow-analysis-accumulated-delay-exceeds-maximum',
    },
    {
      fragment: 'promotional-action-on-transactional-template',
      rule: 'flow-dsl-message-class-mismatch',
    },
  ] as const

  for (const probe of cases) {
    it(`refuses publication for ${probe.fragment}, naming ${probe.rule}`, async () => {
      const before = (await readLiveFlowVersion(sql, KEYS.refusals)) ?? 0
      const refused = await asManager((uow) =>
        publishFlowDefinition(
          uow,
          {
            definition: corpus(probe.fragment, KEYS.refusals),
            flowKey: KEYS.refusals,
            publishedBy: PUBLISHED_BY,
            title: 'Refusal probe',
          },
          { validate },
        ),
      ).catch((error: unknown) => error)
      expect(flowRefusalOf(refused)).toBe('definition_invalid')
      expect(
        (refused as { details: { rules: readonly string[] } }).details.rules,
        'the named rule travels with the refusal, so an operator is told which one',
      ).toContain(probe.rule)
      // Nothing was written: the transaction rolled back, so the live version did not move.
      expect((await readLiveFlowVersion(sql, KEYS.refusals)) ?? 0).toBe(before)
    })
  }

  it('the control: the same flow accepts a valid document, so the refusals are the documents', async () => {
    const before = (await readLiveFlowVersion(sql, KEYS.refusals)) ?? 0
    const published = await asManager((uow) =>
      publishFlowDefinition(
        uow,
        {
          definition: corpus('valid-05-reminder', KEYS.refusals),
          flowKey: KEYS.refusals,
          publishedBy: PUBLISHED_BY,
          title: 'Refusal probe',
        },
        { validate },
      ),
    )
    expect(published.version).toBe(before + 1)
  })
})

describe('acceptance — four hundred enrolments stay pinned when the flow is edited', () => {
  it('leaves all 400 on version N, by row count and by the document one of them reads', async () => {
    expect(contactIds, 'the four hundred contacts were created').toHaveLength(ENROLMENTS)

    const versionN = await asManager((uow) =>
      publishFlowDefinition(
        uow,
        {
          definition: corpus('valid-04-bounded-nurture-loop', KEYS.pinning),
          flowKey: KEYS.pinning,
          publishedBy: PUBLISHED_BY,
          title: 'Pinning probe',
        },
        { validate },
      ),
    )
    await asManager((uow) => setFlowActive(uow, KEYS.pinning, true))

    // One transaction for the four hundred, which is also what a bulk enrolment would do. The figure is
    // the acceptance line's; the enrolment API's caps and idempotency are C-AUTO-07's.
    const enrolments = await asManager(async (uow) => {
      const out: { enrolmentId: string; pinnedVersion: number }[] = []
      for (const customerId of contactIds) {
        out.push(
          await enrolOnLiveVersion(uow, {
            at: ENROLLED_AT,
            createdBy: PUBLISHED_BY,
            customerId,
            flowKey: KEYS.pinning,
          }),
        )
      }
      return out
    })
    expect(enrolments).toHaveLength(ENROLMENTS)
    expect(new Set(enrolments.map((enrolment) => enrolment.pinnedVersion))).toEqual(
      new Set([versionN.version]),
    )

    // The edit.
    const versionNext = await asManager((uow) =>
      publishFlowDefinition(
        uow,
        {
          definition: edited('valid-04-bounded-nurture-loop', KEYS.pinning, 'added_in_next'),
          flowKey: KEYS.pinning,
          publishedBy: PUBLISHED_BY,
          title: 'Pinning probe',
        },
        { validate },
      ),
    )
    expect(versionNext.version).toBe(versionN.version + 1)
    // The figure C-AUTO-09 displays before saving, answered inside the publishing transaction.
    expect(versionNext.activeEnrolmentsOnPreviousVersion).toBe(ENROLMENTS)

    // By row count, counted in SQL and narrowed to this flow.
    expect(await countEnrolmentsOnVersion(sql, versionN.flowId, versionN.version)).toBe(ENROLMENTS)
    expect(await countEnrolmentsOnVersion(sql, versionN.flowId, versionNext.version)).toBe(0)

    // And by EXECUTING one of them: the document an enrolment is governed by is version N's node set.
    const first = enrolments[0]
    if (first === undefined) throw new Error('no enrolment to read')
    const pinned = await readEnrolmentPinnedDefinition(sql, first.enrolmentId)
    if (pinned === null) throw new Error('the enrolment has no pinned definition')
    // The DOCUMENT first and the numbers after it, deliberately: the claim is which graph governs this
    // enrolment, and a read that followed max(version) would fail on the version number one line earlier
    // — which reads as an off-by-one rather than as the flow having been swapped underneath somebody.
    const nodeIds = (pinned.definition as FlowDefinition).nodes.map((node) => node.id)
    expect(nodeIds, 'the node added by the edit is not in the pinned document').not.toContain(
      'added_in_next',
    )
    expect(pinned.pinnedVersion).toBe(versionN.version)
    expect(pinned.liveVersion).toBe(versionNext.version)
    // The control: the node IS in the live version, so the assertion above is the pin rather than an edit
    // that never landed.
    const [live] = await sql<{ definition: FlowDefinition }[]>`
      select d.definition from flow_definition d join flow f on f.id = d.flow_id
       where f.flow_key = ${KEYS.pinning} and d.version = ${versionNext.version}
    `
    expect(live?.definition.nodes.map((node) => node.id)).toContain('added_in_next')

    // And the two readings of "how many are on version N" are not the same question. Ending one of the
    // four hundred leaves the ROW count at 400 and the ACTIVE count at 399, which is why the figure the
    // publish returns is the active one: an enrolment that has finished is not going anywhere, and a
    // count that included it would grow every time the flow ran.
    await asManager((uow) =>
      endFlowEnrolment(uow, {
        at: ENDED_AT,
        enrolmentId: first.enrolmentId,
        reason: 'goal_met',
        status: 'completed',
      }),
    )
    expect(await countEnrolmentsOnVersion(sql, versionN.flowId, versionN.version)).toBe(ENROLMENTS)
    expect(
      await countEnrolmentsOnVersion(sql, versionN.flowId, versionN.version, { activeOnly: true }),
    ).toBe(ENROLMENTS - 1)
  })

  it('pins a NEW enrolment to the newest version, so the pin is resolved at enrolment time', async () => {
    // The other half of the rule. Without this, "everybody stays on N" would also hold for a system that
    // never moved anybody onto N+1 at all.
    const live = await readLiveFlowVersion(sql, KEYS.pinning)
    const joiner = contactIds[0]
    if (joiner === undefined || live === null) throw new Error('nothing to enrol onto')
    // A second enrolment for the same contact: the per-flow dedupe is C-AUTO-07's, so at this layer the
    // row is simply another enrolment — which is what makes the version resolution visible on its own.
    const second = await asManager((uow) =>
      enrolOnLiveVersion(uow, {
        at: ENROLLED_AT,
        createdBy: PUBLISHED_BY,
        customerId: joiner,
        flowKey: KEYS.pinning,
      }),
    )
    expect(second.pinnedVersion).toBe(live)
    const pinned = await readEnrolmentPinnedDefinition(sql, second.enrolmentId)
    if (pinned === null) throw new Error('the enrolment has no pinned definition')
    expect((pinned.definition as FlowDefinition).nodes.map((node) => node.id)).toContain(
      'added_in_next',
    )
  })
})

describe('enrolment refusals and the lifecycle', () => {
  it('refuses an enrolment into a flow that is not active, and into one with no version', async () => {
    const customerId = contactIds[1]
    if (customerId === undefined) throw new Error('no contact')

    const noVersion = await asManager(async (uow) => {
      await uow.sql`
        insert into flow (flow_key, title, created_by)
        values (${KEYS.unpublished}, 'Unpublished probe', ${PUBLISHED_BY})
        on conflict (flow_key) do nothing
      `
      await setFlowActive(uow, KEYS.unpublished, true)
      return enrolOnLiveVersion(uow, {
        at: ENROLLED_AT,
        createdBy: PUBLISHED_BY,
        customerId,
        flowKey: KEYS.unpublished,
      }).catch((error: unknown) => error)
    })
    expect(flowRefusalOf(noVersion)).toBe('flow_has_no_published_version')

    const inactive = await asManager(async (uow) => {
      await publishFlowDefinition(
        uow,
        {
          definition: corpus('valid-03-no-show', KEYS.inactive),
          flowKey: KEYS.inactive,
          publishedBy: PUBLISHED_BY,
          title: 'Inactive probe',
        },
        { validate },
      )
      await setFlowActive(uow, KEYS.inactive, false)
      return enrolOnLiveVersion(uow, {
        at: ENROLLED_AT,
        createdBy: PUBLISHED_BY,
        customerId,
        flowKey: KEYS.inactive,
      }).catch((error: unknown) => error)
    })
    expect(flowRefusalOf(inactive)).toBe('flow_not_active')
    // Read back through the repository: the refusal is the flow's state and not a cached view of it.
    expect((await readFlowByKey(sql, KEYS.inactive))?.isActive).toBe(false)
  })

  it('ends an enrolment once, keeps the pin, and refuses a second ending', async () => {
    const customerId = contactIds[2]
    if (customerId === undefined) throw new Error('no contact')
    const enrolment = await asManager((uow) =>
      enrolOnLiveVersion(uow, {
        at: ENROLLED_AT,
        createdBy: PUBLISHED_BY,
        customerId,
        flowKey: KEYS.pinning,
      }),
    )
    await asManager((uow) =>
      endFlowEnrolment(uow, {
        at: ENDED_AT,
        enrolmentId: enrolment.enrolmentId,
        reason: 'goal_met',
        status: 'completed',
      }),
    )
    const pinned = await readEnrolmentPinnedDefinition(sql, enrolment.enrolmentId)
    expect(pinned?.status).toBe('completed')
    expect(pinned?.pinnedVersion).toBe(enrolment.pinnedVersion)

    const second = await asManager((uow) =>
      endFlowEnrolment(uow, {
        at: ENDED_AT,
        enrolmentId: enrolment.enrolmentId,
        reason: 'goal_met',
        status: 'completed',
      }),
    ).catch((error: unknown) => error)
    expect(flowRefusalOf(second)).toBe('enrolment_not_active')
  })
})
