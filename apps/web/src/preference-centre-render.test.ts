import { unreachableOptOutPhrasesIn } from '@berelax/core'
import { PREFERENCE_GRID } from '@berelax/db'
import { describe, expect, it } from 'vitest'
import {
  cellName,
  PREFERENCE_MAIN_OPEN,
  type PreferenceCellView,
  type PreferenceCentreView,
  type PreferenceLocale,
  renderPreferenceCentreHtml,
} from '../app/(public)/preferences/render.ts'

/**
 * C-CRM-07 — the preference centre's renderer, which is pure, so this needs no database and no browser.
 *
 * Four claims live here because they are claims about the BYTES rather than about a row:
 *
 *   - **A valid link and a refused one produce the same shell.** Asserted as byte equality of everything
 *     outside `<main>`'s children, with the control that what is inside differs. That is the acceptance
 *     criterion — *"the same status code and the same page shell (snapshot comparison), so the page never
 *     reveals whether a contact is known to the business"* — and half of it (the status) is asserted in
 *     `preference-centre.itest.ts` against a real response.
 *   - **Every cell of the REAL grid is named in both languages.** Over `PREFERENCE_GRID` from
 *     `@berelax/db`, not over a list retyped here, so a channel or purpose added to `@berelax/shared`
 *     without words fails this rather than reaching a customer as `review_request`.
 *   - **No control is unlabelled and no two share a name.** Six buttons all reading "Stop" is a page a
 *     screen reader cannot navigate, and `button-name` is one of the two rule ids the axe control in the
 *     integration suite asserts — so this is the cheap half of the same check.
 *   - **Nothing on the page tells anybody to reply STOP.** The page is the alternative to that instruction,
 *     so it is the one surface where saying it would be self-contradicting as well as untrue.
 */

const CELLS: readonly PreferenceCellView[] = PREFERENCE_GRID.map((cell, index) => ({
  channel: cell.channel,
  purpose: cell.purpose,
  // Three states across six cells, so every branch of the renderer's state word and its stop/start choice
  // is exercised by the base view rather than by a case that constructs one.
  consent: (['granted', 'withdrawn', 'unknown'] as const)[index % 3] ?? 'granted',
}))

const DESK = '+97165551234'

function view(overrides: Partial<PreferenceCentreView> = {}): PreferenceCentreView {
  return {
    locale: 'en',
    cells: CELLS,
    suppressed: false,
    suppressionSource: null,
    wording: [
      {
        purpose: 'marketing',
        version: 3,
        text: 'PROVISIONAL DRAFT marketing wording for C-CRM-07 render tests.',
        isProvisional: true,
      },
      {
        purpose: 'review_request',
        version: 2,
        text: 'PROVISIONAL DRAFT review-request wording for C-CRM-07 render tests.',
        isProvisional: true,
      },
    ],
    linkExpiresAtIso: '2026-10-19T10:00:00.000Z',
    outcome: { kind: 'none' },
    deskPhoneE164: DESK,
    otherLocaleHref: '/preferences?c=x&t=y&lang=ar',
    emailDetailHeld: false,
    ...overrides,
  }
}

/** Everything outside `<main>`'s children: the prologue up to the one `<main>`, and the epilogue after it. */
function shellOf(html: string): { readonly prologue: string; readonly epilogue: string } {
  const open = html.indexOf(PREFERENCE_MAIN_OPEN)
  const close = html.indexOf('</main>')
  if (open === -1 || close === -1) {
    throw new Error(
      `The document has no single ${PREFERENCE_MAIN_OPEN} … </main> to split on, so the shell cannot be ` +
        'compared. If the wrapper was renamed, rename PREFERENCE_MAIN_OPEN with it rather than loosening ' +
        'this — the comparison is the acceptance criterion.',
    )
  }
  return {
    prologue: html.slice(0, open + PREFERENCE_MAIN_OPEN.length),
    epilogue: html.slice(close),
  }
}

/** Every `<button>`'s text, in document order. The accessible name of a plain submit button is its text. */
const buttonNames = (html: string): readonly string[] =>
  [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) => (match[1] ?? '').trim())

