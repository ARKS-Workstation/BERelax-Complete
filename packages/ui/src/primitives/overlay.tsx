/**
 * Every surface that floats above the page, and the one shadow they share.
 *
 * ## Why all of this CSS is in one file, and why that file is called `overlay`
 *
 * Two constraints meet here.
 *
 * `pnpm layout` allows `box-shadow` only in a file whose name is an overlay word
 * (`overlay|dialog|sheet|toast|popover|tooltip|menu|drawer|modal`), because docs/08 §2 specifies exactly
 * one shadow and a card that grows one is how a flat system stops being flat. A dialog, a bottom sheet,
 * a popover and a select menu are all the same thing to that rule — a surface that floats — so they
 * share one file that says so in its name.
 *
 * The second constraint is Next.js. `dialog.tsx`, `sheet.tsx`, `popover.tsx` and `select.tsx` are
 * `'use client'` modules, because they read direction from React context. In the App Router **every**
 * export of a `'use client'` module is a client reference, including a plain string: a server component
 * that imported `DIALOG_CSS` from `dialog.tsx` would get a proxy and put it through
 * `dangerouslySetInnerHTML`. So the CSS for the client primitives lives on this side of the boundary,
 * in a module with no `'use client'`, and `styles.tsx` can assemble it on the server.
 *
 * ## The geometry
 *
 * A dialog and a bottom sheet take `--radius-3` (docs/08 §4). A popover and a select menu take the
 * *control* radius, `--radius-2`: both hang off the control that opened them and read as an extension
 * of it, and docs/08 §4 does not assign them a radius of their own.
 */
import { radiusVarFor } from './contract.ts'

export const OVERLAY_CSS = `
/* The one floating surface. Everything below is this plus a position. */
.be-overlay {
  background: var(--color-surface);
  color: var(--color-ink);
  border: 1px solid var(--color-hairline);
  box-shadow: var(--shadow-overlay);
}

/* The scrim is the ink token at 40%, not a hand-mixed translucent grey: one colour, one opacity, and
   nothing to measure for contrast because nothing is read against it. */
.be-scrim {
  position: fixed;
  inset: 0;
  background: var(--color-ink);
  opacity: 0.4;
  /* Its own keyframes, ending at the scrim's own opacity. Sharing be-fade-in would end at opacity 1
     with animation-fill-mode: both, and the scrim would black the page out instead of veiling it. */
  animation: be-scrim-in var(--dur-slow) var(--ease-out-quiet) both;
}

.be-dialog {
  position: fixed;
  inset-block-start: 50%;
  inset-inline-start: 50%;
  transform: translate(-50%, -50%);
  inline-size: min(32rem, calc(100% - var(--space-8) * 2));
  max-block-size: calc(100dvh - var(--space-9) * 2);
  overflow: auto;
  padding: var(--space-8);
  border-radius: ${radiusVarFor('dialog')};
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  /* docs/08 §5: a dialog is 320ms. The scale is 0.98 rather than a slide — a centred surface that
     travels has to travel from somewhere, and there is nowhere for it to have come from. */
  animation: be-dialog-in var(--dur-slow) var(--ease-out-quiet) both;
}

.be-dialog__title { font-size: var(--text-xl); margin: 0; }
.be-dialog__description { color: var(--color-ink-2); margin: 0; }

/* The bottom sheet: the same surface, on the edge the thumb is already near. */
.be-sheet {
  position: fixed;
  inset-block-end: 0;
  inset-inline: 0;
  max-block-size: 90dvh;
  overflow: auto;
  padding: var(--space-6) var(--space-8) var(--space-9);
  /* Only the two leading corners, because the other two are off the bottom of the screen. Logical
     corners, so the sheet does not need a second rule for Arabic. */
  border-start-start-radius: ${radiusVarFor('sheet')};
  border-start-end-radius: ${radiusVarFor('sheet')};
  border-end-start-radius: 0;
  border-end-end-radius: 0;
  border-block-end: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  animation: be-sheet-in var(--dur-slow) var(--ease-out-soft) both;
}

/*
 * The handle. It is the only thing in this system that wears --radius-handle, and
 * apps/web/src/primitives.itest.ts walks every element on the page to prove it: a 999px corner
 * anywhere else is a pill, and a pill is a different design language.
 */
.be-sheet__handle {
  align-self: center;
  inline-size: 40px;
  block-size: 4px;
  border-radius: ${radiusVarFor('handle')};
  background: var(--color-border);
}

.be-popover {
  inline-size: min(20rem, calc(100vw - var(--space-8) * 2));
  padding: var(--space-6);
  border-radius: ${radiusVarFor('select')};
  animation: be-fade-in var(--dur-base) var(--ease-out-quiet) both;
}

.be-popover__arrow { fill: var(--color-surface); }

.be-select__content {
  border-radius: ${radiusVarFor('select')};
  overflow: hidden;
  /* Radix reports the trigger's width as a custom property; a menu narrower than the control it
     belongs to reads as a different control. */
  min-inline-size: var(--radix-select-trigger-width);
  max-block-size: var(--radix-select-content-available-height);
  animation: be-fade-in var(--dur-base) var(--ease-out-quiet) both;
}

.be-select__viewport { padding: var(--space-3); }

.be-select__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  /* 48px, like every other target: a menu row is hit with a thumb as often as a button is. */
  min-block-size: 48px;
  padding-inline: var(--space-5);
  border-radius: ${radiusVarFor('select')};
  font-size: var(--text-base);
  cursor: pointer;
  outline: none;
}

/* Radix moves this attribute with the keyboard and the pointer both, so one rule covers hover and
   arrow keys — two rules would eventually disagree. */
.be-select__item[data-highlighted] {
  background: var(--color-ground-sunk);
}

.be-select__item[data-state="checked"] { font-weight: 600; }

@keyframes be-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes be-scrim-in {
  from { opacity: 0; }
  to { opacity: 0.4; }
}

@keyframes be-dialog-in {
  from { opacity: 0; transform: translate(-50%, -50%) scale(0.98); }
  to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}

/*
 * The sheet rises, and nothing about that is mirrored: it moves on the block axis, where Arabic and
 * English agree. --move-lg is zeroed by the reduced-motion token override, so the movement disappears
 * and the fade survives without a per-component branch.
 */
@keyframes be-sheet-in {
  from { opacity: 0; transform: translateY(var(--move-lg)); }
  to { opacity: 1; transform: translateY(0); }
}
`
