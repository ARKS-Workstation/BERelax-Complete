/**
 * The promotional controls console, as HTML — C-AUTO-05.
 *
 * Pure: rows in, a document out, no database and no clock. That is what lets a render test assert what the
 * screen SAYS without a server, and it is why nothing here reads `new Date()`: a document that printed "as of
 * now" could not produce two identical screenshots on a repeat run.
 *
 * ## What the screen is for, and the one thing it must always say
 *
 * Two controls stop promotional traffic — the marketing kill switch somebody engages, and the promotional
 * sender ID TDRA suspends — and neither of them stops a booking confirmation, a reminder or an OTP. The
 * banner therefore always carries that sentence, because it is the first question staff ask when a screen
 * says something has stopped, and the answer is what keeps a marketing sanction from being escalated as an
 * outage. `promotionalSendingBanner` in `@berelax/messaging` is the one place the four states and their words
 * live, so this file renders them rather than composing its own.
 *
 * ## Why the last-changed actor and instant are on the card and not behind a link
 *
 * A switch whose state you can see and whose owner you cannot is a switch nobody takes back off: the person
 * looking at it does not know whether it was engaged an hour ago for a complaint or three weeks ago by
 * somebody who has left. So the card carries `changed_by`, `changed_by_role`, the instant and the reason,
 * which is exactly the row `messaging_control` holds.
 *
 * ## Why this is a document served by a route handler
 *
 * W-SITE-01's registry is in exact bijection with the filesystem and requires every *document* to be served
 * in both locales, so a `page.tsx` here would need an Arabic admin document and the admin shell to render it
 * — W-SYS-01's work — and it would join a twelve-cell screenshot matrix whose RTL half must be a real Arabic
 * route. The Messages inbox, the breakpoint preview and the compliance screens are the precedents. This
 * surface is English-only and shows an operator the state of two controls.
 */
