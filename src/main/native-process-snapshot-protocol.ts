import type { NativeProcessRow, NativeTerminalProcessRow } from '../shared/native-process-info'

export type NativeProcessSnapshotRequest = { id: number; kind: 'cheap' | 'full' }

export type NativeProcessSnapshotResponse =
  | { id: number; ok: true; kind: 'cheap'; rows: NativeProcessRow[] }
  | { id: number; ok: true; kind: 'full'; rows: NativeTerminalProcessRow[] }
  | { id: number; ok: false; error: string }
