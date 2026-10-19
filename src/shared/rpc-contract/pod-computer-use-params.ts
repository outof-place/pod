// Fork-only (Pod): params of computer.permissionsReset, which takes none.
import { z } from 'zod'

// Strict and empty: nothing a caller sends reaches tccutil.
export const ComputerPermissionsResetParams = z.object({}).strict()
