/**
 * The two primitives that are surfaces and nothing else: the panel and the chip.
 *
 * Both take `--radius-1` — 2px — which is the single most visible decision in docs/08 §7's list of
 * what keeps this from looking like every other shadcn site. shadcn's card is `rounded-xl` (12px) and
 * its badge is `rounded-full`; 2px on a warm ground with a hairline border reads as printed matter
 * rather than as an application, and that is the whole aesthetic.
 *
 * **No shadow.** `pnpm layout` enforces it by filename — this file is not an overlay — and docs/08 §1
 * makes elevation the exception rather than the texture: a panel has a hairline and a surface, which is
 * enough to separate it from the page.
 *
 * `.be-panel` rather than `.be-card`, because `.be-card` is the therapist card's container-query root
 * from W-SYS-02 and two components cannot own one class name. The panel is the generic surface; the
 * therapist card is a component built on the same radius.
 */
import type { ReactNode } from 'react'
import { radiusVarFor } from './contract.ts'

export const SURFACE_CSS = `
.be-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-8);
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-radius: ${radiusVarFor('card')};
  color: var(--color-ink);
}

.be-panel__title { font-size: var(--text-lg); margin: 0; }

.be-chips { display: flex; flex-wrap: wrap; gap: var(--space-4); }

/*
 * A chip is read, not pressed. It carries no href and no handler, so it is a <span> and is deliberately
 * absent from the touch-target audit's selector — a 48px floor on a label would make a row of five
 * qualifications the tallest thing on the page.
 */
.be-chip {
  display: inline-flex;
  align-items: center;
  min-block-size: 28px;
  padding-inline: var(--space-5);
  border: 1px solid var(--color-hairline);
  border-radius: ${radiusVarFor('chip')};
  background: var(--color-ground-sunk);
  /* ink, not ink-2: a chip sits on the sunk ground rather than the page ground, and ink-2 measures its
     4.5:1 against the page. */
  color: var(--color-ink);
  font-size: var(--text-sm);
}
`

export interface PanelProps {
  readonly title?: string
  readonly children: ReactNode
  readonly className?: string
}

export function Panel({ title, children, className }: PanelProps) {
  return (
    <div className={className === undefined ? 'be-panel' : `be-panel ${className}`}>
      {title === undefined ? null : <p className="be-panel__title">{title}</p>}
      {children}
    </div>
  )
}

export interface ChipProps {
  readonly children: ReactNode
}

export function Chip({ children }: ChipProps) {
  return <span className="be-chip">{children}</span>
}
