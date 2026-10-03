import { describe, expect, it } from 'vitest'
import {
  baselineFindings,
  baselineReport,
  MINIMUM_BASELINE_OBSERVATIONS,
  type Observation,
  REQUIRED_SECURITY_HEADERS,
} from './baseline.ts'

const seen = (overrides: Partial<Observation> = {}): Observation => ({
  kind: 'admin_route_unauthenticated',
  path: '/settings/integrations',
  status: 303,
  headers: { location: '/login' },
  bodyExcerpt: '',
  ...overrides,
})

const kinds = (findings: readonly { kind: string }[]) => findings.map((finding) => finding.kind)

describe('the admin-route probe', () => {
  // The rule is about the STATUS and not the body, and this case is why: 200 with text/html, noindex
  // and no-store is exactly what the sign-in page answers, so a body assertion would pass against a
  // document with nothing to do with its subject.
  it('reports a 200 on an admin path with no session, whatever the body says', () => {
    const findings = baselineFindings([
      seen({
        status: 200,
        headers: {
          'content-type': 'text/html',
          'x-robots-tag': 'noindex',
          'cache-control': 'no-store',
        },
        bodyExcerpt: '<html><body>Sign in</body></html>',
      }),
    ])
    expect(kinds(findings)).toEqual(['admin_route_unauthenticated'])
    expect(findings[0]?.severity).toBe('critical')
  })

  it('accepts a redirect, a 401, a 403 and a 404 and reports nothing', () => {
    for (const status of [301, 302, 303, 307, 308, 401, 403, 404]) {
      expect(baselineFindings([seen({ status })]), `status ${status}`).toEqual([])
    }
  })
})

describe('the secret-file probe', () => {
  it('reports a 200 and nothing for a 404', () => {
    expect(
      kinds(baselineFindings([seen({ kind: 'secret_file_exposed', path: '/.env', status: 200 })])),
    ).toEqual(['secret_file_exposed'])
    expect(
      baselineFindings([seen({ kind: 'secret_file_exposed', path: '/.env', status: 404 })]),
    ).toEqual([])
  })
})

describe('the header probe', () => {
  it('reports exactly the headers that are absent, and nothing when all are present', () => {
    const present = Object.fromEntries(REQUIRED_SECURITY_HEADERS.map((header) => [header, 'set']))
    expect(
      baselineFindings([seen({ kind: 'security_headers_absent', status: 200, headers: present })]),
    ).toEqual([])
    const findings = baselineFindings([
      seen({
        kind: 'security_headers_absent',
        status: 200,
        headers: { 'x-content-type-options': 'nosniff' },
      }),
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.detail).toContain('content-security-policy')
    expect(findings[0]?.detail).toContain('referrer-policy')
    expect(findings[0]?.detail).not.toContain('x-content-type-options')
  })
})

describe('the version and source-map probes', () => {
  it('reports a Server header carrying a version and ignores one that does not', () => {
    expect(
      kinds(
        baselineFindings([
          seen({ kind: 'server_version_disclosed', headers: { server: 'nginx/1.25.3' } }),
        ]),
      ),
    ).toEqual(['server_version_disclosed'])
    expect(
      baselineFindings([seen({ kind: 'server_version_disclosed', headers: { server: 'nginx' } })]),
    ).toEqual([])
    expect(baselineFindings([seen({ kind: 'server_version_disclosed', headers: {} })])).toEqual([])
  })

  it('reports a published source map', () => {
    expect(
      kinds(
        baselineFindings([
          seen({ kind: 'source_map_published', path: '/_next/static/chunk.js.map', status: 200 }),
        ]),
      ),
    ).toEqual(['source_map_published'])
  })
})

describe('the floor', () => {
  // A scan that made no request found nothing, and reporting "no findings" for it is ADR 0002's green
  // tick over zero modules said about a security scan.
  it('marks a report with too few observations as having examined nothing', () => {
    expect(baselineReport([]).examinedNothing).toBe(true)
    expect(
      baselineReport(Array.from({ length: MINIMUM_BASELINE_OBSERVATIONS }, () => seen()))
        .examinedNothing,
    ).toBe(false)
  })

  // And the clean answer, which the suite has to prove as well: a scanner that reported a finding for
  // every response is a scanner whose output means nothing.
  it('answers no findings for a well-behaved origin', () => {
    const present = Object.fromEntries(REQUIRED_SECURITY_HEADERS.map((header) => [header, 'set']))
    expect(
      baselineReport([
        seen(),
        seen({ path: '/till' }),
        seen({ kind: 'secret_file_exposed', path: '/.env', status: 404 }),
        seen({ kind: 'security_headers_absent', path: '/', status: 200, headers: present }),
        seen({ kind: 'source_map_published', path: '/x.js.map', status: 404 }),
        seen({ kind: 'server_version_disclosed', path: '/', headers: {} }),
      ]).findings,
    ).toEqual([])
  })
})
