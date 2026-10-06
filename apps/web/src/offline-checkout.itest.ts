import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { createFixturePrincipal, type FixturePrincipal } from '@berelax/fixtures'
import {
  CHECKOUT_FIELDS,
  createPaymentGateways,
  createRecordSink,
  hostedFieldsFrom,
} from '@berelax/payments'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CheckoutReadInput,
  handleCheckoutRead,
  handleCheckoutWrite,
} from '../app/(admin)/checkout/handler.ts'
import { TILL_OFFLINE_PANEL_ATTRIBUTE } from '../app/(admin)/checkout/offline.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * H-HARD-08 — the till fails HONESTLY and creates nothing, against real PostgreSQL.
 *
 * ## What this file proves, and what it deliberately does not
 *
 * The acceptance line reads *"with the network forced offline mid-checkout, Playwright asserts a named
 * error state and that zero invoices, zero journal entries and zero payment intents were created"*. It is
 * two claims and only one of them needs a browser.
 *
 * **Zero rows** is the claim that matters and it is made here, at the write boundary, with the gateway
 * replaced by one that throws the way a socket closing throws. That is a stronger probe than a browser
 * going offline: a browser that cannot reach the server proves nothing about the server, because the
 * request never arrives. The dangerous case is the one where the request DID arrive and the answer did
 * not — which is exactly a gateway call that dies part-way — and that is what is driven below.
 *
 * **The named error state** is asserted on the bytes: the panel is on the page before any submission and
 * carries the attempt's reference and the three sentences, because this checkout runs no script and a
 * failed submission ends on the browser's own error page. See `app/(admin)/checkout/offline.ts`.
 *
 * The BROWSER half — `context.setOffline(true)` and a submit — is not in this file and is recorded as
 * deferred in the manifest with the reason: it needs `next build`, and this container had 1.4 GB free with
 * three other agents building. Running a build that fails with ENOSPC would have broken their runs too.
 * `apps/web/src/checkout.itest.ts` is where that case belongs, because it already stands the application
 * and a stand-in gateway origin up under the `checkout` port band.
 *
 * ## Why the gateway is replaced rather than the connection
 *
 * Killing the database connection mid-transaction is `packages/fixtures/src/aborted-transaction.itest.ts`'s
 * claim and it is made there, over the booking's three tables. Here the question is the PAYMENT path: the
 * gateway is the only thing in it that reaches outside the building, so it is the thing the wifi takes
 * away. `authoriseCheckout` is explicit that a non-refusal error must PROPAGATE — *"swallowing everything
 * here would turn a lost connection into 'the ledger refused the write', which sends somebody to look at
 * the wrong thing"* — and this file is what holds that open.
 */

const MARKER = 'hhard08 offline checkout itest'

let sql: Sql
let principal: FixturePrincipal

const CLOCK: Instant = Date.parse('2026-09-25T10:00:00.000Z') as Instant

/** The amount and reference every attempt below uses. Integer fils, VAT-inclusive (ADR 0007). */
const AMOUNT_FILS = '20000'

const chrome = () => ({
  googleReauth: null,
  sendBacklog: null,
  role: 'owner' as const,
  returnTo: '/checkout',
})

function readInput(key: string): CheckoutReadInput {
  const config = loadConfig()
  return {
    chrome: chrome(),
    hostedFields: hostedFieldsFrom(config),
    gatewayName: 'fake-card-gateway',
    nowIso: '2026-09-25T10:00:00.000Z',
    actorLabel: principal.staffReference,
    form: { amountFils: AMOUNT_FILS, reference: key },
  }
}

function body(key: string): string {
  const fields = CHECKOUT_FIELDS
  return new URLSearchParams({
    [fields.instrumentToken]: `tok_${key}`,
    [fields.idempotencyKey]: key,
    [fields.amountFils]: AMOUNT_FILS,
    [fields.reference]: key,
  }).toString()
}

const request = (key: string): Request =>
  new Request('https://example.invalid/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body(key),
  })

