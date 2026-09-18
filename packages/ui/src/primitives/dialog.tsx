'use client'

/**
 * The dialog and the bottom sheet: one Radix Dialog, two positions.
 *
 * They are the same component because they are the same thing — a modal surface with a scrim, a focus
 * trap, an Escape key and a title. What differs is where it sits and therefore which corners are
 * rounded: `--radius-3` on all four for a centred dialog, on the two leading corners for a sheet whose
 * other two are off the bottom of the screen (docs/08 §4, and the CSS in `overlay.tsx`).
 *
 * A sheet rather than a dialog on a phone is not decoration: the thumb is at the bottom of the device,
 * and a centred dialog puts its actions where the hand is not.
 *
 * `dir` is passed explicitly, as in `popover.tsx`: Radix's Dialog carries no direction of its own, and
 * its content is portalled into `document.body` where the page's own `dir` does not reach it.
 *
 * ## The close button is the shape the Button contract exists for
 *
 * An icon and no text. It is rendered by Radix's `Close` rather than by `Button` — Radix owns the
 * element that closes the dialog — so it states `aria-label` here; `contract.ts` is what makes the same
 * omission a compile error anywhere `Button` is used.
 */
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useDirection } from '@radix-ui/react-direction'
import type { ReactNode } from 'react'
import { Icon } from '../icon.tsx'

export interface ModalProps {
  /** What the trigger button says. */
  readonly trigger: ReactNode
  readonly title: string
  /** Radix warns when content has no description, and a modal with no explanation earns the warning. */
  readonly description: string
  readonly closeLabel: string
  readonly children: ReactNode
}

function Modal({
  trigger,
  title,
  description,
  closeLabel,
  children,
  surface,
}: ModalProps & { readonly surface: 'dialog' | 'sheet' }) {
  const dir = useDirection()
  return (
    <DialogPrimitive.Root>
      <DialogPrimitive.Trigger className="be-btn be-btn--quiet">{trigger}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="be-scrim" />
        <DialogPrimitive.Content
          className={surface === 'sheet' ? 'be-overlay be-sheet' : 'be-overlay be-dialog'}
          dir={dir}
        >
          {surface === 'sheet' ? (
            // The grab handle. Decorative: the sheet is dismissed with Escape, the scrim or the close
            // button, and announcing a shape to a screen reader tells it nothing.
            <div className="be-sheet__handle" aria-hidden="true" />
          ) : null}
          <DialogPrimitive.Title className="be-dialog__title">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="be-dialog__description">
            {description}
          </DialogPrimitive.Description>
          {children}
          <DialogPrimitive.Close
            className="be-btn be-btn--ghost"
            aria-label={closeLabel}
            data-icon-only="true"
          >
            <Icon name="close" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** A centred modal surface. `--radius-3` on all four corners. */
export function Dialog(props: ModalProps) {
  return <Modal {...props} surface="dialog" />
}

/** The same surface on the bottom edge, with the handle. `--radius-3` on the two leading corners. */
export function Sheet(props: ModalProps) {
  return <Modal {...props} surface="sheet" />
}
