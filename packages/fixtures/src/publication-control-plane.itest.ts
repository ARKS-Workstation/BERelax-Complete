import { randomUUID } from 'node:crypto'
import {
  agentPrincipal,
  bannedClaimVocabulary,
  type CompliancePolicy,
  decidePublicationTransition,
  PUBLICATION_STATES,
  PUBLICATION_TRANSITIONS,
  type PublicationOrigin,
  type PublicationState,
  publicationCanonicalContent,
  publicationCopyFindings,
  resolvedPermissionsOf,
  SEO_AGENT_GRANTS,
  SEO_AGENT_PRINCIPAL,
  staffPrincipal,
  UNRECORDED,
} from '@berelax/core'
import {
  createConnection,
  publicationContentHash,
  publicationHistory,
  publicationPosition,
  publicationRecordById,
  publishSurface,
  readCompliancePolicy,
  recordApproval,
  recordDraft,
  recordLintPass,
  revertSurfaceTo,
  type Sql,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * W-SITE-10 — the publication control plane, against the real database.
 *
 * Every acceptance line of this unit is a claim about what PostgreSQL refuses, and not one of them can be
 * checked by reading TypeScript. The trap this file exists against is named in the unit's own brief: *a
 * service-layer guard that the database would let past is the defect this line exists against*. So every
 * refusal below is driven as a STATEMENT — an insert or an update issued directly, with the ids and the
 * hashes the constraint is about — and the service functions are exercised beside them so the two layers
 * can be seen to agree rather than assumed to.
 *
 * ## Isolation
 *
 * Every surface this file writes carries a per-run suffix, so no assertion is a total over a shared table
 * and nothing here depends on file order (CONTRIBUTING-AGENT-BRIEF §12). It cannot clean up after itself and
 * does not try: all three tables refuse DELETE for every role including the owner, which is the property
 * under test. The rows are a few per run and the surfaces are unique, so they are invisible to every other
 * suite — which is the only form of isolation an append-only table admits.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

let sql: Sql
let policy: CompliancePolicy
let profileVersion: number

/** A surface nothing else in the suite will touch. */
const RUN = randomUUID().slice(0, 8)
const surfaceFor = (name: string): string => `pages/w-site-10-${name}-${RUN}`

/** A frozen instant, so nothing here depends on how long a test took. */
const AT = new Date('2026-09-28T09:00:00.000Z')

/** The critical-path budget docs/08 §8 states, as a figure the DB rows carry. Never the authority. */
const BUDGET = 250 * 1024

const sha = async (text: string): Promise<string> => await publicationContentHash(sql, text)

/** The SQLSTATE a statement bounced off, or undefined if it did not bounce. */
async function sqlstateOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : `no-sqlstate: ${String(error)}`
  }
}

/** The constraint a statement bounced off, or undefined. What a CHECK violation is asserted BY. */
async function constraintOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    const constraint = error as { constraint_name?: unknown; constraint?: unknown }
    const name = constraint.constraint_name ?? constraint.constraint
    return typeof name === 'string' ? name : `no-constraint: ${String(error)}`
  }
}

/** The whole sequence for one surface, through the service functions. Returns every id it minted. */
async function publishOnce(
  surface: string,
  regions: readonly { readonly region: string; readonly text: string }[],
  measured = 180_000,
): Promise<{
  readonly contentSha256: string
  readonly lintPassId: string
  readonly approvalId: string
  readonly recordId: string
}> {
  const canonical = publicationCanonicalContent(regions)
  const contentSha256 = await sha(canonical)
  await recordDraft(sql, {
    surface,
    contentSha256,
    recordedAt: AT,
    actorKind: 'staff',
    actorLabel: 'Approver 01',
  })
  const { lintPassId } = await recordLintPass(sql, {
    surface,
    contentSha256,
    termsChecked: bannedClaimVocabulary(policy).length,
    lintedAt: AT,
    actorKind: 'staff',
    actorLabel: 'Approver 01',
  })
  const { approvalId } = await recordApproval(sql, {
    surface,
    lintPassId,
    contentSha256,
    approverUserId: `user-${RUN}`,
    approverDisplayName: 'Approver 01',
    approverRole: 'owner',
    approvedAt: AT,
  })
  const { recordId } = await publishSurface(sql, {
    surface,
    lintPassId,
    approvalId,
    contentSha256,
    measuredCriticalPathBytes: measured,
    criticalPathBudgetBytes: BUDGET,
    recordedAt: AT,
    actorKind: 'staff',
    actorLabel: 'Approver 01',
  })
  return { contentSha256, lintPassId, approvalId, recordId }
}

const CLEAN = [
  { region: 'title', text: 'What to expect on a first visit' },
  { region: 'body', text: 'The desk takes your booking and shows you to the room.' },
]

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  const row = await readCompliancePolicy(sql)
  policy = {
    bannedClaimTerms: row.bannedClaimTerms,
    permittedPublicTitles: row.permittedPublicTitles,
    medicalClaimsPermitted: row.medicalClaimsPermitted,
  }
  profileVersion = row.profileVersion
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

// ------------------------------------------------------------------------------------------------

