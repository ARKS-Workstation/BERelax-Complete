import { PLACEHOLDER_MARKERS } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  canTransition,
  classifyErasureCoverage,
  decideRightsResponse,
  dueDateFor,
  ERASURE_PSEUDONYM_PATTERN,
  ERASURE_RULES,
  erasurePseudonym,
  isRetainingAction,
  isRightsRequestOverdue,
  isTerminalRightsState,
  type ProbedColumn,
  planClinicalErasure,
  planRetentionPurge,
  RIGHTS_REQUEST_STATES,
  ruleForColumn,
} from './rights-policy.ts'

/**
 * The pure half of the rights engine. No clock, no database, no key.
 *
 * Every assertion here is paired with a control that must fail, per brief rule 3 — and in this file the
 * controls are doing most of the work, because nearly every claim the policy makes is of the form "and the
 * obvious wrong answer is detected". A test that only checked the pseudonym was well formed would pass for
 * a pseudonym derived from the wrong thing.
 */

const UUID_A = '01a0dc9b-cd6e-7861-ae40-0884f6b44d9c'
const UUID_B = '01a0dc9b-cd77-7703-b596-a330c44783be'

describe('erasurePseudonym', () => {
  it('produces the shape migration 0085 admits, and the wrong shape does not match it', () => {
    const pseudonym = erasurePseudonym(UUID_A)
    expect(pseudonym).toMatch(ERASURE_PSEUDONYM_PATTERN)
    // The control that matters most: the hex spelling of the same id is the value somebody would reach for
    // first, and it is the one the constraint has to refuse — because `phone_match_key` is the trailing
    // nine DIGITS of this column, so a pseudonym carrying digits derives a key that could equal a living
    // person's.
    expect(`erased-${UUID_A.replaceAll('-', '')}`).not.toMatch(ERASURE_PSEUDONYM_PATTERN)
  })

  it('contains no digits at all, which is what makes the generated match key empty', () => {
    const pseudonym = erasurePseudonym(UUID_A)
    expect(pseudonym.replace('erased-', '')).not.toMatch(/[0-9]/)
    // The control: this is the derivation the database performs. On the pseudonym it must produce nothing.
    const digitsOnly = pseudonym.replaceAll(/[^0-9]/g, '')
    expect(digitsOnly.slice(-9)).toBe('')
    // And the same derivation on a real number must produce nine digits, or the assertion above would
    // hold for a derivation that never produces anything.
    expect('+971590009901'.replaceAll(/[^0-9]/g, '').slice(-9)).toBe('590009901')
  })

  it('is stable and injective, so erasing twice is idempotent and two people cannot collide', () => {
    expect(erasurePseudonym(UUID_A)).toBe(erasurePseudonym(UUID_A))
    expect(erasurePseudonym(UUID_A)).not.toBe(erasurePseudonym(UUID_B))
    // Injectivity is a consequence of the encoding being a bijection on hex, so a one-character change in
    // the id must change exactly one character of the pseudonym. A hash would change all of them, and the
    // point of this assertion is that it is NOT a hash.
    const nudged = `${UUID_A.slice(0, -1)}d`
    const before = erasurePseudonym(UUID_A)
    const after = erasurePseudonym(nudged)
    const differing = [...before].filter((character, i) => character !== after[i]).length
    expect(differing).toBe(1)
  })

  it('refuses a source that is not a uuid, rather than encoding whatever it is given', () => {
    expect(() => erasurePseudonym('+971590009901')).toThrow(/not a uuid|customer uuid/i)
    expect(() => erasurePseudonym('')).toThrow()
    // Upper case is accepted, because a uuid read back from a different driver may arrive that way and
    // refusing it would fail an erasure for a formatting difference.
    expect(erasurePseudonym(UUID_A.toUpperCase())).toBe(erasurePseudonym(UUID_A))
  })
})

