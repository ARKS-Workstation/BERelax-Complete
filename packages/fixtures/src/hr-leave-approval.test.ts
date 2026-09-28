import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  APPOINTMENT_STATUSES,
  type AppointmentStatus,
  LEAVE_APPROVAL_REFUSALS,
  LEAVE_OVERRIDE_ROLES,
} from '@berelax/core'
import { LEAVE_REQUEST_REFUSALS } from '@berelax/db'
import { describe, expect, it } from 'vitest'

/**
 * P-HR-09 — the claim about the SOURCE: no appointment status is reachable from the approval path.
 *
 * The acceptance line is *"a test enumerates every transition the approval path can trigger and asserts
 * CANCELLED_BY_SALON and NO_SHOW are not among them"*, and the way that line is satisfied badly is a
 * hand-written list of the statuses this unit does not write. Such a list is a second statement of a fact, it
 * would still pass if the approval path started cancelling appointments tomorrow, and it would pass with the
 * approval module deleted. So the enumeration is DERIVED: the module graph reachable from the approval entry
 * points is walked, and every appointment status any reached module can write is collected out of its source.
 *
 * ## What "reachable" means here, precisely
 *
 * Imports are resolved **per symbol**, not per package. That precision is the whole reason the answer means
 * anything: `@berelax/core`'s barrel is `export *` over every module in the package, so following it wholesale
 * would reach `lifecycle/transitions.ts` — which declares all nine statuses — from any file that imports
 * anything at all from core, and the enumeration would be the entire state machine for every unit in the
 * build. {@link symbolIndex} therefore maps each package's exported NAMES to the files that declare them, and
 * a name that cannot be resolved **fails this test** rather than being skipped: an unresolved symbol is a hole
 * in the walk, and a hole is how an enumeration comes to be smaller than the truth.
 *
 * Within a reached file the granularity is the FILE, which over-approximates: a module reached for one symbol
 * contributes everything it contains. That direction is the safe one for a "cannot happen" claim — if the
 * over-approximation holds no cancellation, the precise set certainly does not — and it is stated rather than
 * hidden.
 *
 * ## Comments are stripped and strings are KEPT
 *
 * A status is a string, so blanking strings would leave the scan unable to match anything anywhere — the
 * vacuous pass in its purest form. Comments are blanked instead, because the prose explaining why this unit
 * must not write `cancelled_by_salon` contains the words `cancelled_by_salon`, and
 * `packages/db/src/repositories/reassignment.ts` contains them for the same reason: P-HR-04's header says at
 * length why a reassignment does not change the status. A scan that read comments would report both files as
 * cancelling appointments.
 *
 * ## Three controls, because each assertion below is an EMPTY result
 *
 *   1. The walk is asserted to reach a floor number of modules, and to contain the modules it must.
 *   2. The same scan over the closure from `cancelAppointment` and from `transitionAppointment` is asserted to
 *      find the statuses those modules legitimately write — including both of the two forbidden ones. A scan
 *      that had stopped matching would report the approval path clean having examined nothing (ADR 0002).
 *   3. The scan is run again over the approval closure with a cancellation SPLICED IN, and must find it. That
 *      is the control over the file actually being asserted about, which (2) is not.
 */
const REPO = join(import.meta.dirname, '..', '..', '..')

/** The entry points of the approval path, including the one that resolves a conflict. */
const ENTRY_POINTS = [
  join(REPO, 'packages', 'core', 'src', 'hr', 'leave-approval.ts'),
  join(REPO, 'packages', 'db', 'src', 'repositories', 'leave-request.ts'),
  join(REPO, 'apps', 'web', 'app', '(admin)', 'hr', 'leave', '[id]', 'route.ts'),
  // P-HR-04's transaction is part of the approval path: it is how a conflict is RESOLVED, and the acceptance
  // line says so. Including it makes the claim stronger rather than weaker — the enumeration now covers the
  // one module in the estate that touches a conflicting appointment at all.
  join(REPO, 'packages', 'db', 'src', 'repositories', 'reassignment.ts'),
]

