/**
 * The NAP block: name, address, phone and hours, rendered from the premises row and nothing else.
 *
 * docs/09 §4 lists this as the first of the *derived* consumers of `premises` — "Footer NAP block,
 * `/contact`, `/spa`, map embed, directions link" — and states the rule it exists to keep: **one source
 * of truth, no hard-coded address in a template.** `packages/db/src/seed/premises.test.ts` greps every
 * file under `packages/` and `apps/` for the street and the four phone numbers and fails on a match, so
 * this component cannot contain an address even by accident: it has no data of its own.
 *
 * ## Why it takes the `/api/facts` payload
 *
 * Because the alternative is two derivations of one row. `/api/facts` publishes `Facts`; this renders
 * `Facts`. So "the footer and the fact sheet agree" is true by construction rather than by two builders
 * being kept in step, and a test can compare the rendered DOM against the payload and the payload against
 * the row — which is what the acceptance criterion asks for ("each compared against the row value rather
 * than a literal").
 *
 * The copy is the caller's, for the reason every pattern in this directory gives: copy belongs to the
 * route because the route is the locale (`app/(en)` and `app/(ar)` are two documents, not one with a
 * toggle). The **data** is never the caller's.
 *
 * ## What it refuses to render
 *
 * A WhatsApp number, while there is none. docs/13 §3 records two — the prototype's and the live site's —
 * and Y1-nap asks which is canonical, so `premises.phone_whatsapp` holds a placeholder the schema's
 * `is_placeholder_text()` refuses. `contact.whatsapp.status` is `unconfirmed` and this block renders
 * `copy.whatsappUnconfirmed` where the number would go. Rendering one of the two candidates would put a
 * number on the page that may not reach the business, and it would be indistinguishable from one the
 * owner had confirmed.
 *
 * `pnpm layout` fails if this file contains `@media (min-width`: the block answers to its container,
 * because it appears in a page-wide footer, in the measure column of `/contact` and in a 300px admin rail.
 */
import {
  type Facts,
  formatUaePhone,
  addressLines as postalAddressLines,
  telLinkFor,
} from '@berelax/shared'

/** The container width at which the address and the hours stop stacking. */
export const NAP_BLOCK_LAYOUTS = [
  { minInlineSize: 0, layout: 'stack' },
  { minInlineSize: 480, layout: 'columns' },
] as const

export type NapBlockLayout = (typeof NAP_BLOCK_LAYOUTS)[number]['layout']

export const NAP_BLOCK_CSS = `
.be-nap {
  container-type: inline-size;
  container-name: nap-block;
}

.be-nap__inner {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-6);
  --nap-layout: stack;
}

/* An <address> element is italic in every browser's default sheet, which is wrong for a postal address
   set in the body face beside a price list. */
.be-nap__address { font-style: normal; margin: 0; }
.be-nap__heading {
  font-size: var(--text-sm);
  color: var(--color-ink-2);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0 0 var(--space-4);
}
.be-nap__lines { margin: 0; }
.be-nap__line { display: block; }
.be-nap__aliases { color: var(--color-ink-2); font-size: var(--text-sm); margin: var(--space-4) 0 0; }
.be-nap__hours { margin: 0; display: grid; gap: var(--space-3); }
.be-nap__day { display: flex; flex-wrap: wrap; gap: var(--space-4); margin: 0; }
.be-nap__day-name { color: var(--color-ink-2); }
/* Tabular figures so a column of opening times lines up on the colon rather than drifting. */
.be-nap__session { font-variant-numeric: tabular-nums; }
.be-nap__note { color: var(--color-ink-2); font-size: var(--text-sm); margin: 0; }
/* A channel with no confirmed value. Not hidden: a reader is told the channel exists and that the number
   is not published yet, which is the honest state and the one the owner has to act on. */
.be-nap__pending { color: var(--color-ink-2); font-size: var(--text-sm); margin: 0; }

/* From 480px of container the address and the hours sit side by side. The 48px floor and the 20px gap on
   the actions come from .be-action and .be-actions in layout/styles.tsx, so this block cannot arrive at a
   44px tap target through its own padding. */
@container nap-block (min-width: 480px) {
  .be-nap__inner {
    --nap-layout: columns;
    grid-template-columns: 1fr 1fr;
  }
  .be-nap__actions { grid-column: 1 / -1; }
}
`