describe('dueDateFor and the overdue boundary', () => {
  it('adds whole days to the instant the request was received', () => {
    const received = new Date('2026-09-26T07:00:00.000Z')
    expect(dueDateFor(received, 30).toISOString()).toBe('2026-10-26T07:00:00.000Z')
  })

  it('refuses a deadline of zero, which would be overdue the instant it was taken', () => {
    expect(() => dueDateFor(new Date('2026-09-26T07:00:00.000Z'), 0)).toThrow(/at least 1/)
    expect(() => dueDateFor(new Date('2026-09-26T07:00:00.000Z'), 1.5)).toThrow(/whole number/)
  })

  it('is overdue only once the clock has PASSED the due instant', () => {
    const dueAt = new Date('2026-10-26T07:00:00.000Z')
    const request = { dueAt, state: 'in_progress' as const }
    // The boundary the acceptance line names, and the one a frozen-clock test lands on exactly.
    expect(isRightsRequestOverdue(request, dueAt)).toBe(false)
    expect(isRightsRequestOverdue(request, new Date(dueAt.getTime() + 1))).toBe(true)
    // The control: a closed request is never overdue, however far past its deadline the clock is.
    expect(
      isRightsRequestOverdue({ dueAt, state: 'completed' }, new Date('2027-01-01T00:00:00.000Z')),
    ).toBe(false)
  })
})

describe('the request lifecycle', () => {
  it('permits only the transitions the database also permits', () => {
    expect(canTransition('received', 'in_progress')).toBe(true)
    expect(canTransition('in_progress', 'partially_completed')).toBe(true)
    // The control, and it is the transition somebody would write by accident: straight from received to
    // completed, skipping the state the clinical functions require (ZY006 refuses without `in_progress`).
    expect(canTransition('received', 'completed')).toBe(false)
  })

  it('lets nothing leave a terminal state', () => {
    for (const from of ['completed', 'partially_completed', 'refused'] as const) {
      for (const to of RIGHTS_REQUEST_STATES) {
        expect(canTransition(from, to)).toBe(false)
      }
      expect(isTerminalRightsState(from)).toBe(true)
    }
    // The control: the two non-terminal states must NOT report as terminal, or the loop above would be
    // asserting something true of every state.
    expect(isTerminalRightsState('received')).toBe(false)
    expect(isTerminalRightsState('in_progress')).toBe(false)
  })
})

describe('planClinicalErasure', () => {
  const YEARS = 25

  it('destroys a synthetic payload key under every profile, because it is nobody’s health data', () => {
    for (const erasureOverridesRetention of [true, false]) {
      const decision = planClinicalErasure({
        dataOrigin: 'synthetic',
        erasureOverridesRetention,
        clinicalRetentionYears: YEARS,
      })
      expect(decision.action).toBe('crypto_erase')
      expect(decision.conflict).toBeNull()
      expect(PLACEHOLDER_MARKERS.test(decision.reason)).toBe(false)
    }
  })

  it('retains a REAL payload under the profile in force, and records the conflict', () => {
    const decision = planClinicalErasure({
      dataOrigin: 'real',
      erasureOverridesRetention: false,
      clinicalRetentionYears: YEARS,
    })
    expect(decision.action).toBe('retain_statutory')
    // The conflict is a value, not prose: the whole point is that a retention which defeated an erasure
    // request said so in a field somebody can query.
    expect(decision.conflict).toEqual({
      obligation: 'clinical_retention_years',
      years: YEARS,
      openQuestionId: 'Y1-licence',
    })
    // And the reason carries the FIGURE, so a resolution row does not have to be read beside the profile
    // to be understood.
    expect(decision.reason).toContain(String(YEARS))
    // It also has to be STORABLE: this string reaches `rights_resolution_class.retained_reason`, which
    // `is_placeholder_text` refuses for any text containing `unknown`, `pending` and seven other markers.
    expect(PLACEHOLDER_MARKERS.test(decision.reason)).toBe(false)
  })

  it('destroys a real payload key once the owner has set erasure_overrides_retention', () => {
    const decision = planClinicalErasure({
      dataOrigin: 'real',
      erasureOverridesRetention: true,
      clinicalRetentionYears: YEARS,
    })
    expect(decision.action).toBe('crypto_erase')
    expect(decision.conflict).toBeNull()
    // The control for the pair above: the two real-data cases must DISAGREE, or the function is not
    // reading the profile at all. A `planClinicalErasure` that always destroyed would pass every
    // assertion in the synthetic test and the one above it, and this is what catches it.
    expect(
      planClinicalErasure({
        dataOrigin: 'real',
        erasureOverridesRetention: false,
        clinicalRetentionYears: YEARS,
      }).action,
    ).not.toBe(decision.action)
  })
})