describe('acceptance — the state machine is enforced in the DATABASE', () => {
  it('refuses a direct INSERT of state=published with no lint_pass_id and no approval_id', async () => {
    // The acceptance line, as a statement. The surface is walked to `approved` first so the ORDERING is
    // satisfied and the only thing left to refuse is the EVIDENCE — without that the transition trigger
    // fires instead and the case would report PASS about a rule it never reached. The weight figures are
    // supplied for the same reason.
    const surface = surfaceFor('evidence')
    const contentSha256 = await sha(publicationCanonicalContent(CLEAN))
    await recordDraft(sql, {
      surface,
      contentSha256,
      recordedAt: AT,
      actorKind: 'staff',
      actorLabel: 'Editor 01',
    })
    const { lintPassId } = await recordLintPass(sql, {
      surface,
      contentSha256,
      termsChecked: 20,
      lintedAt: AT,
      actorKind: 'staff',
      actorLabel: 'Editor 01',
    })
    await recordApproval(sql, {
      surface,
      lintPassId,
      contentSha256,
      approverUserId: `user-${RUN}`,
      approverDisplayName: 'Approver 01',
      approverRole: 'owner',
      approvedAt: AT,
    })
    expect((await publicationPosition(sql, surface)).state).toBe('approved')

    const refused = await constraintOf(
      () => sql`
        insert into publication_record (
          surface, state, content_sha256, recorded_at, actor_kind, actor_label,
          measured_critical_path_bytes, critical_path_budget_bytes
        ) values (
          ${surface}, 'published', ${contentSha256}, ${AT}, 'staff', 'Approver 01', 180000, ${BUDGET}
        )
      `,
    )
    expect(refused).toBe('publication_record_published_needs_evidence')
    // And nothing was written: a refusal that left a row would be worse than no refusal.
    expect((await publicationPosition(sql, surface)).state).toBe('approved')
  }, 30_000)

  it('refuses a direct UPDATE to state=published with no evidence, by the same constraint', async () => {
    // The UPDATE half. With triggers ON an UPDATE is refused by the append-only trigger (ZZ001, asserted in
    // its own case below), so this runs with `session_replication_role = 'replica'` — which is how a restore
    // from a dump runs, and is precisely the route 0087's header calls "the one route in that nobody is
    // watching". The CHECK is what answers there, and it is what the acceptance line names.
    const surface = surfaceFor('evidence-update')
    const contentSha256 = await sha(publicationCanonicalContent(CLEAN))
    await recordDraft(sql, {
      surface,
      contentSha256,
      recordedAt: AT,
      actorKind: 'staff',
      actorLabel: 'Editor 01',
    })
    const refused = await constraintOf(() =>
      sql.begin(async (tx) => {
        await tx`set local session_replication_role = 'replica'`
        await tx`
          update publication_record
             set state = 'published', lint_pass_id = null, approval_id = null,
                 measured_critical_path_bytes = 180000, critical_path_budget_bytes = ${BUDGET}
           where surface = ${surface} and state = 'draft'
        `
      }),
    )
    expect(refused).toBe('publication_record_published_needs_evidence')
    // The control on the fixture: with the triggers off the same UPDATE carrying evidence DOES go through,
    // so the refusal above is about the missing evidence and not about the replica role refusing writes.
    const { lintPassId } = await recordLintPass(sql, {
      surface,
      contentSha256,
      termsChecked: 20,
      lintedAt: AT,
      actorKind: 'staff',
      actorLabel: 'Editor 01',
    })
    const { approvalId } = await recordApproval(sql, {
      surface,
      lintPassId,
      contentSha256,
      approverUserId: `user-${RUN}`,
      approverDisplayName: 'Approver 01',
      approverRole: 'owner',
      approvedAt: AT,
    })
    const accepted = await constraintOf(() =>
      sql.begin(async (tx) => {
        await tx`set local session_replication_role = 'replica'`
        await tx`
          update publication_record
             set state = 'published', lint_pass_id = ${lintPassId}::uuid,
                 approval_id = ${approvalId}::uuid,
                 measured_critical_path_bytes = 180000, critical_path_budget_bytes = ${BUDGET}
           where surface = ${surface} and state = 'draft'
        `
        // Rolled back: this row would violate the state machine's ORDERING if it survived, and the point
        // of the control is only that the CHECK is satisfiable.
        await tx`rollback`
      }),
    )
    expect(accepted).toBeUndefined()
  }, 30_000)

  it('agrees with @berelax/core about every (from, to) pair, in both directions', async () => {
    // The mirror, asserted rather than reviewed. `PUBLICATION_TRANSITIONS` is a second statement of the
    // trigger's `case`, and this is what stops the two drifting: each pair is driven as a real INSERT on a
    // surface parked in the `from` state, and the database's answer must be the table's answer.
    const origins: readonly PublicationOrigin[] = [UNRECORDED, ...PUBLICATION_STATES]
    const disagreements: string[] = []
    let attempted = 0
    for (const from of origins) {
      for (const to of PUBLICATION_STATES) {
        attempted += 1
        const surface = surfaceFor(`pair-${from}-${to}`)
        const ids = await parkAt(surface, from)
        const supersedes = from === 'published' && to === 'published' ? ids.recordId : null
        // In one transaction with the audit row, because the deferred constraint (ZZ004) applies to every
        // published INSERT and would otherwise answer every `-> published` pair before the transition rule
        // was reached. That check has a case of its own; this one is about the arrows.
        const code = await sqlstateOf(() =>
          sql.begin(async (tx) => {
            const [row] = await tx<{ id: string }[]>`
              insert into publication_record (
                surface, state, content_sha256, lint_pass_id, approval_id, supersedes_id,
                measured_critical_path_bytes, critical_path_budget_bytes, recorded_at, actor_kind,
                actor_label
              ) values (
                ${surface}, ${to}, ${ids.contentSha256},
                ${to === 'draft' ? null : ids.lintPassId},
                ${to === 'published' ? ids.approvalId : null},
                ${supersedes},
                ${to === 'published' ? 180000 : null},
                ${to === 'published' ? BUDGET : null},
                ${AT}, 'staff', 'Approver 01'
              ) returning id
            `
            if (to === 'published' && row !== undefined) {
              await tx`
                insert into audit_event (
                  actor_kind, actor_label, action, entity_type, entity_id, operation
                ) values (
                  'staff', 'Approver 01', 'publication.publish', 'publication_record', ${row.id}, 'create'
                )
              `
            }
          }),
        )
        const databaseAllowed = code === undefined
        const tableAllows = PUBLICATION_TRANSITIONS[from].includes(to)
        if (databaseAllowed !== tableAllows) {
          disagreements.push(
            `${from} -> ${to}: the table says ${tableAllows ? 'allowed' : 'refused'} and the database ` +
              `said ${databaseAllowed ? 'allowed' : `refused (${String(code)})`}`,
          )
        }
        // And when both refuse, the database must refuse it as a TRANSITION and not by some other rule —
        // otherwise a pair could agree by accident, which is the failure ADR 0003 is about.
        if (!tableAllows && !databaseAllowed && code !== 'ZZ002') {
          disagreements.push(`${from} -> ${to}: refused by ${String(code)} rather than ZZ002`)
        }
        // The pure decision has to answer the same thing, with complete evidence.
        const decided = decidePublicationTransition(
          { state: from, currentRecordId: from === UNRECORDED ? null : ids.recordId },
          to,
          {
            lintPassId: to === 'draft' ? null : ids.lintPassId,
            approvalId: to === 'published' ? ids.approvalId : null,
            measuredCriticalPathBytes: to === 'published' ? 180_000 : null,
            supersedesId: supersedes,
          },
        )
        if ((decided.kind === 'allowed') !== tableAllows) {
          disagreements.push(
            `${from} -> ${to}: decidePublicationTransition disagrees with its own table`,
          )
        }
      }
    }
    expect(disagreements).toEqual([])
    // ADR 0002: a loop that ran no iterations passes every assertion in it.
    expect(attempted).toBe(origins.length * PUBLICATION_STATES.length)
  }, 120_000)
})

