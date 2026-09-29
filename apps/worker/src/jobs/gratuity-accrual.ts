import {
  accountCode,
  accrualCatchUpFloor,
  accrualMonthsOwing,
  accrueGratuityMonth,
  type EntryDraft,
  type EntryId,
  type GratuityAccounts,
  type GratuityRules,
  gratuityAccrualEntry,
  gratuityRulesFor,
  latestCompletedAccrualMonth,
  localDate,
  monthAfter,
  monthEnd,
} from '@berelax/core'
import {
  type Actor,
  businessDayAt,
  type GratuityAccrualInput,
  type GratuityEmployeeRow,
  type GratuityRuleRow,
  type JournalEntryInput,
  periodLockFor,
  postGratuityAccrual,
  readGratuityAccruals,
  readGratuityEmployees,
  readGratuityLiabilities,
  readGratuityRules,
  readSetting,
  readUnpaidLeaveDaysByMonth,
  type Sql,
  type WrittenGratuityAccrual,
  withUnitOfWork,
} from '@berelax/db'
import {
  AppError,
  GRATUITY_EXPENSE_ACCOUNT_SETTING_KEY,
  GRATUITY_LIABILITY_ACCOUNT_SETTING_KEY,
} from '@berelax/shared'

/**
 * The monthly gratuity accrual pass (P-HR-13).
 *
 * End-of-service gratuity is not paid monthly, it is OWED monthly, and this pass is the only thing that
 * grows the liability. docs/04 §7's whole statement on the subject is that it is *"an accruing balance-sheet
 * liability, accrued monthly"*, and every figure it accrues with comes from a `gratuity_rule` version that
 * is flagged provisional against `Y9-gratuity` — there is no rate, band, divisor or cap in this file, and
 * `hr-gratuity.test.ts` scans it for a numeric literal to prove there is not.
 *
 * ## It posts a DIFFERENCE, which is what makes it safe to run
 *
 * The month's movement is the whole liability owed at the month end minus what is already on the books
 * (ADR 0057). Three things follow, and all three are why this pass is dull rather than dangerous:
 *
 *   * **Idempotence is arithmetic, not memory.** A month already accrued has a movement of zero, and
 *     `gratuity_accrual_one_original_per_month` refuses the row anyway. Nothing is remembered in this
 *     module; 0031 records what a job's own state costs, which is a second accrual the first time it is
 *     lost.
 *   * **No drift.** Twelve monthly movements sum exactly to the twelve-month liability, so the journal and
 *     the engine cannot disagree by a residue that nobody can trace.
 *   * **A wage rise needs no restatement.** It lands as one catch-up movement in the month it is known. That
 *     matters because P-HR-12's payroll run is immutable once completed (ZY141) and its header figures may
 *     only be written by the statement that completes it (ZY142): a pass that had to revisit an earlier
 *     month would be unable to.
 *
 * ## A catch-up sweep, and which month is complete
 *
 * Every complete month with no accrual row yet is accrued, bounded by {@link CATCH_UP_MONTHS} — the shape
 * `leave-accrual.ts` takes and for its reason: a monthly cron declares a 31-day interval, so a dead pass is
 * reported after about two months rather than after two hours, and a pass that only ever did "last month"
 * would lose every month it missed.
 *
 * Which month is complete is a question about the TRADING session and not about the calendar. Trading runs
 * 11:00–02:00, so at 01:30 on 1 March the session in force opened on 28 February and February has not
 * finished: this pass must accrue January. `businessDayAt` and `latestCompletedAccrualMonth` answer that
 * pair, and nothing here re-derives where a trading day ends.
 *
 * ## Two classes of employee are REFUSED and named, never accrued at zero
 *
 * Both matter more here than in the labour-cost forecast, because service length multiplies the whole
 * figure rather than adding to it.
 *
 *   * **Unpriced.** All nineteen seeded therapists carry a null wage, because a wage is a fact about a
 *     person and the build does not invent one (brief rule 15). Treating null as zero would report a roster
 *     of nineteen people as owing nothing, and nothing about the figure would look wrong.
 *   * **A provisional employment RECORD.** The same nineteen rows carry `employed_from = 1970-01-01`, an
 *     epoch placeholder 0050's seeder chose precisely because it cannot be mistaken for a transcribed fact.
 *     Accruing against it would owe fifty-six years of gratuity rather than a slightly wrong figure, so a
 *     row still flagged `is_provisional` is refused even if somebody has since set a wage. This is the one
 *     exclusion this pass adds that the forecast does not have, and it exists because of what the two
 *     figures are: a forecast that is wrong by decades is obviously wrong, and a balance-sheet liability
 *     that is wrong by decades sits there looking like a number.
 *
 * ## Accruing into a month somebody has already filed
 *
 * ADR 0026: a closed period cannot be reopened without a migration, and the journal has no edit (ADR 0017).
 * So a month whose accounting period has since been locked is still accrued — the liability was earned —
 * but the entry is dated in the next OPEN period and NAMES the locked one, which `ZY174` enforces and the
 * narrative states. The pass walks forward from the month after the lock until it finds an unlocked date,
 * so a run of consecutive locked months lands in the first open one rather than failing.
 *
 * ## The accounts come from settings
 *
 * `hr.gratuity_expense_account` and `hr.gratuity_liability_account`, both compliance-locked and provisional
 * against `Y8-coa`. Not constants, because `chart_of_accounts` is itself a provisional row (0018): a code
 * written here would be this build deciding an accountant's classification, in a journal where changing it
 * later means restating history.
 *
 * ## The instant is injected
 *
 * `atIso` is an argument and never a clock read, so the pass is reproducible: the integration suite drives
 * it at a frozen instant and asserts the second run writes nothing, which is exactly what a job reading
 * `new Date()` could not be asked.
 */

