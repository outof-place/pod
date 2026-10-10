// Fork-only (Pod): per-sandbox tokens, held in memory only. Same shape as agent-api's proxy tokens:
// mint(scope), resolve(token), revoke(token), revokeScope(match).
import { createHash, randomBytes } from 'node:crypto'

export type SandboxTokenScope = { kind: 'orbstack-sandbox-hook'; machine: string }

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createSandboxTokens() {
  // Keyed by SHA-256, so a lookup's timing says nothing about the token itself.
  const scopes = new Map<string, SandboxTokenScope>()

  const mint = (scope: SandboxTokenScope): string => {
    const token = randomBytes(32).toString('base64url')
    scopes.set(digest(token), scope)
    return token
  }

  const resolve = (token: string): SandboxTokenScope | null =>
    token ? (scopes.get(digest(token)) ?? null) : null

  const revoke = (token: string): void => {
    scopes.delete(digest(token))
  }

  const revokeScope = (match: (scope: SandboxTokenScope) => boolean): void => {
    for (const [key, scope] of scopes) {
      if (match(scope)) {
        scopes.delete(key)
      }
    }
  }

  return { mint, resolve, revoke, revokeScope }
}

export type SandboxTokens = ReturnType<typeof createSandboxTokens>

/** One live hook token per sandbox machine: minted on first use, revoked with the machine. */
export function createSandboxHookTokens(tokens: SandboxTokens = createSandboxTokens()) {
  const byMachine = new Map<string, string>()
  return {
    tokenFor(machine: string): string {
      const live = byMachine.get(machine)
      if (live && tokens.resolve(live)?.machine === machine) {
        return live
      }
      const token = tokens.mint({ kind: 'orbstack-sandbox-hook', machine })
      byMachine.set(machine, token)
      return token
    },
    authorizes(machine: string, token: string): boolean {
      const scope = tokens.resolve(token)
      return scope?.kind === 'orbstack-sandbox-hook' && scope.machine === machine
    },
    revokeMachine(machine: string): void {
      byMachine.delete(machine)
      tokens.revokeScope((scope) => scope.machine === machine)
    }
  }
}

export type SandboxHookTokens = ReturnType<typeof createSandboxHookTokens>