/**
 * Walks a fresh surface to `state` and returns the evidence ids the pair test will cite.
 *
 * The lint pass and the approval are ALWAYS minted on a surface of their own, so that a refusal in the pair
 * test is unambiguously about the arrow: a null `lint_pass_id` would let the evidence CHECK answer instead,
 * and the case would report the transition rule as firing when it had not. Nothing constrains a lint pass to
 * the surface that cites it, so citing a real one from elsewhere is a legal row in every other respect.
 *
 * The walk itself is raw INSERTs rather than the service functions, and that is deliberate: `recordLintPass`
 * writes a lint pass AND its record in one transaction and `recordApproval` does the same, so neither can
 * park a surface at `lint_passed` without also approving it. The arrows are what the test is about; this
 * helper is scaffolding, and it is checked by the assertion at the end — if a walk lands somewhere else the
 * case fails here rather than reporting about a state it never reached.
 */
async function parkAt(
  surface: string,
  state: PublicationOrigin,
): Promise<{
  readonly contentSha256: string
  readonly lintPassId: string
  readonly approvalId: string
  readonly recordId: string | null
}> {
  const contentSha256 = await sha(`${publicationCanonicalContent(CLEAN)}\n${surface}`)
  const evidenceSurface = `${surface}-evidence`
  await recordDraft(sql, {
    surface: evidenceSurface,
    contentSha256,
    recordedAt: AT,
    actorKind: 'staff',
    actorLabel: 'Editor 01',
  })
  const { lintPassId } = await recordLintPass(sql, {
    surface: evidenceSurface,
    contentSha256,
    termsChecked: 20,
    lintedAt: AT,
    actorKind: 'staff',
    actorLabel: 'Editor 01',
  })
  const { approvalId } = await recordApproval(sql, {
    surface: evidenceSurface,
    lintPassId,
    contentSha256,
    approverUserId: `user-${RUN}`,
    approverDisplayName: 'Approver 01',
    approverRole: 'owner',
    approvedAt: AT,
  })

  /** One step of the walk, citing the evidence a row in that state is required to carry. */
  const step = async (to: PublicationState): Promise<void> => {
    await sql`
      insert into publication_record (
        surface, state, content_sha256, lint_pass_id, approval_id,
        measured_critical_path_bytes, critical_path_budget_bytes, recorded_at, actor_kind, actor_label
      ) values (
        ${surface}, ${to}, ${contentSha256},
        ${to === 'draft' ? null : lintPassId},
        ${to === 'published' ? approvalId : null},
        ${to === 'published' ? 180000 : null},
        ${to === 'published' ? BUDGET : null},
        ${AT}, 'staff', 'Approver 01'
      )
    `
  }

  const walk: Readonly<Record<PublicationOrigin, readonly PublicationState[]>> = {
    unrecorded: [],
    draft: ['draft'],
    lint_passed: ['draft', 'lint_passed'],
    approved: ['draft', 'lint_passed', 'approved'],
    published: ['draft', 'lint_passed', 'approved', 'published'],
  }
  for (const to of walk[state]) {
    if (to === 'published') {
      // The deferred audit constraint applies to a parked row as much as to a real publish, so the row and
      // its audit event go in one transaction — which is the constraint doing its job on this helper.
      await publishSurface(sql, {
        surface,
        lintPassId,
        approvalId,
        contentSha256,
        measuredCriticalPathBytes: 180_000,
        criticalPathBudgetBytes: BUDGET,
        recordedAt: AT,
        actorKind: 'staff',
        actorLabel: 'Approver 01',
      })
      continue
    }
    await step(to)
  }
  const position = await publicationPosition(sql, surface)
  expect(position.state, `parkAt could not reach ${state} for ${surface}`).toBe(state)
  return { contentSha256, lintPassId, approvalId, recordId: position.currentRecordId }
}

