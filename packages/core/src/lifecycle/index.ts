/**
 * The appointment lifecycle (B-LIFE-01).
 *
 * The transition table as data: which moves are legal, which role may make each one, what each one
 * emits, and what a repeat of it does. Pure — the instant, the actor and their role are arguments.
 */
export * from './transitions.ts'
