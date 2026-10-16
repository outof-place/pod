// Fork-only (Pod): SSH passphrase, password and keyboard-interactive prompts for runtime RPC clients,
// the desktop's ssh:credential-request and ssh:credential-resolved.

/** One open prompt of an SSH connect, as the desktop's credential dialog shows it. */
export type PodSshCredentialRequest = {
  requestId: string
  targetId: string
  kind: 'passphrase' | 'password' | 'keyboard-interactive'
  /** The host's or ssh2's prompt text (the key file for a passphrase). */
  detail: string
  /** keyboard-interactive only: the server allows showing what is typed. */
  echo?: boolean
  /** When the connect stops waiting and the prompt settles as `timeout`. */
  expiresAtMs: number
}

/** `submitted`/`cancelled`: an answer or null, here or in the desktop's dialog; `aborted`: the
 *  connect attempt ended first. */
export type PodSshCredentialSettleReason = 'submitted' | 'cancelled' | 'timeout' | 'aborted'

/** Sent to a client events subscription that passed `sshCredentials: true`. A prompt open when the
 *  subscription starts is sent right away, before `ready`. */
export type PodSshCredentialRequestedEvent = {
  type: 'sshCredentialRequested'
} & PodSshCredentialRequest

/** The prompt was answered (here or in the desktop's dialog), cancelled, aborted or timed out. */
export type PodSshCredentialResolvedEvent = {
  type: 'sshCredentialResolved'
  requestId: string
  reason: PodSshCredentialSettleReason
}

export type PodSshCredentialEvent = PodSshCredentialRequestedEvent | PodSshCredentialResolvedEvent

/** Added to the subscription's `ready` frame when the runtime honours the opt-in. */
export type PodSshCredentialsReadyFields = { sshCredentials?: true }