describe('acceptance — a refused link and a valid one share one shell', () => {
  for (const locale of ['en', 'ar'] as const) {
    it(`is byte-identical outside <main> in ${locale}`, () => {
      const valid = renderPreferenceCentreHtml(view({ locale }))
      const refused = renderPreferenceCentreHtml(
        // Exactly what the handler builds for an unknown token: the locale from the URL and nothing else.
        view({ locale, cells: null, wording: [], linkExpiresAtIso: null }),
      )
      expect(shellOf(refused).prologue).toBe(shellOf(valid).prologue)
      expect(shellOf(refused).epilogue).toBe(shellOf(valid).epilogue)

      // The control. Without it a renderer that returned one constant document would pass the two
      // assertions above, and the page would tell nobody anything at all.
      expect(refused).not.toBe(valid)
      expect(valid).toContain('data-preference-body="grid"')
      expect(refused).toContain('data-preference-body="unavailable"')
      expect(refused).not.toContain('data-preference-cell=')
    })
  }

  it('never carries the contact id or the token into the document', () => {
    // The capability is in the URL and the URL is a Referer away from every link on the page, so the one
    // place it must not ALSO be is the bytes. The language switch is the single exception and it is the whole
    // point of it, so it is excluded by taking the document apart rather than by loosening the search — and
    // it lives inside `<main>` for exactly that reason, because the shell must not differ per request.
    const html = renderPreferenceCentreHtml(
      view({ otherLocaleHref: '/preferences?c=CONTACT-ID&t=TOKEN-VALUE&lang=ar' }),
    )
    const withoutTheLanguageLink = html.replace(
      /<p data-preference-region="language">[\s\S]*?<\/p>/,
      '',
    )
    expect(withoutTheLanguageLink).not.toContain('CONTACT-ID')
    expect(withoutTheLanguageLink).not.toContain('TOKEN-VALUE')
    // The control: the search would find them if they were there.
    expect(html).toContain('TOKEN-VALUE')
  })
})

describe('acceptance — both languages and both directions', () => {
  it('renders ar as dir=rtl and en as dir=ltr, and they are different documents', () => {
    const english = renderPreferenceCentreHtml(view({ locale: 'en' }))
    const arabic = renderPreferenceCentreHtml(view({ locale: 'ar' }))
    expect(english).toContain('<html lang="en" dir="ltr">')
    expect(arabic).toContain('<html lang="ar" dir="rtl">')
    // The control on the pair: an Arabic page is not the English one with an attribute flipped.
    expect(arabic.replace('lang="ar" dir="rtl"', 'lang="en" dir="ltr"')).not.toBe(english)
  })

  it('names every cell of the real grid in both languages, and never as its raw value', () => {
    expect(PREFERENCE_GRID.length).toBe(6)
    for (const locale of ['en', 'ar'] as const) {
      for (const cell of PREFERENCE_GRID) {
        const name = cellName(cell, locale)
        expect(name, `${locale} ${cell.channel}:${cell.purpose}`).not.toContain(cell.channel)
        expect(name, `${locale} ${cell.channel}:${cell.purpose}`).not.toContain(cell.purpose)
        expect(name.length).toBeGreaterThan(3)
      }
    }
    // The control, and it is the assertion that matters: a cell with no words falls back to the raw value,
    // so the loop above CAN fail. Without this, a `cellName` that returned a constant would pass it.
    expect(cellName({ channel: 'pigeon', purpose: 'gossip' }, 'en')).toContain('pigeon')
  })

  it('gives every button a distinct, non-empty name in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const names = buttonNames(renderPreferenceCentreHtml(view({ locale })))
      // Six cells plus "stop everything".
      expect(names, locale).toHaveLength(PREFERENCE_GRID.length + 1)
      for (const name of names) expect(name.length, `${locale}: '${name}'`).toBeGreaterThan(2)
      expect(new Set(names).size, `${locale}: ${names.join(' | ')}`).toBe(names.length)
    }
  })
})

describe('acceptance — the page is the opt-out, so it never names a reply keyword', () => {
  for (const locale of ['en', 'ar'] as const) {
    it(`renders no unreachable opt-out instruction in ${locale}`, () => {
      const documents = [
        renderPreferenceCentreHtml(view({ locale })),
        renderPreferenceCentreHtml(view({ locale, cells: null, wording: [] })),
        renderPreferenceCentreHtml(view({ locale, suppressed: true, suppressionSource: 'manual' })),
        renderPreferenceCentreHtml(
          view({
            locale,
            outcome: { kind: 'refused', refusal: 'preference_grant_on_a_tombstone' },
          }),
        ),
      ]
      for (const html of documents) expect(unreachableOptOutPhrasesIn(html)).toEqual([])
      // The control on the predicate, in this file, so a scan that could never fire cannot pass this case.
      expect(unreachableOptOutPhrasesIn(`${documents[0]}<p>Reply STOP to unsubscribe</p>`)).toEqual(
        ['Reply STOP', 'STOP to'],
      )
    })
  }
})

