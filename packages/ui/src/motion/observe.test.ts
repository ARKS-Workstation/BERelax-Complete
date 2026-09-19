import { describe, expect, it } from 'vitest'
import {
  CONDENSED_ATTRIBUTE,
  condenseWhileSentinelIsOffScreen,
  type ObservedElement,
  type ObservedEntry,
  type Observer,
  type ObserverFactory,
  REVEAL_ROOT_MARGIN,
  REVEALED_ATTRIBUTE,
  revealOnFirstIntersection,
} from './observe.ts'

/**
 * The smallest element that answers the three questions `observe.ts` asks, and records what was done
 * to it. A real `Element` satisfies the same interface; this one can be read back.
 */
function element(attributes: readonly string[] = []): ObservedElement & {
  readonly attributes: Set<string>
} {
  const set = new Set(attributes)
  return {
    attributes: set,
    setAttribute: (name: string) => {
      set.add(name)
    },
    removeAttribute: (name: string) => {
      set.delete(name)
    },
    hasAttribute: (name: string) => set.has(name),
  }
}

interface Stub {
  readonly factory: ObserverFactory
  /** Deliver a callback, exactly as the browser would. */
  fire(entries: readonly ObservedEntry[]): void
  readonly observed: ObservedElement[]
  readonly unobserved: ObservedElement[]
  readonly options: { rootMargin?: string; threshold?: number } | undefined
  readonly disconnects: number
  readonly instances: number
}

/** A stubbed `IntersectionObserver`: it records, and it fires when the test says so. */
function stub(): Stub {
  const state = {
    observed: [] as ObservedElement[],
    unobserved: [] as ObservedElement[],
    disconnects: 0,
    instances: 0,
    options: undefined as { rootMargin?: string; threshold?: number } | undefined,
  }
  let deliver: ((entries: readonly ObservedEntry[], self: Observer) => void) | undefined
  let observer: Observer | undefined

  const factory: ObserverFactory = (callback, options) => {
    state.instances += 1
    state.options = options
    deliver = callback
    observer = {
      observe: (target) => {
        state.observed.push(target)
      },
      unobserve: (target) => {
        state.unobserved.push(target)
      },
      disconnect: () => {
        state.disconnects += 1
      },
    }
    return observer
  }

  return {
    factory,
    fire: (entries) => {
      if (deliver === undefined || observer === undefined) throw new Error('nothing was observing')
      deliver(entries, observer)
    },
    get observed() {
      return state.observed
    },
    get unobserved() {
      return state.unobserved
    },
    get options() {
      return state.options
    },
    get disconnects() {
      return state.disconnects
    },
    get instances() {
      return state.instances
    },
  }
}

describe('acceptance — the reveal fallback disconnects after the first intersection', () => {
  it('reveals on intersection and disconnects, once', () => {
    const observer = stub()
    const target = element()
    expect(revealOnFirstIntersection([target], observer.factory)).toBeDefined()
    expect(observer.observed).toEqual([target])
    expect(observer.options?.rootMargin).toBe(REVEAL_ROOT_MARGIN)

    observer.fire([{ target, isIntersecting: true }])

    expect(target.hasAttribute(REVEALED_ATTRIBUTE)).toBe(true)
    expect(observer.unobserved).toEqual([target])
    expect(observer.disconnects).toBe(1)
  })

  it('does nothing at all before the element has arrived', () => {
    // The control, and it is the one that matters: an IntersectionObserver fires **once at
    // registration** with `isIntersecting: false` for everything off screen. A fallback that acted on
    // any callback would reveal the whole page immediately — and would still pass the assertion above,
    // because `disconnect` would have been called either way.
    const observer = stub()
    const target = element()
    revealOnFirstIntersection([target], observer.factory)

    observer.fire([{ target, isIntersecting: false }])

    expect(target.hasAttribute(REVEALED_ATTRIBUTE)).toBe(false)
    expect(observer.unobserved).toEqual([])
    expect(observer.disconnects).toBe(0)

    observer.fire([{ target, isIntersecting: true }])
    expect(target.hasAttribute(REVEALED_ATTRIBUTE)).toBe(true)
    expect(observer.disconnects).toBe(1)
  })

  it('keeps watching the elements that have not arrived yet', () => {
    const observer = stub()
    const [first, second, third] = [element(), element(), element()]
    revealOnFirstIntersection([first, second, third], observer.factory)
    // One observer for the page, not one per element: fourteen live callbacks competing with a scroll is
    // the cost this fallback exists to avoid.
    expect(observer.instances).toBe(1)
    expect(observer.observed).toHaveLength(3)

    observer.fire([{ target: second, isIntersecting: true }])
    expect(observer.disconnects).toBe(0)
    expect(first.hasAttribute(REVEALED_ATTRIBUTE)).toBe(false)

    observer.fire([
      { target: first, isIntersecting: true },
      { target: third, isIntersecting: false },
    ])
    expect(observer.disconnects).toBe(0)

    observer.fire([{ target: third, isIntersecting: true }])
    expect(observer.disconnects).toBe(1)
    expect(observer.unobserved).toEqual([second, first, third])
  })

  it('never reveals the same element twice', () => {
    const observer = stub()
    const target = element()
    revealOnFirstIntersection([target], observer.factory)
    observer.fire([{ target, isIntersecting: true }])
    observer.fire([{ target, isIntersecting: true }])
    // Once, and only once: a second decrement would take the counter negative and a remount would
    // re-hide content the reader is already reading.
    expect(observer.unobserved).toEqual([target])
    expect(observer.disconnects).toBe(1)
  })

  it('creates no observer for a page with nothing left to reveal', () => {
    const empty = stub()
    expect(revealOnFirstIntersection([], empty.factory)).toBeUndefined()
    expect(empty.instances).toBe(0)

    const done = stub()
    expect(revealOnFirstIntersection([element([REVEALED_ATTRIBUTE])], done.factory)).toBeUndefined()
    expect(done.instances).toBe(0)
  })
})

describe('the header fallback is a state, not an arrival', () => {
  it('condenses while the sentinel is off screen and restores when it returns', () => {
    const observer = stub()
    const sentinel = element()
    const header = element()
    condenseWhileSentinelIsOffScreen(sentinel, header, observer.factory)
    expect(observer.observed).toEqual([sentinel])

    observer.fire([{ target: sentinel, isIntersecting: false }])
    expect(header.hasAttribute(CONDENSED_ATTRIBUTE)).toBe(true)

    observer.fire([{ target: sentinel, isIntersecting: true }])
    expect(header.hasAttribute(CONDENSED_ATTRIBUTE)).toBe(false)
  })

  it('stays connected, unlike the reveal', () => {
    // The control on the pair. A one-shot here would condense the header once and leave it condensed at
    // the top of the page — which says "you have moved" when the reader has not — and a test that only
    // ever asserted `disconnect` was called would have accepted it.
    const observer = stub()
    const sentinel = element()
    condenseWhileSentinelIsOffScreen(sentinel, element(), observer.factory)
    observer.fire([{ target: sentinel, isIntersecting: false }])
    observer.fire([{ target: sentinel, isIntersecting: true }])
    expect(observer.disconnects).toBe(0)
    expect(observer.unobserved).toEqual([])
  })
})