/** The `agent_definition` this pass reports to. Seeded by 0107; `assertRegistry` refuses a cron without one. */
export const GRATUITY_ACCRUAL_AGENT = 'gratuity_accrual'

/** Published per accrual posted, so a liability change is visible outside the database. */
export const GRATUITY_ACCRUED_EVENT = 'gratuity.accrued'

/**
 * How far back a pass will reach for a month with no accrual row.
 *
 * Twenty-four months, matching `leave-accrual.ts`. **It bounds the number of ROWS and not the liability, and
 * that difference is the whole point of writing it down**: an earlier version of this comment claimed the
 * bound stopped a first run deriving years of liability nobody agreed, copied from `leave-accrual.ts` where
 * it is true, and it is false here.
 *
 * Leave accrues INDEPENDENTLY per month, so bounding the months bounds the total. Gratuity accrues as a
 * DIFFERENCE against the whole liability owed (ADR 0057), so the oldest month inside the window carries
 * everything earned before it as one catch-up movement. A first run against somebody with three years of
 * service writes twenty-four rows and the first of them is thirteen months' worth.
 *
 * That is CORRECT for a liability and it is why it was left as it is rather than bounded harder: the employee
 * earned the entitlement, and a liability that omitted the first eighteen months would understate what is
 * owed — the one error that leaves no trace. What the bound buys is a bounded number of journal entries and a
 * bounded amount of work per pass, which is worth having on its own.
 *
 * What actually stops a decade of service being priced for the seeded roster is the
 * `provisional_employment_record` refusal, not this number: all nineteen carry the epoch placeholder
 * `1970-01-01`, and refusing them is what keeps fifty-six years of gratuity off the balance sheet.
 *
 * A constant rather than a setting, because what it trades off is a choice about THIS pass and not a policy
 * about gratuity.
 */
export const CATCH_UP_MONTHS = 24

/** How far forward the pass will look for an open period when the accrual month is locked. */
const MAX_LOCKED_MONTHS_AHEAD = 36

/** `actor_id` is a uuid column; the label is where a name goes. */
const ACTOR: Actor = { kind: 'system', label: 'gratuity.accrual' }

/** The `created_by` label on every accrual this pass writes. */
const CREATED_BY = 'gratuity.accrual'

/** Why an employee was considered and not accrued. Reported, because a silent skip is a missing liability. */
export interface GratuityExclusion {
  readonly employeeId: string
  readonly staffReference: string
  readonly reason: 'unpriced' | 'provisional_employment_record'
}

export interface GratuityAccrualResult {
  /** The trading date the pass was made for — the session the instant belongs to. */
  readonly tradingDate: string
  /** True when that session was still open, which is what makes its month incomplete. */
  readonly withinTradingHours: boolean
  /** The latest month the pass was willing to accrue. */
  readonly throughMonth: string
  /** Employees considered. Reported even when zero, so "nothing owing" is not "nothing ran". */
  readonly considered: number
  /** Accruals posted. Empty on a second pass of the same month, which is the acceptance criterion. */
  readonly written: readonly WrittenGratuityAccrual[]
  /** Fils added across every accrual posted. */
  readonly accruedFils: number
  /** Employees refused, with the reason. Never silently dropped. */
  readonly excluded: readonly GratuityExclusion[]
  /** Accrual months whose period was locked, so the entry landed later. `month -> entry date`. */
  readonly rebasedMonths: readonly { readonly accrualMonth: string; readonly entryDate: string }[]
  /** Employees whose liability would have gone BACKWARDS, which needs a correction and not a posting. */
  readonly overAccrued: readonly string[]
  /** The policy versions in hand, for the record. */
  readonly policyVersions: number
}

