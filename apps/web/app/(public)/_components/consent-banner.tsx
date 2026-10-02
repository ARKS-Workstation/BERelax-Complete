import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_CONSENT_PATH,
  ANALYTICS_CONSENT_WORDING,
  CONSENT_MODE_SIGNALS,
  CONSENT_SIGNAL_SEPARATOR,
} from '@berelax/shared'
import type { Locale } from '@berelax/ui'

/**
 * The consent banner (A-MEAS-02): the thing that produces a consent record, and ships no client module.
 *
 * ## Why this is a server component with an inline script and not a `'use client'` island
 *
 * Three reasons, and the first is the one that decides it.
 *
 * **A banner that hydrates cannot gate a tag that loads during hydration.** The whole claim of this unit
 * is that no third-party tag loads before a recorded consent. A React island's `useEffect` runs *after*
 * the first paint and after whatever else the page has already started fetching, so a gate that lives in
 * one is a gate that arrives late. The theme and the scroll-timeline fallback are inline blocking scripts
 * for the same reason, stated in `themeBootstrapScript` and `motionBootstrapScript`: a correction after
 * hydration is a visible wrong frame, and here it would be a visible wrong REQUEST.
 *
 * **`build/budgets.json` caps the client JavaScript every route ships at 4096 bytes and names the two
 * modules allowed to be in it.** A third name there fails `pnpm budgets` by rule name, and the budget has
 * under 3.5KB of room with the theme and direction providers already in it. A banner on every public page
 * is exactly the thing that budget exists to notice.
 *
 * **It has to work with no JavaScript framework at all.** The markup is rendered server-side and the two
 * buttons are plain `<button>`s; the script attaches ONE delegated listener. If the script never runs the
 * banner is visible, no cookie is written, no record exists, and the gate stays closed — which is the
 * correct degraded state rather than a blank page or a silent grant.
 *
 * ## What the inline script does, and the one thing it deliberately does not
 *
 * It answers one question before the first paint: **has a decision been recorded on this device.** If so
 * it sets `data-consent` on `<html>` to the cookie's raw value and the CSS hides the banner.
 *
 * It does NOT resolve that value into a set of signals and it does not decide whether any tag may load.
 * That is `mayLoadClientTag` in `packages/core/src/analytics/consent-gate.ts`, over
 * `grantedConsentSignals` — one gate, asked in one place, which is this unit's whole subject. The
 * attribute is a CSS hook and a readable statement of what the browser presented; it is not an authority,
 * and A-MEAS-04's tag loader reads the cookie through the gate rather than reading this.
 *
 * The script's cookie EXTRACTION is nevertheless a second parse of a format `cookieValue` already parses,
 * because a blocking script cannot import a module. So it arrives with the check that holds the two
 * equal: `apps/web/src/consent-bootstrap.test.ts` runs this exact string in a context with a fabricated
 * `document.cookie` and asserts the value it extracts is the value `grantedConsentSignals` reads from the
 * same bytes, over a generator that produces both outcomes.
 *
 * ## Why a denial writes a cookie that grants nothing rather than no cookie
 *
 * `grantedConsentSignals` reads an EMPTY cookie value as null — absent, unreadable and empty are one
 * answer and that answer is deny, which is right for the gate and useless for the banner: a visitor who
 * pressed "no" would be asked again on every page. So a denial writes {@link CONSENT_NO_SIGNALS_TOKEN},
 * which is not the name of any signal, so the shared parse discards it and grants nothing — the same
 * property that makes `analytics_storage_denied` safe to receive. The decision is therefore visible to
 * the banner and invisible to the gate, which is exactly the division wanted.
 */

/** Set on `<html>` when a decision has been recorded on this device. Read by the CSS below. */
export const CONSENT_STATE_ATTRIBUTE = 'data-consent'

/** The banner's element id, so the CSS and the integration suite name the same thing once. */
export const CONSENT_BANNER_ID = 'be-consent'

