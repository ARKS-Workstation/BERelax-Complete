/**
 * The HTML part of a transactional email, built from the template's text body.
 *
 * Resend's port requires **both** parts (`packages/providers/src/email/port.ts`): an HTML-only
 * transactional email is a deliverability problem rather than a stylistic one. So the HTML is derived
 * from the one body the template author wrote, and there is no second body to keep in step — a template
 * with an HTML variant and a text variant is two messages that will eventually say different things, and
 * the one nobody previews is the one that ships wrong.
 *
 * ## Why it is here and not in the transport
 *
 * The admin inbox shows the HTML part in a preview pane, reading `message.body_html` — the bytes the
 * provider was actually given. That means the HTML has to exist at the moment the row is written, which
 * is outside `transports/`, so this module carries no provider import and the transport and the row use
 * the same function. A preview pane that re-rendered the body would be showing something nobody sent.
 *
 * ## Why `safeText` and not just escaping
 *
 * A rendered body contains customer data: `Customer 0042`, a service name, a magic link. Escaping stops
 * markup injection into a message this business signs with its own sending domain, where the blast radius
 * is the domain's reputation rather than one page. `safeText` from `@berelax/core` also strips bidi
 * controls, which escaping does nothing about — a single U+202E reverses the rest of the line, and an
 * Arabic-capable template is exactly where one arrives unnoticed.
 */
import { safeText } from '@berelax/core'
import type { OutboundMessage } from './port.ts'

/**
 * The HTML part for one message.
 *
 * Blank lines become paragraphs and single newlines become `<br>`, which is the shape every text
 * template in this system is written in. Inline styles rather than a stylesheet, because an email client
 * strips `<style>` as often as it honours it; the colours are the CSS system keywords rather than hex, so
 * this file needs no exemption from `pnpm colours` and the message inherits the reader's own light or
 * dark preference instead of fighting it.
 */
export function renderEmailHtml(message: OutboundMessage): string {
  const paragraphs = message.body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map(
      (block) =>
        `<p style="margin:0 0 1em">${block
          .split('\n')
          .map((line) => safeText(line))
          .join('<br>')}</p>`,
    )
    .join('')
  const dir = message.locale === 'ar' ? 'rtl' : 'ltr'
  return [
    `<!doctype html><html lang="${message.locale}" dir="${dir}"><head>`,
    '<meta charset="utf-8">',
    `<title>${safeText(message.subject ?? '')}</title>`,
    '</head>',
    '<body style="margin:0;padding:24px;font:16px/1.6 system-ui,sans-serif;' +
      'color:CanvasText;background:Canvas">',
    `<main style="max-width:36em;margin:0 auto">${paragraphs}</main>`,
    '</body></html>',
  ].join('')
}