describe('the states the page has words for', () => {
  it('prints the suppression banner only when the handset is on the list', () => {
    expect(renderPreferenceCentreHtml(view())).not.toContain('data-preference-state="suppressed"')
    const html = renderPreferenceCentreHtml(
      view({ suppressed: true, suppressionSource: 'preference_centre' }),
    )
    expect(html).toContain('data-preference-state="suppressed"')
    expect(html).toContain('data-preference-suppression-source="preference_centre"')
  })

  it('always prints the consequence of stopping a handset row', () => {
    // The repository suppresses the NUMBER, which stops every promotional message to it. A page that let a
    // reader believe a single toggle was single would be making a promise the key cannot keep.
    for (const locale of ['en', 'ar'] as const) {
      expect(renderPreferenceCentreHtml(view({ locale }))).toContain(
        'data-preference-note="handset"',
      )
    }
  })

  it('says an email row records a decision and nothing else, until an address is held', () => {
    expect(renderPreferenceCentreHtml(view({ emailDetailHeld: false }))).toContain(
      'data-preference-note="email"',
    )
    expect(renderPreferenceCentreHtml(view({ emailDetailHeld: true }))).not.toContain(
      'data-preference-note="email"',
    )
  })

  it('marks a provisional wording as a draft and an approved one not at all', () => {
    const provisional = renderPreferenceCentreHtml(view())
    expect(provisional).toContain('data-preference-state="draft-wording"')
    expect(provisional).toContain('data-preference-wording-version="3"')
    const approved = renderPreferenceCentreHtml(
      view({
        wording: [
          { purpose: 'marketing', version: 4, text: 'Approved words.', isProvisional: false },
        ],
      }),
    )
    expect(approved).not.toContain('data-preference-state="draft-wording"')
    expect(approved).toContain('data-preference-wording-version="4"')
  })

  it('prints one statement per purpose, each marked with the purpose it is for', () => {
    // The defect this catches is silent and is about the ROW rather than the page: one statement standing in
    // for both means a `review_request` grant recorded against words that say nothing about review requests,
    // and `consent_grant_carries_its_wording` is satisfied by any version at all.
    const html = renderPreferenceCentreHtml(view())
    const purposes = [...new Set(PREFERENCE_GRID.map((cell) => cell.purpose))]
    expect(purposes).toHaveLength(2)
    for (const purpose of purposes) {
      expect(html, purpose).toContain(`data-preference-wording="${purpose}"`)
      expect(html, purpose).toContain(`data-preference-region="statement:${purpose}"`)
    }
    // The control: a purpose with nothing published prints no card, so the loop above can fail.
    const onlyOne = renderPreferenceCentreHtml(
      view({
        wording: [
          { purpose: 'marketing', version: 1, text: 'Only marketing.', isProvisional: false },
        ],
      }),
    )
    expect(onlyOne).toContain('data-preference-wording="marketing"')
    expect(onlyOne).not.toContain('data-preference-wording="review_request"')
  })

  it('answers a refusal it has no words for without claiming to know why', () => {
    const named = renderPreferenceCentreHtml(
      view({ outcome: { kind: 'refused', refusal: 'preference_grant_on_a_tombstone' } }),
    )
    expect(named).toContain('data-preference-refusal="preference_grant_on_a_tombstone"')
    expect(named).toContain('joined with another one')

    const unnamed = renderPreferenceCentreHtml(
      view({ outcome: { kind: 'refused', refusal: 'something_nobody_translated' } }),
    )
    // The NAME reaches the marker and never the prose: a closed `Record` plus a fallback that claims
    // nothing is what stops a database string being shown to a customer.
    expect(unnamed).toContain('data-preference-refusal="something_nobody_translated"')
    expect(unnamed).toContain('We could not record that change')
    expect(unnamed).not.toContain('>something_nobody_translated<')
  })

  it('offers the stop control for a granted cell and the start control otherwise', () => {
    const states: readonly PreferenceCellView['consent'][] = ['granted', 'withdrawn', 'unknown']
    for (const consent of states) {
      const first = PREFERENCE_GRID[0]
      if (first === undefined) throw new Error('PREFERENCE_GRID is empty')
      const html = renderPreferenceCentreHtml(
        view({ cells: [{ channel: first.channel, purpose: first.purpose, consent }] }),
      )
      expect(html).toContain(`data-preference-state="${consent}"`)
      expect(html, consent).toContain(
        `value="${consent === 'granted' ? 'unsubscribe' : 'resubscribe'}"`,
      )
    }
  })

  it('posts every control to the page itself with no action attribute', () => {
    // The capability is in the query string, and a form with an `action` would be a second place it is
    // written — or, if relative, a place the canonical redirect could strip it from. With no `action` the
    // browser posts to the current URL, query and all, with JavaScript off.
    const html = renderPreferenceCentreHtml(view())
    const forms = [...html.matchAll(/<form[^>]*>/g)].map((match) => match[0])
    expect(forms).toHaveLength(PREFERENCE_GRID.length + 1)
    for (const form of forms) {
      expect(form).toBe('<form method="post">')
    }
    // No script of any kind: the acceptance is that the page works with JavaScript disabled, and the
    // strongest form of that is having nothing to disable.
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onsubmit')
  })
})

describe('the locales are a closed pair', () => {
  it('has words for every locale the page can be served in', () => {
    const locales: readonly PreferenceLocale[] = ['en', 'ar']
    for (const locale of locales) {
      const html = renderPreferenceCentreHtml(view({ locale }))
      // `?? ''` in the renderer means a missing copy key renders as a blank rather than as a crash, so the
      // check is that nothing came out empty where words belong.
      expect(html, locale).not.toContain('<h1></h1>')
      expect(html, locale).not.toContain('<title></title>')
      expect(html, locale).not.toContain('<h2></h2>')
    }
  })
})
