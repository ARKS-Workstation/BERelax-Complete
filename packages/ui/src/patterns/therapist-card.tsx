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

.be-card__link {
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
   ratios from 0.461 to 0.799, and a centre crop to 4:5 takes the torso and leaves the face out of
   frame. object-position comes from assets/media/manifest.json, per image. */
.be-card__portrait {
  display: block;
  inline-size: 100%;
  aspect-ratio: 4 / 5;
  object-fit: cover;
  background: var(--color-surface-clay);
  border-radius: var(--radius-1);
  /* docs/08 §5: this is what says the card is explorable. 200ms, --ease-calm. */
  transition: transform var(--dur-base) var(--ease-calm);
}

.be-card__link:hover .be-card__portrait { transform: scale(1.03); }

.be-card__body { display: flex; flex-direction: column; gap: var(--space-3); }
.be-card__label { font-weight: 600; }
/* ink-2 and not ink-3: this label is body size, so it needs 4.5:1, and ink-3 measures 3.40:1. */
.be-card__unnamed { color: var(--color-ink-2); }
.be-card__meta { color: var(--color-ink-2); font-size: var(--text-sm); display: none; margin: 0; }
.be-card__services { display: none; margin: 0; color: var(--color-ink-2); font-size: var(--text-sm); }

/* Below 260px there is room for a portrait and a label and nothing else. */
@container therapist-card (min-width: 260px) {
  .be-card__link { --card-layout: compact; }
  .be-card__meta { display: block; }
}

/* From 340px the portrait moves beside the text: two short columns read faster than one tall one. */
@container therapist-card (min-width: 340px) {
  .be-card__link {
    --card-layout: split;
    grid-template-columns: minmax(96px, 34%) 1fr;
    align-items: start;
  }
}

/* From 420px there is room for what the therapist actually does, which is the reason to show a card
   at all rather than a photograph. */
@container therapist-card (min-width: 420px) {
  .be-card__link {
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
  readonly href: string
  readonly portrait: {
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
  return (
    <div className="be-card">
      <a className="be-card__link" href={href} aria-label={named ? displayName : reference}>
        {/* Decorative in the accessibility sense: the label beside it carries the meaning, and there
            is no name to describe the person by. */}
        <img
          className="be-card__portrait"
          src={portrait.src}
          alt=""
          loading="lazy"
          style={{ objectPosition: portrait.objectPosition }}
        />
        <span className="be-card__body">
          <span className={named ? 'be-card__label' : 'be-card__label be-card__unnamed'}>
            {named ? displayName : unnamedLabel}
          </span>
          {qualifications === undefined ? null : (
            <span className="be-card__meta">{qualifications}</span>
          )}
          {services === undefined ? null : <span className="be-card__services">{services}</span>}
        </span>
      </a>
    </div>
  )
}
