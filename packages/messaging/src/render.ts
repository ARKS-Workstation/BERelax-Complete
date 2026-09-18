/**
 * Template rendering, with a declared variable allowlist.
 *
 * ## Why an undeclared variable is an error rather than an empty string
 *
 * The default behaviour of every templating library is to render an unknown placeholder as nothing.
 * That is the wrong default here, and the failure it produces is specific: *"Hi , your appointment on
 * is confirmed"* goes out to a customer, the send succeeds, the delivery receipt is positive, and
 * nothing anywhere records that the message was nonsense. There is no error to page on and no metric
 * that moves.
 *
 * So a template declares its variables, and both halves are enforced:
 *
 *  - a placeholder that is **not declared** fails to render, which catches a typo in the template;
 *  - a declared variable that is **not supplied** fails to render, which catches a caller that forgot
 *    one.
 *
 * Both throw a named error carrying the variable, because the common case is finding out from a
 * template somebody wrote three months ago.
 *
 * ## Why the output is escaped per channel
 *
 * A customer name is untrusted text. In an email body it can close a tag; in any Arabic message it can
 * carry a U+202E that reverses the rest of the line (ADR 0011). Both are handled here rather than at
 * each call site, because "remember to escape" is not a control.
 */
import { safeText, stripBidiControls } from '@berelax/core'
import { AppError } from '@berelax/shared'
import type { Channel } from './port.ts'

/** `{{customer_name}}`. Deliberately not a general expression syntax — a template is not a program. */
const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/g

export interface TemplateDefinition {
  readonly key: string
  readonly channel: Channel
  readonly locale: 'en' | 'ar'
  readonly body: string
  readonly subject?: string
  /** Every variable the body may use. A placeholder outside this list fails to render. */
  readonly variables: readonly string[]
}

export type TemplateValues = Readonly<Record<string, string | number>>

export class TemplateRenderError extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('validation', message, { details })
    this.name = 'TemplateRenderError'
  }
}

/** Placeholders a body actually uses, in order of first appearance. */
export function placeholdersIn(body: string): string[] {
  const found: string[] = []
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1]
    if (name !== undefined && !found.includes(name)) found.push(name)
  }
  return found
}

/**
 * Checks a template against its own declaration, without rendering it.
 *
 * Run at authoring time, so a template with a typo is rejected when somebody is looking at it rather
 * than at 2am when the reminder job runs.
 */
export function validateTemplate(template: TemplateDefinition): void {
  const used = placeholdersIn(template.body).concat(
    template.subject === undefined ? [] : placeholdersIn(template.subject),
  )
  const undeclared = used.filter((name) => !template.variables.includes(name))
  if (undeclared.length > 0) {
    throw new TemplateRenderError(
      `Template '${template.key}' uses undeclared variable(s): ${undeclared.join(', ')}. ` +
        'Declare them, or fix the typo — an undeclared placeholder would render as nothing and the ' +
        'message would go out incomplete with no error anywhere.',
      { key: template.key, undeclared },
    )
  }
  const unused = template.variables.filter((name) => !used.includes(name))
  if (unused.length > 0) {
    throw new TemplateRenderError(
      `Template '${template.key}' declares variable(s) it never uses: ${unused.join(', ')}. ` +
        'A declared variable is a promise the caller has to keep; an unused one makes every call site ' +
        'compute something nobody reads.',
      { key: template.key, unused },
    )
  }
}

/**
 * Renders a template.
 *
 * Every supplied value is stripped of bidi controls and, for email, HTML-escaped. A value is never
 * trusted, including one that "cannot" contain markup: a customer name typed at the front desk is
 * untrusted input like any other.
 */
export function renderTemplate(template: TemplateDefinition, values: TemplateValues): string {
  validateTemplate(template)

  const missing = template.variables.filter((name) => values[name] === undefined)
  if (missing.length > 0) {
    throw new TemplateRenderError(
      `Rendering '${template.key}' is missing value(s) for: ${missing.join(', ')}. ` +
        'Rendering a blank there would produce a message like "your appointment on  is confirmed", ' +
        'which sends successfully and is reported as delivered.',
      { key: template.key, missing },
    )
  }

  return template.body.replace(PLACEHOLDER, (_match, name: string) => {
    const value = String(values[name])
    return template.channel === 'email' ? safeText(value) : stripBidiControls(value)
  })
}
