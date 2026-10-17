// Fork-only (Pod): the defaults and caps every sim call obeys, so its output never floods an
// agent's context and its waits end before the agent's own tool call does.

/** `lease --wait` and `wait --mine` exit with this while still queued or held: call again. */
export const SIM_CALL_AGAIN_EXIT_CODE = 75

/** Seconds one waiting call blocks: under Claude Code's 2-minute Bash default. */
export const SIM_LEASE_DEFAULT_WAIT_S = 100
/** The most one call may ask for: under that tool's 10-minute ceiling. */
export const SIM_LEASE_MAX_WAIT_S = 540
/** A queued lease with no `lease` or `wait --mine` call for this long is abandoned (expired). */
export const SIM_WAITER_ABANDON_S = 2 * SIM_LEASE_MAX_WAIT_S

/**
 * A device reserved for a waiter goes to the next one unless claimed within this (the pool's
 * default; its config may change it); the lapsed waiter rejoins the queue at the back. Longer than
 * an agent's turn between two calls on a long context; an open `lease --wait` claims at once.
 */
export const SIM_RESERVATION_CLAIM_S = 180
/** A takeover gives the device back after this long without the person's input. */
export const SIM_TAKEOVER_IDLE_GIVE_BACK_S = 120

/** A waiting outcome lists this many waiters ahead and holders, then counts the rest. */
export const SIM_WAITING_LIST_MAX = 5

/** `state` lists visible nodes up to this many, then "+N more, use --filter". */
export const SIM_STATE_DEFAULT_MAX_NODES = 60
export const SIM_STATE_MAX_NODES = 500
/** A label or value longer than this is cut, with an ellipsis. */
export const SIM_NODE_TEXT_MAX_CHARS = 120

/**
 * `logs` reads since this holder's last `logs` call: the newest lines within both budgets, then
 * "+N more, use --grep".
 */
export const SIM_LOGS_DEFAULT_MAX_LINES = 200
export const SIM_LOGS_MAX_LINES = 2000
export const SIM_LOGS_DEFAULT_MAX_BYTES = 16_384
export const SIM_LOGS_MAX_BYTES = 262_144
export const SIM_LOG_LINE_MAX_CHARS = 500

/** A screenshot is a half-scale JPEG unless asked otherwise (about 24 KB for an iPhone 16 Pro). */
export const SIM_SCREENSHOT_DEFAULT_SCALE = 0.5
export const SIM_SCREENSHOT_DEFAULT_FORMAT = 'jpeg'

export const SIM_WAIT_DEFAULT_TIMEOUT_S = 10
/** Typed text (`type`, `pbcopy`, the tab's text input), in code points: zod's string length. */
export const SIM_TYPE_MAX_CHARS = 4096
