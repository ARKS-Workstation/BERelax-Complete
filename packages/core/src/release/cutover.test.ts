import { describe, expect, it } from 'vitest'
import {
  CUTOVER_MEASURED_ON,
  CUTOVER_RULES,
  CUTOVER_STEPS,
  type CutoverRun,
  type CutoverStepRecord,
  canonicalCutoverRun,
  cutoverRunProblems,
  renderCutoverRun,
} from './cutover.ts'

/**
 * The cutover sequence's judgement, and the dry run's one claim: nothing changed.
 *
 * Each refusal is paired with the clean record it is a refusal against, because every one of them is a
 * walk over a list and a walk over an empty list objects to nothing (ADR 0002). The two that matter
 * most are the floor — a run that checksummed no table at all reports exactly what a clean run reports
 * — and the window, which is two statements of one fact and is held equal here.
 */

/** Every read-only step performed, every writing step skipped. What a clean dry run looks like. */
function dryRunSteps(): CutoverStepRecord[] {
  return CUTOVER_STEPS.map((step) =>
    step.writes
      ? {
          id: step.id,
          performed: false,
          durationMs: null,
          skippedReason: 'writes, and this is a dry run',
          exitCode: null,
        }
      : { id: step.id, performed: true, durationMs: 12, skippedReason: null, exitCode: 0 },
  )
}

const START = '2097-04-18T06:00:00.000Z'
const FINISH = '2097-04-18T06:00:30.000Z'

function dryRun(over: Partial<CutoverRun> = {}): CutoverRun {
  const run: CutoverRun = {
    runVersion: 1,
    mode: 'dry_run',
    startedAtIso: START,
    finishedAtIso: FINISH,
    measuredOverMs: 30_000,
    coversEveryStep: false,
    measuredOn: 'agent_container',
    steps: dryRunSteps(),
    tableChecksums: [
      { table: 'public.appointment', before: 'abc', after: 'abc' },
      { table: 'public.invoice', before: 'def', after: 'def' },
    ],
    digest: '',
    ...over,
  }
  return run
}

const rules = (run: CutoverRun): readonly string[] =>
  cutoverRunProblems(run).map((problem) => problem.rule)

describe('the sequence', () => {
  it('declares every step with an agent, a reason and whether it writes', () => {
    expect(CUTOVER_STEPS.length).toBeGreaterThan(5)
    for (const step of CUTOVER_STEPS) {
      expect(step.why.length, step.id).toBeGreaterThan(60)
      expect(['script', 'operator'], step.id).toContain(step.agent)
      expect(typeof step.writes, step.id).toBe('boolean')
    }
  })

  it('gives every script step a command and every operator step none, so the split is readable', () => {
    // An operator step with a command in this list would read as a step the script takes. The five
    // that are an operator's are the five nothing here can do: stop and start a process, choose where
    // the only copy of this business goes, take a decision, and open the doors.
    for (const step of CUTOVER_STEPS) {
      if (step.agent === 'operator') expect(step.commands, step.id).toHaveLength(0)
      else expect(step.commands.length, step.id).toBeGreaterThan(0)
    }
    expect(CUTOVER_STEPS.filter((step) => step.agent === 'operator')).toHaveLength(5)
  })

  it('begins with the two preflight reads and ends with the business reading this system', () => {
    expect(CUTOVER_STEPS[0]?.id).toBe('preflight-go-no-go')
    expect(CUTOVER_STEPS[1]?.id).toBe('preflight-freeze')
    expect(CUTOVER_STEPS.at(-1)?.id).toBe('open-for-business')
    expect(CUTOVER_STEPS.at(-1)?.agent).toBe('operator')
  })
})

