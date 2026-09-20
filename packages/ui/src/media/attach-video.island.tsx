'use client'

/**
 * The attach island: the only JavaScript the hero costs, and it runs after LCP is final.
 *
 * docs/08 §6 is the whole design. The LCP element is a real `<img>` inside an art-directed `<picture>`;
 * the `<video>` ships with `preload="none"`, `muted loop playsinline`, **no `src`** and **no `poster`**;
 * and this attaches the source after `requestIdleCallback` (timeout 2500) or `load + 400ms`, then
 * cross-fades on the `playing` event. The stated cost is ~0ms LCP against +0.3–0.9s for the obvious
 * version, and the reason is mechanical rather than a tuning claim: an element with no resource is not an
 * LCP candidate at all, so the browser's largest-contentful-paint entry is already final and already the
 * photograph before anything here runs.
 *
 * ## What is deliberately not in this file
 *
 * **The decision.** Every gate — reduced motion, reduced transparency, the reader's stored choice, data
 * saver, the measured downlink — is `heroAttachDecision` in `attach-video.ts`, which is pure and has unit
 * tests including a navigator with no `connection` object. What is left here is DOM: find the element,
 * read the attributes, apply the answer.
 *
 * **Any copy.** The control's two accessible names arrive in `data-hero-label-*`, rendered by the server
 * that knew the locale.
 *
 * **Any URL.** The four renditions are serialised into `data-hero-sources` by the server, from
 * `heroVideoSources()` in `@berelax/media/video` — the same declaration `build-video-renditions` encoded
 * against. A rendition this island invented would be a 404 behind a `<video>`, which the browser resolves
 * by showing the poster forever and reporting nothing.
 *
 * ## Why the crop is chosen with `matchMedia` and not by `<source media>`
 *
 * Because `media` on a `<source>` inside a `<video>` **does nothing**. It is honoured for `<picture>` and
 * was removed from the video element's resource-selection algorithm; Chromium ignores it. So an
 * art-directed video has to pick its crop in script, and the query it picks with is the ladder's own —
 * `CROPS[crop].media`, serialised beside each source. That keeps the breakpoint in one place
 * (`packages/media/src/ladders.ts`) and leaves the evaluation to the engine that owns it. W-SYS-10
 * recorded the mirror image of this in the admin preview: a `<source media>` there is evaluated against
 * the viewport rather than the element, which is why its rows drop `media` entirely.
 *
 * ## Why it renders `null`
 *
 * An island that renders markup cannot be deferred without taking content out of the server-rendered HTML
 * (ADR 0013), and on this route the content *is* the photograph. `motion/reveal.tsx` renders `null` for the
 * same reason.
 */
import { useEffect } from 'react'
import { MOTION_STORAGE_KEY } from '../theme/theme.ts'
import {
  HERO_AMBIENT_PROPERTY,
  HERO_ATTACH_IDLE_TIMEOUT_MS,
  HERO_ATTACH_LOAD_DELAY_MS,
  HERO_CONTROL_ATTRIBUTE,
  HERO_CONTROL_LABEL_ATTRIBUTE,
  HERO_HOLD_ATTRIBUTE,
  HERO_SOURCES_ATTRIBUTE,
  HERO_STATE_ATTRIBUTE,
  HERO_VIDEO_PROPERTY,
  type HeroControl,
  type HeroState,
  heroAttachDecision,
  type MotionChoice,
  type NavigatorHint,
  type ResourceTimingSample,
} from './attach-video.ts'

/** One entry of `data-hero-sources`. Mirrors `HeroVideoSource` in `@berelax/media/video`. */
interface DeclaredSource {
  readonly src: string
  readonly type: string
  readonly media: string
}

/** The hero root, its video and its control. Null when the markup is not a hero. */
interface HeroParts {
  readonly root: HTMLElement
  readonly video: HTMLVideoElement
  readonly control: HTMLButtonElement | null
}

function partsOf(root: HTMLElement): HeroParts | null {
  const video = root.querySelector('video')
  if (video === null) return null
  return {
    root,
    video,
    control: root.querySelector<HTMLButtonElement>('button.be-hero__control'),
  }
}

/**
 * The declared sources, parsed, and never a thrown exception.
 *
 * A malformed attribute means no video rather than a broken page: this runs inside an effect, and an
 * exception here would take the rest of the page's hydration with it.
 */
