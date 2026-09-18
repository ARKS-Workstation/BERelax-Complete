/**
 * `@berelax/ui/primitives` — the shadcn/Radix component set, re-geometried onto this system.
 *
 * ## Why this is a subpath and a `.tsx` barrel
 *
 * The same reason as `@berelax/ui/layout` and `@berelax/ui/patterns`: the root typecheck project
 * (`tsconfig.json`) has neither `jsx` nor the DOM lib — that absence is what stops a
 * `document.querySelector` compiling inside `packages/core` — and its `include` glob is
 * `packages/**\/*.ts`, which does not match `.tsx`. A `.tsx` barrel is invisible to that project; a
 * `.ts` one would be matched by the glob, drag every component into a project with no `jsx`, and fail
 * `pnpm typecheck`. These components are typechecked by the app that renders them: `next build` runs
 * `tsc` over `apps/web/tsconfig.json`, which has `jsx`, the DOM lib and React's types.
 *
 * `contract.ts` is the deliberate exception. It is framework-free and **is** in the root project, which
 * is what lets `contract.test.ts` assert with `@ts-expect-error` that an icon-only `Button` with no
 * `aria-label` does not compile.
 *
 * ## What is copied from shadcn and what is not
 *
 * The composition is shadcn's — Radix primitives wrapped with our classes, copied in rather than
 * installed (docs/08 §7). The geometry is not: 48px targets, `--radius-1/2/3`, 17px controls, one
 * shadow. "Default shadcn geometry is replaced, not themed."
 */

export type { IconName, IconProps } from '../icon.tsx'
export { ICON_CSS, ICON_NAMES, Icon } from '../icon.tsx'
export type { ButtonBaseProps, ButtonProps, ButtonVariant } from './button.tsx'
export { BUTTON_CSS, Button } from './button.tsx'
export type { IconLabelling, IconPlacement, RadiusRole } from './contract.ts'
export {
  ICON_SIZE,
  ICON_STROKE_WIDTH,
  MIN_FORM_FONT_SIZE_PX,
  RADIUS_ROLE,
  radiusVarFor,
} from './contract.ts'
export type { ModalProps } from './dialog.tsx'
export { Dialog, Sheet } from './dialog.tsx'
export { DirectionProvider, useDirection } from './direction.tsx'
export type { FieldProps, InputProps, TextareaProps } from './field.tsx'
export { FIELD_PRIMITIVE_CSS, Field, Input, Textarea } from './field.tsx'
export { OVERLAY_CSS } from './overlay.tsx'
export type { PopoverProps } from './popover.tsx'
export { Popover } from './popover.tsx'
export type { SelectOption, SelectProps } from './select.tsx'
export { Select } from './select.tsx'
export { PRIMITIVES_CSS, PrimitiveStyles } from './styles.tsx'
export type { ChipProps, PanelProps } from './surface.tsx'
export { Chip, Panel, SURFACE_CSS } from './surface.tsx'