/** The row shape `@berelax/db` returns, in the shape the pure engine takes. */
function asRules(row: GratuityRuleRow): GratuityRules {
  return {
    effectiveFrom: localDate(row.effectiveFrom),
    daysPerYearFirstBand: row.daysPerYearFirstBand,
    daysPerYearAfterBand: row.daysPerYearAfterBand,
    bandBoundaryYears: row.bandBoundaryYears,
    dailyWageDaysDivisor: row.dailyWageDaysDivisor,
    wageBasis: row.wageBasis === 'gross' ? 'gross' : 'basic',
    probationMonths: row.probationMonths,
    accruesDuringProbation: row.accruesDuringProbation,
    unpaidLeaveDaysExcluded: row.unpaidLeaveDaysExcluded,
  }
}

/**
 * Where an accrual for `accruedTo` may be dated.
 *
 * The month end itself when nothing locks it. Otherwise the first month end after the lock that is not
 * itself locked — walked forward rather than computed, because consecutive locked periods are ordinary (a
 * quarter is three of them) and a single step would land inside the next lock and be refused.
 */
async function entryDateFor(
  sql: Sql,
  accruedTo: string,
): Promise<{ readonly entryDate: string; readonly lockedPeriodId: string | null }> {
  const lockedPeriodId = await periodLockFor(sql, accruedTo)
  if (lockedPeriodId === null) return { entryDate: accruedTo, lockedPeriodId: null }

  let candidate = monthEnd(monthAfter(localDate(accruedTo)))
  for (let step = 0; step < MAX_LOCKED_MONTHS_AHEAD; step += 1) {
    if ((await periodLockFor(sql, candidate as string)) === null) {
      return { entryDate: candidate as string, lockedPeriodId }
    }
    candidate = monthEnd(monthAfter(candidate))
  }
  throw new AppError(
    'invariant_violated',
    `A gratuity accrual for the month ending ${accruedTo} falls in locked period "${lockedPeriodId}", ` +
      `and every month for ${MAX_LOCKED_MONTHS_AHEAD} months after it is locked too. There is no open ` +
      'period to post into, so the liability cannot be recorded at all — which is a period-locking ' +
      'problem and not an accrual one, and unlocking a filed period needs a migration (ADR 0026).',
    { details: { accruedTo, lockedPeriodId } },
  )
}

/**
 * The entry id for one employee-month. Deterministic, because `@berelax/core` allocates no ids.
 *
 * Deterministic and not random, so a pass that crashed between posting the entry and inserting the accrual
 * row cannot post a SECOND entry for the same month on its next run: the primary key on `journal_entry`
 * refuses it. The whitespace is stripped because `staff_reference` is "Therapist 07" and an id is read out
 * of a log by a person.
 */
function accrualEntryId(staffReference: string, accrualMonth: string): EntryId {
  return `GRA-${staffReference.replace(/\s+/g, '')}-${accrualMonth}` as EntryId
}

/**
 * Maps a core `EntryDraft` onto the structural mirror `@berelax/db` takes.
 *
 * Field for field, exactly as `journal.ts`'s own docstring describes: `packages/db` may never import
 * `packages/core` (brief rule 4), so `Money` becomes integer fils and `LocalDate` becomes a string here
 * rather than in either package. One mapper and not an inline object at the call site, because the inline
 * version spelled the two account codes a second time — and a posting rule that names an account twice is
 * one edit away from naming two different ones, which is exactly what resolving them from settings was for.
 */
function asJournalEntryInput(draft: EntryDraft): JournalEntryInput {
  return {
    entryId: draft.entryId as string,
    entryDate: draft.entryDate as string,
    narrative: draft.narrative,
    source: draft.source,
    lines: draft.lines.map((line) => ({
      accountCode: line.account as string,
      debitFils: line.side === 'debit' ? line.amount.fils : 0,
      creditFils: line.side === 'credit' ? line.amount.fils : 0,
      ...(line.memo === undefined ? {} : { memo: line.memo }),
    })),
  }
}

