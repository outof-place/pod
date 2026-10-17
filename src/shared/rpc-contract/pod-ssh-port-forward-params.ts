// Fork-only (Pod): SSH port forwarding over RPC, the desktop's ssh:*PortForward* IPC.
import { z } from 'zod'

const targetId = z.string().min(1).max(256)
const port = z.number().int().min(1).max(65535)

const forward = {
  targetId,
  localPort: port,
  remoteHost: z.string().trim().min(1).max(253),
  remotePort: port,
  label: z.string().trim().max(256).optional()
}

/** No targetId: every host's forwards, not enriched (the desktop's list does the same). */
export const SshListPortForwardsParams = z.object({ targetId: targetId.optional() }).strict()
export const SshAddPortForwardParams = z.object(forward).strict()
export const SshUpdatePortForwardParams = z
  .object({ id: z.string().min(1).max(256), ...forward })
  .strict()
export const SshRemovePortForwardParams = z.object({ id: z.string().min(1).max(256) }).strict()
export const SshListDetectedPortsParams = z.object({ targetId }).strict()
export const SshPortsUnsubscribeParams = z
  .object({ subscriptionId: z.string().min(1).max(256) })
  .strict()
