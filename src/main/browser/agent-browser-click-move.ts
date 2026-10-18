// Fork-only (Pod): Chromium hands a page a pointer move at its next animation frame and answers
// Input.dispatchMouseEvent only then, while a press goes at once and takes a waiting move with it.
// agent-browser's click sends move, press and release, each after the last one's answer: the
// click's move answered as soon as it is sent spares the click that wait (up to a frame).

/** Whether a click is in flight on a session, whose one pointer move the CDP proxy answers at once. */
export class AgentBrowserClickMove {
  private expected = false

  expect(): void {
    this.expected = true
  }

  done(): void {
    this.expected = false
  }

  /** True once per click, for its pointer move. */
  takesMove(params: Record<string, unknown>): boolean {
    if (!this.expected || params.type !== 'mouseMoved') {
      return false
    }
    this.expected = false
    return true
  }
}
