/**
 * Masking, which exists because the admin Messages inbox is screenshotted and published as a link.
 *
 * Each assertion is paired with the control that matters here: that the mask actually *removes* the
 * digits. "The last four are 9069" passes just as happily on a function that returns the whole number,
 * so every case also asserts the full value is gone.
 */
import { describe, expect, it } from 'vitest'
import { maskEmail, maskPhone, maskRecipient } from './mask.ts'

describe('maskPhone', () => {
  it('keeps the last four digits and nothing else', () => {
    const full = '+971528239069'
    expect(maskPhone(full)).toBe('…9069')
    // The control. Without it a pass-through implementation satisfies the line above.
    expect(maskPhone(full)).not.toContain('+971')
    expect(maskPhone(full)).not.toContain('52823')
  })

  it('leaves a value too short to mask alone rather than padding it', () => {
    // Four digits is already only the last four. Padding it would invent digits.
    expect(maskPhone('9069')).toBe('9069')
    expect(maskPhone(' 12 ')).toBe('12')
  })
})

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('customer0042@example.com')).toBe('c***@example.com')
    expect(maskEmail('customer0042@example.com')).not.toContain('ustomer')
  })

  it('takes the last @ so a quoted local part cannot smuggle a domain through', () => {
    expect(maskEmail('a@b@example.com')).toBe('a***@example.com')
  })

  it('falls back to the number mask for something that is not an address', () => {
    // Stricter of the two: four characters rather than a domain. A malformed recipient is exactly the
    // case where guessing the shape leaks the value.
    expect(maskEmail('@example.com')).toBe('….com')
    expect(maskEmail('not-an-address')).toBe('…ress')
  })
})

describe('maskRecipient', () => {
  it('dispatches on the channel, not on the shape of the value', () => {
    expect(maskRecipient('email', 'customer0042@example.com')).toBe('c***@example.com')
    expect(maskRecipient('sms', '+971528239069')).toBe('…9069')
    expect(maskRecipient('whatsapp', '+971528239069')).toBe('…9069')
    // The control, and the reason it is not sniffed: an address arriving on the SMS channel is a bug,
    // and the number mask keeps less of it than the email mask would.
    expect(maskRecipient('sms', 'customer0042@example.com')).toBe('….com')
  })
})