describe('decideRightsResponse', () => {
  it('refuses to issue a response while no supervisory authority is recorded', () => {
    for (const authority of [null, '', '   ']) {
      const decision = decideRightsResponse({ supervisoryAuthority: authority })
      expect(decision.issued).toBe(false)
      expect(decision).toHaveProperty('refusal', 'rights_response_authority_absent')
    }
  })

  it('issues one once an authority is recorded', () => {
    const decision = decideRightsResponse({ supervisoryAuthority: '  A named authority  ' })
    expect(decision).toEqual({ issued: true, supervisoryAuthority: 'A named authority' })
  })
})

describe('the erasure rule registry', () => {
  it('gives every rule a reason, and every retaining rule a reason for KEEPING the data', () => {
    for (const rule of ERASURE_RULES.values()) {
      expect(rule.why.trim().length, rule.key).toBeGreaterThan(40)
      if (isRetainingAction(rule.action)) {
        // The SUBJECT's reason, which is what reaches `rights_resolution_class.retained_reason`. Required,
        // long enough to be a sentence, and — the assertion that forced the field to exist —
        // free of every marker `is_placeholder_text` (0026) refuses. Writing `why` into that column rolled
        // a whole erasure back, because the maintainer's prose quotes `'unknown'` as an enum label.
        expect(rule.subjectReason, rule.key).toBeDefined()
        expect((rule.subjectReason ?? '').length, rule.key).toBeGreaterThan(60)
        expect(PLACEHOLDER_MARKERS.test(rule.subjectReason ?? ''), rule.key).toBe(false)
        // And it is a DIFFERENT sentence from the maintainer's, not a copy: one names migrations and the
        // other is handed to a person.
        expect(rule.subjectReason, rule.key).not.toBe(rule.why)
      } else {
        // Absent from every non-retaining rule, so the field cannot become decoration: a subject reason on
        // a row that is deleted would be a reason for keeping data that is not there.
        expect(rule.subjectReason, rule.key).toBeUndefined()
      }
      // A real unit id, not a fixed one. C-CRM-10 wrote every rule in the registry and this pinned the
      // field to its own name, which made the field decoration: `registeredBy` exists so that a later unit
      // adding a table can say who classified it, and an assertion that only C-CRM-10 may appear means the
      // next unit either lies about the attribution or deletes this line. W-SYS-11 was the first to hit it,
      // adding `staff_credential` and `staff_session` — two tables the credential probe finds and no
      // customer appears in.
      //
      // Still asserted, and on the shape rather than on a list of permitted units: a list would need
      // editing by every unit that registers a rule, which is the same defect one level up.
      expect(rule.registeredBy, rule.key).toMatch(
        /^(?:[A-Z]-[A-Z]{2,5}-\d{2}|[A-Z]\d{2}|[A-Z]-[A-Z]\d)$/,
      )
      if (rule.action === 'retain_statutory') {
        // A statutory retention names the PROFILE COLUMN the figure comes from, never a literal number, so
        // the years cannot go stale against the profile.
        expect(rule.obligationColumn, rule.key).toBeDefined()
      }
      if (rule.action === 'inherits_parent') {
        expect(rule.parent, rule.key).toBeDefined()
      }
    }
    // The control on the pattern above, in both directions. A regex assertion over an empty registry passes,
    // and a regex that stopped discriminating would too — so the unit that BUILT the registry must still
    // account for most of it, and the set of registering units must be small enough to read.
    const registrars = [...new Set([...ERASURE_RULES.values()].map((r) => r.registeredBy))]
    expect(registrars).toContain('C-CRM-10')
    /*
      A ceiling on the NUMBER OF REGISTRARS used to stand here, and it moved from 6 to 10 when P-HR-11 became
      the sixth, then tripped again on H-MIG-03's `imported_package_sale.package_sale_id` — twice failing for
      the right reason and asking for the wrong fix, because another unit classifying a column it created is
      the registry working. A constant on a dimension that grows honestly only ever buys a bumped number.

      So the constant moved to the dimension where growth IS the defect. A tenth unit owning one column each
      is legible; a second unit accumulating dozens of rules is a second engine, and that is what the case
      means by "led by the unit that built it". The largest non-C-CRM-10 registrar owns 3 — W-SITE-10's
      publication columns — so a tenth of the registry is headroom for several more honest classifications
      and still refuses a second engine. Stated as a share rather than a count so it does not go stale as the
      registry grows, and paired with the majority assertion below, which is the same claim from the other
      side.
    */
    const ruleCountByRegistrar = new Map<string, number>()
    for (const rule of ERASURE_RULES.values()) {
      ruleCountByRegistrar.set(
        rule.registeredBy,
        (ruleCountByRegistrar.get(rule.registeredBy) ?? 0) + 1,
      )
    }
    for (const [unit, owned] of ruleCountByRegistrar) {
      if (unit === 'C-CRM-10') continue
      expect(owned, `${unit} owns ${owned} of ${ERASURE_RULES.size} rules`).toBeLessThanOrEqual(
        ERASURE_RULES.size / 10,
      )
    }
    // And the control the share needs, or a registry of ten equal registrars would satisfy every line above:
    // the engine's own unit is not subject to that share, so say outright that it exceeds it.
    expect(ruleCountByRegistrar.get('C-CRM-10') ?? 0).toBeGreaterThan(ERASURE_RULES.size / 10)
    expect(
      [...ERASURE_RULES.values()].filter((r) => r.registeredBy === 'C-CRM-10').length,
    ).toBeGreaterThan(ERASURE_RULES.size / 2)
  })

  it('the control: a registry entry owned by nobody is refused by the shape the case checks', () => {
    // Without this, a pattern that matched everything would pass the loop above for every entry and the
    // field could become decoration — which is what a hard-coded unit id did from the other direction
    // (ADR 0002). Each of these is a real way the field goes wrong: blank, a person, a team, prose, and a
    // lower-case id that no manifest row carries.
    const UNIT_ID = /^[A-Z]-[A-Z]{2,5}-\d{2}$/
    for (const notAUnit of [
      '',
      '  ',
      'claude',
      'the platform team',
      'see the migration',
      'c-auto-07',
    ]) {
      expect(UNIT_ID.test(notAUnit), notAUnit).toBe(false)
    }
    // And every id the registry actually holds satisfies it, so the two halves are about one pattern.
    const owners = new Set([...ERASURE_RULES.values()].map((rule) => rule.registeredBy))
    expect(
      owners.size,
      'more than one unit classifies columns now, which is the point',
    ).toBeGreaterThan(1)
    for (const owner of owners) expect(UNIT_ID.test(owner), owner).toBe(true)
  })

  it('is still mostly C-CRM-10, and every other registering unit is one that had to classify a table', () => {
    // The control the widened assertion above needs. `registeredBy` is a string, so a typo would satisfy the
    // shape; this says the set of units is small, deliberate and led by the unit that built the engine.
    const units = new Set([...ERASURE_RULES.values()].map((rule) => rule.registeredBy))
    expect(units.has('C-CRM-10')).toBe(true)
    const byCcrm10 = [...ERASURE_RULES.values()].filter((rule) => rule.registeredBy === 'C-CRM-10')
    expect(byCcrm10.length).toBeGreaterThan(ERASURE_RULES.size / 2)
    /*
      And the others are NAMED rather than counted, so a unit added here is a diff somebody reads. This line
      is a tripwire and it did its job: it read `['C-CRM-10', 'G-REV-02']` when three merges had since added
      rules, and the integrating verify failed on it rather than letting the set grow unwatched.

      Each name is here because its unit had to classify a table it created, which is the claim this case
      makes: C-AUTO-07's two flow-run columns, W-SITE-10's three publication columns, W-SYS-11's
      `staff_credential` and `staff_session` — two tables the credential probe finds and no customer appears
      in — G-REV-02's `review_intake_email`, whose body holds a customer's own words about this business, and
      P-HR-11's `commission_line.invoice_id`, a pointer at an invoice whose own rule decides the matter.
      A fourth spelling of one unit's id, or a unit that registered a rule for a table it did not create,
      fails here and nowhere else. It did its job a second time: W-SYS-14's `private_document.content_sha256`
      and P-HR-12's `wps_export.file_sha256` were both unclassified when they merged, which ADR 0034 turned
      into a refused erasure rather than a silently unclassified column — nine cases in `rights.itest.ts`
      failed with "the catalogue holds columns no erasure rule classifies" until each got a rule.
    */
    expect([...units].sort()).toEqual([
      'C-AUTO-07',
      'C-CRM-10',
      'G-REV-02',
      'G-REV-05',
      'H-MIG-03',
      'P-HR-11',
      'P-HR-12',
      'W-SITE-10',
      'W-SYS-11',
      'W-SYS-14',
    ])
  })

  it('keeps the four retaining actions distinct, because their justifications are different', () => {
    expect(isRetainingAction('retain_statutory')).toBe(true)
    expect(isRetainingAction('retain_append_only')).toBe(true)
    expect(isRetainingAction('retain_for_subject')).toBe(true)
    expect(isRetainingAction('retain_legitimate_interest')).toBe(true)
    // The controls. `crypto_erase` leaves a row in place and is NOT a retention of readable data, and
    // `inherits_parent` is not a retention at all — folding either in would demand a retained_reason for
    // data that is gone, and the database refuses that.
    expect(isRetainingAction('crypto_erase')).toBe(false)
    expect(isRetainingAction('inherits_parent')).toBe(false)
    expect(isRetainingAction('delete_row')).toBe(false)
  })

  it('keeps the suppression entry, which is the retention an erasure most easily gets backwards', () => {
    const suppression = ERASURE_RULES.get('public.suppression.key_hmac')
    expect(suppression?.action).toBe('retain_for_subject')
    // The control, spelled as the defect rather than as the rule: deleting this row is what makes a
    // re-imported number messageable again, so the one action this key must never carry is a removal.
    expect(['delete_row', 'redact']).not.toContain(suppression?.action)
  })

  it('resolves an exact key before a table wildcard, and neither before nothing', () => {
    const probed = (schema: string, table: string, column: string): ProbedColumn => ({
      schema,
      table,
      column,
      axes: ['contact_detail'],
    })
    // `invoice.customer_phone` has an exact rule; `premises.email` is covered by `public.premises.*`.
    expect(ruleForColumn(probed('public', 'invoice', 'customer_phone'))?.action).toBe(
      'retain_statutory',
    )
    expect(ruleForColumn(probed('public', 'premises', 'email'))?.action).toBe('not_customer_data')
    // The control, and it is the mechanism the whole unit rests on: a column nothing classifies resolves
    // to undefined rather than to a default.
    expect(
      ruleForColumn(probed('public', 'a_table_nobody_registered', 'phone_e164')),
    ).toBeUndefined()
  })
})

