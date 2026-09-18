/**
 * @berelax/db — Drizzle schema, migrations and repositories.
 *
 * Hard constraints, enforced by `pnpm boundaries`:
 *   - may import @berelax/shared only
 *   - MUST NOT import @berelax/core (dependency direction is core <- db, never db -> core)
 */
export {
  type ConnectionOptions,
  createConnection,
  REQUIRED_EXTENSIONS,
  type Sql,
} from './connection.ts'
export {
  createJobQueue,
  type JobQueueOptions,
  MAINTENANCE_JOBS,
  PGBOSS_SCHEMA,
} from './jobs/boss.ts'
export * as schema from './schema/index.ts'

export const SCHEMA_VERSION = 6 as const
