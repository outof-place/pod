import type React from 'react'
import { CircleCheck, TriangleAlert } from 'lucide-react'

/** macOS-only feature, so `/` is the separator; paths outside the root stay absolute. */
export function displayPathUnderRoot(path: string, rootAliases: readonly string[]): string {
  for (const root of rootAliases) {
    const prefix = root.endsWith('/') ? root : `${root}/`
    if (path.startsWith(prefix)) {
      return path.slice(prefix.length)
    }
  }
  return path
}

export function CheckValue({
  tone,
  children
}: {
  tone: 'ok' | 'warn' | 'neutral'
  children: React.ReactNode
}): React.JSX.Element {
  if (tone === 'ok') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-status-success">
        <CircleCheck className="size-3.5" />
        {children}
      </span>
    )
  }
  if (tone === 'warn') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-status-warning">
        <TriangleAlert className="size-3.5" />
        {children}
      </span>
    )
  }
  return <span className="text-xs text-muted-foreground">{children}</span>
}
