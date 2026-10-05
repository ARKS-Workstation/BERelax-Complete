import * as migration_20261005_132543_initial from './20261005_132543_initial'

export const migrations = [
  {
    up: migration_20261005_132543_initial.up,
    down: migration_20261005_132543_initial.down,
    name: '20261005_132543_initial',
  },
]
