import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The source-level half of *"the interpreter contains no window logic of its own"* (C-AUTO-07).
 *
 * `packages/messaging/src/gate/window.ts` states the failure in as many words: *"two implementations of
 * quiet hours ... is the failure C-AUTO-07's acceptance line is written against"*. A behavioural test proves
 * the rule for the cases it drives — `packages/fixtures/src/flow-interpreter.itest.ts` drives the hold
 * outside the window and the release at the next opening — and this proves it for every case, including the
 * one nobody wrote a test for.
 *
 * ## The needles are NAMED, and the list is the whole check
 *
 * ADR 0002: a check that examined nothing passes. So this file does four things and each is load-bearing:
 *
 *   1. it names every identifier that would betray a second implementation of quiet hours, so a reader can
 *      see WHAT is forbidden rather than being told "no window logic";
 *   2. it scans CODE and not prose. Comments are blanked first, for the reason
 *      `scripts/check-schema-conventions.mjs` blanks them: this file's own documentation names
 *      `nextPromotionalWindowOpen` in the sentence explaining why it may not be called, and a scan that
 *      read comments would fire on the explanation of itself. `stripComments` is asserted to work below,
 *      because a stripper that blanked everything would make the scan pass over anything at all;
 *   3. it asserts the corpus is big enough for an empty result to mean something — a file renamed out of
 *      the set fails here rather than reporting that all is well;
 *   4. it asserts the needles DO match where the window legitimately lives, which is the control against a
 *      list gone stale after a rename.
 *
 * ## What the interpreter IS allowed to do with an instant
 *
 * `addMinutes`. A delay node adds its minutes to the instant the run last resumed, and that is the whole of
 * the interpreter's arithmetic over time — deliberately not in the list, because a delay is a duration and a
 * window is a wall-clock rule, and confusing the two would make the ban forbid the feature. Whether the
 * instant a delay lands on is inside the promotional window is answered later, by the gate, through the send
 * choke point; the release instant the gate names is carried out of the interpreter untouched.
 */

/** Every file that decides anything about a flow run. The scan is over exactly these. */
const INTERPRETER_SOURCES = [
  'apps/worker/src/automation/interpreter.ts',
  'apps/worker/src/automation/runtime.ts',
  'apps/worker/src/automation/reads.ts',
  'apps/worker/src/automation/nodes/effect.ts',
  'apps/worker/src/automation/nodes/message.ts',
  'apps/worker/src/automation/nodes/tag.ts',
  'apps/worker/src/automation/nodes/stage.ts',
  'packages/core/src/automation/step-plan.ts',
] as const

/**
 * The identifiers that would BE a second implementation of quiet hours, each with what it is.
 *
 * Named individually rather than as one regular expression, so a failure says which one appeared and a
 * reader of this list learns what the rule is about.
 */
const WINDOW_LOGIC = [
  { needle: 'withinPromotionalWindow', why: 'the gate’s own "is it open now" predicate' },
  { needle: 'withinPromotionalHours', why: "core's predicate behind it" },
  { needle: 'nextPromotionalWindowOpen', why: 'the release instant, which the gate computes' },
  { needle: 'nextPromotionalOpen', why: "core's function behind it" },
  { needle: 'decidePromotionalWindow', why: 'the whole window decision' },
  { needle: 'decideSendWindow', why: "the gate's adaptor onto it" },
  { needle: 'effectivePromotionalHours', why: 'the Ramadan narrowing' },
  { needle: 'asPromotionalWindow', why: 'reading a window out of the settings registry' },
  { needle: 'PromotionalWindow', why: 'the window type, which only a decider needs' },
  { needle: 'startHour', why: 'an hour bound read by hand' },
  { needle: 'endHour', why: 'an hour bound read by hand' },
  {
    needle: 'promotional_window',
    why: "the setting key, read outside the gate's own registry read",
  },
  { needle: 'MAX_QUEUED_PROMOTIONAL_STALENESS_SECONDS', why: 'the staleness ceiling' },
  { needle: 'RAMADAN_PROMOTIONAL_HOURS', why: 'the provisional Ramadan hours' },
] as const

/** Where the window legitimately lives. The control reads these. */
const WINDOW_OWNERS = [
  'packages/messaging/src/gate/window.ts',
  'packages/core/src/messaging/promotional-window.ts',
] as const

/**
 * The one identifier one interpreter file is allowed to name, and why.
 *
 * `runtime.ts` passes `promotionalWindow: TDRA_PROMOTIONAL_WINDOW` into the `SendContext` it builds, which is
 * how the gate is GIVEN the ceiling — every `SendContext` in this repository does it, and a runtime that did
 * not would be one whose gate had no window at all. Handing a value to the decider is the opposite of
 * deciding. The exemption is narrow in two directions: only that file, only that name, and the last case in
 * this file asserts the name appears there exactly twice (the import and the hand-off) so a runtime that
 * started reading hours off the value fails on `startHour`, which is NOT exempt anywhere.
 */