/**
 * Splits the roster into who may be accrued and who is refused, with the reason.
 *
 * Refused BEFORE anything else is read about them, so an excluded employee costs no queries and — more to
 * the point — cannot reach the posting loop at all. A guard inside the loop is one edit away from being
 * stepped over; a partition that never puts them in the list cannot be.
 *
 * The provisional check comes FIRST and the order matters. An employee with a provisional employment record
 * AND a wage would otherwise be reported as accruable-but-unpriced when the real problem is the epoch
 * employment date — and the two have different answers: one is "put the wage in", the other is "confirm the
 * HR file", which is Y8-staff.
 */
function partitionAccruable(employees: readonly GratuityEmployeeRow[]): {
  readonly accruable: readonly GratuityEmployeeRow[]
  readonly excluded: readonly GratuityExclusion[]
} {
  const accruable: GratuityEmployeeRow[] = []
  const excluded: GratuityExclusion[] = []
  for (const employee of employees) {
    const reason: GratuityExclusion['reason'] | null = employee.isProvisional
      ? 'provisional_employment_record'
      : employee.wageFils === null
        ? 'unpriced'
        : null
    if (reason === null) {
      accruable.push(employee)
    } else {
      excluded.push({
        employeeId: employee.employeeId,
        staffReference: employee.staffReference,
        reason,
      })
    }
  }
  return { accruable, excluded }
}

/** What one pass has decided to post, accumulated across the roster. */
interface AccrualPlan {
  readonly toWrite: GratuityAccrualInput[]
  readonly rebasedMonths: { accrualMonth: string; entryDate: string }[]
  readonly overAccrued: string[]
}

/**
 * Plans one employee's owing months, oldest first, carrying the running liability forward.
 *
 * The running figure is why this is a loop and not a map: each month's movement is a difference against
 * what the PREVIOUS month left, so a catch-up of six months posts six differences rather than the whole
 * liability in the first one and nothing after it.
 */
async function planEmployee(
  sql: Sql,
  plan: AccrualPlan,
  args: {
    readonly employee: GratuityEmployeeRow
    readonly versions: readonly GratuityRules[]
    readonly throughMonth: ReturnType<typeof localDate>
    readonly wageBasis: string
    readonly accounts: GratuityAccounts
    readonly alreadyAccruedFils: number
    readonly accruedMonths: readonly string[]
    readonly unpaidDays: ReadonlyMap<string, number>
  },
): Promise<void> {
  const { employee, versions, throughMonth, accounts } = args
  const employedFrom = localDate(employee.employedFrom)
  const employedUntil = employee.employedUntil === null ? null : localDate(employee.employedUntil)

  const months = accrualMonthsOwing({
    employedFrom,
    employedUntil,
    throughMonth,
    maxMonths: CATCH_UP_MONTHS,
    alreadyAccrued: args.accruedMonths.map((month) => localDate(month)),
  })
  if (months.length === 0) return

  // The whole unpaid history the engine may need, not only the months being accrued: the liability at a
  // month end is CUMULATIVE, so a month excluded earlier still reduces the figure being posted now.
  const unpaidForEmployee = new Map<string, number>()
  for (const [key, days] of args.unpaidDays) {
    const [id, month] = key.split('\u0000')
    if (id === employee.employeeId && month !== undefined) unpaidForEmployee.set(month, days)
  }
  const service = { employedFrom, employedUntil, unpaidLeaveDaysByMonth: unpaidForEmployee }

  let already = args.alreadyAccruedFils
  for (const month of months) {
    const accrual = accrueGratuityMonth({
      rules: gratuityRulesFor(versions, monthEnd(month)),
      service,
      accrualMonth: month,
      wageFils: employee.wageFils as number,
      alreadyAccruedFils: already,
    })
    if (accrual.overAccrued) {
      // Not posted. A negative movement means the books hold more than is owed, which the journal answers
      // with a dated reversal and a replacement (ADR 0017) and never with a line whose sign carries its
      // direction. It needs somebody to decide which figure was wrong, so the pass names the employee and
      // stops accruing them rather than guessing — and stops rather than skipping, because every later
      // month would be a difference against a figure already known to be wrong.
      if (!plan.overAccrued.includes(employee.staffReference)) {
        plan.overAccrued.push(employee.staffReference)
      }
      return
    }
    if (accrual.movementFils === 0) continue

    const { entryDate, lockedPeriodId } = await entryDateFor(sql, accrual.accruedTo as string)
    if (lockedPeriodId !== null) {
      plan.rebasedMonths.push({ accrualMonth: accrual.accrualMonth as string, entryDate })
    }
    const contribution = accrual.liability.contributions.at(-1)
    plan.toWrite.push({
      employeeId: employee.employeeId,
      staffReference: employee.staffReference,
      accrualMonth: accrual.accrualMonth as string,
      accruedTo: accrual.accruedTo as string,
      wageFils: employee.wageFils as number,
      wageBasis: args.wageBasis,
      employedDays: contribution?.employedDays ?? 0,
      unpaidLeaveDays: contribution?.excludedDays ?? 0,
      cumulativeFils: accrual.cumulativeFils,
      accruedFils: accrual.movementFils,
      ruleEffectiveFrom: accrual.liability.ruleEffectiveFrom as string,
      lockedPeriodId,
      correctsAccrualId: null,
      createdBy: CREATED_BY,
      entry: asJournalEntryInput(
        gratuityAccrualEntry({
          entryId: accrualEntryId(employee.staffReference, accrual.accrualMonth as string),
          entryDate: localDate(entryDate),
          accounts,
          amountFils: accrual.movementFils,
          accrualMonth: accrual.accrualMonth,
          staffReference: employee.staffReference,
          lockedPeriodId,
        }),
      ),
    })
    already = accrual.cumulativeFils
  }
}

