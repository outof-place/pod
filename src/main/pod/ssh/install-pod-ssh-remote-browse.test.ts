import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPodSshRemoteBrowse, setPodSshRemoteBrowse } from './pod-ssh-remote-browse'
import { installPodSshRemoteBrowse } from './install-pod-ssh-remote-browse'

const { getSshConnectionManagerMock } = vi.hoisted(() => ({
  getSshConnectionManagerMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
vi.mock('../../ssh/ssh-target-registry', () => ({
  getSshConnectionManager: getSshConnectionManagerMock
}))

afterEach(() => {
  setPodSshRemoteBrowse(null)
  vi.clearAllMocks()
})

describe('installPodSshRemoteBrowse', () => {
  it("lists through the desktop's browser on the current connection manager", async () => {
    const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
    const exec = vi.fn().mockResolvedValue(channel)
    const getConnection = vi.fn(() => ({ exec }))
    getSshConnectionManagerMock.mockReturnValue({ getConnection })
    installPodSshRemoteBrowse()

    const listing = getPodSshRemoteBrowse()?.('ssh-1', '~/src')
    await vi.waitFor(() => expect(exec).toHaveBeenCalled())
    channel.emit('data', Buffer.from('/home/me/src\napp/\nnotes.md\n'))
    channel.emit('exit', 0)
    channel.emit('close')

    await expect(listing).resolves.toEqual({
      resolvedPath: '/home/me/src',
      pathFlavor: 'posix',
      entries: [
        { name: 'app', isDirectory: true },
        { name: 'notes.md', isDirectory: false }
      ]
    })
    expect(getConnection).toHaveBeenCalledWith('ssh-1')
    expect(exec).toHaveBeenCalledWith(expect.stringContaining(`cd "$HOME"/'src' && pwd`))
  })

  it('names a host that is not connected', async () => {
    getSshConnectionManagerMock.mockReturnValue({ getConnection: () => undefined })
    installPodSshRemoteBrowse()

    await expect(getPodSshRemoteBrowse()?.('ssh-9', '~')).rejects.toThrow(
      'SSH connection "ssh-9" not found'
    )
  })

  it('reports a host whose SSH layer has no connection manager yet', async () => {
    getSshConnectionManagerMock.mockReturnValue(null)
    installPodSshRemoteBrowse()

    await expect(getPodSshRemoteBrowse()?.('ssh-1', '~')).rejects.toThrow(
      'SSH connection manager not initialized'
    )
  })
})
