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
export * from './reschedule-policy.ts'
export * from './transitions.ts'
