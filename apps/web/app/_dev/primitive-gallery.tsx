/**
 * Every primitive in `@berelax/ui/primitives`, on one page, in whichever locale renders it.
 *
 * ## Why it is shared between two routes rather than duplicated
 *
 * W-SYS-03's acceptance is twelve axe runs: three viewports x two themes x **two directions**. The
 * direction of a document is set by its root layout — `apps/web/app/(en)/layout.tsx` and
 * `(ar)/layout.tsx` each render their own `<html lang dir>` — so the RTL half of that matrix has to be
 * a real Arabic route, not the English one with `dir` flipped on a wrapper. W-SYS-01 already paid for
 * that lesson: an earlier draft set `lang`/`dir` on a `<main>` inside one English layout, and it
 * rendered mirrored text while doing none of the four things `theme/arabic.css` exists to do, because
 * every rule there is inherited from the document element.
 *
 * So there are two routes and one component. The copy is a prop, because copy belongs to the locale;
 * the structure is here, because a gallery that drifts between the two directions is auditing two
 * different pages and reporting one number.
 *
 * ## What is deliberately not here
 *
 * No `onClick` anywhere. The page is server-rendered (ADR 0013), and the only client islands on it are
 * the Radix ones — `Select`, `Popover`, `Dialog` and `Sheet` — which need state to open at all.
 * Everything else, `Button` included, is a server component.
 */
import {
  Button,
  Chip,
  Dialog,
  Field,
  Icon,
  Input,
  Panel,
  Popover,
  PrimitiveStyles,
  Select,
  type SelectOption,
  Sheet,
  Textarea,
} from '@berelax/ui/primitives'

/**
 * The gallery's own layout, which is a development surface and not part of the design system.
 *
 * `.be-actions` (20px gap, wrapping) and every other class on the page come from `@berelax/ui`; these
 * four rules are the stack this page puts them in. They live here rather than in `packages/ui` because
 * nothing but this route renders them, and a design system that carries its own demonstration page is
 * a design system with a page nobody can delete.
 */
const GALLERY_CSS = `
.be-gallery { display: flex; flex-direction: column; gap: var(--space-9); }

.be-gallery__controls {
  display: grid;
  gap: var(--space-8);
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
  align-items: start;
}

.be-gallery__body { color: var(--color-ink-2); }
`

export interface PrimitiveGalleryCopy {
  readonly buttons: {
    readonly primary: string
    readonly quiet: string
    readonly ghost: string
    readonly withIcon: string
    /** The accessible name of the icon-only button. Without it the component does not compile. */
    readonly iconOnly: string
    readonly disabled: string
  }
  readonly nav: { readonly label: string; readonly today: string; readonly hours: string }
  readonly chips: readonly [string, ...string[]]
  readonly panel: { readonly title: string; readonly body: string }
  readonly fields: {
    readonly mobile: string
    readonly mobileHint: string
    readonly notes: string
    readonly notesPlaceholder: string
    readonly duration: string
    readonly durations: readonly SelectOption[]
    readonly durationDefault: string
  }
  readonly popover: { readonly trigger: string; readonly label: string; readonly body: string }
  readonly dialog: {
    readonly trigger: string
    readonly title: string
    readonly description: string
    readonly close: string
  }
  readonly sheet: {
    readonly trigger: string
    readonly title: string
    readonly description: string
    readonly close: string
  }
}

export function PrimitiveGallery({ copy }: { readonly copy: PrimitiveGalleryCopy }) {
  return (
    <>
      <PrimitiveStyles />
      <style
        href="berelax-dev-gallery"
        precedence="default"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant in this module, never user input
        dangerouslySetInnerHTML={{ __html: GALLERY_CSS }}
      />

      <div className="be-gallery">
        {/*
          The buttons. Six of them, and the fifth is the one this unit exists for: an icon and no text,
          which compiles only because it carries an `aria-label`.
        */}
        <div className="be-actions">
          <Button>{copy.buttons.primary}</Button>
          <Button variant="quiet">{copy.buttons.quiet}</Button>
          <Button variant="ghost">{copy.buttons.ghost}</Button>
          <Button icon="calendar">{copy.buttons.withIcon}</Button>
          <Button icon="search" aria-label={copy.buttons.iconOnly} variant="quiet" />
          <Button disabled>{copy.buttons.disabled}</Button>
        </div>

        {/* Nav icons are 24px rather than 20px. docs/08 §7, and the one place the difference shows. */}
        <nav aria-label={copy.nav.label} className="be-actions">
          <a className="be-btn be-btn--ghost" href="#slots">
            <Icon name="calendar" placement="nav" />
            {copy.nav.today}
          </a>
          <a className="be-btn be-btn--ghost" href="#menu">
            <Icon name="clock" placement="nav" />
            {copy.nav.hours}
          </a>
        </nav>

        <div className="be-chips">
          {copy.chips.map((chip) => (
            <Chip key={chip}>{chip}</Chip>
          ))}
        </div>

        <Panel title={copy.panel.title}>
          <p className="be-gallery__body">{copy.panel.body}</p>
        </Panel>

        <div className="be-gallery__controls">
          <Field label={copy.fields.mobile} hint={copy.fields.mobileHint}>
            <Input name="gallery-mobile" type="tel" autoComplete="tel" inputMode="tel" />
          </Field>
          <Select
            label={copy.fields.duration}
            options={copy.fields.durations}
            defaultValue={copy.fields.durationDefault}
          />
          <Field label={copy.fields.notes}>
            <Textarea name="gallery-notes" placeholder={copy.fields.notesPlaceholder} />
          </Field>
        </div>

        {/*
          The three overlays. Each one portals into `document.body`, which is why the direction has to
          cross that boundary through `DirectionProvider` rather than through the DOM.
        */}
        <div className="be-actions">
          <Popover trigger={copy.popover.trigger} label={copy.popover.label}>
            <p className="be-gallery__body">{copy.popover.body}</p>
          </Popover>
          <Dialog
            trigger={copy.dialog.trigger}
            title={copy.dialog.title}
            description={copy.dialog.description}
            closeLabel={copy.dialog.close}
          >
            <Chip>{copy.chips[0]}</Chip>
          </Dialog>
          <Sheet
            trigger={copy.sheet.trigger}
            title={copy.sheet.title}
            description={copy.sheet.description}
            closeLabel={copy.sheet.close}
          >
            <Chip>{copy.chips[0]}</Chip>
          </Sheet>
        </div>
      </div>
    </>
  )
}
