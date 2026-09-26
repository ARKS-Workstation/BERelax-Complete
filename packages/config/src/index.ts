/**
 * @berelax/config — boot-time configuration. Reads the environment, validates it, fails loudly.
 *
 * Not importable by @berelax/core, which must stay pure. See docs/adr/0001.
 */
export {
  APP_ENVS,
  type AppEnv,
  type Config,
  isProduction,
  parseConfig,
} from './env.ts'
export { loadConfig } from './load.ts'
export {
  assertRoleMayEdit,
  type CacheTag,
  defaultsForSeeding,
  getDefinition,
  invalidationsFor,
  PACKAGE_POLICY_SETTING_KEYS,
  PACKAGE_TRANSFERABLE_SETTING_KEY,
  PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY,
  PACKAGE_VALIDITY_MONTHS_SETTING_KEY,
  provisionalSettings,
  SETTING_TIERS,
  SETTINGS,
  type SettingDefinition,
  type SettingKey,
  type SettingTier,
  validateSetting,
} from './settings/registry.ts'
