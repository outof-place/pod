import { describe, expect, it } from 'vitest'
import {
  parseCloneOwnerAndName,
  workspaceCloneParent,
  workspaceCreateProjectParent
} from './workspace-clone-destination'

describe('parseCloneOwnerAndName', () => {
  it.each([
    ['https://github.com/acme/widget.git', ['acme'], 'widget'],
    ['https://github.com/acme/widget', ['acme'], 'widget'],
    ['https://github.com/acme/widget/', ['acme'], 'widget'],
    ['git@github.com:acme/widget.git', ['acme'], 'widget'],
    ['ssh://git@github.com/acme/widget.git', ['acme'], 'widget'],
    ['ssh://git@git.example.com:2222/team/widget.git', ['team'], 'widget'],
    ['https://gitlab.com/group/sub/deeper/widget.git', ['group', 'sub', 'deeper'], 'widget'],
    ['git@gitlab.com:group/sub/widget.git', ['group', 'sub'], 'widget'],
    ['https://dev.azure.com/org/project/_git/widget', ['org', 'project'], 'widget'],
    ['https://org@dev.azure.com/org/project/_git/widget', ['org', 'project'], 'widget'],
    ['git@ssh.dev.azure.com:v3/org/project/widget', ['org', 'project'], 'widget'],
    ['https://org.visualstudio.com/project/_git/widget', ['org', 'project'], 'widget'],
    ['org@vs-ssh.visualstudio.com:v3/org/project/widget', ['org', 'project'], 'widget'],
    ['https://bitbucket.org/team/widget.git', ['team'], 'widget'],
    ['https://git.example.com/team/my%20widget.git', ['team'], 'my widget']
  ])('reads %s', (url, owner, name) => {
    expect(parseCloneOwnerAndName(url)).toEqual({ owner, name })
  })

  it.each([
    '/Users/me/src/widget',
    './widget',
    'file:///Users/me/src/widget.git',
    'C:\\src\\widget',
    'https://git.example.com/widget.git',
    'https://git.example.com/../widget.git',
    'https://git.example.com/team/%2E%2E/widget.git',
    'not a url',
    ''
  ])('names no owner for %s', (url) => {
    expect(parseCloneOwnerAndName(url)).toBeNull()
  })
})

describe('workspace clone and create parents', () => {
  it('nests clones under the owner and falls back to _local', () => {
    expect(workspaceCloneParent('/Users/me/pod', 'git@github.com:acme/widget.git')).toBe(
      '/Users/me/pod/acme'
    )
    expect(workspaceCloneParent('/Users/me/pod', 'https://gitlab.com/a/b/c.git')).toBe(
      '/Users/me/pod/a/b'
    )
    expect(workspaceCloneParent('/Users/me/pod', '/tmp/widget')).toBe('/Users/me/pod/_local')
    expect(workspaceCreateProjectParent('/Users/me/pod')).toBe('/Users/me/pod/_local')
  })
})
