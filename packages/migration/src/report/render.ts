import type { ReconciliationReport, ReconciliationRun } from './generate.ts'

/**
 * The human-readable reconciliation report, generated from the SAME value the machine-readable one is.
 *
 * ## There is no field list in this file, and that is the decision
 *
 * The acceptance line asks that the two forms be "generated from one source and asserted equal by a
 * test". The obvious implementation writes the headings and the figures out by hand, and it satisfies the
 * letter of that line while being the thing it is aimed at: a hand-written list drifts the first time a
 * field is added to the report, and the symptom is a page a person reads that is missing the figure the
 * JSON holds. That is this repository's recorded failure — "a second statement of a fact drifts" — in the
 * place where it is least visible, because both forms still look complete.
 *
 * So {@link reportFigures} WALKS the report generically and yields one `path = value` pair per leaf, and
 * {@link renderReconciliationReport} renders nothing but those pairs under headings derived from the
 * paths. A field added to {@link ReconciliationReport} appears in the human form with no change here, and
 * a field the walk could not reach would fail `report-forms.test.ts`, which counts the leaves of the
 * JSON and the lines of the text and requires the same number.
 *
 * ## The run instant is rendered from the WRAPPER
 *
 * {@link renderReconciliationRun} prints `generatedAt` in a header above the report body and nowhere
 * inside it, so the body of two runs over the same data is byte-identical and the header is the only line
 * that moves. Rendering the instant inside the body would make the human form uncomparable while the
 * machine form stayed comparable — two forms of one report that disagree about what they are.
 */

export interface ReportFigure {
  /** Dotted path with array indices, e.g. `sources.0.sourceRows`. Stable across runs. */
  readonly path: string
  /** The leaf, as it is rendered. `null` renders as `—` so an absence cannot read as a zero. */
  readonly value: string
}

/** How a null leaf is rendered. Not `0`, and not blank: ADR 0070's whole subject in one character. */
export const ABSENT = '—'

const leaf = (value: unknown): string => {
  if (value === null) return ABSENT
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return String(value)
}

/**
 * Every figure the report states, in document order, one per leaf.
 *
 * Generic over the shape, so it cannot omit a field. Arrays are indexed rather than summarised, because a
 * reconciliation is read row by row: "three quarantined rows" is not actionable and "line 7 of
 * contacts.tsv, unsupported_country" is.
 */
export function reportFigures(report: ReconciliationReport): readonly ReportFigure[] {
  const out: ReportFigure[] = []
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        // An empty list still has to SAY it is empty. A section that renders nothing is
        // indistinguishable from a section somebody forgot, which is the whole of ADR 0002 in a report.
        out.push({ path, value: '(none)' })
        return
      }
      for (const [index, item] of value.entries()) walk(item, `${path}.${index}`)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value))
        walk(item, path === '' ? key : `${path}.${key}`)
      return
    }
    out.push({ path, value: leaf(value) })
  }
  walk(report, '')
  return Object.freeze(out)
}

/** The top-level section a path belongs to: everything before the first dot. */
const sectionOf = (path: string): string => path.split('.')[0] ?? path

/**
 * The report as text, with one line per figure, grouped by section.
 *
 * No width alignment and no column padding. A padded table is a second layout to keep in step with the
 * paths, and the byte-identity claim then depends on the widest value in the run — so two runs over the
 * same data with one longer file name would differ on every line of the section.
 */
export function renderReconciliationReport(report: ReconciliationReport): string {
  const lines: string[] = ['MIGRATION RECONCILIATION']
  let section = ''
  for (const figure of reportFigures(report)) {
    const next = sectionOf(figure.path)
    if (next !== section) {
      section = next
      lines.push('', `[${section}]`)
    }
    lines.push(`${figure.path} = ${figure.value}`)
  }
  lines.push(
    '',
    report.unexplainedVariances === 0
      ? 'VERDICT: every variance is tied to a named cause.'
      : `VERDICT: ${report.unexplainedVariances} variance(s) no named cause accounts for. ` +
          'A variance is either tied to a named cause or it is unexplained, and an unexplained one ' +
          'fails this report (ADR 0070).',
  )
  return `${lines.join('\n')}\n`
}

/** The same body, with the run instant in a header above it and nowhere inside it. */
export function renderReconciliationRun(run: ReconciliationRun): string {
  return [
    `generated-at: ${run.generatedAt}`,
    `content-digest: ${run.contentDigest}`,
    '',
    renderReconciliationReport(run.report),
  ].join('\n')
}