describe('a dry run', () => {
  it('passes when every read-only step ran, every writing step was skipped and no table moved', () => {
    expect(rules(dryRun())).toEqual([])
  })

  it('refuses a table whose checksum moved, naming the table', () => {
    const problems = cutoverRunProblems(
      dryRun({
        tableChecksums: [
          { table: 'public.appointment', before: 'abc', after: 'abc' },
          { table: 'public.invoice', before: 'def', after: 'ghi' },
        ],
      }),
    )
    expect(problems.map((problem) => problem.rule)).toEqual([CUTOVER_RULES.tableChanged])
    expect(problems[0]?.detail).toContain('public.invoice')
    expect(problems[0]?.detail).not.toContain('public.appointment')
  })

  it('refuses a run that checksummed nothing — the floor', () => {
    const problems = cutoverRunProblems(dryRun({ tableChecksums: [] }))
    expect(problems.map((problem) => problem.rule)).toContain(CUTOVER_RULES.examinedNothing)
  })

  it('refuses a sequence that declares no step, which would make every walk vacuous', () => {
    expect(cutoverRunProblems(dryRun(), []).map((problem) => problem.rule)).toContain(
      CUTOVER_RULES.examinedNothing,
    )
  })

  it('refuses a writing step that was performed', () => {
    const steps = dryRunSteps().map((record) =>
      record.id === 'final-import'
        ? { ...record, performed: true, durationMs: 900, skippedReason: null, exitCode: 0 }
        : record,
    )
    const problems = cutoverRunProblems(dryRun({ steps }))
    expect(problems.map((problem) => problem.rule)).toEqual([CUTOVER_RULES.writingStepPerformed])
    expect(problems[0]?.detail).toContain('final-import')
  })

  it('refuses a declared step that is not recorded at all', () => {
    const steps = dryRunSteps().filter((record) => record.id !== 'preflight-freeze')
    const problems = cutoverRunProblems(dryRun({ steps }))
    expect(problems.map((problem) => problem.rule)).toEqual([CUTOVER_RULES.stepNotRecorded])
    expect(problems[0]?.detail).toContain('preflight-freeze')
  })

  it('refuses a recorded step the sequence does not declare', () => {
    const steps = [
      ...dryRunSteps(),
      {
        id: 'quietly-added',
        performed: true,
        durationMs: 1,
        skippedReason: null,
        exitCode: 0,
      },
    ]
    expect(rules(dryRun({ steps }))).toEqual([CUTOVER_RULES.stepNotDeclared])
  })

  it('refuses a step that was skipped with no reason, and one that carries a duration anyway', () => {
    const noReason = dryRunSteps().map((record) =>
      record.id === 'final-import' ? { ...record, skippedReason: '  ' } : record,
    )
    expect(rules(dryRun({ steps: noReason }))).toEqual([CUTOVER_RULES.malformed])
    const ghostDuration = dryRunSteps().map((record) =>
      record.id === 'final-import' ? { ...record, durationMs: 4000 } : record,
    )
    expect(rules(dryRun({ steps: ghostDuration }))).toEqual([CUTOVER_RULES.malformed])
  })

  it('refuses a performed step with no duration, because the window is then a sum with a hole', () => {
    const steps = dryRunSteps().map((record) =>
      record.id === 'preflight-go-no-go' ? { ...record, durationMs: null } : record,
    )
    expect(rules(dryRun({ steps }))).toEqual([CUTOVER_RULES.malformed])
  })

  it('refuses a step that exited non-zero, naming the step and its label', () => {
    const steps = dryRunSteps().map((record) =>
      record.id === 'preflight-go-no-go' ? { ...record, exitCode: 1 } : record,
    )
    const problems = cutoverRunProblems(dryRun({ steps }))
    expect(problems.map((problem) => problem.rule)).toEqual([CUTOVER_RULES.stepFailed])
    expect(problems[0]?.detail).toContain('The go/no-go check passes')
  })
})

