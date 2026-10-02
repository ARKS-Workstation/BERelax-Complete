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
  COMMISSION_ENABLED_SETTING_KEY,
  DEPOSIT_ENABLED_SETTING_KEY,
  DEPOSIT_PERCENT_BP_SETTING_KEY,
  DEPOSIT_POLICY_OPEN_QUESTION_ID,
  DEPOSIT_POLICY_SETTING_KEYS,
  defaultsForSeeding,
  FORECAST_SHOW_UP_RATE_BP_SETTING_KEY,
  getDefinition,
  invalidationsFor,
  PACKAGE_POLICY_SETTING_KEYS,
  PACKAGE_TRANSFERABLE_SETTING_KEY,
  PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY,
  PACKAGE_VALIDITY_MONTHS_SETTING_KEY,
  PROVISIONAL_DEPOSIT_PERCENT_BP,
  PROVISIONAL_SHOW_UP_RATE_BP,
  PROVISIONAL_SUMMER_MONTHS,
  provisionalSettings,
  SEASONALITY_SUMMER_MONTHS_SETTING_KEY,
  SETTING_TIERS,
  SETTINGS,
  type SettingDefinition,
  type SettingKey,
  type SettingTier,
  SHOW_UP_RATE_WHOLE_BP,
  validateSetting,
  WPS_AGENT_ID_SETTING_KEY,
  WPS_EMPLOYER_ID_SETTING_KEY,
} from './settings/registry.ts'
