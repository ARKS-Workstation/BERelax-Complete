import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { assertNever } from './assert-never.ts'

describe('assertNever', () => {
  it('throws an invariant_violated AppError naming the context', () => {
    try {
      assertNever('unexpected' as never, 'appointmentStatus')
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).kind).toBe('invariant_violated')
      expect((e as AppError).message).toContain('appointmentStatus')
      expect((e as AppError).details).toEqual({ value: 'unexpected' })
    }
  })
})
