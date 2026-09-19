import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GOOGLE_REVOKE_ENDPOINT } from './oauth/revoke.ts'

/**
 * The offboarding runbook, parsed rather than trusted.
 *
 * docs/10 §5 ends its offboarding checklist with the phrase this file exists to honour: *"in the runbook,
 * not in someone's head"*. A checklist that lives in prose rots in a particular way — a step goes missing
 * and nobody notices, because the remaining six read like a complete list. The step that goes missing is
 * predictable, and docs/10 names it: **remove from Google Cloud project IAM**, *"the one everybody forgets
 * and the account that can change the OAuth client and consent screen"*.
 *
 * So the seven items are asserted individually, by the keyword that identifies each, against the real file
 * — and the **order** between transferring Primary Ownership and removing the user is asserted too,
 * because that one is not a matter of tidiness. A Primary Owner cannot be removed at all, so a runbook
 * that put the removal first would strand an operator at step 2 with nothing to do.
 *
 * Every assertion here is paired with a control that runs the same parser over a deliberately broken copy
 * of the document. Without those, a parser that silently matched nothing — a changed heading prefix, a
 * renamed file read as empty — would report seven passes while examining nothing, which is the failure
 * ADR 0003 exists for.
 */

const PATH = new URL('../../../docs/runbooks/google-offboarding.md', import.meta.url)
const RUNBOOK = readFileSync(PATH, 'utf8')

/** Every ATX heading, in document order, with its level. The order is half of what is being asserted. */
interface Heading {
  readonly level: number
  readonly text: string
}

function headings(markdown: string): readonly Heading[] {
  const found: Heading[] = []
  for (const line of markdown.split('\n')) {
    const match = /^(#{1,6})\s+(.*\S)\s*$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      found.push({ level: match[1].length, text: match[2] })
    }
  }
  return found
}

/** The `## Step N — …` headings, which are the checklist items as headed steps. */
function steps(markdown: string): readonly Heading[] {
  return headings(markdown).filter((h) => h.level === 2 && /^Step \d+\s/.test(h.text))
}

/** The index of the first heading whose text contains `needle`, or -1. Case-insensitive. */
function headingIndex(markdown: string, needle: string): number {
  const lower = needle.toLowerCase()
  return headings(markdown).findIndex((h) => h.text.toLowerCase().includes(lower))
}

/**
 * The seven items docs/10 §5 lists, each with the words that identify its step.
 *
 * Quoted from the document rather than paraphrased, so a reader can check the mapping by eye. The match is
 * on a distinguishing phrase rather than on the whole sentence: a runbook is allowed to phrase a step
 * better than a bullet in a design document did, and pinning the exact wording would make every
 * improvement to the runbook a test failure.
 */
const CHECKLIST: readonly { readonly item: string; readonly heading: string }[] = [
  {
    item: 'disconnect in admin (revokes at Google and zeroises the stored token)',
    heading: 'Disconnect in admin',
  },
  {
    item: 'remove them as a GBP user, transferring Primary Ownership first',
    heading: 'Business Profile',
  },
  { item: 'remove from Search Console users', heading: 'Search Console users' },
  { item: 'remove from the GA4 property', heading: 'GA4 property' },
  { item: 'remove from Google Cloud project IAM', heading: 'Google Cloud project IAM' },
  { item: 'rotate the client secret if they ever had it', heading: 'client secret' },
  { item: 'audit the sequence', heading: 'Audit the sequence' },
]

