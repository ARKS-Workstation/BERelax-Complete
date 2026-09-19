/**
 * The price grid as a table, because a price grid is a table.
 *
 * docs/09 §"LLM SEO" asks for "tables for comparable facts", and the comparable fact this business has is
 * `(treatment × duration) → gross`. A list of rows reads the same to a person and differently to every
 * machine: a `<table>` with a row header per duration is the one shape an assistant extracts correctly, and
 * it is the shape that lets a reader compare four durations without scrolling back.
 *
 * ## Why the currency is in the column head and not in every cell
 *
 * `formatAmount` — the figure grouped, two decimals, no symbol — is what goes in a cell, and `AED` is
 * stated once in the header. That is `formatAmount`'s own documented purpose and it buys two things here.
 * A column of `AED 1,200.00` repeated thirty-two times is noise a reader has to look past to compare the
 * numbers; and the string `formatAmount` produces is **identical under `en-AE` and `ar-AE-u-nu-latn`**
 * (docs/08 §7 chose Latin numerals), so the Arabic and English documents publish the same figure rather
 * than two spellings of it that a test has to normalise before it can compare them.
 *
 * ## Why every cell carries `data-price-row`
 *
 * It is the only way to assert the acceptance criterion — *"every rendered price string equals its
 * catalogue gross-fils row formatted through the money helper, over all 32"* — against the **served DOM**
 * rather than against the component's props. The attribute names the row (`<slug>-<minutes>`), so the test
 * can find the cell for a catalogue row and compare the text; without it the assertion could only count
 * strings that look like prices, which passes on a page that renders the same figure thirty-two times.
 *
 * There is deliberately no amount in an attribute. The figure appears once per cell, as text, because a
 * second copy in a `data-` attribute is a second place it can be wrong and the one nobody reads.
 *
 * `pnpm layout` fails if this file contains `@media (min-width`: the table answers to its container.
 */

/** The container width at which the duration column stops being the whole row. */
export const PRICE_TABLE_LAYOUTS = [
  { minInlineSize: 0, layout: 'stack' },
  { minInlineSize: 380, layout: 'columns' },
] as const

export const PRICE_TABLE_CSS = `
.be-prices {
  container-type: inline-size;
  container-name: price-table;
  inline-size: 100%;
}

.be-prices__table {
  inline-size: 100%;
  border-collapse: collapse;
  /* A price column that does not line up on the decimal is a price column nobody compares. */
  font-variant-numeric: tabular-nums;
}

.be-prices__caption {
  text-align: start;
  color: var(--color-ink-2);
  font-size: var(--text-sm);
  padding-block-end: var(--space-4);
}

.be-prices__head {
  text-align: start;
  font-size: var(--text-sm);
  color: var(--color-ink-2);
  font-weight: 600;
  padding-block: var(--space-4);
  border-block-end: 1px solid var(--color-border-strong);
}

.be-prices__head--amount { text-align: end; }

.be-prices__label {
  text-align: start;
  font-weight: 400;
  padding-block: var(--space-5);
  padding-inline-end: var(--space-6);
  border-block-end: 1px solid var(--color-hairline);
}

.be-prices__amount {
  text-align: end;
  font-weight: 600;
  padding-block: var(--space-5);
  border-block-end: 1px solid var(--color-hairline);
}

/* The group header inside a table that lists more than one treatment: /pricing renders all eight. */
.be-prices__group {
  text-align: start;
  padding-block: var(--space-6) var(--space-4);
  border-block-end: 1px solid var(--color-border-strong);
}
`

/** One priced duration. `amount` is already formatted — see the header on which helper and why. */
export interface PriceTableRow {
  /** `<slug>-<minutes>`, the catalogue row this cell came from. */
  readonly id: string
  /** What the row is, in the document's language: "45 minutes". */
  readonly label: string
  /** `formatAmount` output: grouped, two decimals, no currency symbol. */
  readonly amount: string
}

/** A group of rows under one treatment, for a table that lists more than one. */
export interface PriceTableGroup {
  /** The treatment's public display name, from the catalogue. Never composed here. */
  readonly name: string
  readonly rows: readonly PriceTableRow[]
}

export interface PriceTableProps {
  /** Visible, and the table's accessible name. A caption rather than a hidden label. */
  readonly caption: string
  /** The header of the label column: "Duration". */
  readonly labelHeading: string
  /** The header of the amount column. States the currency once: "Price (AED, VAT included)". */
  readonly amountHeading: string
  readonly groups: readonly PriceTableGroup[]
}

export function PriceTable({ caption, labelHeading, amountHeading, groups }: PriceTableProps) {
  const grouped = groups.length > 1
  return (
    <div className="be-prices">
      <table className="be-prices__table">
        <caption className="be-prices__caption">{caption}</caption>
        <thead>
          <tr>
            <th className="be-prices__head" scope="col">
              {labelHeading}
            </th>
            <th className="be-prices__head be-prices__head--amount" scope="col">
              {amountHeading}
            </th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.name}>
            {grouped ? (
              <tr>
                {/* `colspan` on a `th` with `scope="colgroup"` is how a reader announces which treatment
                    the rows below belong to. A visual-only heading outside the table would leave a screen
                    reader with eight identical "45 minutes" rows and no way to tell them apart. */}
                <th className="be-prices__group" colSpan={2} scope="colgroup">
                  {group.name}
                </th>
              </tr>
            ) : null}
            {group.rows.map((row) => (
              <tr key={row.id}>
                <th className="be-prices__label" scope="row">
                  {row.label}
                </th>
                <td className="be-prices__amount" data-price-row={row.id}>
                  {row.amount}
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  )
}
