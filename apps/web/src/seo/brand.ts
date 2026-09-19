/**
 * The bare brand, and why it may never be published on its own.
 *
 * docs/09 §"The brand collision" and docs/13 §6 record the same problem twice, which is how much it matters:
 * **`berelax.com` is an international airport-spa chain called Be Relax, with an outlet at Abu Dhabi
 * International Airport** — same name, same city, vastly more domain authority. Ask an assistant about "Be
 * Relax Abu Dhabi" today and it describes the airport spa.
 *
 * The entity strategy that follows is one sentence: *"Always the full name 'Be Relax Massage Center and
 * Spa', never the bare brand, in titles, schema, GBP and every citation."* A title or a schema `name`
 * carrying the bare brand is not a missed opportunity — it is a citation that reinforces the wrong entity,
 * and the KPI docs/09 defines ("the assistant described the airport spa") is measured against exactly these
 * strings.
 *
 * So this is a rule with a name, not a style note. `apps/web/src/seo/brand.test.ts` scans the title-bearing
 * source of `apps/web` and `packages/ui` for violations, and `structured-data.itest.ts` applies the same
 * predicate to the `name` and `legalName` the real premises row publishes into the graph.
 */

/** The rule name a finding quotes, so a reworded message is not a reworded rule. */
export const BARE_BRAND_RULE = 'bare-brand-without-massage-center'

/**
 * The brand, and what has to follow it.
 *
 * `be\s*relax` matches `Be Relax`, `BE RELAX` and `BeRelax`, because all three appear in the wild (the live
 * domain is `berelaxmassage.com` and the prototype's wordmark is set as one word). The qualifier is
 * `Massage Cent(er|re)` — the American spelling is the one docs/13 §1 records as the trading name, and the
 * British one is here because it is what somebody will type, and a rule that passed the wrong spelling
 * silently would be worse than one that refuses it loudly.
 *
 * The separator class is what makes this usable rather than pedantic: the trading name is written both
 * `Be Relax Massage Center and Spa` and `BE RELAX — Massage Center and Spa`, so a space, a dash, a comma or
 * a colon between the two halves is the same name. Four characters, which is what ` — ` and `, ` need and no
 * more: a word between them means the brand is standing alone in that sentence, and so does a gap wide
 * enough to hold one.
 */
const BRAND = /be\s*relax/gi
const QUALIFIED = /^[\s\p{Pd}·,:|]{0,4}massage\s+cent(?:er|re)/iu

/** One place the bare brand appears unqualified, with enough context to find it. */
export interface BareBrandFinding {
  readonly rule: typeof BARE_BRAND_RULE
  /** The character offset of the brand mention. */
  readonly index: number
  /** The brand mention and what follows it, so a message can show why it failed. */
  readonly excerpt: string
}

/**
 * Every unqualified mention of the brand in a string.
 *
 * Returns all of them rather than the first, for the reason `lintPublicDisplayName` gives: somebody told
 * about one occurrence fixes that one and submits the same string again.
 */
export function bareBrandFindings(text: string): readonly BareBrandFinding[] {
  const findings: BareBrandFinding[] = []
  BRAND.lastIndex = 0
  let match = BRAND.exec(text)
  while (match !== null) {
    const after = text.slice(match.index + match[0].length)
    if (!QUALIFIED.test(after)) {
      findings.push({
        rule: BARE_BRAND_RULE,
        index: match.index,
        excerpt: text.slice(match.index, match.index + match[0].length + 32),
      })
    }
    match = BRAND.exec(text)
  }
  return findings
}

/** True when every mention of the brand in `text` is followed by the qualifier. */
export function brandIsQualified(text: string): boolean {
  return bareBrandFindings(text).length === 0
}
