import { describe, expect, it } from 'vitest'
import {
  auditOperationFor,
  auditStateOf,
  CMS_MUTATIONS,
  classifyMutation,
  cmsAuditEntry,
  type MutationSignals,
} from './audit.ts'

const base: MutationSignals = {
  operation: 'update',
  restoringVersion: false,
  previousStatus: 'draft',
  nextStatus: 'draft',
}

describe('acceptance — publish, unpublish and revert are distinguishable in the audit trail', () => {
  it('classifies each one', () => {
    expect(classifyMutation({ ...base, operation: 'create', previousStatus: null })).toBe('create')
    expect(classifyMutation({ ...base, operation: 'delete' })).toBe('delete')
    expect(classifyMutation({ ...base, nextStatus: 'published' })).toBe('publish')
    expect(classifyMutation({ ...base, previousStatus: 'published', nextStatus: 'draft' })).toBe(
      'unpublish',
    )
    expect(classifyMutation(base)).toBe('update')
    expect(classifyMutation({ ...base, restoringVersion: true })).toBe('version_revert')
  })

  it('calls a revert a revert even when it also changes the status', () => {
    // Payload's restoreVersion sets `req.context.isRestoringVersion` and then runs the ordinary update
    // path, so without checking the flag first a revert that restores a published version is recorded as
    // a publish — and the fact that the wording came from an old version is lost.
    expect(
      classifyMutation({
        ...base,
        restoringVersion: true,
        previousStatus: 'draft',
        nextStatus: 'published',
      }),
    ).toBe('version_revert')
  })

  it('does not call an ordinary republish a revert', () => {
    // The control for the flag: with `restoringVersion` false the same transition is a publish.
    expect(classifyMutation({ ...base, previousStatus: 'draft', nextStatus: 'published' })).toBe(
      'publish',
    )
  })

  it('maps every mutation onto a value the audit_event CHECK constraint accepts', () => {
    // Migration 0005 constrains `operation` to a fixed list shared with bookings and money. A CMS verb
    // that is not on it fails the insert, which would mean losing the audit row for the change.
    const allowed = new Set(['create', 'update', 'delete'])
    for (const mutation of CMS_MUTATIONS) {
      expect(allowed.has(auditOperationFor(mutation)), mutation).toBe(true)
    }
    expect(auditOperationFor('publish')).toBe('update')
  })
})

describe('acceptance — before/after carry the declared fields and nothing else', () => {
  const document = {
    id: 4,
    question: 'Do I need to undress?',
    answer: { root: { type: 'root', children: [] } },
    topic: 'visiting',
    _status: 'published',
    // Payload internals and a hypothetical secret. Neither is part of the content model, so neither may
    // reach an append-only table nobody can redact.
    updatedAt: '2026-09-18T10:00:00.000Z',
    _payload_internal: 'whatever this release calls it',
    api_key: 'sk-live-should-never-be-audited',
  }

  it('keeps the model’s fields', () => {
    const state = auditStateOf('faq_entries', document)
    expect(Object.keys(state ?? {}).sort()).toEqual(['_status', 'answer', 'question', 'topic'])
    expect(state?.['question']).toBe('Do I need to undress?')
  })

  it('drops anything the model does not declare', () => {
    const state = auditStateOf('faq_entries', document)
    expect(state).not.toHaveProperty('api_key')
    expect(state).not.toHaveProperty('_payload_internal')
    expect(state).not.toHaveProperty('updatedAt')
  })

  it('returns undefined for no document and for an unknown collection', () => {
    expect(auditStateOf('faq_entries', null)).toBeUndefined()
    expect(auditStateOf('faq_entries', undefined)).toBeUndefined()
    expect(auditStateOf('not_a_collection', document)).toBeUndefined()
  })

  it('returns undefined rather than {} for a document with none of its fields', () => {
    // Payload passes `previousDoc: {}` on a create rather than omitting it. `before_state: {}` reads as
    // "every field was cleared", which is the opposite of "there was nothing there" — and it is the
    // difference the whole before/after pair exists to record.
    expect(auditStateOf('faq_entries', {})).toBeUndefined()
    expect(auditStateOf('faq_entries', { updatedAt: '2026-09-18T10:00:00.000Z' })).toBeUndefined()
    // The control: one declared field present is enough to make it a state.
    expect(auditStateOf('faq_entries', { topic: 'visiting' })).toEqual({ topic: 'visiting' })
  })

  it('reads a global’s fields too', () => {
    const state = auditStateOf('editorial_defaults', {
      default_seo_title: 'BE RELAX',
      default_seo_description: 'A massage centre in Al Zahiyah.',
      journal_index_blurb: null,
      createdAt: '2026-09-18T10:00:00.000Z',
    })
    expect(Object.keys(state ?? {}).sort()).toEqual([
      'default_seo_description',
      'default_seo_title',
      'journal_index_blurb',
    ])
  })

  it('builds an entry with a namespaced action and no empty state on a create', () => {
    const entry = cmsAuditEntry({
      slug: 'faq_entries',
      entityId: '4',
      mutation: 'create',
      before: null,
      after: document,
    })
    expect(entry.action).toBe('cms.faq_entries.create')
    expect(entry.entityType).toBe('faq_entries')
    expect(entry.operation).toBe('create')
    // `undefined`, not `{}`: an empty object in `before_state` reads as "every field was cleared".
    expect(entry.before).toBeUndefined()
    expect(entry.after).toBeDefined()
  })

  it('carries both states on a publish', () => {
    const entry = cmsAuditEntry({
      slug: 'faq_entries',
      entityId: '4',
      mutation: 'publish',
      before: { ...document, _status: 'draft' },
      after: document,
    })
    expect(entry.before?.['_status']).toBe('draft')
    expect(entry.after?.['_status']).toBe('published')
    expect(entry.action).toBe('cms.faq_entries.publish')
  })
})