/**
 * One pass, for the business day containing `atIso`.
 *
 * Reads once, outside every loop: the policy versions, the employees, the accruals already written, the
 * liabilities and the unpaid days. A read per employee would make the cost of a quiet month grow with the
 * size of the roster rather than with the number of months owing — and a policy re-read per employee could
 * judge the first half of the roster against one version and the second half against another, with nothing
 * in the row saying which.
 */
export async function runGratuityAccrual(
  sql: Sql,
  atIso: string,
  options: { readonly employeeIds?: readonly string[] } = {},
): Promise<GratuityAccrualResult> {
  const day = await businessDayAt(sql, atIso)
  if (day === null) {
    throw new AppError(
      'invariant_violated',
      `The gratuity accrual pass ran at ${atIso} and business_day holds no trading session at or before ` +
        'it, so which month has completed is unknown. Generate the trading calendar ' +
        '(generateBusinessDays) first: deciding it from the instant’s own calendar date would accrue the ' +
        'wrong month for every pass between midnight and 02:00, which is when a 1st-of-the-month cron runs.',
    )
  }

  const versions = (await readGratuityRules(sql)).map(asRules)
  if (versions.length === 0) {
    throw new AppError(
      'invariant_violated',
      'No gratuity_rule version exists, so there is no policy to accrue against. 0107 seeds version 1; ' +
        'an empty table means the migration has not been applied to this database.',
    )
  }
  const throughMonth = latestCompletedAccrualMonth({
    tradingDate: localDate(day.tradingDate),
    sessionIsOpen: day.isOpen,
  })
  const earliestMonth = accrualCatchUpFloor(throughMonth, CATCH_UP_MONTHS)

  // The basis is a property of the version governing the LATEST month the pass will accrue. A basis that
  // differed between versions inside one catch-up window would need a read per month; the column is
  // constrained to two values and no version in this build changes it, so this reads the governing one and
  // the wage is re-read per employee rather than per month.
  const latestRules = gratuityRulesFor(versions, monthEnd(throughMonth))

  // Branded through `accountCode`, which refuses anything that is not four digits. The settings schema
  // already enforces that shape, so this is the second statement of it and deliberately so: a value that
  // reached `app_setting` before the schema existed, or through a restore, would otherwise be posted and
  // refused by the foreign key on `journal_line.account_code` — at which point the failure names a
  // constraint rather than the setting somebody has to go and fix.
  const accounts: GratuityAccounts = {
    expense: accountCode(await readSetting<string>(sql, GRATUITY_EXPENSE_ACCOUNT_SETTING_KEY)),
    liability: accountCode(await readSetting<string>(sql, GRATUITY_LIABILITY_ACCOUNT_SETTING_KEY)),
  }

  const employees = await readGratuityEmployees(sql, {
    engagedOnOrBefore: monthEnd(throughMonth) as string,
    wageBasis: latestRules.wageBasis,
    ...(options.employeeIds === undefined ? {} : { employeeIds: options.employeeIds }),
  })
  const empty: GratuityAccrualResult = {
    tradingDate: day.tradingDate,
    withinTradingHours: day.isOpen,
    throughMonth: throughMonth as string,
    considered: employees.length,
    written: [],
    accruedFils: 0,
    excluded: [],
    rebasedMonths: [],
    overAccrued: [],
    policyVersions: versions.length,
  }
  if (employees.length === 0) return empty

  const { accruable, excluded } = partitionAccruable(employees)
  if (accruable.length === 0) return { ...empty, excluded }

  const employeeIds = accruable.map((employee) => employee.employeeId)

  const originalsByEmployee = new Map<string, string[]>()
  for (const row of await readGratuityAccruals(sql, {
    employeeIds,
    fromMonth: earliestMonth as string,
    toMonth: monthEnd(throughMonth) as string,
  })) {
    if (row.correctsAccrualId !== null) continue
    const held = originalsByEmployee.get(row.employeeId) ?? []
    held.push(row.accrualMonth)
    originalsByEmployee.set(row.employeeId, held)
  }

  // The LIVE liability, from the view that excludes superseded rows. This is what the month's movement is a
  // difference against, and reading it from the view rather than summing the rows above is deliberate: the
  // view is what ZY175 holds a settlement to, and two expressions of one sum is one opportunity to
  // disagree about somebody's entitlement.
  const liabilityByEmployee = new Map<string, number>()
  for (const row of await readGratuityLiabilities(sql, employeeIds)) {
    liabilityByEmployee.set(row.employeeId, row.accruedFils)
  }

  const unpaidDays = new Map<string, number>()
  for (const row of await readUnpaidLeaveDaysByMonth(sql, {
    employeeIds,
    fromMonth: earliestMonth as string,
    toMonth: monthEnd(throughMonth) as string,
  })) {
    unpaidDays.set(`${row.employeeId}\u0000${row.accrualMonth}`, row.unpaidDays)
  }

  const plan: AccrualPlan = { toWrite: [], rebasedMonths: [], overAccrued: [] }
  for (const employee of accruable) {
    await planEmployee(sql, plan, {
      employee,
      versions,
      throughMonth,
      wageBasis: latestRules.wageBasis,
      accounts,
      alreadyAccruedFils: liabilityByEmployee.get(employee.employeeId) ?? 0,
      accruedMonths: originalsByEmployee.get(employee.employeeId) ?? [],
      unpaidDays,
    })
  }
  const { toWrite, rebasedMonths, overAccrued } = plan

  // One transaction for the postings, the audit rows and the events. Any two of the three committing
  // without the third is the bug `UnitOfWork` exists to make impossible: a liability with no audit row is a
  // balance-sheet change nobody can account for.
  return withUnitOfWork(sql, ACTOR, async (uow) => {
    const written: WrittenGratuityAccrual[] = []
    let accruedFils = 0
    for (const input of toWrite) {
      const row = await postGratuityAccrual(uow, input)
      if (row === null) continue
      written.push(row)
      accruedFils += row.accruedFils
      await uow.audit.record({
        action: 'gratuity.accrued',
        entityType: 'employee',
        entityId: row.employeeId,
        operation: 'create',
        // No `before`: the liability is the sum of the accrual rows and has no prior value of its own to
        // record. The accrual IS the change, which is the claim this ledger makes about itself.
        after: {
          accrualId: row.accrualId,
          accrualMonth: row.accrualMonth,
          accruedFils: row.accruedFils,
          entryId: row.entryId,
          entryDate: row.entryDate,
        },
      })
      await uow.publish({
        eventType: GRATUITY_ACCRUED_EVENT,
        aggregateType: 'employee',
        aggregateId: row.employeeId,
        payload: {
          accrualMonth: row.accrualMonth,
          accruedFils: row.accruedFils,
          entryId: row.entryId,
        },
        // Keyed on the employee and the accrual MONTH rather than on the pass, so a transaction retried
        // after the row committed enqueues nothing and a genuine later month can still notify.
        idempotencyKey: `${GRATUITY_ACCRUED_EVENT}:${row.employeeId}:${row.accrualMonth}`,
      })
    }
    return {
      tradingDate: day.tradingDate,
      withinTradingHours: day.isOpen,
      throughMonth: throughMonth as string,
      considered: employees.length,
      written,
      accruedFils,
      excluded,
      rebasedMonths,
      overAccrued,
      policyVersions: versions.length,
    }
  })
}