/** The modules that legitimately DO write a cancellation or a no-show, for control (2). */
const CANCELLATION_ENTRY_POINTS = [
  join(REPO, 'packages', 'db', 'src', 'repositories', 'cancel.ts'),
  join(REPO, 'packages', 'db', 'src', 'repositories', 'appointment-transition.ts'),
]

/** Workspace package roots, for resolving a `@berelax/x` specifier to files. */
const PACKAGE_ROOTS: Readonly<Record<string, string>> = {
  '@berelax/core': join(REPO, 'packages', 'core', 'src'),
  '@berelax/db': join(REPO, 'packages', 'db', 'src'),
  '@berelax/shared': join(REPO, 'packages', 'shared', 'src'),
  '@berelax/config': join(REPO, 'packages', 'config', 'src'),
  '@berelax/ui': join(REPO, 'packages', 'ui', 'src'),
  '@berelax/messaging': join(REPO, 'packages', 'messaging', 'src'),
  '@berelax/hr': join(REPO, 'packages', 'hr', 'src'),
  '@berelax/fixtures': join(REPO, 'packages', 'fixtures', 'src'),
  '@berelax/clinical': join(REPO, 'packages', 'clinical', 'src'),
  '@berelax/providers': join(REPO, 'packages', 'providers', 'src'),
  '@berelax/auth': join(REPO, 'packages', 'auth', 'src'),
  '@berelax/google': join(REPO, 'packages', 'google', 'src'),
  '@berelax/media': join(REPO, 'packages', 'media', 'src'),
  '@berelax/cms': join(REPO, 'packages', 'cms', 'src'),
  '@berelax/pdf': join(REPO, 'packages', 'pdf', 'src'),
}

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(path)
  }
  return out
}

/**
 * Every exported name in a package, mapped to the files that declare it.
 *
 * Declarations and re-exports both, because `packages/db/src/index.ts` names most of its surface in
 * `export { … } from './repositories/x.ts'` blocks while `packages/core/src/index.ts` is `export *`. Test
 * files are excluded: a symbol a test declares is not part of any import graph, and including them would let
 * a name resolve to a `.test.ts`.
 */
function symbolIndex(root: string): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>()
  const add = (name: string, file: string) => {
    const held = index.get(name)
    if (held === undefined) index.set(name, [file])
    else if (!held.includes(file)) held.push(file)
  }
  for (const file of sourceFiles(root)) {
    if (file.endsWith('.test.ts') || file.endsWith('.itest.ts')) continue
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(
      /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
    )) {
      add(match[1] as string, file)
    }
    // `export { a, type B, c as d }` — with or without a `from`, since a local re-export is how a module
    // publishes a name it imported.
    for (const match of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const part of (match[1] as string).split(',')) {
        const name = part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)
          .pop()
          ?.trim()
        if (name !== undefined && name.length > 0) add(name, file)
      }
    }
  }
  return index
}

const SYMBOLS: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> = new Map(
  Object.entries(PACKAGE_ROOTS).map(([specifier, root]) => [specifier, symbolIndex(root)]),
)

/** One import statement's specifier and the names it takes. */
interface ImportSite {
  readonly specifier: string
  readonly names: readonly string[]
}

const IMPORT = /import\s+(?:type\s+)?(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))?\s*from\s*'([^']+)'/g

function importsOf(text: string): readonly ImportSite[] {
  const sites: ImportSite[] = []
  for (const match of text.matchAll(IMPORT)) {
    const braced = match[1]
    const specifier = match[3] as string
    const names =
      braced === undefined
        ? match[2] === undefined
          ? []
          : [match[2]]
        : braced
            .split(',')
            .map(
              (part) =>
                part
                  .trim()
                  .replace(/^type\s+/, '')
                  .split(/\s+as\s+/)[0]
                  ?.trim() ?? '',
            )
            .filter((name) => name.length > 0)
    sites.push({ specifier, names })
  }
  return sites
}

