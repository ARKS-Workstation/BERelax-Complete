import { describe, expect, it } from 'vitest'
import { costOf } from './encoding.ts'
import {
  placeholdersIn,
  renderTemplate,
  type TemplateDefinition,
  validateTemplate,
} from './render.ts'
import { DISCRETION_FORBIDDEN_VARIABLES, transactionalDefaults } from './templates.ts'

const template: TemplateDefinition = {
  key: 'booking.confirmed',
  channel: 'sms',
  locale: 'en',
  body: 'BE RELAX: your booking on {{date}} at {{time}} is confirmed. {{link}}',
  variables: ['date', 'time', 'link'],
}

const values = { date: '18 September', time: '20:00', link: 'https://example.com/b/abc' }

describe('rendering', () => {
  it('substitutes every declared variable', () => {
    expect(renderTemplate(template, values)).toBe(
      'BE RELAX: your booking on 18 September at 20:00 is confirmed. https://example.com/b/abc',
    )
  })

  it('finds the placeholders a body uses', () => {
    expect(placeholdersIn(template.body)).toEqual(['date', 'time', 'link'])
  })
})

describe('the allowlist, and why a blank is the wrong default', () => {
  it('refuses a placeholder the template did not declare', () => {
    // A typo in a template. The default behaviour of every templating library is to render it as
    // nothing, and the message goes out incomplete with a positive delivery receipt.
    expect(() =>
      validateTemplate({ ...template, body: 'Hi {{custmer_name}}', variables: ['customer_name'] }),
    ).toThrow(/undeclared variable\(s\): custmer_name/)
  })

  it('refuses a declared variable the body never uses', () => {
    expect(() =>
      validateTemplate({ ...template, variables: [...template.variables, 'unused'] }),
    ).toThrow(/never uses: unused/)
  })

  it('refuses to render when a declared value is missing, rather than rendering a blank', () => {
    const { time, ...incomplete } = values
    void time
    expect(() => renderTemplate(template, incomplete)).toThrow(/missing value\(s\) for: time/)
  })

  it('names the variable in the error, because the template was written months ago', () => {
    try {
      renderTemplate(template, { date: '18 September', time: '20:00' })
      expect.unreachable('expected a render error')
    } catch (error) {
      expect(String(error)).toContain('link')
    }
  })
})

describe('untrusted values', () => {
  it('strips a bidi override from an SMS value', () => {
    // U+202E reverses the rest of the line. In an Arabic reminder carrying a time, that is a message
    // stating the wrong time and looking perfectly ordinary.
    const rendered = renderTemplate(
      { ...template, body: 'Hi {{name}}', variables: ['name'] },
      { name: 'Ahmed\u202e' },
    )
    expect(rendered).toBe('Hi Ahmed')
  })

  it('escapes markup in an email value', () => {
    const rendered = renderTemplate(
      { ...template, channel: 'email', body: 'Hi {{name}}', variables: ['name'] },
      { name: '<script>alert(1)</script>' },
    )
    expect(rendered).toBe('Hi &lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('does not escape markup in an SMS, where there is no markup to escape', () => {
    const rendered = renderTemplate(
      { ...template, body: 'Total {{total}}', variables: ['total'] },
      { total: 'AED 350 <> 400' },
    )
    expect(rendered).toContain('<>')
  })
})

describe('discretion: no default transactional message names the treatment', () => {
  const defaults = transactionalDefaults()

  it('ships transactional defaults in both languages', () => {
    expect(defaults.length).toBeGreaterThan(0)
    const keys = new Set(defaults.map((t) => t.key))
    for (const key of keys) {
      const locales = defaults.filter((t) => t.key === key).map((t) => t.locale)
      // A customer who booked in Arabic and is reminded in English has been told the system does not
      // remember them.
      expect(new Set(locales)).toEqual(new Set(['en', 'ar']))
    }
  })

  for (const forbidden of DISCRETION_FORBIDDEN_VARIABLES) {
    it(`declares no '${forbidden}' variable in any transactional default`, () => {
      // A confirmation naming the treatment and the therapist arrives on a lock screen, and is read
      // by whoever is holding the phone. The message carries time, place and a link; everything else
      // is behind the link. docs/06 D2.
      for (const template of defaults) {
        expect(template.variables, `${template.key}/${template.locale}`).not.toContain(forbidden)
      }
    })
  }

  it('every default validates against its own declaration', () => {
    for (const template of defaults) validateTemplate(template)
  })

  it('every default renders with plausible values and produces no empty substitution', () => {
    for (const template of defaults) {
      // Markers without angle brackets: the email channel escapes them, which is correct and would
      // make this assertion about escaping rather than about substitution.
      const filled = Object.fromEntries(template.variables.map((name) => [name, `VALUE-${name}`]))
      const rendered = renderTemplate(template, filled)
      expect(rendered).not.toContain('{{')
      for (const name of template.variables) expect(rendered).toContain(`VALUE-${name}`)
    }
  })

  it('keeps every SMS default inside one segment in both languages', () => {
    // A cost gate wearing a correctness gate's clothes, and worth having: the Arabic limit is 70
    // characters against English's 160, so a body that fits comfortably in English spills into a
    // second segment in Arabic. The first draft of these templates did exactly that on all three
    // booking messages — the ones sent most often, every day, forever.
    for (const template of transactionalDefaults().filter((t) => t.channel === 'sms')) {
      const filled = Object.fromEntries(
        template.variables.map((name) => [
          name,
          name === 'link' ? 'brlx.ae/b/AbCdEf' : name === 'date' ? '18 Sep' : '20:00',
        ]),
      )
      expect(costOf('sms', renderTemplate(template, filled)).segments).toBe(1)
    }
  })
})