describe('the seven checklist items from docs/10 §5 are present as headed steps', () => {
  it('has exactly seven numbered steps, numbered 1 to 7 in order', () => {
    const numbers = steps(RUNBOOK).map((h) => Number(/^Step (\d+)/.exec(h.text)?.[1]))
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  for (const { item, heading } of CHECKLIST) {
    it(`covers "${item}"`, () => {
      const matches = steps(RUNBOOK).filter((h) =>
        h.text.toLowerCase().includes(heading.toLowerCase()),
      )
      // Exactly one: two steps claiming the same checklist item would mean a seventh item is missing
      // while the count still reads seven.
      expect(matches).toHaveLength(1)
    })
  }

  it('names the Cloud IAM step — the one docs/10 §5 says everybody forgets', () => {
    // Called out separately from the loop above, and not because the loop does not cover it. The
    // acceptance criterion names this step by hand, and an assertion generated from a table is one a
    // future edit to the table can silently drop.
    const index = headingIndex(RUNBOOK, 'Google Cloud project IAM')
    expect(index).toBeGreaterThanOrEqual(0)
    const step = steps(RUNBOOK).find((h) => h.text.includes('Google Cloud project IAM'))
    expect(step?.text).toMatch(/^Step 5\b/)
  })

  it('the control: a copy with the Cloud IAM step deleted fails the same check', () => {
    // Without this, a parser that matched nothing — a changed heading prefix, an unreadable file — would
    // report every assertion above as a pass while examining nothing.
    const broken = RUNBOOK.replace(
      '## Step 5 — Remove from Google Cloud project IAM',
      '## Step 5 — ',
    )
    expect(steps(broken).filter((h) => h.text.includes('Google Cloud project IAM'))).toHaveLength(0)
  })
})

describe('primary-ownership transfer precedes user removal', () => {
  /**
   * The ordering assertion, on the two sub-headings of step 2.
   *
   * There is exactly one Primary Owner of a listing and the Primary Owner **cannot be removed**. So a
   * runbook that put the removal first does not merely read oddly: it strands the operator at a step the
   * Business Profile UI will not offer, and Google's promotion waiting period then makes the recovery a
   * week long rather than a minute.
   */
  const TRANSFER = 'Transfer Primary Ownership'
  const REMOVE = 'Remove the account as a Business Profile user'

  it('both sub-steps exist', () => {
    expect(headingIndex(RUNBOOK, TRANSFER)).toBeGreaterThanOrEqual(0)
    expect(headingIndex(RUNBOOK, REMOVE)).toBeGreaterThanOrEqual(0)
  })

  it('the transfer heading comes first', () => {
    expect(headingIndex(RUNBOOK, TRANSFER)).toBeLessThan(headingIndex(RUNBOOK, REMOVE))
  })

  it('the control: swapping the two sub-steps fails the ordering assertion', () => {
    // The same parser over a copy with the two sub-steps exchanged. A `<` between two indices is exactly
    // the kind of assertion that passes when both sides are -1, and this is what rules that out.
    const a = `### Step 2a — ${TRANSFER}`
    const b = `### Step 2b — ${REMOVE}`
    const swapped = RUNBOOK.replace(a, '@@A@@').replace(b, a).replace('@@A@@', b)
    expect(headingIndex(swapped, TRANSFER)).toBeGreaterThan(headingIndex(swapped, REMOVE))
  })
})

describe('every step says whether it is automated, and a manual one says why', () => {
  /** The marker line under each step heading. `no` must carry a reason after the dash. */
  const MARKERS = [...RUNBOOK.matchAll(/^\*\*Automated:\*\*\s+(yes|no)\b(.*)$/gm)]

  it('there is one marker per step', () => {
    expect(MARKERS).toHaveLength(steps(RUNBOOK).length)
  })

  it('step 1 is the automated one and the rest are manual', () => {
    expect(MARKERS.map((m) => m[1])).toEqual(['yes', 'no', 'no', 'no', 'no', 'no', 'no'])
  })

  it('every manual step gives a reason rather than only asserting it is manual', () => {
    for (const marker of MARKERS) {
      if (marker[1] !== 'no') continue
      // An em dash and then prose. "Automated: no" with nothing after it is a step somebody will try to
      // automate, or worse, quietly skip.
      expect(marker[2] ?? '').toMatch(/—\s*\S.{20,}/)
    }
  })

  it('the control: a marker with no reason is rejected', () => {
    const broken = '**Automated:** no'
    const match = /^\*\*Automated:\*\*\s+(yes|no)\b(.*)$/m.exec(broken)
    expect(match?.[2] ?? '').not.toMatch(/—\s*\S.{20,}/)
  })
})

describe('the runbook names the endpoint the code actually calls', () => {
  it('cites the revocation endpoint verbatim', () => {
    // A runbook that named the wrong endpoint would be a step an operator performs, believes, and gets
    // nothing from. The constant is the one `revokeStoredGrant` sends to.
    expect(RUNBOOK).toContain(GOOGLE_REVOKE_ENDPOINT)
  })

  it('names the manual revocation page for a revocation that never confirms', () => {
    // The one recovery that needs no token, and therefore the only backstop when the token itself is what
    // is failing. docs/10 §4 names it as where an owner revokes by hand.
    expect(RUNBOOK).toContain('myaccount.google.com/permissions')
  })

  it('states what zeroisation does NOT guarantee', () => {
    // The claim this unit must not overstate. An UPDATE to NULL leaves the old tuple in the page until it
    // is vacuumed, and nothing here touches the WAL, a replica or a backup — so the runbook says so.
    for (const phrase of ['vacuumed', 'WAL', 'backup']) {
      expect(RUNBOOK).toContain(phrase)
    }
  })

  it('the control: the same assertions fail against a document that says none of it', () => {
    const silent = '# Runbook\n\nDisconnect the account. Done.\n'
    expect(silent).not.toContain(GOOGLE_REVOKE_ENDPOINT)
    expect(silent).not.toContain('vacuumed')
    expect(steps(silent)).toHaveLength(0)
  })
})