describe('the measured window', () => {
  it('refuses a window that is not one', () => {
    expect(rules(dryRun({ finishedAtIso: '2097-04-18T05:00:00.000Z' }))).toContain(
      CUTOVER_RULES.windowNotRecorded,
    )
    expect(rules(dryRun({ startedAtIso: 'whenever' }))).toContain(CUTOVER_RULES.windowNotRecorded)
  })

  it('holds the recorded duration equal to the two instants it lies between', () => {
    const problems = cutoverRunProblems(dryRun({ measuredOverMs: 90 }))
    expect(problems.map((problem) => problem.rule)).toEqual([CUTOVER_RULES.windowNotRecorded])
    expect(problems[0]?.detail).toContain('30000 ms apart')
  })

  it('derives coversEveryStep rather than trusting it', () => {
    // The field that stops a dry run's floor being quoted as the cutover's duration. A record claiming
    // it covers every step while half of them were skipped is the edit nobody would notice.
    const problems = cutoverRunProblems(dryRun({ coversEveryStep: true }))
    expect(problems.map((problem) => problem.rule)).toEqual([CUTOVER_RULES.malformed])
    const everyStep = CUTOVER_STEPS.map((step) => ({
      id: step.id,
      performed: true,
      durationMs: 5,
      skippedReason: null,
      exitCode: 0,
    }))
    expect(
      cutoverRunProblems(dryRun({ mode: 'execute', steps: everyStep, coversEveryStep: true })),
    ).toEqual([])
  })
})

describe('where it was measured', () => {
  it('records it, and refuses a value outside the closed set rather than defaulting one', () => {
    expect(CUTOVER_MEASURED_ON).toContain('agent_container')
    expect(rules(dryRun())).toEqual([])
    const problems = cutoverRunProblems(
      dryRun({ measuredOn: 'somewhere' as unknown as 'agent_container' }),
    )
    expect(problems.map((problem) => problem.rule)).toEqual([CUTOVER_RULES.malformed])
    expect(problems[0]?.detail).toContain('ADR 0126')
  })

  it('says on the face of the rendering when the window is a container\u2019s figure', () => {
    expect(renderCutoverRun(dryRun())).toContain('measured on a shared agent container')
    expect(renderCutoverRun(dryRun({ measuredOn: 'chosen_machine' }))).not.toContain(
      'measured on a shared agent container',
    )
  })
})

describe('the digest', () => {
  it('ignores the digest field and key order, so a re-serialised record digests the same', () => {
    const run = dryRun({ digest: 'whatever' })
    // Re-serialised with the keys in a different order and a different digest value, which is what a
    // record written by another code path looks like.
    const reordered = JSON.parse(
      JSON.stringify(
        Object.fromEntries([
          ['digest', 'other'],
          ...Object.entries(run).filter(([key]) => key !== 'digest'),
        ]),
      ),
    ) as CutoverRun
    expect(canonicalCutoverRun(reordered)).toBe(canonicalCutoverRun(run))
  })

  it('changes when a figure changes, which is what makes a hand edit detectable', () => {
    expect(canonicalCutoverRun(dryRun({ measuredOverMs: 31_000 }))).not.toBe(
      canonicalCutoverRun(dryRun()),
    )
  })
})

describe('the rendering', () => {
  it('prints the window with what it is a window over, and says a dry run is a floor', () => {
    const rendered = renderCutoverRun(dryRun())
    expect(rendered).toContain('CUTOVER — dry_run')
    expect(rendered).toContain('declared step(s)')
    expect(rendered).toContain('this is a FLOOR and not an estimate of the real cutover')
    expect(rendered).toContain('tables checksummed: 2')
    expect(rendered).toContain('VERDICT: clean')
  })

  it('omits the floor warning when every step ran, which is the only time it should', () => {
    const everyStep = CUTOVER_STEPS.map((step) => ({
      id: step.id,
      performed: true,
      durationMs: 5,
      skippedReason: null,
      exitCode: 0,
    }))
    const rendered = renderCutoverRun(
      dryRun({ mode: 'execute', steps: everyStep, coversEveryStep: true }),
    )
    expect(rendered).not.toContain('this is a FLOOR')
  })

  it('prints every problem with its rule name, and a row for a step that was never recorded', () => {
    const steps = dryRunSteps().filter((record) => record.id !== 'preflight-freeze')
    const rendered = renderCutoverRun(dryRun({ steps }))
    expect(rendered).toContain('NOT RECORDED  preflight-freeze')
    expect(rendered).toContain(`[${CUTOVER_RULES.stepNotRecorded}]`)
  })
})
