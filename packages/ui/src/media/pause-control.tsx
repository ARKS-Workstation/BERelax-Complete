import type { ReactElement } from 'react'
import { Icon } from '../icon.tsx'
import {
  HERO_CONTROL_ATTRIBUTE,
  HERO_CONTROL_LABEL_ATTRIBUTE,
  type HeroControl,
} from './attach-video.ts'

/**
 * WCAG 2.2.2's pause control for the hero loop — server-rendered, and hydrated by nothing.
 *
 * ## Why it is not a client component
 *
 * It has a click handler, so the obvious shape is `'use client'` with an `onClick`. That would put React
 * *and* this component's own hydration cost on the page whose entire premise is that the hero is free —
 * and it would buy nothing, because the island is already there: docs/08 §6 budgets one ~1.4KB island to
 * attach the video, and the same island can add one listener. So the markup is server-rendered, the island
 * wires it, and the page carries one client module instead of two.
 *
 * The consequence is deliberate and is why the control ships `hidden`: with JavaScript off or a chunk that
 * 404s, nothing attaches a video and nothing reveals the button, so a reader is never offered a control
 * that cannot work. A dead control is worse than no control — it is a promise the page cannot keep, and a
 * screen reader announces it either way.
 *
 * ## Why it is hidden at all, when docs/08 §6 says "always visible"
 *
 * Because "always" is scoped to the video being there. WCAG 2.2.2 applies to content that *moves*, and
 * three of this hero's paths never move: reduced motion, reduced transparency and a connection measured
 * under 600 kbit/s all end with the still and no video at all. A pause button over a photograph is a
 * control with nothing to control, and on the two token paths it is worse than that — it invites a reader
 * who has asked for no motion to ask again. While the loop is playing the control is visible, which is what
 * the success criterion actually requires.
 *
 * ## Both glyphs, one control
 *
 * The pause and play glyphs are both in the markup and the state attribute decides which is drawn
 * (`styles.ts`). The island therefore changes one attribute and one label to move between the two: it
 * builds no elements, reads no locale and carries no copy, which is what keeps a locale-blind island
 * correct on the Arabic document. The labels travel with the markup, in `data-hero-label-*`, for the same
 * reason — the island has to set an accessible name and must not be the thing that knows the language.
 */
export interface HeroPauseControlCopy {
  /** The accessible name while the loop is playing, i.e. what the control will do: pause it. */
  readonly pause: string
  /** The accessible name while it is not: docs/08 §6's tap-to-play. */
  readonly play: string
}

export interface HeroPauseControlProps {
  readonly copy: HeroPauseControlCopy
  /**
   * The state the server renders.
   *
   * Always `hidden` in practice, and a parameter rather than a constant because the specimen and the
   * gate fixtures need to render the other two without a browser. A server that rendered `pause` would be
   * claiming a video is playing before a single byte of it has been requested.
   */
  readonly initial?: HeroControl
}

export function HeroPauseControl({
  copy,
  initial = 'hidden',
}: HeroPauseControlProps): ReactElement {
  return (
    <button
      type="button"
      className="be-hero__control"
      // `hidden` and not a class: it takes the control out of the accessibility tree and out of the tab
      // order together, which two of the three CSS ways of hiding something do not.
      hidden={initial === 'hidden'}
      {...{ [HERO_CONTROL_ATTRIBUTE]: initial }}
      {...{ [`${HERO_CONTROL_LABEL_ATTRIBUTE}-pause`]: copy.pause }}
      {...{ [`${HERO_CONTROL_LABEL_ATTRIBUTE}-play`]: copy.play }}
      // The name of the state it is in, which for a hidden control is the one it will be revealed in.
      aria-label={initial === 'pause' ? copy.pause : copy.play}
    >
      <span data-hero-glyph="pause">
        <Icon name="pause" />
      </span>
      <span data-hero-glyph="play">
        <Icon name="play" />
      </span>
    </button>
  )
}
