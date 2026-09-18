/**
 * The two message classifications, and the channels they travel on.
 *
 * These live in `shared` rather than in `@berelax/messaging`, where they are used, for one structural
 * reason: `@berelax/providers` needs `MessageClass` in its SMS and email port signatures, and
 * `@berelax/messaging` needs the ports to build a transport. Declaring them in `messaging` made the two
 * packages depend on each other — pnpm links a cyclic workspace pair and warns, and any future build
 * step for either package has no valid order to run in. `shared` is the leaf every package may depend
 * on, which is exactly what a type two packages both need is for.
 */

/**
 * Channels the platform can send on.
 *
 * WhatsApp is later but the model is channel-shaped now, because retrofitting it into a flat SMS-shaped
 * type means touching every send path.
 */
export type Channel = 'sms' | 'email' | 'whatsapp'

/**
 * Transactional or promotional. This is the most consequential field in the messaging module.
 *
 * It is an immutable property of the TEMPLATE, never of the send call, so an automation cannot route
 * promotional content down a transactional path. UAE promotional SMS must carry an AD-prefixed sender id
 * and is confined to 07:00–21:00; getting it wrong risks sender-id suspension, which would stop every
 * booking confirmation. See docs/04-uae-compliance.md §5.
 */
export type MessageClass = 'transactional' | 'promotional'