describe('acceptance — the banned-claims lint is derived from regulatory_profile', () => {
  it('the profile in force really carries the terms the corpus depends on', () => {
    // The claim `packages/core/src/compliance/banned-claims.test.ts` cannot make: that these words are on
    // the ROW and not in a fixture. Without this, that file's corpus would prove the lint works against a
    // list this repository does not actually hold.
    expect(policy.medicalClaimsPermitted).toBe(false)
    for (const term of ['cure', 'heal', 'medical', 'treatment', 'diagnosis', 'clinic']) {
      expect(policy.bannedClaimTerms, `${term} is not on the profile in force`).toContain(term)
    }
    // `clinic` is 0093's addition, and `clinical` is 0004's. Both, because the stemmer matches neither to
    // the other and a page can carry either word.
    expect(policy.bannedClaimTerms).toContain('clinical')
    // And the vocabulary the lint will compare against is bigger than the row's list, because the code half
    // of the lexicon is in it too — a count equal to the row's would mean the code half had been dropped.
    expect(bannedClaimVocabulary(policy).length).toBeGreaterThan(policy.bannedClaimTerms.length)
  })

  it('refuses a known-bad page BY RULE NAME, against the real row', async () => {
    const findings = publicationCopyFindings(
      [
        { region: 'title', text: 'How massage cures sciatica' },
        { region: 'body', text: 'Visit our clinic and ask the doctor.' },
      ],
      policy,
    )
    expect(findings.map((finding) => finding.rule)).toEqual([
      'banned_claim_term',
      'banned_claim_term',
      'unpermitted_staff_title',
    ])
    expect(findings.map((finding) => finding.term)).toEqual(['cure', 'clinic', 'doctor'])
    // The control: clean copy against the same row produces nothing, so the three findings above are about
    // the copy rather than about a lint that refuses everything.
    expect(publicationCopyFindings(CLEAN, policy)).toEqual([])
  })

  it('records WHICH profile version the pass compared against, and refuses a pass that examined nothing', async () => {
    const surface = surfaceFor('lint-evidence')
    const contentSha256 = await sha(publicationCanonicalContent(CLEAN))
    await recordDraft(sql, {
      surface,
      contentSha256,
      recordedAt: AT,
      actorKind: 'staff',
      actorLabel: 'Editor 01',
    })
    const { lintPassId } = await recordLintPass(sql, {
      surface,
      contentSha256,
      termsChecked: bannedClaimVocabulary(policy).length,
      lintedAt: AT,
      actorKind: 'staff',
      actorLabel: 'Editor 01',
    })
    const [pass] = await sql<{ version: number; terms: number }[]>`
      select regulatory_profile_version as version, terms_checked as terms
        from publication_lint_pass where id = ${lintPassId}::uuid
    `
    expect(pass?.version).toBe(profileVersion)
    expect(Number(pass?.terms)).toBe(bannedClaimVocabulary(policy).length)

    // ADR 0002 as a CHECK: a pass that compared against nothing cannot be recorded as a pass.
    const refused = await constraintOf(
      () => sql`
        insert into publication_lint_pass (
          surface, content_sha256, regulatory_profile_version, terms_checked, linted_at,
          actor_kind, actor_label
        ) values (
          ${surface}, ${contentSha256}, ${profileVersion}, 0, ${AT}, 'staff', 'Editor 01'
        )
      `,
    )
    expect(refused).toBe('publication_lint_pass_examined_something')
  }, 30_000)
})