/** The attribute a button carries, whose value is the decision it posts. */
export const CONSENT_ANSWER_ATTRIBUTE = 'data-consent-answer'

/**
 * The cookie value for a decision that grants nothing.
 *
 * Deliberately not the name of any Consent Mode v2 signal, so `grantedConsentSignals` discards it and the
 * gate sees an empty grant — see the header. A constant rather than a literal in two places, and
 * `consent-bootstrap.test.ts` asserts that the shared parse grants nothing for it, which is the control
 * that matters: a token the parse happened to recognise would turn every denial into a grant.
 */
export const CONSENT_NO_SIGNALS_TOKEN = 'none'

/**
 * The banner's own CSS, authored as a string and hoisted once, exactly as `DesignSystemStyles` is.
 *
 * `[data-consent] #be-consent { display: none }` is the whole hiding mechanism, and it is a CSS rule
 * rather than a conditional render because the server cannot read a cookie on a prerendered route: `/`
 * and `/ar` are built once, so the markup is the same for everybody and the DOCUMENT decides.
 *
 * No `box-shadow`, which `pnpm layout` would refuse outside an overlay component, and no `100vh`. The
 * colours are tokens; `pnpm colours` refuses a literal hex outside the token layer.
 */
export const CONSENT_BANNER_CSS = `
#${CONSENT_BANNER_ID} {
  position: fixed;
  inset-inline: 0;
  inset-block-end: 0;
  z-index: 40;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-6);
  padding: var(--space-6) var(--space-8);
  border-block-start: 1px solid var(--color-hairline);
  background: var(--color-surface-raised);
  color: var(--color-ink);
}

#${CONSENT_BANNER_ID} p {
  flex: 1 1 20rem;
  margin: 0;
}

:root[${CONSENT_STATE_ATTRIBUTE}] #${CONSENT_BANNER_ID} {
  display: none;
}
`

interface BannerCopy {
  /** The accessible name of the region. Not the consent statement — that is the wording row's words. */
  readonly label: string
  readonly accept: string
  readonly reject: string
}

/**
 * The two button labels and the region's name, per locale.
 *
 * These are NOT part of the consent statement and are deliberately not in `ANALYTICS_CONSENT_WORDING`.
 * What the wording hash has to cover is the statement a visitor agreed to; a button saying "Accept" is
 * chrome, and folding it into the hashed text would make a relabelled button a new consent version that
 * invalidated every record written under the old one.
 */
const COPY: Record<Locale, BannerCopy> = {
  en: {
    label: 'Measurement choices',
    accept: 'Accept measurement',
    reject: 'Reject measurement',
  },
  ar: {
    label: 'خيارات القياس',
    accept: 'أوافق على القياس',
    reject: 'أرفض القياس',
  },
}

/**
 * The script that runs before first paint.
 *
 * Deliberately total: a `try` around everything, because a page must render even where `document.cookie`
 * throws, and the whole point of this script is that it cannot be the thing that breaks a document.
 *
 * Assembled from the shared constants — the cookie name, the separator, the path, the signal names — so
 * none of them is spelled twice. It names no vendor and no host: `scripts/check-egress-guard.mjs` rule 6
 * refuses a module naming an analytics destination outside a declared adapter, and a script shipped on
 * every public page is the last place one should appear.
 *
 * The POST is `keepalive` so a visitor who answers and immediately navigates still has their decision
 * recorded; without it the request is cancelled by the navigation and the banner comes back. The cookie
 * is set by the SERVER's response, not here, so the attributes are stated once beside `visitorCookie` —
 * and the attribute is only set once the response has come back, so a failed write leaves the banner up
 * and the gate closed, which is the correct degraded state.
 */
