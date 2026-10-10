import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { writeFileAtomically } from '../../codex-accounts/fs-utils'
import { POD_ORBSTACK_MACHINE_PREFIX } from '../../../shared/pod-orbstack-types'

const MachineEntrySchema = z.object({
  name: z.string().startsWith(POD_ORBSTACK_MACHINE_PREFIX),
  worktreeId: z.string().min(1),
  worktreePath: z.string().min(1),
  createdAt: z.number(),
  // Why keep creating: a crash mid-create must still let Pod delete what it started.
  state: z.enum(['creating', 'ready']),
  // shared: the worktree's terminal machine, all of /Users. sandbox: isolated, for agents.
  kind: z.enum(['shared', 'sandbox']).default('shared'),
  /** Claude Code version installed in a sandbox; matches the host's at provisioning. */
  agentVersion: z.string().optional()
})

const RegistrySchema = z.object({
  version: z.literal(1),
  machines: z.array(MachineEntrySchema),
  dockerPins: z.array(z.string()),
  /** Worktrees whose Claude launches run in their sandbox by default. */
  sandboxAgents: z.array(z.string()).default([])
})

export type PodOrbstackMachineKind = z.infer<typeof MachineEntrySchema>['kind']
export type PodOrbstackMachineEntry = z.infer<typeof MachineEntrySchema>
type PodOrbstackMachineEntryInput = z.input<typeof MachineEntrySchema>
type RegistryData = z.infer<typeof RegistrySchema>

/** The only record of machines Pod created; anything not listed here is read-only to Pod. */
export class PodOrbstackRegistry {
  private data: RegistryData | null = null

  constructor(private readonly filePath: string) {}

  private load(): RegistryData {
    if (this.data) {
      return this.data
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      parsed = undefined
    }
    const result = RegistrySchema.safeParse(parsed)
    this.data = result.success
      ? result.data
      : { version: 1, machines: [], dockerPins: [], sandboxAgents: [] }
    return this.data
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileAtomically(this.filePath, `${JSON.stringify(this.load(), null, 2)}\n`)
  }

  machines(): readonly PodOrbstackMachineEntry[] {
    return this.load().machines
  }

  dockerPins(): readonly string[] {
    return this.load().dockerPins
  }

  findByName(name: string): PodOrbstackMachineEntry | null {
    return this.load().machines.find((entry) => entry.name === name) ?? null
  }

  findByWorktree(
    worktreeId: string,
    kind: PodOrbstackMachineKind = 'shared'
  ): PodOrbstackMachineEntry | null {
    return (
      this.load().machines.find(
        (entry) => entry.worktreeId === worktreeId && entry.kind === kind
      ) ?? null
    )
  }

  /** Pod may change a machine only if both the prefix and this registry say it is Pod's. */
  isPodOwned(name: string): boolean {
    return name.startsWith(POD_ORBSTACK_MACHINE_PREFIX) && this.findByName(name) !== null
  }

  upsert(entry: PodOrbstackMachineEntryInput): void {
    const parsed = MachineEntrySchema.parse(entry)
    const data = this.load()
    data.machines = [...data.machines.filter((existing) => existing.name !== parsed.name), parsed]
    this.save()
  }

  remove(name: string): void {
    const data = this.load()
    data.machines = data.machines.filter((entry) => entry.name !== name)
    this.save()
  }

  isDockerPinned(worktreeId: string): boolean {
    return this.load().dockerPins.includes(worktreeId)
  }

  setDockerPin(worktreeId: string, pinned: boolean): void {
    const data = this.load()
    const others = data.dockerPins.filter((id) => id !== worktreeId)
    data.dockerPins = pinned ? [...others, worktreeId] : others
    this.save()
  }

  sandboxAgents(): readonly string[] {
    return this.load().sandboxAgents
  }

  isSandboxAgents(worktreeId: string): boolean {
    return this.load().sandboxAgents.includes(worktreeId)
  }

  setSandboxAgents(worktreeId: string, enabled: boolean): void {
    const data = this.load()
    const others = data.sandboxAgents.filter((id) => id !== worktreeId)
    data.sandboxAgents = enabled ? [...others, worktreeId] : others
    this.save()
  }
}
