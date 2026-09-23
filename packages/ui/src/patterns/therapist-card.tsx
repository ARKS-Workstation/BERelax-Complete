/**
 * The therapist card: a photograph, a label, and no invented name.
 *
 * ## The label
 *
 * A therapist has **no display name** until an admin sets one and records a photography consent
 * (ADR 0020). The launch state of this business is nineteen photographs and zero names, so the card
 * takes `displayName` as optional and renders `unnamedLabel` when it is absent. It is not a
 * placeholder to fill in later: a card that always shows a name is a card that hides the guard, and
 * `packages/fixtures/src/synthetic.ts` exists because a plausible name in a fixture eventually gets
 * treated as a person.
 *
 * ## Why container queries and not breakpoints
 *
 * This card appears in a four-across grid on the home page, in the measure column of a treatment
 * page, and in a 300px rail in the admin. Those are three different widths at the *same* viewport, so
 * a `@media` rule would be wrong in two of the three places. `@container` asks the only question that
 * predicts the layout: how much room does this card have?
 *
 * `pnpm layout` fails if this file ever contains `@media (min-width`, because the first thing anybody
 * reaches for when a card looks wrong in one place is the page breakpoint that happens to fix it.
 *
 * The declared widths are docs/08 §4's: 260, 340 and 420px.
 */
import { slotAspectRatio } from '@berelax/media/slots'
import type { ReactNode } from 'react'

/**
 * The container widths at which the card changes shape, and what it becomes.
 *
 * Exported so `kitchen-sink.itest.ts` drives the container to exactly these widths rather than to
 * widths that happen to work. The names are readable back out of the rendered page as
 * `--card-layout`, which is how a test can assert *which* layout it got rather than inferring it.
 */
export const THERAPIST_CARD_LAYOUTS = [
  { minInlineSize: 0, layout: 'stack' },
  { minInlineSize: 260, layout: 'compact' },
  { minInlineSize: 340, layout: 'split' },
  { minInlineSize: 420, layout: 'wide' },
] as const

export type TherapistCardLayout = (typeof THERAPIST_CARD_LAYOUTS)[number]['layout']

export const THERAPIST_CARD_CSS = `
.be-card {
  container-type: inline-size;
  container-name: therapist-card;
}

/* The linked card and the unlinked one are one box.
   :where() so the pair carries no more specificity than the single class did, which is what lets the
   container queries below keep overriding grid-template-columns from one selector. A therapist with no
   display name and no recorded photography consent has no page to link to (ADR 0020), so their card is a
   <div> rather than an <a> — and a card that changed shape when it lost its link would turn the publication
   guard into a visual difference, which it is not: it is the absence of a destination.

   No backtick appears in this comment, or in any comment in this file. The whole stylesheet is one template
   literal, so one backtick ends it early and the rest of the file is parsed as JavaScript — which is a
   syntax error several hundred lines further down, in a place that says nothing about the cause. */
:where(.be-card__link, .be-card__unlinked) {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-5);
  text-decoration: none;
  color: var(--color-ink);
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-radius: var(--radius-1);
  padding: var(--space-6);
  --card-layout: stack;
}

/* The portrait is cropped around a declared focal point: the photographs are full-length at native
   ratios from 0.461 to 0.799, and a centre crop takes the torso and leaves the face out of frame.
   object-position comes from assets/media/manifest.json, per image.

   The ratio is read from the therapist-portrait slot rather than written here, because the media gate
   refuses a literal one (aspect-ratio-must-come-from-the-slot-registry) and because a card reserving the
   wrong box reflows when the photograph lands.

   The slot's ratio is the right box HERE and only because of what this element is: one <img> whose src the
   caller chooses, at every viewport. The derivative job takes BOTH ladder crops for every slot, so the
   art-directed <picture> is served 4:5 on a phone and 16:9 on a laptop and reserves its box per crop
   instead (apps/web/src/components/media/slot-picture.tsx). What must match this box is the src: hand this
   card the desktop 16:9 derivative and object-fit: cover centre-crops it against an object-position
   computed for the 4:5 crop, which takes the face back out of frame. */
.be-card__portrait {
  display: block;
  inline-size: 100%;
  aspect-ratio: ${slotAspectRatio('therapist-portrait')};
  object-fit: cover;
  background: var(--color-surface-clay);
  border-radius: var(--radius-1);
  /* docs/08 §5: this is what says the card is explorable. 200ms, --ease-calm. */
  transition: transform var(--dur-base) var(--ease-calm);
}

.be-card__link:hover .be-card__portrait { transform: scale(1.03); }

/* The same box, with no photograph in it.
   A therapist portrait has no derivative until the media job has run over an uploaded original, and nothing
   has uploaded one (Y12-photos; Y12-consent-photo is the other half of why). An <img> whose bytes 404 is a
   broken image and a wasted request; an element with no box at all is a card that reflows the day the
   photograph lands, which is the CLS regression the reserved box exists to prevent. So the box is reserved
   and painted in the placeholder colour the slot registry already names for it. */
.be-card__portrait--pending { background: var(--color-surface-clay); }

.be-card__body { display: flex; flex-direction: column; gap: var(--space-3); }
.be-card__label { font-weight: 600; }
/* ink-2 and not ink-3: this label is body size, so it needs 4.5:1, and ink-3 measures 3.40:1. */
.be-card__unnamed { color: var(--color-ink-2); }
.be-card__meta { color: var(--color-ink-2); font-size: var(--text-sm); display: none; margin: 0; }
.be-card__services { display: none; margin: 0; color: var(--color-ink-2); font-size: var(--text-sm); }

/* Below 260px there is room for a portrait and a label and nothing else. */
@container therapist-card (min-width: 260px) {
  :where(.be-card__link, .be-card__unlinked) { --card-layout: compact; }
  .be-card__meta { display: block; }
}

/* From 340px the portrait moves beside the text: two short columns read faster than one tall one. */
@container therapist-card (min-width: 340px) {
  :where(.be-card__link, .be-card__unlinked) {
    --card-layout: split;
    grid-template-columns: minmax(96px, 34%) 1fr;
    align-items: start;
  }
}

/* From 420px there is room for what the therapist actually does, which is the reason to show a card
   at all rather than a photograph. */
@container therapist-card (min-width: 420px) {
  :where(.be-card__link, .be-card__unlinked) {
    --card-layout: wide;
    grid-template-columns: minmax(140px, 40%) 1fr;
  }
  .be-card__services { display: block; }
}
`

