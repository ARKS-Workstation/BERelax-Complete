import { AppError } from '@berelax/shared'
import postgres from 'postgres'

/**
 * PostgreSQL connection factory.
 *
 * `prepare: false` is not optional: DigitalOcean Managed PostgreSQL fronts the database with
 * PgBouncer in transaction pooling mode, where server-side prepared statements do not survive
 * between statements. Enabling them works locally and fails in production, which is the worst
 * kind of difference. See docs/02-architecture.md §2.
 */
export type Sql = ReturnType<typeof postgres>

export interface ConnectionOptions {
  readonly url: string
  /** Keep small: PgBouncer multiplexes, and DO Managed Postgres has a hard connection ceiling. */
  readonly max?: number
  readonly idleTimeoutSeconds?: number
  readonly connectTimeoutSeconds?: number
  readonly onNotice?: (notice: unknown) => void
}

export function createConnection(options: ConnectionOptions): Sql {
  if (!options.url) {
    throw new AppError('validation', 'DATABASE_URL is required to create a connection')
  }
  return postgres(options.url, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 30,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    prepare: false,
    onnotice: options.onNotice ?? (() => {}),
    types: {
      // Return bigint as a string rather than a lossy JS number. Money is integer fils and
      // counts can exceed 2^53 in an event table; silent precision loss is unacceptable.
      bigint: {
        to: 20,
        from: [20],
        serialize: (v: string | bigint) => String(v),
        parse: (v: string) => v,
      },
    },
  })
}

/** Extensions the schema depends on. `btree_gist` is load-bearing: the no-double-booking
 *  exclusion constraint cannot be expressed without it. */
export const REQUIRED_EXTENSIONS = ['btree_gist', 'pgcrypto', 'pg_trgm', 'unaccent'] as const
