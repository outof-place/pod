// Pasted SSH host text (`user@host:port`, `ssh://user@host:port`) split into its parts. The settings
// pane, the Add Remote Host dialog and the ssh.addTarget and ssh.updateTarget RPCs all use it.

/** The pane's message for a port outside 1 to 65535, whether typed or pasted into the host. */
export const SSH_PORT_INVALID_MESSAGE = 'Port must be between 1 and 65535'

export type ParsedSshHostInput = {
  host: string
  username?: string
  port?: number
  invalidPort?: boolean
  configHost: string
}

export function parseSshHostInput(rawInput: string): ParsedSshHostInput | null {
  const input = rawInput.trim()
  if (!input) {
    return null
  }

  if (/^ssh:\/\//i.test(input)) {
    return parseSshUrl(input)
  }

  const atIndex = input.lastIndexOf('@')
  const username = atIndex > 0 ? input.slice(0, atIndex).trim() : undefined
  const hostPort = atIndex > 0 ? input.slice(atIndex + 1).trim() : input
  const parsed = parseHostAndOptionalPort(hostPort)
  if (!parsed.host) {
    return null
  }

  return {
    host: parsed.host,
    username,
    port: parsed.port,
    invalidPort: parsed.invalidPort,
    configHost: parsed.host
  }
}

/** A blank or untouched (22) port is the one a pasted `host:port` may replace. */
export function isDefaultSshPortDraft(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === '' || trimmed === '22'
}

/**
 * The connection fields a form or RPC payload really means: what was typed wins, the pasted host
 * fills the rest. `port` is NaN for a pasted port outside 1 to 65535 or unreadable typed text.
 */
export function resolveSshConnectionFields(draft: {
  host: string
  configHost: string
  username: string
  port: string
}): { host: string; configHost: string; username: string; port: number } {
  const parsed = parseSshHostInput(draft.host)
  const host = parsed?.host ?? draft.host.trim()
  const configHost = draft.configHost.trim() || parsed?.configHost || host
  const username = draft.username.trim() || parsed?.username || ''
  const parsedPort = Number.parseInt(draft.port, 10)
  const port =
    parsed?.invalidPort === true
      ? Number.NaN
      : parsed?.port !== undefined && isDefaultSshPortDraft(draft.port)
        ? parsed.port
        : parsedPort
  return { host, configHost, username, port }
}

function parseSshUrl(input: string): ParsedSshHostInput | null {
  try {
    const url = new URL(input)
    if (url.protocol !== 'ssh:' || !url.hostname) {
      return null
    }
    // Why: URL.hostname keeps IPv6 literals bracketed, but ssh2 and DNS
    // resolution expect the bare address. The non-URL parser already strips.
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const port = url.port ? parsePort(url.port) : undefined
    if (url.port && port === undefined) {
      return {
        host,
        username: decodeSshUrlUsername(url.username),
        configHost: host,
        invalidPort: true
      }
    }
    return {
      host,
      username: decodeSshUrlUsername(url.username),
      port,
      configHost: host
    }
  } catch {
    return parseSshUrlWithInvalidPort(input)
  }
}

function parseSshUrlWithInvalidPort(input: string): ParsedSshHostInput | null {
  const match = input.match(/^ssh:\/\/(?:([^@/?#]*)@)?(\[[^\]]+\]|[^:/?#]+):([^/?#]*)(?:[/?#]|$)/i)
  if (!match) {
    return null
  }

  const rawHost = match[2]
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  const port = parsePort(match[3])
  if (port !== undefined) {
    return null
  }

  return {
    host,
    username: decodeSshUrlUsername(match[1] ?? ''),
    configHost: host,
    invalidPort: true
  }
}

function decodeSshUrlUsername(value: string): string | undefined {
  if (!value) {
    return undefined
  }
  try {
    return decodeURIComponent(value)
  } catch {
    // Why: malformed pasted SSH URLs should surface validation errors in the
    // form, not throw during parsing before the user can fix the input.
    return value
  }
}

export function parseHostAndOptionalPort(input: string): {
  host: string
  port?: number
  invalidPort?: boolean
} {
  if (input.startsWith('[')) {
    const closeIndex = input.indexOf(']')
    if (closeIndex > 1) {
      const host = input.slice(1, closeIndex)
      const suffix = input.slice(closeIndex + 1)
      if (suffix.startsWith(':')) {
        const port = parsePort(suffix.slice(1))
        return port === undefined ? { host, invalidPort: true } : { host, port }
      }
      return { host }
    }
  }

  const firstColon = input.indexOf(':')
  if (firstColon !== -1 && firstColon === input.lastIndexOf(':')) {
    const host = input.slice(0, firstColon)
    const port = parsePort(input.slice(firstColon + 1))
    if (host) {
      return port === undefined ? { host, invalidPort: true } : { host, port }
    }
  }

  return { host: input }
}

function parsePort(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined
  }
  const port = Number(value)
  return isValidPort(port) ? port : undefined
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}
