import { type Config, parseConfig } from './env.ts'

let cached: Config | undefined

/**
 * Loads and caches configuration from the real process environment.
 *
 * Call this once, as early as possible in a process's life — that is the whole point. Anything
 * that needs configuration receives a `Config`, it does not call this.
 */
export function loadConfig(): Config {
  cached ??= parseConfig(process.env)
  return cached
}

/** Test seam only. */
export function resetConfigCache(): void {
  cached = undefined
}
