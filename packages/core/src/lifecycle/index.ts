/**
 * The appointment lifecycle (B-LIFE-01).
 *
 * The transition table as data: which moves are legal, which role may make each one, what each one
 * emits, and what a repeat of it does. Pure — the instant, the actor and their role are arguments.
 */

/**
 * B-LIFE-03's pure rules: the cancellation window that flags rather than charges, the NO_SHOW clock guard,
 * and the two facts a reschedule's successor is born with. All three take the instant as an ARGUMENT —
 * `packages/core` reads no clock.
 */
export * from './cancellation-policy.ts'
/**
 * B-MSG-03's invalidation key: the value that decides, at the moment of sending, whether a scheduled
 * message is still about the appointment it was built for. Pure, and the instant is an argument.
 */
export * from './invalidation-key.ts'
export * from './reschedule-policy.ts'
export * from './transitions.ts'