function declaredSources(video: HTMLVideoElement): readonly DeclaredSource[] {
  const raw = video.getAttribute(HERO_SOURCES_ATTRIBUTE)
  if (raw === null || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is DeclaredSource =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as DeclaredSource).src === 'string' &&
        typeof (entry as DeclaredSource).type === 'string' &&
        typeof (entry as DeclaredSource).media === 'string',
    )
  } catch {
    return []
  }
}

/** The sources whose crop this viewport is served, in declaration order. */
function sourcesForViewport(sources: readonly DeclaredSource[]): readonly DeclaredSource[] {
  return sources.filter((source) => {
    try {
      return window.matchMedia(source.media).matches
    } catch {
      // A query this engine cannot parse: the crop is unknown, so offering the file would be a guess.
      return false
    }
  })
}

function setState(parts: HeroParts, state: HeroState, hold?: string): void {
  parts.root.setAttribute(HERO_STATE_ATTRIBUTE, state)
  if (hold === undefined) parts.root.removeAttribute(HERO_HOLD_ATTRIBUTE)
  else parts.root.setAttribute(HERO_HOLD_ATTRIBUTE, hold)
}

function setControl(parts: HeroParts, control: HeroControl): void {
  const button = parts.control
  if (button === null) return
  button.setAttribute(HERO_CONTROL_ATTRIBUTE, control)
  button.hidden = control === 'hidden'
  const label = button.getAttribute(`${HERO_CONTROL_LABEL_ATTRIBUTE}-${control}`)
  // Only for the two visible states; `hidden` has no label attribute and must not clear the one that is
  // there, because a control that is revealed again has to be announced as something.
  if (label !== null && label !== '') button.setAttribute('aria-label', label)
}