describe('acceptance — the approval is a named act against a content hash', () => {
  it('records the user id, a display-name and role snapshot, an instant and the hash', async () => {
    const surface = surfaceFor('approval')
    const ids = await publishOnce(surface, CLEAN)
    const [row] = await sql<
      {
        userId: string
        displayName: string
        role: string
        approvedAt: Date
        hash: string
        lintPassId: string
      }[]
    >`
      select approver_user_id as "userId", approver_display_name as "displayName",
             approver_role as "role", approved_at as "approvedAt", content_sha256 as hash,
             lint_pass_id as "lintPassId"
        from publication_approval where id = ${ids.approvalId}::uuid
    `
    expect(row?.userId).toBe(`user-${RUN}`)
    // The snapshot, which is the point of the column. Stored beside the id rather than joined, so a later
    // rename cannot rewrite who approved what.
    expect(row?.displayName).toBe('Approver 01')
    expect(row?.role).toBe('owner')
    expect(row?.approvedAt).toBeInstanceOf(Date)
    expect(row?.approvedAt.toISOString()).toBe(AT.toISOString())
    expect(row?.hash).toBe(ids.contentSha256)
    expect(row?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row?.lintPassId).toBe(ids.lintPassId)
  }, 30_000)

  it('refuses an approval whose hash differs from the linted content', async () => {
    // The hash-mismatch test, and the one the unit's brief singles out: the happy path proves nothing about
    // it. The approval cites a real lint pass and a DIFFERENT hash — which is exactly what approving copy
    // that was edited after the lint looks like — and the composite key refuses it.
    const surface = surfaceFor('hash-mismatch')
    const linted = await sha(publicationCanonicalContent(CLEAN))
    const edited = await sha(
      publicationCanonicalContent([...CLEAN, { region: 'body', text: 'One more sentence.' }]),
    )
    expect(edited).not.toBe(linted)
    await recordDraft(sql, {
      surface,
      contentSha256: linted,
      recordedAt: AT,
      actorKind: 'staff',
      actorLabel: 'Editor 01',
    })
    const { lintPassId } = await recordLintPass(sql, {
      surface,
      contentSha256: linted,
      termsChecked: 20,
      lintedAt: AT,
      actorKind: 'staff',
      actorLabel: 'Editor 01',
    })
    const refused = await constraintOf(() =>
      recordApproval(sql, {
        surface,
        lintPassId,
        contentSha256: edited,
        approverUserId: `user-${RUN}`,
        approverDisplayName: 'Approver 01',
        approverRole: 'owner',
        approvedAt: AT,
      }),
    )
    expect(refused).toBe('publication_approval_is_for_the_linted_content')
    // The control: the same approval for the LINTED hash is accepted, so the refusal is about the mismatch.
    const accepted = await constraintOf(() =>
      recordApproval(sql, {
        surface,
        lintPassId,
        contentSha256: linted,
        approverUserId: `user-${RUN}`,
        approverDisplayName: 'Approver 01',
        approverRole: 'owner',
        approvedAt: AT,
      }),
    )
    expect(accepted).toBeUndefined()
  }, 30_000)

  it('refuses publishing a hash the approval did not approve', async () => {
    // The other end of the chain. An approval exists, and the record cites it with different content —
    // which is what publishing an edit made after the approval looks like.
    const surface = surfaceFor('publish-mismatch')
    const ids = await publishOnce(surface, CLEAN)
    const edited = await sha('something else entirely')
    const refused = await constraintOf(
      () => sql`
        insert into publication_record (
          surface, state, content_sha256, lint_pass_id, approval_id, supersedes_id,
          measured_critical_path_bytes, critical_path_budget_bytes, recorded_at, actor_kind, actor_label
        ) values (
          ${surface}, 'published', ${edited}, ${ids.lintPassId}::uuid, ${ids.approvalId}::uuid,
          ${ids.recordId}::uuid, 180000, ${BUDGET}, ${AT}, 'staff', 'Approver 01'
        )
      `,
    )
    expect(refused).toBe('publication_record_is_the_approved_content')
  }, 30_000)

  it('refuses an approver with no stated name, rather than defaulting one', async () => {
    // Brief rule 10 and rule 15 as a constraint: the only value that would satisfy a default here is the
    // name of a person, and a placeholder is worse than a blank because it looks configured.
    const surface = surfaceFor('nameless')
    const contentSha256 = await sha(publicationCanonicalContent(CLEAN))
    await recordDraft(sql, {
      surface,
      contentSha256,
      recordedAt: AT,
      actorKind: 'staff',
      actorLabel: 'Editor 01',
    })
    const { lintPassId } = await recordLintPass(sql, {
      surface,
      contentSha256,
      termsChecked: 20,
      lintedAt: AT,
      actorKind: 'staff',
      actorLabel: 'Editor 01',
    })
    for (const name of ['', '   ', 'TBD', 'TODO']) {
      const refused = await constraintOf(
        () => sql`
          insert into publication_approval (
            lint_pass_id, content_sha256, approver_user_id, approver_display_name, approver_role,
            approved_at
          ) values (
            ${lintPassId}::uuid, ${contentSha256}, 'u', ${name}, 'owner', ${AT}
          )
        `,
      )
      expect(refused, `"${name}" was accepted as an approver's name`).toBe(
        'publication_approval_name_is_stated',
      )
    }
    // And a role the matrix has never heard of, for the reason `principalFrom` gives: `can(role, …)`
    // deciding on an unknown string is worse than a refusal.
    expect(
      await constraintOf(
        () => sql`
          insert into publication_approval (
            lint_pass_id, content_sha256, approver_user_id, approver_display_name, approver_role,
            approved_at
          ) values (
            ${lintPassId}::uuid, ${contentSha256}, 'u', 'Approver 01', 'intern', ${AT}
          )
        `,
      ),
    ).toBe('publication_approval_role_known')
  }, 30_000)
})