export interface TherapistCardProps {
  /** Absent until an admin sets one. See ADR 0020 and the note above. */
  readonly displayName?: string
  /** What to render instead of a name. Supplied by the caller because it is translated copy. */
  readonly unnamedLabel: string
  /**
   * Where this therapist's own page is, or **absent** because they have none.
   *
   * Optional since W-SITE-04, and the optionality is the publication guard rather than a convenience. ADR
   * 0020 and migration 0050: a therapist page exists only with a display name *and* a recorded photography
   * consent, and `employee.is_publishable` is GENERATED from both. All nineteen therapists of this business
   * have neither (`Y12-names`, `Y12-consent-photo`), so docs/13 §8 states the launch state exactly —
   * *"every therapist renders as an unlinked photo card reading Name not yet published"* — and a card that
   * had to be given an `href` could only be given one that 404s.
   *
   * Absent means **no anchor element at all**, not a disabled one: an `<a>` with no `href` is still
   * announced as a link by some screen readers, and `href="#"` is a link that scrolls the page.
   */
  readonly href?: string
  /**
   * The photograph, or **absent** because no derivative of it exists.
   *
   * Optional for a different reason from `href`, and worth keeping separate: a therapist may have consented
   * and been named and still have no *built* derivative, because a derivative is produced by the media job
   * from an uploaded original and nothing has uploaded one. When it is absent the card reserves the same box
   * and paints it in the slot's placeholder colour, so the photograph arrives later with no layout shift.
   */
  readonly portrait?: {
    /**
     * One image, served at every viewport, in the 4:5 box above.
     *
     * An original or the slot's **mobile** (4:5) derivative — not the desktop 16:9 one, which this box
     * would centre-crop against a focal point computed for the other shape. A slot's ladder has both.
     */
    readonly src: string
    /** From the asset's focal point, so the crop keeps the face in frame. */
    readonly objectPosition: string
  }
  /**
   * A reference like `Therapist 07`, used as the link's accessible name.
   *
   * Internal, and never rendered as a display name — but two unnamed cards whose links are both called
   * "Name not yet published" are indistinguishable to a screen-reader user working through a list of
   * links, and this is the only thing that tells them apart until an admin sets a name.
   */
  readonly reference: string
  /** What they are qualified for. Shown from the `compact` layout up. */
  readonly qualifications?: string
  /** Detail worth reading only when the container is wide enough for it. */
  readonly services?: ReactNode
}

export function TherapistCard({
  displayName,
  unnamedLabel,
  href,
  portrait,
  reference,
  qualifications,
  services,
}: TherapistCardProps) {
  const named = displayName !== undefined && displayName.length > 0
  // A function rather than an element, because the unlinked card has one more thing to say and it belongs
  // *inside* the body column: a third child of the card's grid would land in the first column of a second
  // row from 340px up, where the portrait is.
  const body = (extra: ReactNode) => (
    <>
      {portrait === undefined ? (
        // The reserved box with nothing in it, and deliberately not an <img>: see `portrait` above.
        <span className="be-card__portrait be-card__portrait--pending" />
      ) : (
        // Decorative in the accessibility sense: the label beside it carries the meaning, and there
        // is no name to describe the person by.
        <img
          className="be-card__portrait"
          src={portrait.src}
          alt=""
          loading="lazy"
          style={{ objectPosition: portrait.objectPosition }}
        />
      )}
      <span className="be-card__body">
        <span className={named ? 'be-card__label' : 'be-card__label be-card__unnamed'}>
          {named ? displayName : unnamedLabel}
        </span>
        {qualifications === undefined ? null : (
          <span className="be-card__meta">{qualifications}</span>
        )}
        {services === undefined ? null : <span className="be-card__services">{services}</span>}
        {extra}
      </span>
    </>
  )
  return (
    <div className="be-card" data-therapist-card={reference}>
      {href === undefined ? (
        // No anchor. The reference is rendered rather than carried on an `aria-label`, because `aria-label`
        // on a plain <div> is ignored — and it is still the only thing that tells two unnamed cards apart.
        <div className="be-card__unlinked">
          {body(<span className="be-card__meta">{reference}</span>)}
        </div>
      ) : (
        <a className="be-card__link" href={href} aria-label={named ? displayName : reference}>
          {body(null)}
        </a>
      )}
    </div>
  )
}