/** `localStorage` throws in a private window, and a hero must not be what takes the page down. */
function readStoredChoice(): string | null {
  try {
    return window.localStorage.getItem(MOTION_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredChoice(choice: MotionChoice): void {
  try {
    window.localStorage.setItem(MOTION_STORAGE_KEY, choice)
  } catch {
    // A reader in a private window gets the default behaviour on the next page. Nothing else changes.
  }
}

/** Every resource timing, reduced to the two numbers the gate reads. */
function timingSamples(): readonly ResourceTimingSample[] {
  try {
    return window.performance.getEntriesByType('resource').map((entry) => {
      const timing = entry as PerformanceResourceTiming
      return { transferSize: Number(timing.transferSize), duration: Number(timing.duration) }
    })
  } catch {
    return []
  }
}

/**
 * Attaches the chosen sources and asks the element to play.
 *
 * `preload` is raised from `none` to `auto` **before** `load()`: with `preload="none"` the element fetches
 * nothing and `play()` would be the thing that starts the download, which works but reverses the order —
 * the request would be made from inside a promise a rejected autoplay policy can cancel.
 */
function attach(parts: HeroParts, chosen: readonly DeclaredSource[], readerAsked: boolean): void {
  setState(parts, 'attaching')
  // Force the transparent frame to be COMPUTED before the source is attached, and the reason is a real
  // failure rather than caution: a transition runs between two computed values, so if `attaching` and
  // `playing` land in one task without a style recalculation between them the browser never sees
  // `opacity: 0` and the cross-fade does not run at all — the first frame of the video simply appears.
  // A cached rendition on a fast connection is exactly that case, and it is the one a developer tests
  // with. Reading a computed value is what forces the recalculation.
  void window.getComputedStyle(parts.video).opacity
  for (const source of chosen) {
    const element = document.createElement('source')
    element.src = source.src
    element.type = source.type
    parts.video.append(element)
  }
  parts.video.preload = 'auto'
  parts.video.load()
  void parts.video.play().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : ''
    if (name === 'NotAllowedError') {
      // docs/08 §6: stay on the still and reveal tap-to-play. The sources stay attached, so the reader's
      // tap plays what has already been fetched instead of starting the fetch.
      setState(parts, 'paused')
      setControl(parts, 'play')
      return
    }
    // Anything else is the element telling us it cannot play this file at all — an unsupported codec, a
    // 404, a decode error. There is nothing for a control to control, so the still stays and the button
    // stays hidden rather than promising a video that does not exist.
    setState(parts, 'held', 'playback-refused')
    setControl(parts, readerAsked ? 'play' : 'hidden')
  })
}

/**
 * Everything the island does, in one function, so the effect is a one-liner and this is testable from a
 * page rather than from React.
 *
 * Returns its own teardown. Every listener is removed: an island whose listeners outlive the element it
 * was watching is a leak that only shows up on a client-side navigation.
 */
export function startHeroVideo(scope: ParentNode = document): () => void {
  const teardown: (() => void)[] = []
  for (const element of scope.querySelectorAll<HTMLElement>('.be-hero')) {
    const parts = partsOf(element)
    if (parts === null) continue
    teardown.push(startOne(parts))
  }
  return () => {
    for (const stop of teardown) stop()
  }
}

function startOne(parts: HeroParts): () => void {
  const { video, control } = parts
  let cancelled = false
  let attached = false

  const onPlaying = (): void => {
    setState(parts, 'playing')
    setControl(parts, 'pause')
  }
  const onPause = (): void => {
    // docs/08 §6 asks for this listener by name: iOS Low Power Mode can be switched on mid-session, which
    // pauses a playing video with no promise to reject and no error to catch. The only evidence is this
    // event, and without it the control would stay a pause button over a frozen frame.
    setState(parts, 'paused')
    setControl(parts, 'play')
  }
  const onError = (): void => {
    setState(parts, 'held', 'playback-refused')
    setControl(parts, 'hidden')
  }
  video.addEventListener('playing', onPlaying)
  video.addEventListener('pause', onPause)
  video.addEventListener('error', onError)

  const run = (readerAsked: boolean): void => {
    if (cancelled) return
    const root = document.documentElement
    const styles = window.getComputedStyle(root)
    const chosen = sourcesForViewport(declaredSources(video))
    const decision = heroAttachDecision({
      ambientDuration: styles.getPropertyValue(HERO_AMBIENT_PROPERTY),
      videoFlag: styles.getPropertyValue(HERO_VIDEO_PROPERTY),
      storedChoice: readStoredChoice(),
      samples: timingSamples(),
      declaredSources: chosen.length,
      navigator: window.navigator as unknown as NavigatorHint,
      readerAsked,
    })
    if (!decision.attach) {
      setState(parts, 'held', decision.reason ?? undefined)
      setControl(parts, decision.control)
      return
    }
    attached = true
    attach(parts, chosen, readerAsked)
  }

  const onControlClick = (): void => {
    if (!video.paused && attached) {
      // The reader's choice, remembered. `pause()` fires `pause`, which is what moves the control — one
      // path for the reader's own tap and for iOS taking the decision out of their hands.
      writeStoredChoice('paused')
      video.pause()
      return
    }
    writeStoredChoice('playing')
    if (!attached) {
      run(true)
      return
    }
    void video.play().catch(() => {
      setState(parts, 'paused')
      setControl(parts, 'play')
    })
  }
  control?.addEventListener('click', onControlClick)

  /*
   * docs/08 §6: after `requestIdleCallback` (timeout 2500) or `load + 400ms`.
   *
   * **After `load` either way**, and that is a reading rather than a detail. An idle period is whenever
   * the main thread is free, which happens *while the network is busy* — so an idle callback registered
   * during hydration can fire before the poster has finished arriving, and the island would then put a
   * video download in the way of the LCP image it exists to protect. `load` is the honest lower bound for
   * "LCP is final": every image the initial document asked for has arrived by then.
   *
   * Both branches, not either. Safari has no `requestIdleCallback`, so the timer is the path on every
   * iPhone rather than a rare fallback. And `load` may already have fired by the time an island hydrates,
   * in which case a listener would never be called at all — the case that silently does nothing, and the
   * reason for the `readyState` branch.
   */
  const idle = (
    window as unknown as {
      requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number
    }
  ).requestIdleCallback
  let handle: number | undefined
  let timer: number | undefined
  const afterLoad = (): void => {
    if (typeof idle === 'function') {
      handle = idle(() => run(false), { timeout: HERO_ATTACH_IDLE_TIMEOUT_MS })
      return
    }
    timer = window.setTimeout(() => run(false), HERO_ATTACH_LOAD_DELAY_MS)
  }
  if (document.readyState === 'complete') afterLoad()
  else window.addEventListener('load', afterLoad, { once: true })

  return () => {
    cancelled = true
    video.removeEventListener('playing', onPlaying)
    video.removeEventListener('pause', onPause)
    video.removeEventListener('error', onError)
    control?.removeEventListener('click', onControlClick)
    window.removeEventListener('load', afterLoad)
    if (timer !== undefined) window.clearTimeout(timer)
    const cancelIdle = (window as unknown as { cancelIdleCallback?: (handle: number) => void })
      .cancelIdleCallback
    if (handle !== undefined && typeof cancelIdle === 'function') cancelIdle(handle)
  }
}

export default function HeroVideoIsland() {
  useEffect(() => startHeroVideo(), [])
  return null
}