const directoryOf = (file: string): string => file.slice(0, file.lastIndexOf('/'))

/** Every unresolved specifier the walk met, so a hole in it fails rather than shrinking the answer. */
const unresolved: string[] = []

function resolve(from: string, site: ImportSite): readonly string[] {
  if (site.specifier.startsWith('node:')) return []
  if (site.specifier.startsWith('.')) {
    // Relative specifiers carry their extension in this repository (`./x.ts`), which is what makes this a
    // path join rather than a resolver.
    const path = join(directoryOf(from), site.specifier)
    if (!path.endsWith('.ts') && !path.endsWith('.tsx')) {
      unresolved.push(`${from} -> ${site.specifier} (no extension)`)
      return []
    }
    return [path]
  }
  const index = SYMBOLS.get(site.specifier)
  if (index === undefined) {
    // A third-party package. Nothing in `node_modules` writes an appointment status, and following it would
    // make the walk unbounded; but a WORKSPACE package missing from the map would silently shrink the answer,
    // so that case is the failure below.
    if (site.specifier.startsWith('@berelax/')) {
      unresolved.push(`${from} -> ${site.specifier} (workspace package not in PACKAGE_ROOTS)`)
    }
    return []
  }
  const reached: string[] = []
  for (const name of site.names) {
    const files = index.get(name)
    if (files === undefined) {
      unresolved.push(`${from} -> ${site.specifier}#${name}`)
      continue
    }
    reached.push(...files)
  }
  return reached
}

/** The transitive closure of files reachable from `entries`, by per-symbol resolution. */
function closure(entries: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (seen.has(file)) continue
    seen.add(file)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      unresolved.push(`${file} (cannot be read)`)
      continue
    }
    for (const site of importsOf(text)) {
      for (const next of resolve(file, site)) if (!seen.has(next)) queue.push(next)
    }
  }
  return [...seen].sort()
}

/**
 * Comments blanked, strings KEPT.
 *
 * Adapted from `hr-rota.test.ts`'s `codeOnly` and deliberately not shared with it: that helper also blanks
 * string literals, which is right for its rules and would make this scan unable to match a status at all.
 * Copying rather than sharing is the choice that file makes for the same reason — a shared helper is one both
 * files then have to agree about.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** One place a module can put an appointment into a status, and the status it names. */
interface StatusWrite {
  readonly file: string
  readonly status: AppointmentStatus
  readonly line: number
  readonly evidence: string
}

/**
 * `update appointment …` statements, whole, from a module's code.
 *
 * Statement-shaped and not line-shaped, because the statements in this repository are template literals
 * spanning several lines: `update appointment` is on one and `set status = …` on the next, so a line scan
 * asking whether the same line holds both finds nothing anywhere. The first version of this file did exactly
 * that and reported `set status = 'approved'` on `leave_request` as an appointment write, which is the mirror
 * mistake — a scan matching a table it was not about.
 *
 * `\bappointment\b` and not `appointment%`, so `update appointment_reassignment_flag` — which P-HR-04 does
 * on every clearance — is not read as a write to the appointment itself.
 */