/** The real registry, and the same registry with the card gateway's `authorise` taken away. */
function registries() {
  const config = loadConfig()
  const live = createPaymentGateways({
    config,
    clock: { now: () => CLOCK },
    records: createRecordSink(),
  })
  /*
    The gateway whose socket closed.

    A THROW and not a returned failure, deliberately: a returned failure is the gateway answering, which
    `authoriseCheckout` would report as a refusal. What the wifi produces is no answer at all, and the
    shape of that in JavaScript is a rejected promise from the adapter — which must propagate, so the
    route answers 503 rather than rendering a refusal the gateway never made.
  */
  const offline = {
    ...live,
    byInstrument: () => ({
      ...live.cards,
      authorise: () => {
        throw new Error('ECONNRESET: the connection to the gateway was reset mid-request')
      },
    }),
  }
  return { live, offline }
}

/** The three tables the acceptance line names, counted in SQL at one instant. */
async function moneyRows(reference: string): Promise<{
  readonly intents: number
  readonly invoices: number
  readonly journalEntries: number
}> {
  const [row] = await sql<{ intents: string; invoices: string; journalEntries: string }[]>`
    select (select count(*)::text from payment_intent where reference = ${reference}) as "intents",
           -- Counted over the WHOLE table rather than by a reference, because an invoice carries none of
           -- this attempt's values: the claim is that the attempt created no invoice at all, which is a
           -- delta the caller takes around the call.
           (select count(*)::text from invoice)                                      as "invoices",
           (select count(*)::text from journal_entry)                                as "journalEntries"
  `
  return {
    intents: Number(row?.intents ?? '0'),
    invoices: Number(row?.invoices ?? '0'),
    journalEntries: Number(row?.journalEntries ?? '0'),
  }
}

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
  principal = await createFixturePrincipal(sql, { role: 'owner' as const, enrolTotp: true })
}, 30_000)

afterAll(async () => {
  /*
    The payment intents are NOT deleted, and the attempt to delete them is what taught this file why.

    `payment_intent_transaction` holds a row per gateway transaction and references the intent, so the
    delete is refused by the foreign key — which is the payments estate being right: the three figures on
    an intent are a cache of those append-only rows, recomputed at commit by ZY163, and an intent that
    could be deleted would be a figure with nothing behind it. ADR 0056's position is that only a gateway
    transaction row can move an intent's state; nothing can remove one.

    So the keys below are STABLE across runs rather than per-run, and the file is rerunnable because of
    what the idempotency key does: a repeat of the same attempt REPLAYS, so run two's "creates an intent"
    case sees the same single row and run two's replay case sees the same "Already recorded." That is the
    behaviour the paper fallback depends on, exercised by rerunning rather than asserted about once.
  */
  if (sql !== undefined) {
    await principal?.cleanup()
    await sql.end({ timeout: 5 })
  }
})