export function consentBootstrapScript(): string {
  const cookie = JSON.stringify(ANALYTICS_CONSENT_COOKIE)
  const attribute = JSON.stringify(CONSENT_STATE_ATTRIBUTE)
  const answerAttribute = JSON.stringify(CONSENT_ANSWER_ATTRIBUTE)
  const allSignals = JSON.stringify([...CONSENT_MODE_SIGNALS].join(CONSENT_SIGNAL_SEPARATOR))
  return (
    '(function(){' +
    // The extraction, structured exactly like `cookieValue` in @berelax/shared: split on `;`, compare the
    // name by EQUALITY after trimming, never by prefix — `berelax_consent_version` must not be read as
    // this cookie, and a `startsWith` is how that happens.
    'function read(){try{var p=(document.cookie||"").split(";");' +
    `for(var i=0;i<p.length;i++){var j=p[i].indexOf("=");if(j<0)continue;` +
    `if(p[i].slice(0,j).trim()!==${cookie})continue;` +
    'var v=p[i].slice(j+1).trim();return v===""?null:v}return null}catch(e){return null}}' +
    `function show(v){try{if(v!==null)document.documentElement.setAttribute(${attribute},v)}catch(e){}}` +
    'show(read());' +
    'try{document.addEventListener("click",function(e){' +
    `var t=e.target&&e.target.closest?e.target.closest("["+${answerAttribute}+"]"):null;` +
    `if(!t)return;var answer=t.getAttribute(${answerAttribute});` +
    `var granted=answer==="granted"?${allSignals}:"";` +
    'var locale=document.documentElement.lang==="ar"?"ar":"en";' +
    `fetch(${JSON.stringify(ANALYTICS_CONSENT_PATH)},{method:"POST",keepalive:true,` +
    'headers:{"content-type":"application/json"},' +
    'body:JSON.stringify({decision:answer,granted:granted===""?[]:granted.split(' +
    `${JSON.stringify(CONSENT_SIGNAL_SEPARATOR)}),locale:locale,surface:"consent_banner"})})` +
    '.then(function(r){if(r.ok)show(read())}).catch(function(){});' +
    '},false)}catch(e){}' +
    '})()'
  )
}

/**
 * The banner, rendered by both root layouts.
 *
 * It renders the wording row's EXACT words — `ANALYTICS_CONSENT_WORDING`, the same bytes migration 0125
 * published as version 1 — because the record's hash is the hash of what was shown. Rendering a paraphrase
 * here and hashing the constant would record consent against words nobody read, which is the one failure
 * the hash exists to make impossible.
 *
 * `hidden` is deliberately absent: the banner is VISIBLE in the served HTML and the document's
 * `data-consent` attribute hides it. A banner that started hidden and was revealed by script would be
 * invisible to a visitor whose script never ran — and that visitor is precisely the one who has given no
 * consent and must be asked.
 */
export function ConsentBanner({ locale }: { locale: Locale }) {
  // Indexed from a `Record<Locale, …>` rather than through a lookup that could miss: `Locale` is a union
  // of two, so a third locale is a tsc error here rather than an undefined label at runtime.
  const copy: BannerCopy = COPY[locale]
  const statement =
    locale === 'ar' ? ANALYTICS_CONSENT_WORDING.textAr : ANALYTICS_CONSENT_WORDING.textEn
  return (
    <>
      <style
        href="berelax-consent-banner"
        precedence="default"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant assembled from this module's own tokens, never user input
        dangerouslySetInnerHTML={{ __html: CONSENT_BANNER_CSS.trim() }}
      />
      <section id={CONSENT_BANNER_ID} aria-label={copy.label}>
        <p>{statement}</p>
        <span className="be-actions">
          <button
            type="button"
            className="be-action"
            {...{ [CONSENT_ANSWER_ATTRIBUTE]: 'granted' }}
          >
            {copy.accept}
          </button>
          <button
            type="button"
            className="be-action be-action--quiet"
            {...{ [CONSENT_ANSWER_ATTRIBUTE]: 'denied' }}
          >
            {copy.reject}
          </button>
        </span>
      </section>
    </>
  )
}
