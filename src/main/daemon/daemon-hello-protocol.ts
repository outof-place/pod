export type HelloMessage = {
  type: 'hello'
  version: number
  token: string
  clientId: string
  role: 'control' | 'stream'
  /** Stream framing the client can read. Daemons that predate it ignore it and stay on NDJSON. */
  streamFraming?: string
}

export type DaemonEndpointIdentity = {
  pid: number
  startedAtMs: number
  launchNonce: string
  /** Optional launch metadata. Absent from daemons that predate it; readers must fall back. */
  entryPath?: string
  appVersion?: string
  spawnerExecPath?: string
  /** Fork-only (Pod): the env name it reads a terminal's handle from (pod/decouple). */
  terminalHandleEnv?: string
}

export type HelloResponse = {
  type: 'hello'
  ok: boolean
  error?: string
  daemonIdentity?: DaemonEndpointIdentity
  /** Echoed only when the daemon switches this stream socket to that framing after this line. */
  streamFraming?: string
}