describe('classifyErasureCoverage', () => {
  const column = (table: string, col: string): ProbedColumn => ({
    schema: 'public',
    table,
    column: col,
    axes: ['contact_detail'],
  })

  it('reports an unclassified column rather than passing over it', () => {
    const coverage = classifyErasureCoverage([
      column('customer', 'phone_e164'),
      column('a_table_nobody_registered', 'phone_e164'),
    ])
    expect(coverage.classified).toHaveLength(1)
    expect(coverage.unclassified.map((c) => c.table)).toEqual(['a_table_nobody_registered'])
  })

  it('reports a STALE rule too, so the registry cannot claim coverage it does not have', () => {
    const rules = new Map(ERASURE_RULES)
    const coverage = classifyErasureCoverage([column('customer', 'phone_e164')], rules)
    // Every other rule is stale against this one-column catalogue, which is what the field means.
    expect(coverage.staleRuleKeys).not.toContain('public.customer.phone_e164')
    expect(coverage.staleRuleKeys.length).toBeGreaterThan(0)
    // The control: over a catalogue that matches a rule exactly, nothing is stale. Without this the
    // assertion above would hold for a function that reported every rule as stale always.
    // Looked up and CHECKED, not asserted non-null: `noNonNullAssertion` is an error here, and a registry
    // that had lost the identity rule should fail with that sentence rather than with a type assertion
    // quietly making the control run over an empty map.
    const identityRule = ERASURE_RULES.get('public.customer.phone_e164')
    if (identityRule === undefined) {
      throw new Error(
        'the registry has no rule for public.customer.phone_e164, which cannot be right',
      )
    }
    const exact = classifyErasureCoverage(
      [column('customer', 'phone_e164')],
      new Map([['public.customer.phone_e164', identityRule]]),
    )
    expect(exact.staleRuleKeys).toEqual([])
  })
})

