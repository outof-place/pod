import { z } from 'zod'

// Pod: a multiplex stream id on the caller's own local stream connection.
export const PodTerminalDirectLaneParams = z
  .object({ streamId: z.number().int().nonnegative() })
  .strict()