/**
 * Every string this block renders that is not a fact, in the locale of the document.
 *
 * `dayNames` is index 0 = Sunday, matching `premises_hours.day_of_week` — not the caller's week start.
 * Getting that wrong shifts the whole schedule by a day, which is the kind of defect that looks like a
 * data problem for a week.
 */
export interface NapBlockCopy {
  /** The accessible name of the region. Rendered as the heading of the address column. */
  readonly addressHeading: string
  readonly hoursHeading: string
  readonly dayNames: readonly string[]
  /** Joins the ends of a run of identical days: `Sunday<sep>Saturday`. */
  readonly dayRangeSeparator: string
  /** Used instead of a range when all seven days share one session. */
  readonly everyDay: string
  /** Between the opening and closing time. */
  readonly sessionSeparator: string
  /** Marks a close that falls on the following calendar day, which this business's hours do. */
  readonly closesNextDay: string
  readonly closedLabel: string
  /** Prefix for a `tel:` action: `Call`. The number is appended. */
  readonly callLabel: string
  readonly mapLabel: string
  readonly directionsLabel: string
  /** Introduces `areaAliases`: "also known as". */
  readonly alsoKnownAs: string
  /** Stands where a WhatsApp number would be, while Y1-nap is unanswered. */
  readonly whatsappUnconfirmed: string
}

/**
 * The slice of the fact sheet this block renders.
 *
 * A `Pick` of `Facts` rather than a shape of its own: the point of the component is that the visible NAP
 * and the machine-readable one are the same object, and a parallel interface is where they would drift.
 */
export type NapFacts = Pick<Facts, 'address' | 'geo' | 'contact' | 'hours' | 'parkingNotes'>

export interface NapBlockProps {
  readonly copy: NapBlockCopy
  readonly facts: NapFacts
}

/** One rendered schedule row: a run of consecutive days that share a session. */
interface DayRun {
  readonly fromDay: number
  readonly toDay: number
  readonly opens: string
  readonly closes: string
  readonly closesNextDay: boolean
  readonly isClosed: boolean
}

/**
 * Consecutive days with identical hours, collapsed into one row.
 *
 * docs/13 §2 states one session that runs every day, which is seven identical rows in `premises_hours` —
 * and seven identical lines in a footer are noise a reader skips, so the one fact that matters (the close
 * is on the next day) goes unread.
 *
 * Exported because it needs its own test, and a rule that merged two *different* sessions would be
 * invisible on the seeded data, where all seven are the same. That test is in `apps/web/src/facts.test.ts`
 * rather than beside this file: the root typecheck project includes `.ts` under `packages/` and has no
 * `jsx`, so a `.ts` test next to a `.tsx` component would pull JSX into a project that cannot compile it —
 * the same constraint the barrel at `patterns/index.tsx` records. `apps/web` is typechecked by `next build`,
 * which can.
 *
 * Runs do not wrap around the week. A Saturday and a Sunday that share a session but differ from the
 * middle of the week are two rows, which is correct: `Saturday–Sunday` written as a range from index 6 to
 * index 0 reads as the whole week backwards.
 */