describe('a gateway that stops answering mid-checkout creates nothing', () => {
  it('propagates rather than rendering a refusal the gateway never made', async () => {
    const key = `${MARKER}:offline`
    const before = await moneyRows(key)
    const { offline } = registries()

    // It THROWS out of the handler. The route's own `catch` turns that into a 503 naming the failure —
    // which is the honest answer: "the check could not be made" rather than "the payment was refused".
    await expect(
      handleCheckoutWrite(
        {
          sql,
          registry: offline as never,
          actor: { kind: 'staff', label: principal.staffReference },
        },
        request(key),
        readInput(key),
        () => key,
      ),
    ).rejects.toThrow('ECONNRESET')

    // Zero payment intents, and no invoice or journal entry anywhere — asserted as a DELTA, because both
    // of those tables hold rows other suites wrote (brief rule 12).
    const after = await moneyRows(key)
    expect(after.intents).toBe(0)
    expect(after.invoices - before.invoices).toBe(0)
    expect(after.journalEntries - before.journalEntries).toBe(0)
  }, 30_000)

  it('creates an intent when the gateway DOES answer, which is the control', async () => {
    // On a rerun this is a REPLAY rather than a create, and the assertions are written to hold for both:
    // see `afterAll` on why the intent cannot be removed between runs.
    // Without this, "zero intents" is satisfied by a checkout that cannot authorise anything — and the
    // first draft of this file was exactly that, because the submission was missing a field.
    const key = `${MARKER}:live`
    const { live } = registries()
    const response = await handleCheckoutWrite(
      { sql, registry: live, actor: { kind: 'staff', label: principal.staffReference } },
      request(key),
      readInput(key),
      () => key,
    )
    expect(response.status).toBe(200)
    const html = await response.text()
    // The outcome panel, which only renders for an intent that exists.
    expect(html).toContain('Intent <code>')
    expect((await moneyRows(key)).intents).toBe(1)
  }, 30_000)

  it('writes no second intent when the same attempt is submitted again', async () => {
    // The half that makes the paper fallback safe: the operator is told to look the reference up and, if
    // they submit the same attempt again, the idempotency key replays rather than charging twice.
    const key = `${MARKER}:live`
    const { live } = registries()
    const response = await handleCheckoutWrite(
      { sql, registry: live, actor: { kind: 'staff', label: principal.staffReference } },
      request(key),
      readInput(key),
      () => key,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Already recorded.')
    expect((await moneyRows(key)).intents).toBe(1)
  }, 30_000)
})

describe('the till says what it could not do, on the page, before anything goes wrong', () => {
  it('carries the standing offline panel and the attempt reference', async () => {
    const key = `${MARKER}:panel`
    const response = handleCheckoutRead(readInput(key), () => key)
    const html = await response.text()
    expect(html).toContain(`${TILL_OFFLINE_PANEL_ATTRIBUTE}="standing"`)
    expect(html).toContain('data-till-attempt-reference=')
    // The two sentences the server can never deliver, on the page while it still can be.
    expect(html).toContain('WHETHER THE PAYMENT WAS TAKEN IS NOT')
    expect(html).toContain('never left it')
  })

  it('has nothing to press, because no script runs on this document', async () => {
    /*
      A separate case from the one above, and the split is deliberate: the two claims fail for different
      reasons and a reader of a failure needs to know which.

      The re-auth banner's argument in a second subject — a panel with a control is a panel that is not
      there the one time it matters — and sharper here, because `script-src 'none'` means a control could
      not work even if somebody pressed it. So the panel is marked non-dismissible AND carries no element
      that could be pressed.
    */
    const key = `${MARKER}:no-control`
    const html = await handleCheckoutRead(readInput(key), () => key).text()
    const panelStart = html.indexOf(`${TILL_OFFLINE_PANEL_ATTRIBUTE}=`)
    expect(panelStart).toBeGreaterThan(-1)
    const panel = html.slice(panelStart, html.indexOf('</section>', panelStart))
    expect(panel).toContain('data-dismissible="false"')
    for (const forbidden of ['<button', '<details', '<summary', '<script', 'onclick', 'hidden']) {
      expect(panel, `the offline panel contains ${forbidden}`).not.toContain(forbidden)
    }
    // The presence control: the panel really is the thing being searched, so "no control" is not
    // satisfied by an empty slice.
    expect(panel.length).toBeGreaterThan(500)
  })

  it('never says the payment was taken, queued or will be retried', async () => {
    const key = `${MARKER}:vocabulary`
    const html = await handleCheckoutRead(readInput(key), () => key).text()
    for (const forbidden of [
      'will be sent',
      'will retry',
      'saved offline',
      'offline mode',
      'stored locally',
      'payment succeeded',
    ]) {
      expect(html, `the checkout document says "${forbidden}"`).not.toContain(forbidden)
    }
    // The presence control for the loop: the document DOES talk about the connection dropping, so "it
    // never promises a retry" is not satisfied by a page that says nothing at all.
    expect(html).toContain('If the connection drops')
  })

  it('tells the operator to look the reference up BEFORE taking payment again', async () => {
    const key = `${MARKER}:steps`
    const html = await handleCheckoutRead(readInput(key), () => key).text()
    expect(html).toContain('look the reference up')
    expect(html).toContain('BEFORE taking payment again')
    expect(html).toContain('printed day sheet')
    // And the statement that there is no queue, which is the unit's binding constraint said out loud.
    expect(html).toContain('Nothing is held for you and nothing is waiting to be sent')
  })
})
