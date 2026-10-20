// Fork-only (Pod): the nested repo scan and import on an SSH host over RPC, the desktop's
// projectGroups:scanNested and projectGroups:importNested with a connection.
import { z } from 'zod'

const targetId = z.string().min(1).max(256)
/** POSIX absolute on the host; pod-ssh-nested-repos.ts refuses `..` and NUL before the host is asked. */
const remotePath = z.string().min(1).max(4096)

export const ProjectGroupScanNestedRemoteParams = z.object({ targetId, path: remotePath }).strict()

export const ProjectGroupImportNestedRemoteParams = z
  .object({
    targetId,
    parentPath: remotePath,
    /** Empty or absent: the scanned folder's name. */
    groupName: z.string().max(256).optional(),
    // Why 500: the scan's own ceiling (nested-repo-scan-rules.ts maxRepos).
    projectPaths: z.array(remotePath).max(500),
    mode: z.enum(['group', 'separate'])
  })
  .strict()
