import { describe, expect, it } from 'vitest'
import {
  BACKUP_FORMS,
  BACKUP_POSITIONS,
  backupPositionGaps,
  dataClassesWithErasureRules,
} from './backup-position.ts'
import { DATA_CLASSES, ERASURE_RULES } from './rights-policy.ts'

/**
 * H-HARD-04's fifth acceptance line: every data class carrying an erasure rule also states its backup
 * position. Derived from `ERASURE_RULES` in both directions, because a hand-kept list of classes is
 * exactly how a class comes to have an erasure rule and no backup position.
 */
describe('backup position completeness', () => {
  it('states a backup position for every data class that carries an erasure rule, and for no other', () => {
    const gaps = backupPositionGaps()
    expect(gaps.classesWithoutPosition).toEqual([])
    expect(gaps.positionsWithoutRule).toEqual([])
  })

  // The control. The assertion above is a difference of two sets, and a difference against an empty
  // set is empty — so if the rule registry stopped yielding classes it would pass about nothing.
  it('reads a real number of classes out of the erasure registry', () => {
    const classed = dataClassesWithErasureRules()
    expect(ERASURE_RULES.size).toBeGreaterThan(50)
    expect(classed.size).toBeGreaterThanOrEqual(DATA_CLASSES.length)
    expect(BACKUP_POSITIONS.size).toBe(classed.size)
  })

  // The other half of the control: the predicate has to be able to FAIL. Deleting an entry from a copy
  // of the registry must be reported, which is what proves the comparison is a comparison.
  it('reports a class whose position is missing', () => {
    const classed = [...dataClassesWithErasureRules()]
    const withoutIdentity = new Map(BACKUP_POSITIONS)
    withoutIdentity.delete('identity')
    const missing = classed.filter((entry) => !withoutIdentity.has(entry))
    expect(missing).toEqual(['identity'])
  })

  it('gives every position a form from the closed set, a restore consequence and an open question', () => {
    for (const [dataClass, entry] of BACKUP_POSITIONS) {
      expect(entry.dataClass, `${dataClass} is keyed by another class`).toBe(dataClass)
      expect(BACKUP_FORMS, `${dataClass} has an unknown form`).toContain(entry.form)
      expect(entry.onRestore.length, `${dataClass} says nothing about a restore`).toBeGreaterThan(
        40,
      )
      expect(entry.why.length, `${dataClass} says nothing about why`).toBeGreaterThan(40)
      expect(entry.openQuestionId).toBe('Y13-rpo-rto')
      // Typed `false`, so this cannot be otherwise — asserted anyway, because the type is the claim
      // and a widening of it should break a test rather than pass quietly.
      expect(entry.erasureReachesBackup).toBe(false)
    }
  })

  /**
   * The three classes a restore makes WORSE rather than better, named individually.
   *
   * A generic "every class states something" assertion is satisfied by ten copies of one sentence. These
   * three are the reason the table exists: restoring rolls back a revocation, a withdrawal and a
   * suppression, and each of those is an action taken against somebody that the words "restore the
   * database" do not suggest.
   */
  it('names the classes where a restore undoes a protection', () => {
    expect(BACKUP_POSITIONS.get('credential')?.onRestore).toContain('works again')
    expect(BACKUP_POSITIONS.get('consent_record')?.onRestore).toContain('reads as given')
    expect(BACKUP_POSITIONS.get('suppression_record')?.onRestore).toContain('becomes contactable')
    // And the one class whose data is in the dump without being readable from it.
    expect(BACKUP_POSITIONS.get('clinical')?.form).toBe('present_as_ciphertext')
  })
})
