'use client'

/**
 * The popover, over Radix.
 *
 * ## `dir` is passed explicitly here, and that is not redundant
 *
 * Radix's Select puts the direction on its own content; Popover does not — there is no `dir` anywhere
 * in `@radix-ui/react-popover`. Its content is portalled into `document.body`, outside the subtree the
 * page's `dir` applies to, so without this the panel inherits the document's direction only by
 * accident of where the portal lands. `useDirection()` reads the same `DirectionProvider` the document
 * shell installs from the locale, so one provider drives `<html dir>` and every portal.
 *
 * ## The label is required
 *
 * Radix gives the content `role="dialog"`, and a dialog with no accessible name is an axe violation
 * (`aria-dialog-name`, serious) as well as an announcement of nothing. There is no visible title in a
 * popover, so the name has to be a prop, and making it required is cheaper than finding it in an audit.
 */
import { useDirection } from '@radix-ui/react-direction'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import type { ReactNode } from 'react'

export interface PopoverProps {
  /** What the trigger button says. Visible text, so it is also the trigger's accessible name. */
  readonly trigger: ReactNode
  /** The panel's accessible name. See above — `role="dialog"` needs one. */
  readonly label: string
  readonly children: ReactNode
}

export function Popover({ trigger, label, children }: PopoverProps) {
  const dir = useDirection()
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger className="be-btn be-btn--quiet">
        {trigger}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="be-overlay be-popover"
          dir={dir}
          sideOffset={8}
          aria-label={label}
          collisionPadding={16}
        >
          {children}
          <PopoverPrimitive.Arrow className="be-popover__arrow" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