describe('planRetentionPurge', () => {
  const NOW = new Date('2026-09-26T07:00:00.000Z')
  const OLD = new Date('2026-01-01T00:00:00.000Z')
  const RECENT = new Date('2026-09-20T00:00:00.000Z')
  const rules = [
    { dataClass: 'contact_channel' as const, retainDays: 30, why: 'expired challenges' },
    { dataClass: 'suppression_record' as const, retainDays: null, why: 'never purged' },
  ]

  it('purges exactly the rows past their retention and keeps the rest, per class', () => {
    const verdicts = planRetentionPurge({
      candidates: [
        { rowId: 'old', dataClass: 'contact_channel', anchoredAt: OLD },
        { rowId: 'recent', dataClass: 'contact_channel', anchoredAt: RECENT },
        { rowId: 'suppressed', dataClass: 'suppression_record', anchoredAt: OLD },
      ],
      rules,
      holds: [],
      subjectOf: new Map(),
      now: NOW,
    })
    expect(verdicts).toEqual([
      { rowId: 'old', outcome: 'purge' },
      { rowId: 'recent', outcome: 'keep', because: 'within_retention' },
      { rowId: 'suppressed', outcome: 'keep', because: 'no_purge_for_class' },
    ])
  })

  it('SKIPS a held row and reports the hold, rather than folding it in with the young ones', () => {
    const verdicts = planRetentionPurge({
      candidates: [{ rowId: 'old', dataClass: 'contact_channel', anchoredAt: OLD }],
      rules,
      holds: [{ subjectCustomerId: UUID_A, dataClass: null }],
      subjectOf: new Map([['old', UUID_A]]),
      now: NOW,
    })
    expect(verdicts).toEqual([{ rowId: 'old', outcome: 'skip', because: 'legal_hold' }])
    // The control: the SAME row with no hold is purged, so the skip is the hold's doing and not the
    // dates'. Without this, a `planRetentionPurge` that skipped everything would pass.
    expect(
      planRetentionPurge({
        candidates: [{ rowId: 'old', dataClass: 'contact_channel', anchoredAt: OLD }],
        rules,
        holds: [],
        subjectOf: new Map([['old', UUID_A]]),
        now: NOW,
      }),
    ).toEqual([{ rowId: 'old', outcome: 'purge' }])
  })

  it('reports the HOLD for a row that is also too young, because that is the reason that outlasts', () => {
    const verdicts = planRetentionPurge({
      candidates: [{ rowId: 'recent', dataClass: 'contact_channel', anchoredAt: RECENT }],
      rules,
      holds: [{ subjectCustomerId: null, dataClass: 'contact_channel' }],
      subjectOf: new Map(),
      now: NOW,
    })
    expect(verdicts).toEqual([{ rowId: 'recent', outcome: 'skip', because: 'legal_hold' }])
  })

  it('scopes a hold by subject and by class independently', () => {
    const candidates = [
      { rowId: 'a', dataClass: 'contact_channel' as const, anchoredAt: OLD },
      { rowId: 'b', dataClass: 'contact_channel' as const, anchoredAt: OLD },
    ]
    const subjectOf = new Map([
      ['a', UUID_A],
      ['b', UUID_B],
    ])
    const scoped = planRetentionPurge({
      candidates,
      rules,
      holds: [{ subjectCustomerId: UUID_A, dataClass: 'contact_channel' }],
      subjectOf,
      now: NOW,
    })
    expect(scoped).toEqual([
      { rowId: 'a', outcome: 'skip', because: 'legal_hold' },
      { rowId: 'b', outcome: 'purge' },
    ])
    // The control for the scoping: a hold naming a DIFFERENT class must not bite, or a subject-scoped
    // hold would be an all-classes hold wearing a class.
    expect(
      planRetentionPurge({
        candidates,
        rules,
        holds: [{ subjectCustomerId: UUID_A, dataClass: 'financial' }],
        subjectOf,
        now: NOW,
      }).every((v) => v.outcome === 'purge'),
    ).toBe(true)
  })
})
