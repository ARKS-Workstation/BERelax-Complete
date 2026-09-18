/**
 * The button, re-geometried away from shadcn's defaults and typed so it cannot be unlabelled.
 *
 * ## What is different from the component this is copied from
 *
 * shadcn's button is `h-9 rounded-md px-4 text-sm` — 36px tall, 6px corners, 14px text. Every one of
 * those three is wrong here: docs/08 §4 puts the touch floor at 48px on a phone, gives buttons
 * `--radius-2` (8px), and the type scale starts at 17px. A 36px button also fails
 * `pnpm touch-targets`, which is the check that turns "not looking like every other shadcn site"
 * (docs/08 §7) into something other than an aspiration.
 *
 * The floor is stated as `min-block-size`/`min-inline-size` rather than arrived at through padding,
 * because a floor each variant reaches by its own arithmetic is a floor half of them miss — 32px is
 * what `padding: 4px 10px` produces, and it looks deliberate.
 *
 * ## Why there is no `onClick`
 *
 * This is a server component (ADR 0013: server-rendered, not a SPA). A button that needs a handler is
 * a button inside a client island, and it gets there by being the trigger of one — `Dialog`, `Sheet`
 * and `Popover` render their own trigger with these classes. Adding `onClick` here would make every
 * page that renders a button ship a client bundle.
 */
import type { ReactNode } from 'react'
import { Icon, type IconName } from '../icon.tsx'
import { type IconLabelling, radiusVarFor } from './contract.ts'

export type ButtonVariant = 'primary' | 'quiet' | 'ghost'

export const BUTTON_CSS = `
.be-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  /* docs/08 §4: 48px on a phone, and there is no reason for a desk to be smaller than a thumb. */
  min-block-size: 48px;
  min-inline-size: 48px;
  padding-inline: var(--space-8);
  border: 1px solid transparent;
  border-radius: ${radiusVarFor('button')};
  background: var(--color-accent-gold);
  color: var(--color-ground);
  font: inherit;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  /* docs/08 §5: hover is 140ms of colour, and the press is 90ms. Nothing else moves. */
  transition: background-color var(--dur-fast) var(--ease-calm),
    border-color var(--dur-fast) var(--ease-calm),
    transform var(--dur-instant) var(--ease-calm);
}

.be-btn:hover { background: var(--color-accent-gold-strong); }
.be-btn:active { transform: scale(0.98); }

.be-btn--quiet {
  background: transparent;
  color: var(--color-accent-teal);
  border-color: var(--color-border-strong);
}

.be-btn--quiet:hover { background: var(--color-ground-sunk); }

.be-btn--ghost {
  background: transparent;
  color: var(--color-accent-teal);
  border-color: transparent;
}

.be-btn--ghost:hover { background: var(--color-ground-sunk); }

/* An icon on its own is square: the inline padding exists to give a text label room, and there is no
   text label. The 48px floor is what keeps it a target rather than a 20px glyph. */
.be-btn[data-icon-only="true"] { padding-inline: 0; }

.be-btn[disabled] {
  background: var(--color-ground-sunk);
  color: var(--color-ink-2);
  border-color: var(--color-border);
  cursor: not-allowed;
}
`

export interface ButtonBaseProps {
  readonly variant?: ButtonVariant
  readonly type?: 'button' | 'submit' | 'reset'
  readonly disabled?: boolean
  readonly className?: string
}

/**
 * `IconLabelling` is what makes an icon-only button with no `aria-label` a **compile error** rather
 * than an audit finding. See `contract.ts`, and `contract.test.ts` for the assertion.
 */
export type ButtonProps = ButtonBaseProps & IconLabelling<IconName, ReactNode>

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'be-btn',
  quiet: 'be-btn be-btn--quiet',
  ghost: 'be-btn be-btn--ghost',
}

export function Button(props: ButtonProps) {
  const { variant = 'primary', type = 'button', disabled = false, className } = props
  // Read through `in` rather than destructured: the props are a union, and narrowing it here is what
  // keeps the union's guarantee — that one of `children` and `aria-label` is always present — instead
  // of casting it away.
  const icon = 'icon' in props ? props.icon : undefined
  const children = 'children' in props ? props.children : undefined
  const label = props['aria-label']

  return (
    <button
      className={
        className === undefined ? VARIANT_CLASS[variant] : `${VARIANT_CLASS[variant]} ${className}`
      }
      type={type}
      disabled={disabled}
      aria-label={label}
      data-icon-only={icon !== undefined && children === undefined}
    >
      {icon === undefined ? null : <Icon name={icon} />}
      {children === undefined ? null : <span className="be-btn__label">{children}</span>}
    </button>
  )
}