describe('acceptance — the publication record is append-only', () => {
  it('refuses UPDATE and DELETE on all three tables, for the owner', async () => {
    const surface = surfaceFor('append-only')
    const ids = await publishOnce(surface, CLEAN)
    const cases: readonly [string, () => Promise<unknown>][] = [
      [
        'record UPDATE',
        () => sql`update publication_record set state = 'draft' where surface = ${surface}`,
      ],
      ['record DELETE', () => sql`delete from publication_record where surface = ${surface}`],
      [
        'approval UPDATE',
        () =>
          sql`update publication_approval set approver_display_name = 'Somebody Else'
               where id = ${ids.approvalId}::uuid`,
      ],
      [
        'approval DELETE',
        () => sql`delete from publication_approval where id = ${ids.approvalId}::uuid`,
      ],
      [
        'lint pass UPDATE',
        () =>
          sql`update publication_lint_pass set terms_checked = 1 where id = ${ids.lintPassId}::uuid`,
      ],
      [
        'lint pass DELETE',
        () => sql`delete from publication_lint_pass where id = ${ids.lintPassId}::uuid`,
      ],
    ]
    for (const [name, run] of cases) {
      expect(await sqlstateOf(run), name).toBe('ZZ001')
    }
    // Nothing moved. A refusal that reported ZZ001 and still wrote would be the worst of both.
    const after = await publicationRecordById(sql, ids.recordId)
    expect(after?.state).toBe('published')
  }, 60_000)

  it('has UPDATE, DELETE and TRUNCATE revoked for the application role', async () => {
    // The privilege, stated as well as the trigger, because the two answer different questions — "may this
    // role" and "may anybody" — and a privilege is what a reader of `\dp` sees. `berelax_app` is the role
    // the application actually connects as in production; the suite connects as the owner, so without this
    // assertion the revoke could be absent and every case above would still pass.
    const rows = await sql<{ table: string; priv: string; held: boolean }[]>`
      select t.table_name as table, p.priv,
             has_table_privilege('berelax_app', t.table_name, p.priv) as held
        from (values ('publication_lint_pass'), ('publication_approval'), ('publication_record'))
               as t(table_name),
             (values ('update'), ('delete'), ('truncate'), ('select'), ('insert')) as p(priv)
    `
    const held = new Map(rows.map((row) => [`${row.table}.${row.priv}`, row.held]))
    for (const table of ['publication_lint_pass', 'publication_approval', 'publication_record']) {
      for (const priv of ['update', 'delete', 'truncate']) {
        expect(held.get(`${table}.${priv}`), `${table}.${priv}`).toBe(false)
      }
      // The control: the role can still do its job, so the revokes above are a narrowing rather than the
      // table being unreachable — which would make the whole plane untestable in production and pass here.
      for (const priv of ['select', 'insert']) {
        expect(held.get(`${table}.${priv}`), `${table}.${priv}`).toBe(true)
      }
    }
  }, 30_000)

  it('makes a correction a NEW record that references the superseded one', async () => {
    const surface = surfaceFor('correction')
    const first = await publishOnce(surface, CLEAN)
    // A correction with no supersedes_id is refused, and by the rule that is about it.
    expect(
      await sqlstateOf(
        () => sql`
          insert into publication_record (
            surface, state, content_sha256, lint_pass_id, approval_id,
            measured_critical_path_bytes, critical_path_budget_bytes, recorded_at, actor_kind, actor_label
          ) values (
            ${surface}, 'published', ${first.contentSha256}, ${first.lintPassId}::uuid,
            ${first.approvalId}::uuid, 180000, ${BUDGET}, ${AT}, 'staff', 'Approver 01'
          )
        `,
      ),
    ).toBe('ZZ003')
    // And one naming a record that is not the live one, which is the subtler half.
    const history = await publicationHistory(sql, surface)
    const older = history.find((row) => row.state === 'draft')
    expect(
      await sqlstateOf(
        () => sql`
          insert into publication_record (
            surface, state, content_sha256, lint_pass_id, approval_id, supersedes_id,
            measured_critical_path_bytes, critical_path_budget_bytes, recorded_at, actor_kind, actor_label
          ) values (
            ${surface}, 'published', ${first.contentSha256}, ${first.lintPassId}::uuid,
            ${first.approvalId}::uuid, ${older?.id ?? null}::uuid, 180000, ${BUDGET}, ${AT}, 'staff',
            'Approver 01'
          )
        `,
      ),
    ).toBe('ZZ003')
    // The control: naming the live record is accepted, so the two refusals are about which record and not
    // about corrections being impossible.
    const corrected = await publishSurface(sql, {
      surface,
      lintPassId: first.lintPassId,
      approvalId: first.approvalId,
      contentSha256: first.contentSha256,
      measuredCriticalPathBytes: 181_000,
      criticalPathBudgetBytes: BUDGET,
      recordedAt: AT,
      actorKind: 'staff',
      actorLabel: 'Approver 01',
      supersedesId: first.recordId,
    })
    expect(corrected.supersededId).toBe(first.recordId)
    expect((await publicationRecordById(sql, corrected.recordId))?.supersedesId).toBe(
      first.recordId,
    )
  }, 60_000)

  it('refuses a publish with no audit_event in the same transaction, and writes one when it publishes', async () => {
    const surface = surfaceFor('audited')
    const ids = await publishOnce(surface, CLEAN)
    // The delta, never a total: `audit_event` is append-only and shared (ADR 0008, brief §9).
    const [audited] = await sql<{ n: number }[]>`
      select count(*)::int as n from audit_event
       where action = 'publication.publish' and entity_type = 'publication_record'
         and entity_id = ${ids.recordId}
    `
    expect(audited?.n).toBe(1)

    // And the refusal, which is what makes it a property rather than a habit: the same INSERT in a
    // transaction that writes no audit row is refused at COMMIT.
    const refused = await sqlstateOf(() =>
      sql.begin(async (tx) => {
        await tx`
          insert into publication_record (
            surface, state, content_sha256, lint_pass_id, approval_id, supersedes_id,
            measured_critical_path_bytes, critical_path_budget_bytes, recorded_at, actor_kind, actor_label
          ) values (
            ${surface}, 'published', ${ids.contentSha256}, ${ids.lintPassId}::uuid,
            ${ids.approvalId}::uuid, ${ids.recordId}::uuid, 180000, ${BUDGET}, ${AT}, 'staff',
            'Approver 01'
          )
        `
      }),
    )
    expect(refused).toBe('ZZ004')
    // The live record is still the one `publishOnce` wrote, so the refusal rolled the whole thing back.
    expect((await publicationPosition(sql, surface)).currentRecordId).toBe(ids.recordId)
  }, 60_000)
})

