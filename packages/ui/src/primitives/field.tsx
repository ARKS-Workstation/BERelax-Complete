/**
 * The form controls, and the 16px floor that is not a style choice.
 *
 * ## Why every control here states `font-size: var(--text-base)`
 *
 * iOS Safari zooms the viewport when a focused `input`, `select` or `textarea` computes to **less than
 * 16px**, and it does not zoom back out afterwards. On a phone, mid-booking, that is a page the
 * customer has to pinch their way out of before they can reach the next field. shadcn's inputs are
 * `text-sm` — 14px — which is exactly the value that triggers it, and it is the single most common way
 * a mobile form becomes unusable while looking correct on a laptop.
 *
 * `--text-base` is 17px, so the rule is "inherit the body size and say so". The label is allowed to be
 * 14px: nothing focuses a label. `apps/web/src/primitives.itest.ts` measures every form control at
 * 390px against `MIN_FORM_FONT_SIZE_PX`.
 *
 * ## Labelling
 *
 * `Field` renders a `<label>` **around** its control, so the association needs no `id` and cannot be
 * broken by a duplicated one — an `htmlFor` that points at an id rendered twice on a page labels the
 * first one and silently abandons the second. The select trigger is a `<button>` rather than a native
 * control (see `select.tsx`) and is the one case that has to use `aria-labelledby`.
 */
import type { ReactNode } from 'react'
import { radiusVarFor } from './contract.ts'

export const FIELD_PRIMITIVE_CSS = `
.be-control { display: flex; flex-direction: column; gap: var(--space-3); }

.be-control__label { font-size: var(--text-sm); color: var(--color-ink-2); }

.be-control__hint { font-size: var(--text-sm); color: var(--color-ink-2); margin: 0; }

.be-input,
.be-textarea,
.be-select {
  /* 48px, like every other target. A 40px input is fine with a mouse and not with a thumb. */
  min-block-size: 48px;
  padding-inline: var(--space-6);
  border: 1px solid var(--color-border-strong);
  background: var(--color-surface);
  color: var(--color-ink);
  font-family: inherit;
  /* The iOS zoom guard. 17px, stated rather than inherited, so a utility class cannot quietly make it
     14px without this line having to be deleted first. */
  font-size: var(--text-base);
}

.be-input,
.be-textarea { border-radius: ${radiusVarFor('input')}; }

/* docs/08 §4 gives selects the button radius, which is not a whim: a select is a button that happens
   to hold a value, and it should read as one. */
.be-select {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  border-radius: ${radiusVarFor('select')};
  cursor: pointer;
  text-align: start;
}

.be-textarea {
  padding-block: var(--space-5);
  min-block-size: 96px;
  line-height: 1.647;
  resize: vertical;
}

.be-input::placeholder,
.be-textarea::placeholder { color: var(--color-ink-2); }

/*
 * Radix's Select mirrors its value into a hidden native <select> so a form submits it and the browser
 * can autofill it. It cannot know whether the trigger is inside a <form> until the trigger has mounted,
 * so it renders the mirror unconditionally on the server and removes it after hydration when there is
 * no form — and that server-rendered mirror is 1x1 with clip: rect(0,0,0,0), which the touch-target
 * audit reads as a control 47px under the floor. display: none gives it no box at all, and a
 * display: none control still submits its value, so nothing about form integration changes.
 */
.be-select-field > select[aria-hidden="true"] { display: none; }
`

export interface FieldProps {
  readonly label: string
  readonly hint?: string
  readonly children: ReactNode
}

/** A control and its label, as one block. */
export function Field({ label, hint, children }: FieldProps) {
  return (
    /*
     * The control is `children`: wrapped rather than referenced by id, which is the stronger of the two
     * associations and the one an `htmlFor` cannot break by pointing at an id that is rendered twice.
     * Biome cannot see through a prop, and the alternative it suggests — `useId` plus `htmlFor` — is a
     * hook, which would make every field on every page a client component for no accessibility gain.
     */
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is `children`; see the note above
    <label className="be-control">
      <span className="be-control__label">{label}</span>
      {children}
      {hint === undefined ? null : <span className="be-control__hint">{hint}</span>}
    </label>
  )
}

export interface InputProps {
  readonly name: string
  readonly type?: 'text' | 'tel' | 'email' | 'search' | 'number'
  readonly placeholder?: string
  readonly autoComplete?: string
  readonly defaultValue?: string
  readonly inputMode?: 'text' | 'tel' | 'email' | 'numeric' | 'search'
}

export function Input({ name, type = 'text', ...rest }: InputProps) {
  return <input className="be-input" type={type} name={name} {...rest} />
}

export interface TextareaProps {
  readonly name: string
  readonly rows?: number
  readonly placeholder?: string
  readonly defaultValue?: string
}

export function Textarea({ name, rows = 3, ...rest }: TextareaProps) {
  return <textarea className="be-textarea" name={name} rows={rows} {...rest} />
}