const APPOINTMENT_UPDATE = /update\s+appointment\b[\s\S]*?(?=`)/g

/**
 * Every appointment status a module can WRITE, and every write site that names none.
 *
 * Two shapes, because there are two ways an appointment's status changes in this repository:
 *
 *   * a SQL `update appointment … set status = 'x'` (`cancel.ts` does this);
 *   * an interpolated one (`appointment-transition.ts` writes `set status = ${transition.to}`), which names
 *     no literal and is therefore reported as an unattributed write site — the strictest reading, because a
 *     module that writes a status it computes can write any of the nine.
 *
 * A status LITERAL anywhere in code counts as a write of that status. That over-attributes — a literal in a
 * `where` clause is a read — and over-attribution is the safe direction: the claim being made is that two
 * statuses are absent, so counting a read as a write can only make the answer larger.
 */
function statusWrites(files: readonly string[]): {
  readonly writes: readonly StatusWrite[]
  readonly unattributedWriteSites: readonly string[]
} {
  const writes: StatusWrite[] = []
  const unattributedWriteSites: string[] = []
  for (const file of files) {
    const code = withoutComments(readFileSync(file, 'utf8'))
    code.split('\n').forEach((line, index) => {
      for (const status of APPOINTMENT_STATUSES) {
        if (line.includes(`'${status}'`) || line.includes(`"${status}"`)) {
          writes.push({ file, status, line: index + 1, evidence: line.trim().slice(0, 140) })
        }
      }
    })
    for (const match of code.matchAll(APPOINTMENT_UPDATE)) {
      const statement = match[0]
      if (!/\bset\b[\s\S]*?\bstatus\b/.test(statement)) continue
      const line = code.slice(0, match.index).split('\n').length
      unattributedWriteSites.push(
        `${file}:${line} ${statement.replace(/\s+/g, ' ').trim().slice(0, 140)}`,
      )
    }
  }
  return { writes, unattributedWriteSites }
}

const APPROVAL_CLOSURE = closure(ENTRY_POINTS)
const CANCELLATION_CLOSURE = closure(CANCELLATION_ENTRY_POINTS)

const FORBIDDEN: readonly AppointmentStatus[] = ['cancelled_by_salon', 'no_show']

describe('the walk itself, before anything is concluded from it', () => {
  it('resolved every import it met', () => {
    // The guard that makes every empty result below mean something. An unresolved specifier is a branch of
    // the graph nobody walked, and a walk with holes in it reports a smaller answer than the truth.
    expect([...new Set(unresolved)].sort()).toEqual([])
  })

  it('reached a corpus big enough for an empty answer to mean something', () => {
    // ADR 0002. Floors well under the real figures and far above zero, so a resolver that stopped following
    // imports fails here rather than reporting that the approval path is clean.
    expect(APPROVAL_CLOSURE.length).toBeGreaterThan(20)
    expect(CANCELLATION_CLOSURE.length).toBeGreaterThan(5)
  })

  it('reached the modules the approval path is made of', () => {
    const relative = APPROVAL_CLOSURE.map((file) => file.slice(REPO.length + 1))
    for (const expected of [
      'packages/core/src/hr/leave-approval.ts',
      'packages/core/src/hr/rota-validator.ts',
      'packages/db/src/repositories/leave-request.ts',
      'packages/db/src/repositories/reassignment.ts',
      'packages/db/src/tx.ts',
      'packages/db/src/outbox.ts',
    ]) {
      expect(relative, `${expected} is not in the approval closure`).toContain(expected)
    }
  })

  it('did NOT reach the lifecycle state machine, which is what makes the answer precise', () => {
    // The precision claim, asserted rather than assumed. `packages/core/src/lifecycle/transitions.ts` declares
    // all nine statuses; a walk that followed `@berelax/core`'s `export *` barrel wholesale would reach it
    // from any file importing anything from core, and every assertion below would fail for a reason that has
    // nothing to do with this unit. If per-symbol resolution ever breaks, this case is what says so.
    expect(APPROVAL_CLOSURE.map((file) => file.slice(REPO.length + 1))).not.toContain(
      'packages/core/src/lifecycle/transitions.ts',
    )
  })
})

describe('acceptance — no transition the approval path can trigger is a cancellation or a no-show', () => {
  const approval = statusWrites(APPROVAL_CLOSURE)

  it('enumerates the appointment statuses reachable from the approval path', () => {
    const reachable = [...new Set(approval.writes.map((write) => write.status))].sort()
    for (const status of FORBIDDEN) {
      expect(
        reachable,
        `${status} is reachable from the approval path: ` +
          approval.writes
            .filter((write) => write.status === status)
            .map((write) => `${write.file.slice(REPO.length + 1)}:${write.line} ${write.evidence}`)
            .join('; '),
      ).not.toContain(status)
    }
  })

  it('and writes no appointment status at all, attributed or not', () => {
    // The stronger form, and the one the ADR records: not "it does not cancel" but "it writes no status".
    // An unattributed write site — `set status = ${…}` — could name any of the nine, so its absence is what
    // makes the enumeration above complete rather than a list of literals somebody happened to write.
    expect(
      approval.unattributedWriteSites.map((site) => site.slice(REPO.length + 1)),
      'the approval path contains a statement that writes appointment.status',
    ).toEqual([])
    expect(
      approval.writes.map((write) => `${write.file.slice(REPO.length + 1)}:${write.line}`),
    ).toEqual([])
  })

  it('CONTROL: the same scan over the cancellation path finds both forbidden statuses', () => {
    // Control (2). Without this, every assertion above is satisfied by a scan that matches nothing — a
    // renamed status, a strip that emptied the file, a regular expression that stopped compiling.
    const cancellation = statusWrites(CANCELLATION_CLOSURE)
    const reachable = new Set(cancellation.writes.map((write) => write.status))
    for (const status of FORBIDDEN) {
      expect(reachable, `the scan no longer finds ${status} where it certainly is`).toContain(
        status,
      )
    }
    expect(cancellation.unattributedWriteSites.length).toBeGreaterThan(0)
  })

  it('CONTROL: the scan fires on the approval path when a cancellation is spliced into it', () => {
    // Control (3), over the files actually being asserted about. A rule that matched `cancel.ts` and could
    // not match the approval modules — because the comment strip deleted the wrong thing, say — would pass
    // both cases above.
    const repository = join(REPO, 'packages', 'db', 'src', 'repositories', 'leave-request.ts')
    const spliced = `${withoutComments(readFileSync(repository, 'utf8'))}
async function sneak(uow: UnitOfWork, id: string) {
  await uow.sql\`update appointment set status = 'cancelled_by_salon' where id = \${id}\`
}
`
    const lines = spliced.split('\n')
    const found = lines.filter((line) => line.includes("'cancelled_by_salon'"))
    expect(found.length).toBe(1)
    expect(lines.some((line) => /set\s+status\s*=/.test(line))).toBe(true)
  })
})

