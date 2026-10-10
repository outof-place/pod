// Fork-only (Pod): everything a sandbox may reach on the Mac, per machine and in memory only. The
// hook token, the CA and the anthropic-api route are made on first use and die with the sandbox.
import { randomBytes } from 'node:crypto'
import type { PodOrbstackRelayRowInput } from './pod-orbstack-events'
import {
  createAnthropicRoute,
  getPodSandboxAnthropicCredentials,
  type AnthropicRoute,
  type AnthropicUpstream
} from './pod-orbstack-anthropic-route'
import { createAnthropicUpstream } from './pod-orbstack-anthropic-upstream'
import { readMacClaudePrivacy, type SandboxPrivacy } from './pod-orbstack-privacy-env'
import type { SandboxRelays } from './pod-orbstack-relay'
import { SANDBOX_CA_PATH } from './pod-orbstack-relay-agent'
import { createSandboxCas } from './pod-orbstack-sandbox-ca'
import { createSandboxHookTokens } from './pod-orbstack-sandbox-tokens'

/**
 * What the VM's Claude Code gets instead of a credential. The relay drops it and adds the real one,
 * so the VM never holds anything that works against the API. Each sandbox gets its own random
 * suffix, in memory only, so no two sandboxes (or clones of one template) share it.
 */
export const SANDBOX_CREDENTIAL_PLACEHOLDER = 'pod-sandbox-no-credential'

export function createSandboxAccess(deps: {
  relays: SandboxRelays
  upstream?: AnthropicUpstream
  /** The Mac's Claude Code privacy switches; re-read at every launch. */
  readPrivacy?: () => SandboxPrivacy
  log?: (message: string) => void
  /** Relay log rows of the anthropic-api routes. */
  onRow?: (row: PodOrbstackRelayRowInput) => void
}) {
  const readPrivacy = deps.readPrivacy ?? (() => readMacClaudePrivacy())
  const privacy = new Map<string, SandboxPrivacy>()
  const hookTokens = createSandboxHookTokens()
  const cas = createSandboxCas()
  const routes = new Map<string, AnthropicRoute>()
  const placeholders = new Map<string, string>()
  const placeholderFor = (machine: string): string => {
    const live = placeholders.get(machine)
    if (live) {
      return live
    }
    const minted = `${SANDBOX_CREDENTIAL_PLACEHOLDER}-${randomBytes(16).toString('hex')}`
    placeholders.set(machine, minted)
    return minted
  }
  // One HTTP/2 session to the API for every sandbox; it opens on the first request.
  const client = createAnthropicUpstream({
    target: deps.upstream,
    log: (message) => deps.log?.(message)
  })

  const dropRoute = (machine: string): void => {
    routes.get(machine)?.close()
    routes.delete(machine)
    cas.drop(machine)
    getPodSandboxAnthropicCredentials().released?.({ machine })
  }

  const anthropicRoute = (machine: string): AnthropicRoute => {
    const live = routes.get(machine)
    if (live) {
      return live
    }
    const route = createAnthropicRoute({
      machine,
      ca: cas.forMachine(machine),
      upstream: deps.upstream,
      client,
      privacy: () => privacy.get(machine) ?? readPrivacy(),
      log: (message) => deps.log?.(`${machine}: ${message}`),
      onRow: (row) => deps.onRow?.({ machine, route: 'anthropic-api', ...row })
    })
    routes.set(machine, route)
    return route
  }

  return {
    /** Mints the hook token as the sandbox becomes ready. */
    created(machine: string): void {
      hookTokens.tokenFor(machine)
    },

    /**
     * Starts (or reuses) the machine's relay. Returns the nonce a launch waits for and the env the
     * VM's agent gets, keyed by its name inside the VM.
     */
    start(
      machine: string,
      hookServer: { port: number; token: string }
    ): { nonce: string; vmEnv: Record<string, string> } {
      const mac = readPrivacy()
      privacy.set(machine, mac)
      const mode = getPodSandboxAnthropicCredentials().mode()
      if (mode === 'off') {
        dropRoute(machine)
      }
      const anthropic = mode === 'off' ? null : anthropicRoute(machine)
      if (anthropic) {
        // Binds the sandbox to the login this launch resolves, as a Mac launch would.
        getPodSandboxAnthropicCredentials().launched?.({ machine })
      }
      const { nonce } = deps.relays.ensure(machine, {
        hook: {
          vmPort: hookServer.port,
          hostPort: hookServer.port,
          hookToken: hookServer.token,
          authorize: (token) => hookTokens.authorizes(machine, token)
        },
        anthropic: anthropic ? { route: anthropic } : null
      })
      return {
        nonce,
        vmEnv: {
          // A sandboxed agent sends nothing the Mac agent would not.
          ...mac.env,
          ORCA_AGENT_HOOK_TOKEN: hookTokens.tokenFor(machine),
          ...(anthropic
            ? {
                NODE_EXTRA_CA_CERTS: SANDBOX_CA_PATH,
                // The placeholder's kind picks the auth Claude Code uses, matching the credential.
                [mode === 'oauth' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY']:
                  placeholderFor(machine)
              }
            : {})
        }
      }
    },

    /** The sandbox is going: its relay, token, CA and route go first. */
    forget(machine: string): void {
      deps.relays.stop(machine)
      hookTokens.revokeMachine(machine)
      privacy.delete(machine)
      placeholders.delete(machine)
      dropRoute(machine)
    }
  }
}

export type SandboxAccess = ReturnType<typeof createSandboxAccess>
