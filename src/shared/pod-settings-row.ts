// Fork-only (Pod): how a podSettings field carries its row's text.
import type { z } from 'zod'

/** `.meta()` with the row's title and an optional one-line explanation. */
export function row<T extends z.ZodType>(schema: T, title: string, description?: string): T {
  return schema.meta(description ? { title, description } : { title })
}