import { safeText } from '@berelax/core'
import type { MessagingControlRow } from '@berelax/db'
import {
  type MarketingKillSwitchState,
  type PromotionalSendingBanner,
  promotionalSendingBanner,
} from '@berelax/messaging'
import type { MessagingControlKey } from '@berelax/shared'
import { tokensCss } from '@berelax/ui'
import {
  type AdminChrome,
  GOOGLE_REAUTH_BANNER_CSS,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'

/** The page's own styles. Colours are tokens only; there is no literal in this file (`pnpm colours`). */
const CONTROLS_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-5); }
  h2 { font-size: 1.125rem; margin: 0 0 var(--space-3); }
  p { margin: 0 0 var(--space-5); }
  .banner {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  .banner.is-stopped { border-inline-start-color: var(--color-danger); }
  .banner.is-sending { border-inline-start-color: var(--color-success); }
  .banner p:last-child { margin: 0; }
  ol.controls { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-5); }
  article {
    background: var(--color-surface);
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    padding: var(--space-5);
  }
  .state { display: inline-flex; align-items: center; gap: var(--space-3); font-weight: 600; }
  .dot { width: var(--space-4); height: var(--space-4); border-radius: var(--radius-handle); }
  .dot-engaged { background: var(--color-danger); }
  .dot-disengaged { background: var(--color-success); }
  dl.facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: var(--space-3) var(--space-5);
    margin: var(--space-5) 0 0;
  }
  dl.facts dt { color: var(--color-ink-2); font-size: 0.875rem; }
  dl.facts dd { margin: 0; font-variant-numeric: tabular-nums; }
  form { margin: var(--space-5) 0 0; display: grid; gap: var(--space-3); }
  label { color: var(--color-ink-2); font-size: 0.875rem; }
  input[type='text'] {
    font: inherit;
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface);
    color: var(--color-ink);
    min-height: var(--control-min);
  }
  button {
    font: inherit;
    min-height: var(--control-min);
    padding: var(--space-3) var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface-sand);
    color: var(--color-ink);
    cursor: pointer;
  }
  .refused {
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-2);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  .note { color: var(--color-ink-2); font-size: 0.875rem; margin: var(--space-3) 0 0; }
`

/** What a control's card needs, which is the row plus the words for it. */
export interface ControlView {
  readonly key: MessagingControlKey
  readonly heading: string
  /** Why this control exists, in the words an operator needs before touching it. */
  readonly purpose: string
  readonly row: MessagingControlRow
}

export interface ControlsView {
  readonly killSwitch: MarketingKillSwitchState
  readonly controls: readonly ControlView[]
  /** The signed-in role, so the form is absent rather than present-and-refused for somebody who may not. */
  readonly role: string
  readonly mayToggle: boolean
  /** A refusal or a confirmation from a POST, if this response is answering one. */
  readonly notice: { readonly kind: 'refused' | 'done'; readonly detail: string } | null
  /**
   * The admin chrome, for the Google re-auth banner every admin document carries.
   *
   * Added at merge rather than by this unit, because `google-reauth-banner.test.ts` scans EVERY admin
   * document and this screen was the one that rendered none — an operator toggling the kill switch would not
   * have been told the Google connection was dead. It matters more here than on most screens: this console is
   * where somebody goes when messages are not arriving, and a dead connection is one of the reasons.
   */
  readonly chrome: AdminChrome
}

const CONTROL_HEADINGS: Readonly<
  Record<MessagingControlKey, { heading: string; purpose: string }>
> = {
  marketing_kill_switch: {
    heading: 'Marketing kill switch',
    purpose:
      'Engaging this refuses every promotional send immediately, across every campaign and every ' +
      'automation. It cannot stop a booking confirmation, a reminder or an OTP: those never reach this ' +
      'check.',
  },
  promotional_sender_suspended: {
    heading: 'Promotional sender ID suspended',
    purpose:
      'Recorded when the vendor is rejecting sends from the promotional sender ID — a TDRA suspension. ' +
      'The transactional identity is registered separately and is unaffected, which is why two exist.',
  },
}

export const CONTROL_COPY = CONTROL_HEADINGS

/** `2099-07-04 08:30 UTC`. Stated as UTC rather than localised: the row is an instant, not a wall clock. */
function instantLabel(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function controlArticle(view: ControlView, mayToggle: boolean): string {
  const { row } = view
  const engaged = row.engaged
  const direction = engaged ? 'disengage' : 'engage'
  return [
    `<article data-control="${safeText(view.key)}">`,
    `<h2>${safeText(view.heading)}</h2>`,
    `<p class="state"><span class="dot dot-${engaged ? 'engaged' : 'disengaged'}"></span>`,
    `<span data-state="${safeText(view.key)}">${engaged ? 'Engaged' : 'Not engaged'}</span></p>`,
    `<p>${safeText(view.purpose)}</p>`,
    '<dl class="facts">',
    // The two the acceptance line names, and they are the reason this card exists at all.
    `<div><dt>Last changed by</dt><dd data-actor="${safeText(view.key)}">${safeText(
      row.changedBy,
    )} (${safeText(row.changedByRole)})</dd></div>`,
    `<div><dt>Last changed at</dt><dd><time datetime="${safeText(
      new Date(row.changedAt).toISOString(),
    )}" data-changed-at="${safeText(view.key)}">${safeText(
      instantLabel(row.changedAt),
    )}</time></dd></div>`,
    `<div><dt>Direction</dt><dd>${safeText(row.direction)}</dd></div>`,
    `<div><dt>Reason given</dt><dd>${safeText(row.reason)}</dd></div>`,
    '</dl>',
    mayToggle
      ? [
          `<form method="post" action="/messaging/controls">`,
          `<input type="hidden" name="control" value="${safeText(view.key)}">`,
          `<input type="hidden" name="direction" value="${direction}">`,
          `<label for="reason-${safeText(view.key)}">Reason (required, and recorded against you)</label>`,
          `<input type="text" id="reason-${safeText(view.key)}" name="reason" required>`,
          `<button type="submit">${engaged ? 'Disengage' : 'Engage'}</button>`,
          '</form>',
        ].join('')
      : '<p class="note">Your role may not change this. Ask the owner or a manager.</p>',
    '</article>',
  ].join('')
}

function bannerClass(banner: PromotionalSendingBanner): string {
  return banner.state === 'sending' ? 'banner is-sending' : 'banner is-stopped'
}

export function renderControlsHtml(view: ControlsView): string {
  const suspended =
    view.controls.find((control) => control.key === 'promotional_sender_suspended')?.row.engaged ??
    false
  // The banner's state comes from the SWITCH AS THE GATE SEES IT, which is the stored row OR a
  // non-production environment — not from the row alone. A screen that said "sending" on staging while the
  // gate refused everything would be the second statement of the switch's state this unit exists to remove.
  const banner = promotionalSendingBanner({
    killSwitchEngaged: view.killSwitch.engaged,
    senderSuspended: suspended,
  })

  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<title>Promotional controls — messaging admin</title>',
    `<style>${tokensCss()}${GOOGLE_REAUTH_BANNER_CSS}${CONTROLS_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Promotional controls</h1>',
    view.notice === null
      ? ''
      : `<div class="${view.notice.kind === 'refused' ? 'refused' : 'banner'}" role="status">` +
        `<p>${safeText(view.notice.detail)}</p></div>`,
    `<section class="${bannerClass(banner)}" role="status" data-banner="${safeText(banner.state)}">`,
    `<p><strong>${safeText(banner.headline)}</strong></p>`,
    `<p>${safeText(banner.detail)}</p>`,
    '</section>',
    view.killSwitch.source === 'non_production_default'
      ? '<p class="note">This is not production, so the kill switch is engaged whatever the row below ' +
        'says, and cannot be disengaged here. A seeded or imported campaign must not fire during a ' +
        'walkthrough.</p>'
      : '',
    `<ol class="controls">${view.controls
      .map((control) => `<li>${controlArticle(control, view.mayToggle)}</li>`)
      .join('')}</ol>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

/** The cards, in a declared order, with the copy for each. Total over the vocabulary. */
export function controlViewsFrom(
  rows: Readonly<Record<MessagingControlKey, MessagingControlRow>>,
): readonly ControlView[] {
  return (Object.keys(CONTROL_HEADINGS) as MessagingControlKey[]).map((key) => ({
    key,
    heading: CONTROL_HEADINGS[key].heading,
    purpose: CONTROL_HEADINGS[key].purpose,
    row: rows[key],
  }))
}
