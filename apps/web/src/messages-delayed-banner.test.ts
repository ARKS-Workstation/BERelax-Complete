import { describe, expect, it } from 'vitest'
import { ADMIN_BANNER_CSS, renderAdminBanner } from './components/admin/google-reauth-banner.ts'
import {
  MESSAGES_DELAYED_BANNER_ATTRIBUTE,
  MESSAGES_DELAYED_BANNER_CSS,
  renderMessagesDelayedBanner,
} from './components/admin/messages-delayed-banner.ts'

/**
 * The send-backlog banner's markup, and the two properties that are about what is ABSENT.
 *
 * The visible-in-a-real-browser half is `messages-inbox.itest.ts`, which drives a built application with
 * Playwright. These are the claims a parsed string can carry.
 */
describe('the messages-delayed banner', () => {
  it('renders nothing when the backlog is inside its threshold', () => {
    expect(renderMessagesDelayedBanner(null)).toBe('')
  })

  it('carries the count and the threshold, so a reader can tell a blip from a stoppage', () => {
    const html = renderMessagesDelayedBanner({ queued: 34, threshold: 20 })
    expect(html).toContain(`${MESSAGES_DELAYED_BANNER_ATTRIBUTE}="34"`)
    expect(html).toContain('data-threshold="20"')
    expect(html).toContain('34 messages are queued')
    // The threshold is on the banner so somebody who thinks it is noise can see which setting to change
    // rather than asking for the banner to be removed.
    expect(html).toContain('The alert fires at 20')
  })

  it('agrees with itself about one message', () => {
    expect(renderMessagesDelayedBanner({ queued: 1, threshold: 1 })).toContain(
      '1 message is queued',
    )
  })

  it('says what a receptionist must not do, which is the whole reason it is a banner', () => {
    expect(renderMessagesDelayedBanner({ queued: 5, threshold: 1 })).toContain(
      'Do not tell a client',
    )
  })

  it.each(['<button', '<details', '<summary', ' hidden', ' id=', '<script'])(
    'has no %s, so there is nothing to dismiss and nothing to target by name',
    (forbidden) => {
      // The re-auth banner's argument for its non-dismissible state, and it applies unchanged: the
      // person who dismissed this an hour ago is exactly the person about to promise a client a
      // confirmation that has not been sent. These documents also ship no client bundle, so a banner
      // depending on script would be absent exactly when script was.
      expect(renderMessagesDelayedBanner({ queued: 99, threshold: 1 })).not.toContain(forbidden)
    },
  )

  it.each(['display: none', 'visibility', 'opacity: 0', 'max-height'])(
    'has no %s in its CSS, so no rule can hide it',
    (forbidden) => {
      expect(MESSAGES_DELAYED_BANNER_CSS).not.toContain(forbidden)
    },
  )

  it('is in the admin chrome CSS, so a document that emits the chrome styles it', () => {
    // The 29 render modules name ADMIN_BANNER_CSS. A banner whose rules were not in that constant would
    // render unstyled on every page with nothing failing anywhere.
    expect(ADMIN_BANNER_CSS).toContain('.messages-delayed {')
    expect(ADMIN_BANNER_CSS).toContain('.google-reauth {')
  })

  it('is emitted by renderAdminBanner, above the Google banner', () => {
    const html = renderAdminBanner({
      googleReauth: {
        state: 'broken',
        headline: 'Google is disconnected',
        detail: 'Reconnect to resume posting replies.',
        dismissible: false,
        connectionId: null,
        googleEmail: null,
      },
      sendBacklog: { queued: 40, threshold: 20 },
      role: 'owner' as const,
      returnTo: '/messaging',
    })
    expect(html.indexOf('messages-delayed')).toBeGreaterThanOrEqual(0)
    // Order, and it is a judgement worth a test: the delayed-message banner is about something a member
    // of staff is doing at a terminal right now.
    expect(html.indexOf('messages-delayed')).toBeLessThan(html.indexOf('google-reauth'))
  })

  it('emits only the Google banner when the backlog is clear, and only the backlog one when it is not', () => {
    const backlogOnly = renderAdminBanner({
      googleReauth: null,
      sendBacklog: { queued: 40, threshold: 20 },
      role: 'owner' as const,
      returnTo: '/messaging',
    })
    expect(backlogOnly).toContain('messages-delayed')
    expect(backlogOnly).not.toContain('google-reauth')
    const neither = renderAdminBanner({
      googleReauth: null,
      sendBacklog: null,
      role: 'owner' as const,
      returnTo: '/messaging',
    })
    expect(neither).toBe('')
  })
})