const CEILING_HANDOFF = {
  file: 'apps/worker/src/automation/runtime.ts',
  needle: 'TDRA_PROMOTIONAL_WINDOW',
}

const read = (path: string): string => readFileSync(path, 'utf8')

/**
 * Line and block comments blanked, everything else kept byte for byte.
 *
 * Deliberately naive — it does not understand a `//` inside a string literal — and that is safe in the
 * direction that matters: a string containing `//` would have its tail blanked, which can only make the scan
 * miss a needle in a STRING, and a window rule implemented inside a string literal is not a thing. The
 * alternative, scanning prose, makes this file fire on its own documentation.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//')
      return at === -1 ? line : line.slice(0, at)
    })
    .join('\n')
}

describe('the interpreter contains no window logic of its own', () => {
  it('scans a corpus big enough for an empty result to mean something', () => {
    expect(INTERPRETER_SOURCES.length).toBeGreaterThanOrEqual(8)
    const code = INTERPRETER_SOURCES.map(read).map(stripComments).join('\n')
    // Floors well under the real figures and far above zero. A file renamed out of the list, or a stripper
    // that blanked everything, fails here rather than reporting that nothing was found.
    expect(
      code.length,
      'the interpreter sources survive comment-stripping as real code',
    ).toBeGreaterThan(9_000)
    expect(WINDOW_LOGIC.length).toBeGreaterThanOrEqual(12)
  })

  it('the stripper keeps code and removes prose, so the scan is about one and not the other', () => {
    const sample = [
      '// nextPromotionalWindowOpen in a line comment',
      '/* withinPromotionalWindow in a block comment */',
      'const kept = decideSendWindow',
    ].join('\n')
    const stripped = stripComments(sample)
    expect(stripped).not.toContain('nextPromotionalWindowOpen')
    expect(stripped).not.toContain('withinPromotionalWindow')
    // And the control on the control: it did NOT blank the code, which a stripper that returned '' would.
    expect(stripped).toContain('decideSendWindow')
  })

  it('names no window identifier in any interpreter source', () => {
    const found: string[] = []
    for (const path of INTERPRETER_SOURCES) {
      const code = stripComments(read(path))
      for (const rule of WINDOW_LOGIC) {
        if (path === CEILING_HANDOFF.file && rule.needle === CEILING_HANDOFF.needle) continue
        if (code.includes(rule.needle)) found.push(`${path}: ${rule.needle} (${rule.why})`)
      }
    }
    expect(
      found,
      'the interpreter may not decide anything about the promotional window. The gate owns that rule ' +
        '(packages/messaging/src/gate/window.ts), and two implementations of quiet hours is the failure ' +
        "C-AUTO-07's acceptance line is written against. Ask the gate through sendMessage and carry its " +
        'release instant out untouched.',
    ).toEqual([])
  })

  it('the control: every needle still matches where the window DOES live', () => {
    // Without this the case above passes for a needle list gone stale against a rename — and a stale list
    // is a check that examines nothing, which is worse than no check at all (ADR 0002).
    const owners = WINDOW_OWNERS.map(read).map(stripComments).join('\n')
    const missing = WINDOW_LOGIC.filter((rule) => !owners.includes(rule.needle)).map(
      (rule) => rule.needle,
    )
    expect(
      missing,
      'these identifiers no longer appear in the modules that own the promotional window, so scanning ' +
        'the interpreter for them proves nothing. Update the needle list to the current names.',
    ).toEqual([])
  })

  it('the control: the scan DOES fire when window logic is present', () => {
    // The mutant, in memory: the interpreter's own code with one window call spliced in. Without this the
    // scan could be reading the wrong files, or stripping the code it is supposed to search.
    const mutant = `${stripComments(read(INTERPRETER_SOURCES[0]))}\nconst open = withinPromotionalWindow(a, b)\n`
    const hits = WINDOW_LOGIC.filter((rule) => mutant.includes(rule.needle)).map(
      (rule) => rule.needle,
    )
    expect(hits).toContain('withinPromotionalWindow')
    // And one spliced into the RUNTIME is caught too, although that file holds the one exemption: the
    // exemption is a name, not a licence to decide.
    const runtimeMutant = `${stripComments(read(CEILING_HANDOFF.file))}\nif (w.startHour > 7) return\n`
    expect(
      WINDOW_LOGIC.filter((rule) => rule.needle !== CEILING_HANDOFF.needle)
        .filter((rule) => runtimeMutant.includes(rule.needle))
        .map((rule) => rule.needle),
    ).toContain('startHour')
  })

  it('the exemption is the hand-off and nothing more', () => {
    const code = stripComments(read(CEILING_HANDOFF.file))
    // Present, because a stale exemption hides a real use — and exactly twice, which is the import and the
    // one assignment. A third occurrence is the runtime having started to do something with the value.
    expect(code).toContain('promotionalWindow: TDRA_PROMOTIONAL_WINDOW,')
    expect(
      code.split(CEILING_HANDOFF.needle).length - 1,
      'the ceiling is named twice in this file: the import and the hand-off, and nowhere else',
    ).toBe(2)
  })
})
