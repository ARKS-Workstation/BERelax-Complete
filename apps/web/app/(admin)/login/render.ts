import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'

/**
 * The admin sign-in screen — W-SYS-11.
 *
 * ## Why this page renders no admin chrome
 *
 * Every other admin screen calls `renderAdminBanner(view.chrome)`, and `adminChromeFor` reads the database
 * for the Google re-authorisation notice. This one deliberately does not. A page served to somebody who is
 * not signed in must not render anything derived from the business's state — the banner says whether the
 * Google connection needs attention, which is an operational fact about this salon and not something an
 * unauthenticated visitor is owed. It also keeps the page cheap: the login screen is the one admin URL a
 * crawler or a scanner will actually reach, so it does one query (the credential lookup) on POST and none
 * at all on GET.
 *
 * ## What it never says
 *
 * The messages below never distinguish "no such staff reference" from "wrong password". `ATTEMPT_REFUSED`
 * is one string for both, and `resolveLoginAttempt` does the same work in both cases so the timing does not
 * distinguish them either. A member of staff's handle is not a secret, but a login that answers
 * differently for a handle that is not on the payroll enumerates the payroll — the argument
 * `otp_challenge` (0019) made for phone numbers.
 *
 * It also never says which role the handle belongs to, or whether that role requires a second factor,
 * before the password is right. `totp_required` is only ever reached with a verified password, so the
 * screen asking for a code is itself an admission that the password was correct — which is unavoidable and
 * is why it is only shown at that point rather than being inferable from the handle.
 */

/** What the screen is asking for. The stages are F07's `LoginStage`, less the ones that never render. */
export type LoginView =
  | { readonly kind: 'credentials'; readonly problem: LoginProblem | null }
  | {
      readonly kind: 'totp'
      readonly staffReference: string
      readonly problem: LoginProblem | null
    }
  | { readonly kind: 'enrolment_required'; readonly staffReference: string }

export type LoginProblem = 'refused' | 'totp_refused' | 'incomplete'

/**
 * One message for a wrong password and an unknown handle.
 *
 * Deliberately not "check your password": that phrasing tells somebody who guessed a handle that the handle
 * was right. It names the two things that could be wrong without saying which one is.
 */
const ATTEMPT_REFUSED =
  'That staff reference and password do not match. Check both — the reference is the internal handle ' +
  'on your rota, not an email address.'

const TOTP_REFUSED =
  'That code was not accepted. A code is valid for about thirty seconds and each one may be used ' +
  'once, so if you have just used this one, wait for the next.'

const INCOMPLETE = 'Enter both a staff reference and a password.'

function problemText(problem: LoginProblem): string {
  if (problem === 'refused') return ATTEMPT_REFUSED
  if (problem === 'totp_refused') return TOTP_REFUSED
  return INCOMPLETE
}

const LOGIN_CSS = `
main { max-width: 26rem; margin: 0 auto; padding: var(--space-8) var(--gutter); }
h1 { font-size: 1.25rem; margin-bottom: var(--space-2); }
.lede { color: var(--color-ink-2); margin-bottom: var(--space-6); }
label { display: block; font-weight: 600; margin-bottom: var(--space-1); }
input { display: block; width: 100%; padding: var(--space-3); margin-bottom: var(--space-5);
        border: 1px solid var(--color-border); border-radius: var(--radius-1);
        font: inherit; color: var(--color-ink); background: var(--color-surface); }
input:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
button { padding: var(--space-3) var(--space-5); font: inherit; font-weight: 600; cursor: pointer;
         border: 1px solid var(--color-border-strong); border-radius: var(--radius-1);
         color: var(--color-ink); background: var(--color-surface-raised); }
.problem { border-inline-start: var(--space-1) solid var(--color-danger);
           padding: var(--space-3) var(--space-4); margin-bottom: var(--space-5);
           background: var(--color-ground-sunk); }
.note { margin-top: var(--space-8); font-size: 0.875rem; color: var(--color-ink-3); }
`

function field(args: {
  readonly name: string
  readonly label: string
  readonly type: string
  readonly autocomplete: string
  readonly value?: string
  readonly autofocus?: boolean
}): string {
  return (
    `<label for="${args.name}">${safeText(args.label)}</label>` +
    `<input id="${args.name}" name="${args.name}" type="${args.type}" required ` +
    `autocomplete="${args.autocomplete}"` +
    (args.value === undefined ? '' : ` value="${safeText(args.value)}"`) +
    (args.autofocus === true ? ' autofocus' : '') +
    '>'
  )
}

