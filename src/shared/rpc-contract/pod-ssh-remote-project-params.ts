// Fork-only (Pod): Add Project on an SSH host over RPC, the desktop's ssh:browseDir and repos:addRemote.
import { z } from 'zod'

const targetId = z.string().min(1).max(256)
/** `~` and `~/…` are the host's home; Windows hosts also take `C:/…`. */
const remotePath = z.string().min(1).max(4096)

export const SshBrowseDirParams = z.object({ targetId, dirPath: remotePath }).strict()

export const RepoAddRemoteParams = z
  .object({
    targetId,
    remotePath,
    /** Empty: the folder's name, or the host's label for the home folder itself. */
    displayName: z.string().trim().max(256).optional(),
    /** Absent: git, and the path must be inside a repository. */
    kind: z.enum(['git', 'folder']).optional()
  })
  .strict()