describe('acceptance — the weight check fires before publication', () => {
  it('refuses an over-budget published row with the measured number, and one with no measurement', async () => {
    const surface = surfaceFor('over-budget')
    const ids = await publishOnce(surface, CLEAN)
    const over = BUDGET + 44_000
    let message = ''
    try {
      await publishSurface(sql, {
        surface,
        lintPassId: ids.lintPassId,
        approvalId: ids.approvalId,
        contentSha256: ids.contentSha256,
        measuredCriticalPathBytes: over,
        criticalPathBudgetBytes: BUDGET,
        recordedAt: AT,
        actorKind: 'staff',
        actorLabel: 'Approver 01',
        supersedesId: ids.recordId,
      })
      expect.unreachable('an over-budget page must not be publishable')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('ZZ005')
      message = error instanceof Error ? error.message : String(error)
    }
    // The measured number in the refusal, which is the acceptance criterion's own words.
    expect(message).toContain(String(over))
    expect(message).toContain(String(BUDGET))
    expect(message).toContain(String(over - BUDGET))

    // A published row carrying no figure at all is refused too: a publish that skipped the check has
    // nothing to write, which is what makes the check unskippable rather than customary.
    expect(
      await sqlstateOf(
        () => sql`
          insert into publication_record (
            surface, state, content_sha256, lint_pass_id, approval_id, supersedes_id,
            recorded_at, actor_kind, actor_label
          ) values (
            ${surface}, 'published', ${ids.contentSha256}, ${ids.lintPassId}::uuid,
            ${ids.approvalId}::uuid, ${ids.recordId}::uuid, ${AT}, 'staff', 'Approver 01'
          )
        `,
      ),
    ).toBe('ZZ005')

    // And the CHECK behind the trigger, which is the layer that holds when a restore has triggers off.
    expect(
      await constraintOf(() =>
        sql.begin(async (tx) => {
          await tx`set local session_replication_role = 'replica'`
          await tx`
            insert into publication_record (
              surface, state, content_sha256, lint_pass_id, approval_id, supersedes_id,
              measured_critical_path_bytes, critical_path_budget_bytes, recorded_at, actor_kind,
              actor_label
            ) values (
              ${surface}, 'published', ${ids.contentSha256}, ${ids.lintPassId}::uuid,
              ${ids.approvalId}::uuid, ${ids.recordId}::uuid, ${over}, ${BUDGET}, ${AT}, 'staff',
              'Approver 01'
            )
          `
        }),
      ),
    ).toBe('publication_record_published_is_within_budget')
  }, 60_000)

  it('stores the figure the publish was judged on, so the row explains its own verdict', async () => {
    const surface = surfaceFor('weight-stored')
    const ids = await publishOnce(surface, CLEAN, 199_991)
    const row = await publicationRecordById(sql, ids.recordId)
    expect(row?.measuredCriticalPathBytes).toBe(199_991)
    expect(row?.criticalPathBudgetBytes).toBe(BUDGET)
    // The control: an earlier state carries neither, so the columns are about a published page rather than
    // about every row.
    const history = await publicationHistory(sql, surface)
    for (const record of history.filter((entry) => entry.state !== 'published')) {
      expect(record.measuredCriticalPathBytes, record.state).toBeNull()
      expect(record.criticalPathBudgetBytes, record.state).toBeNull()
    }
  }, 30_000)
})

