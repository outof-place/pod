// PTYs whose queries another view answers (main elects one view per PTY), so this window's xterm
// stays silent on them while it keeps drawing their output.
const answeredElsewhere = new Set<string>()
let subscribed = false

/** Called while a pane connects: main's notices only arrive once someone listens. */
export function ensurePtyQueryResponderSubscription(): void {
  if (subscribed) {
    return
  }
  subscribed = true
  window.api.pty.onQueryResponder?.(({ id, answers }) => {
    if (answers) {
      answeredElsewhere.delete(id)
    } else {
      answeredElsewhere.add(id)
    }
  })
}

export function isPtyQueryAnsweredElsewhere(ptyId: string): boolean {
  return answeredElsewhere.has(ptyId)
}