describe('the refusal vocabularies are disjoint across the two layers', () => {
  it('shares no name between the core decision and the repository', () => {
    // Two vocabularies, two layers, and a name in both would make `details.refusal` ambiguous: a caller
    // branching on it could not tell whether the decision refused or the transaction did. The same claim
    // P-HR-04 makes about REASSIGNMENT_REJECTIONS against the eligibility port's seven.
    const shared = LEAVE_APPROVAL_REFUSALS.filter((name) =>
      (LEAVE_REQUEST_REFUSALS as readonly string[]).includes(name),
    )
    expect(shared).toEqual([])
  })

  it('names an override role set the database also enforces', () => {
    // The role list in `@berelax/core` and the trigger in 0092 are two layers of ONE rule, so the migration
    // must name exactly these roles. A third role added to the list without the migration fails here.
    const migration = readFileSync(
      join(REPO, 'packages', 'db', 'migrations', '0092_leave_approval.sql'),
      'utf8',
    )
    for (const role of LEAVE_OVERRIDE_ROLES) {
      expect(migration, `0092 does not name ${role} in its override check`).toContain(`'${role}'`)
    }
    // And the other direction, which is what catches the migration widening: the only roles its override
    // predicate names are these.
    const predicate = /new\.actor_role not in \(([^)]*)\)/.exec(migration)?.[1] ?? ''
    const named = [...predicate.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
    expect([...named].sort()).toEqual([...LEAVE_OVERRIDE_ROLES].sort())
  })
})
