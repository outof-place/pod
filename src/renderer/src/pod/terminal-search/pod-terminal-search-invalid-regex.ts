// Fork-only (Pod): @xterm/addon-search compiles a Regex-mode term unguarded, so an invalid one threw out of findNext.
export function isInvalidTerminalSearchRegex(
  term: string,
  options: { regex?: boolean } | undefined
): boolean {
  if (!options?.regex || term === '') {
    return false
  }
  try {
    RegExp(term)
  } catch {
    return true
  }
  return false
}
