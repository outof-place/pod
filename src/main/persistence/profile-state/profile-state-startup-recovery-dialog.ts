import { statSync } from 'node:fs'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { translateMain } from '../../i18n/main-i18n'
import { getActiveProfileStateLocation } from './profile-state-active-location'
import { profileStateDatabaseFiles } from './profile-state-storage-classification'

export type ProfileStateStartupRecoveryDialogDeps = {
  message: string
  recoveryCommand?: string
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  copyToClipboard: (text: string) => void
}

/** Present the only safe desktop recovery action without changing the failed authority. */
export async function presentProfileStateStartupRecoveryDialog(
  deps: ProfileStateStartupRecoveryDialogDeps
): Promise<void> {
  const quit = translateMain('profileState.startupRecovery.quitButton', 'Quit')
  const buttons = deps.recoveryCommand
    ? [
        translateMain('profileState.startupRecovery.copyCommandButton', 'Copy recovery command'),
        quit
      ]
    : [quit]
  const nextStep = deps.recoveryCommand
    ? translateMain(
        'profileState.startupRecovery.copyCommandDetail',
        'Copy the recovery command, then run it after Orca closes.'
      )
    : translateMain(
        'profileState.startupRecovery.quitDetail',
        'Quit Orca and resolve the profile-state authority before retrying.'
      )
  const detail = `${deps.message}\n\n${nextStep}`
  const { response } = await deps.showMessageBox({
    type: 'error',
    buttons,
    defaultId: buttons.length - 1,
    cancelId: buttons.length - 1,
    title: translateMain(
      'profileState.startupRecovery.title',
      'Orca profile state cannot be opened'
    ),
    message: translateMain(
      'profileState.startupRecovery.message',
      'Orca cannot safely open this profile.'
    ),
    detail
  })
  if (response === 0 && deps.recoveryCommand) {
    deps.copyToClipboard(deps.recoveryCommand)
  }
}

export type ProfileStateCopyChoice = 'current-sqlite' | 'current-json'

export type ProfileStateCopyChoiceDialogDeps = {
  sqliteSavedAt?: Date
  jsonSavedAt?: Date
  formatTime?: (time: Date) => string
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
}

/** Best-effort save times; SQLite's latest commit may live only in its WAL, and -shm changes on every open. */
export function readProfileStateCopySavedTimes(userDataPath: string): {
  sqliteSavedAt?: Date
  jsonSavedAt?: Date
} {
  try {
    const location = getActiveProfileStateLocation(userDataPath)
    if (location === undefined) {
      return {}
    }
    const sqliteTimes = profileStateDatabaseFiles(location.databaseFile)
      .filter((path) => !path.endsWith('-shm'))
      .map(modifiedAt)
      .filter((time) => time !== undefined)
    const sqliteSavedAt =
      sqliteTimes.length === 0 ? undefined : new Date(Math.max(...sqliteTimes.map(Number)))
    const jsonSavedAt = modifiedAt(location.dataFile)
    return {
      ...(sqliteSavedAt === undefined ? {} : { sqliteSavedAt }),
      ...(jsonSavedAt === undefined ? {} : { jsonSavedAt })
    }
  } catch {
    return {}
  }
}

function modifiedAt(path: string): Date | undefined {
  return statSync(path, { throwIfNoEntry: false })?.mtime
}

/** Ask which diverged copy to keep; undefined means quit without changing either. */
export async function chooseProfileStateCopy(
  deps: ProfileStateCopyChoiceDialogDeps
): Promise<ProfileStateCopyChoice | undefined> {
  const format = deps.formatTime ?? ((time: Date) => time.toLocaleString())
  const savedAt = (time: Date | undefined): string =>
    time === undefined
      ? ''
      : ` ${translateMain('profileState.copyChoice.lastSaved', 'Last saved {{time}}.', { time: format(time) })}`
  const { response } = await deps.showMessageBox({
    type: 'warning',
    buttons: [
      translateMain('profileState.copyChoice.useSqliteButton', 'Use SQLite (Recommended)'),
      translateMain('profileState.copyChoice.useJsonButton', 'Use JSON'),
      translateMain('profileState.copyChoice.quitButton', 'Quit')
    ],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: translateMain('profileState.copyChoice.title', 'Choose profile state'),
    message: translateMain(
      'profileState.copyChoice.message',
      'This profile has two saved copies that don’t match.'
    ),
    detail: [
      translateMain(
        'profileState.copyChoice.cause',
        'This usually happens after opening the profile in an older version of Orca.'
      ),
      '',
      translateMain(
        'profileState.copyChoice.sqliteOption',
        'SQLite: what this version of Orca saved. Changes made in the older version are discarded.'
      ) + savedAt(deps.sqliteSavedAt),
      '',
      translateMain(
        'profileState.copyChoice.jsonOption',
        'JSON: includes changes made in the older version. Changes this version saved since then are discarded.'
      ) + savedAt(deps.jsonSavedAt),
      '',
      translateMain(
        'profileState.copyChoice.archiveNote',
        'Orca archives both copies before switching, then restarts.'
      )
    ].join('\n')
  })
  return response === 0 ? 'current-sqlite' : response === 1 ? 'current-json' : undefined
}