/**
 * The form.
 *
 * `method="post"` to this same path, with no JavaScript anywhere on the page. That is the same decision
 * docs/09 §3 records for the public booking flow and it matters more here: a sign-in screen that needs a
 * bundle to work is a sign-in screen that fails closed for the one operator whose browser blocked it, at
 * the front desk, with a client waiting.
 *
 * `returnTo` travels as a hidden field rather than in the action's query string so that it survives a
 * failed attempt without being re-parsed from the URL each time. It is validated by `safeReturnTo` on the
 * way out, never here — a validator on the rendering side is one an attacker simply does not use.
 */
function form(args: {
  readonly returnTo: string
  readonly fields: string
  readonly submit: string
}): string {
  return (
    `<form method="post" action="/login">` +
    `<input type="hidden" name="returnTo" value="${safeText(args.returnTo)}">` +
    args.fields +
    `<button type="submit">${safeText(args.submit)}</button>` +
    '</form>'
  )
}

export function renderLoginPageHtml(view: LoginView, returnTo: string): string {
  const problem =
    'problem' in view && view.problem !== null
      ? // `role="alert"` rather than a live region: the message arrives as a new document on every
        // attempt, so there is no change for a polite region to announce — the page itself is the change,
        // and an alert is what a screen reader reads on load.
        `<p class="problem" role="alert" data-login-problem="${view.problem}">` +
        `${safeText(problemText(view.problem))}</p>`
      : ''

  const body =
    view.kind === 'credentials'
      ? form({
          returnTo,
          submit: 'Sign in',
          fields:
            field({
              name: 'staffReference',
              label: 'Staff reference',
              type: 'text',
              autocomplete: 'username',
              autofocus: true,
            }) +
            field({
              name: 'password',
              label: 'Password',
              type: 'password',
              autocomplete: 'current-password',
            }),
        })
      : view.kind === 'totp'
        ? form({
            returnTo,
            submit: 'Verify',
            fields:
              // The reference travels back as a hidden field, and the password does NOT: a second round
              // trip re-asks for it. Carrying a password through a hidden field would put it in the
              // document, which is in the browser's back cache and in any proxy that logs a body.
              `<input type="hidden" name="staffReference" value="${safeText(view.staffReference)}">` +
              field({
                name: 'password',
                label: 'Password',
                type: 'password',
                autocomplete: 'current-password',
              }) +
              field({
                name: 'totpCode',
                label: 'Six-digit code from your authenticator',
                type: 'text',
                autocomplete: 'one-time-code',
                autofocus: true,
              }),
          })
        : // `enrolment_required` is a dead end on purpose, and it is the acceptance criterion: a role that
          // must have a second factor and has none cannot sign in. There is no "continue without a code"
          // control, because that control is the bypass this whole unit exists not to have. Enrolment is
          // an operator action with a runbook, not something an unauthenticated page can start — a page
          // that could enrol a factor could enrol one for somebody else.
          '<p class="problem" role="alert" data-login-problem="enrolment_required">' +
          `Your password is correct, but the role held by <strong>${safeText(view.staffReference)}</strong> ` +
          'requires a second factor and none is enrolled. ADR 0009 makes it mandatory for every role ' +
          'that can move money, see salaries or change settings, so there is deliberately no way past ' +
          'this screen. Ask whoever administers access to enrol an authenticator — see ' +
          '<code>docs/runbooks/admin-access.md</code>.</p>'

  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's "brand collision" forbids the bare brand in any title, and
    // `apps/web/src/seo/brand.test.ts` scans every title-bearing line in `apps/web` for it. A sign-in
    // screen has even less reason than the other back-office pages to name the business.
    '<title>Sign in — staff admin</title>',
    `<style>${tokensCss()}${LOGIN_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>Staff sign-in</h1>',
    '<p class="lede">This is the back office. Every screen behind it is refused until you sign in.</p>',
    problem,
    body,
    // Stated on the page rather than only in a migration comment, because the person most likely to hit
    // it is an operator on a fresh deployment wondering why nothing works. The honest answer is that
    // nothing is wrong: there is no account yet, and there is deliberately no default one.
    '<p class="note">A new deployment has no staff accounts, and there is no default account and no ' +
      'development bypass — every sign-in is refused until somebody creates the first credential. That ' +
      'is intentional: a built-in account is one nobody rotates because nobody knows it exists.</p>',
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}