export function collapseHours(weekly: Facts['hours']['weekly']): readonly DayRun[] {
  const runs: DayRun[] = []
  for (const day of weekly) {
    const last = runs[runs.length - 1]
    const sameSession =
      last !== undefined &&
      last.toDay === day.dayOfWeek - 1 &&
      last.opens === day.opens &&
      last.closes === day.closes &&
      last.closesNextDay === day.closesNextDay &&
      last.isClosed === day.isClosed
    if (sameSession && last !== undefined) {
      runs[runs.length - 1] = { ...last, toDay: day.dayOfWeek }
      continue
    }
    runs.push({
      fromDay: day.dayOfWeek,
      toDay: day.dayOfWeek,
      opens: day.opens,
      closes: day.closes,
      closesNextDay: day.closesNextDay,
      isClosed: day.isClosed,
    })
  }
  return runs
}

/** The label for a run: one day, a range, or "every day" when the run is the whole week. */
function runLabel(run: DayRun, copy: NapBlockCopy): string {
  if (run.fromDay === 0 && run.toDay === 6) return copy.everyDay
  const from = copy.dayNames[run.fromDay] ?? String(run.fromDay)
  if (run.fromDay === run.toDay) return from
  return `${from}${copy.dayRangeSeparator}${copy.dayNames[run.toDay] ?? String(run.toDay)}`
}

export function NapBlock({ copy, facts }: NapBlockProps) {
  const { address, geo, contact, hours } = facts
  // The postal lines, derived from the columns rather than from `address.oneLine`: a footer sets an
  // address over several lines and splitting a joined string on its commas is a parse of our own output.
  const lines = postalAddressLines({
    addressLine1: address.line1,
    addressLine2: address.line2,
    floor: address.floor,
    area: address.area,
    emirate: address.emirate,
    countryCode: address.countryCode,
  })
  const phones = [contact.landline, contact.mobile].filter(
    (phone): phone is NonNullable<typeof phone> => phone !== null,
  )

  return (
    <div className="be-nap">
      <div className="be-nap__inner">
        <div>
          <p className="be-nap__heading">{copy.addressHeading}</p>
          <address className="be-nap__address">
            <p className="be-nap__lines">
              {lines.map((line) => (
                <span className="be-nap__line" key={line}>
                  {line}
                </span>
              ))}
            </p>
            {address.areaAliases.length > 0 ? (
              <p className="be-nap__aliases">
                {copy.alsoKnownAs} {address.areaAliases.join(', ')}
              </p>
            ) : null}
          </address>
        </div>

        <div>
          <p className="be-nap__heading">{copy.hoursHeading}</p>
          <div className="be-nap__hours">
            {collapseHours(hours.weekly).map((run) => (
              <p className="be-nap__day" key={`${run.fromDay}-${run.toDay}`}>
                <span className="be-nap__day-name">{runLabel(run, copy)}</span>
                <span className="be-nap__session">
                  {run.isClosed
                    ? copy.closedLabel
                    : `${run.opens}${copy.sessionSeparator}${run.closes}`}
                  {run.closesNextDay && !run.isClosed ? ` ${copy.closesNextDay}` : ''}
                </span>
              </p>
            ))}
          </div>
        </div>

        <div className="be-nap__actions">
          <div className="be-actions">
            {phones.map((phone) => (
              <a className="be-action" href={telLinkFor(phone.e164)} key={phone.e164}>
                {copy.callLabel} {formatUaePhone(phone.e164)}
              </a>
            ))}
            <a className="be-action be-action--quiet" href={geo.mapUrl}>
              {copy.mapLabel}
            </a>
            <a className="be-action be-action--quiet" href={geo.directionsUrl}>
              {copy.directionsLabel}
            </a>
          </div>
          {contact.whatsapp.status === 'unconfirmed' ? (
            <p className="be-nap__pending">{copy.whatsappUnconfirmed}</p>
          ) : (
            <p className="be-nap__note">{formatUaePhone(contact.whatsapp.e164)}</p>
          )}
          {facts.parkingNotes === null ? null : (
            <p className="be-nap__note">{facts.parkingNotes}</p>
          )}
        </div>
      </div>
    </div>
  )
}
