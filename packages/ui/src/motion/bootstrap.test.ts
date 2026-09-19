import { describe, expect, it } from 'vitest'
import {
  MOTION_FALLBACK_ATTRIBUTE,
  MOTION_FALLBACK_FAILSAFE_MS,
  MOTION_READY_ATTRIBUTE,
  motionBootstrapScript,
  SCROLL_TIMELINE_PROPERTY,
  SCROLL_TIMELINE_VALUE,
  scrollTimelineSupported,
} from './bootstrap.ts'

describe('the support test', () => {
  it('asks about exactly the property and value the stylesheet uses', () => {
    const asked: [string, string][] = []
    scrollTimelineSupported((property, value) => {
      asked.push([property, value])
      return true
    })
    expect(asked).toEqual([[SCROLL_TIMELINE_PROPERTY, SCROLL_TIMELINE_VALUE]])
    expect(SCROLL_TIMELINE_PROPERTY).toBe('animation-timeline')
    expect(SCROLL_TIMELINE_VALUE).toBe('view()')
  })

  it('answers both ways', () => {
    expect(scrollTimelineSupported(() => true)).toBe(true)
    expect(scrollTimelineSupported(() => false)).toBe(false)
  })

  it('reads a throwing CSS.supports as unsupported rather than taking the page down', () => {
    expect(
      scrollTimelineSupported(() => {
        throw new TypeError('no such thing')
      }),
    ).toBe(false)
  })
})

describe('acceptance — the blocking bootstrap', () => {
  const script = motionBootstrapScript()

  it('tests support and sets the fallback attribute only when it is absent', () => {
    expect(script).toContain(
      `CSS.supports("${SCROLL_TIMELINE_PROPERTY}","${SCROLL_TIMELINE_VALUE}")`,
    )
    expect(script).toContain(`setAttribute("${MOTION_FALLBACK_ATTRIBUTE}"`)
    // The early return is what makes the attribute conditional. Without it every browser would take the
    // fallback path, which holds every reveal at opacity 0 and waits for an island that is not needed.
    expect(script).toContain('return;')
  })

  it('carries the failsafe that un-hides the page if no island arrives', () => {
    expect(script).toContain(`hasAttribute("${MOTION_READY_ATTRIBUTE}")`)
    expect(script).toContain(`removeAttribute("${MOTION_FALLBACK_ATTRIBUTE}")`)
    expect(script).toContain(String(MOTION_FALLBACK_FAILSAFE_MS))
  })

  it('cannot throw, because it runs before anything has painted', () => {
    expect(script.startsWith('(function(){try{')).toBe(true)
    expect(script.endsWith('}catch(e){}})()')).toBe(true)
  })

  it('stays small enough to be inline in every document', () => {
    // It is in the HTML of every page, in both locales, so its size is a per-request cost rather than a
    // cached one. 400 bytes is about a tenth of what the smallest possible module would cost once the
    // chunk, the manifest entry and the request are counted — which is the trade this script exists to
    // make, and the island budget's claim that the shared layout ships zero motion bytes depends on it
    // staying a string.
    expect(script.length).toBeLessThan(400)
  })

  it('is a single expression, so a bundler cannot reorder it away from the head', () => {
    expect(script.includes('\n')).toBe(false)
  })
})