describe('acceptance — the SEO agent holds no publish permission', () => {
  it('excludes content:publish from the resolved grant set, enumerated', () => {
    // The set assertion the acceptance line asks for. ENUMERATED rather than asked one question at a time,
    // for the reason `seo-agent.policy.test.ts` gives: `can(x) === false` for one permission says that one
    // is absent, and an enumeration says what is present — so a fourth grant is visible to a reader here.
    const agent = agentPrincipal(SEO_AGENT_PRINCIPAL)
    expect(agent).not.toBeNull()
    if (agent === null) return
    expect([...resolvedPermissionsOf(agent)].sort()).toEqual([
      'catalogue:read',
      'report:read',
      'seo_suggestion:propose',
    ])
    expect(resolvedPermissionsOf(agent)).not.toContain('content:publish')
    expect(SEO_AGENT_GRANTS).toHaveLength(3)
    // The control on the set being narrower than a role's rather than merely different: the owner holds the
    // permission, so the absence above is a denial rather than a permission nobody has.
    expect(resolvedPermissionsOf(staffPrincipal('owner'))).toContain('content:publish')
    expect(resolvedPermissionsOf(staffPrincipal('marketer'))).not.toContain('content:publish')
  })
})

describe('acceptance — a revert restores the exact approved content hash', () => {
  it('writes a new record, restores the hash, and leaves the superseded record readable', async () => {
    const surface = surfaceFor('revert')
    const first = await publishOnce(surface, CLEAN)
    const second = await publishOnce(
      surface,
      [...CLEAN, { region: 'body', text: 'A second paragraph, published later.' }],
      181_000,
    )
    expect(second.contentSha256).not.toBe(first.contentSha256)
    const before = await publicationHistory(sql, surface)

    const reverted = await revertSurfaceTo(sql, {
      surface,
      targetRecordId: first.recordId,
      measuredCriticalPathBytes: 178_000,
      criticalPathBudgetBytes: BUDGET,
      recordedAt: AT,
      actorKind: 'staff',
      actorLabel: 'Approver 01',
    })

    // 1. The EXACT approved content hash, and the approval it came with.
    const row = await publicationRecordById(sql, reverted.recordId)
    expect(row?.contentSha256).toBe(first.contentSha256)
    expect(row?.approvalId).toBe(first.approvalId)
    expect(row?.lintPassId).toBe(first.lintPassId)
    // 2. A NEW record: one more row, and the live one is the new id rather than the target's.
    const after = await publicationHistory(sql, surface)
    expect(after.length).toBe(before.length + 1)
    expect(reverted.recordId).not.toBe(first.recordId)
    expect((await publicationPosition(sql, surface)).currentRecordId).toBe(reverted.recordId)
    // 3. The superseded record is still readable, unchanged, and is named by the new one.
    expect(reverted.supersededId).toBe(second.recordId)
    const superseded = await publicationRecordById(sql, second.recordId)
    expect(superseded?.state).toBe('published')
    expect(superseded?.contentSha256).toBe(second.contentSha256)
    expect(superseded?.measuredCriticalPathBytes).toBe(181_000)
    expect(row?.supersedesId).toBe(second.recordId)

    // The weight is RE-measured rather than copied from the target: the page renders from today's
    // templates, so the target's figure describes bytes nobody will download.
    expect(row?.measuredCriticalPathBytes).toBe(178_000)
  }, 90_000)

  it('refuses a revert to a record that was never published, or to the live one', async () => {
    const surface = surfaceFor('revert-refused')
    const ids = await publishOnce(surface, CLEAN)
    const draft = (await publicationHistory(sql, surface)).find((row) => row.state === 'draft')
    await expect(
      revertSurfaceTo(sql, {
        surface,
        targetRecordId: draft?.id ?? ids.recordId,
        measuredCriticalPathBytes: 178_000,
        criticalPathBudgetBytes: BUDGET,
        recordedAt: AT,
        actorKind: 'staff',
        actorLabel: 'Approver 01',
      }),
    ).rejects.toThrow(/not a published record/)
    await expect(
      revertSurfaceTo(sql, {
        surface,
        targetRecordId: ids.recordId,
        measuredCriticalPathBytes: 178_000,
        criticalPathBudgetBytes: BUDGET,
        recordedAt: AT,
        actorKind: 'staff',
        actorLabel: 'Approver 01',
      }),
    ).rejects.toThrow(/already the live version/)
  }, 60_000)
})

describe('the canonical content, and what does and does not change a hash', () => {
  it('is stable under a paste artefact and changes on an edit or a moved paragraph', async () => {
    const base = await sha(publicationCanonicalContent(CLEAN))
    // A Windows line ending and a trailing space: how copy was typed, not what it says. An approval that
    // expired on one of these is an approval people learn to re-give without reading.
    const pasted = await sha(
      publicationCanonicalContent([
        { region: 'title', text: 'What to expect on a first visit  ' },
        { region: 'body', text: 'The desk takes your booking and shows you to the room.\r\n' },
      ]),
    )
    expect(pasted).toBe(base)
    // A real edit.
    expect(
      await sha(
        publicationCanonicalContent([
          { region: 'title', text: 'What to expect on a second visit' },
          CLEAN[1] as { region: string; text: string },
        ]),
      ),
    ).not.toBe(base)
    // The same words in a different region. A paragraph moved from the body into the title is a different
    // page, and a digest that folded the regions together would call it the same one.
    expect(
      await sha(
        publicationCanonicalContent([
          { region: 'title', text: 'The desk takes your booking and shows you to the room.' },
          { region: 'body', text: 'What to expect on a first visit' },
        ]),
      ),
    ).not.toBe(base)
    // And it is a sha256 computed by PostgreSQL, so there is one implementation of it in the build.
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(await sha('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  }, 30_000)
})
