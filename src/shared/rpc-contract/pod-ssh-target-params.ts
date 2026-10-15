// Fork-only (Pod): SSH settings' host form over RPC, validated as the settings pane validates it.
import { z } from 'zod'
import {
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
  SSH_REMOTE_RUNTIMES
} from '../ssh-types'
import { parseSshHostInput, SSH_PORT_INVALID_MESSAGE } from '../ssh-host-input'

const text = (max: number) => z.string().trim().max(max)

/** The pane's form as one payload: add and update both send it whole, as SshPane does. */
export const SshTargetSettingsInput = z
  .object({
    /** Empty: `user@host`, or the alias without a user, as the pane names it. */
    label: text(256).optional(),
    /** The ~/.ssh/config alias; empty: the host. */
    configHost: text(1024).optional(),
    host: text(1024).min(1, 'Host or SSH config alias is required'),
    port: z
      .number()
      .int(SSH_PORT_INVALID_MESSAGE)
      .min(1, SSH_PORT_INVALID_MESSAGE)
      .max(65535, SSH_PORT_INVALID_MESSAGE),
    username: text(256).optional(),
    identityFile: text(4096).optional(),
    gssapiAuthentication: z.boolean().optional(),
    proxyCommand: text(4096).optional(),
    jumpHost: text(1024).optional(),
    /** Off is a per-host compatibility opt-out; on is the default and stores nothing. */
    systemSshConnectionReuse: z.boolean().optional(),
    /** 0 keeps the host's terminals alive until reset (the default). */
    relayGracePeriodSeconds: z
      .number()
      .int()
      .refine(
        (seconds) =>
          seconds === 0 ||
          (seconds >= MIN_SSH_RELAY_GRACE_PERIOD_SECONDS &&
            seconds <= MAX_SSH_RELAY_GRACE_PERIOD_SECONDS),
        `Terminal timeout must be between ${MIN_SSH_RELAY_GRACE_PERIOD_SECONDS} and ${MAX_SSH_RELAY_GRACE_PERIOD_SECONDS} seconds, or 0 to keep terminals alive until reset.`
      )
      .optional(),
    /** Absent: automatic. */
    remoteRuntime: z.enum(SSH_REMOTE_RUNTIMES).optional(),
    allowRemoteCliControl: z.boolean().optional()
  })
  .strict()
  // A pasted `host:port` the pane would refuse (the host is also read as `user@host:port` or an ssh:// URL).
  .refine((form) => parseSshHostInput(form.host)?.invalidPort !== true, {
    message: SSH_PORT_INVALID_MESSAGE,
    path: ['host']
  })

export type SshTargetSettingsInput = z.output<typeof SshTargetSettingsInput>

export const SshAddTargetParams = z.object({ target: SshTargetSettingsInput }).strict()

export const SshUpdateTargetParams = z
  .object({ targetId: z.string().min(1).max(256), target: SshTargetSettingsInput })
  .strict()

export const SshImportConfigParams = z
  .object({
    /** Brings back hosts removed earlier, as the pane's Import button does; its automatic sync doesn't. */
    reAdopt: z.boolean().optional()
  })
  .strict()
