// The base world of runtime responses every parity case starts from; cases override per method.

export const ok = (result) => [{ result }]

export function baseWorld({ worktree, nested }) {
  const wt = (id, path, extra = {}) => ({
    id,
    repoId: 'repo-1',
    path,
    branch: 'main',
    displayName: path.split('/').pop(),
    hostId: 'local',
    parentWorktreeId: null,
    childWorktreeIds: [],
    linkedIssue: null,
    comment: '',
    ...extra
  })
  const tab = (index, extra = {}) => ({
    browserPageId: `page-${index}`,
    index,
    url: `https://example.test/${index}`,
    title: `Tab ${index}`,
    active: index === 0,
    worktreeId: 'repo-1::wt',
    profileId: null,
    profileLabel: null,
    ...extra
  })
  return {
    'worktree.list': ok({
      worktrees: [
        wt(`repo-1::${worktree}`, worktree, {
          childWorktreeIds: ['c1', 'c2'],
          linkedIssue: 42,
          comment: 'wip ✓'
        }),
        wt(`repo-1::${nested}`, nested, { displayName: null, hostId: null }),
        wt('repo-2::/elsewhere', '/elsewhere')
      ],
      totalCount: 3,
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: [] }
    }),
    'worktree.show': ok({
      worktree: wt(`repo-1::${worktree}`, worktree, {
        git: { ahead: 1 },
        tags: ['a', 'b']
      })
    }),
    'terminal.resolveActive': ok({ handle: 'term-active-1' }),
    'terminal.read': ok({
      terminal: {
        handle: 'term-active-1',
        status: 'running',
        nextCursor: '120',
        oldestCursor: '0',
        latestCursor: '120',
        truncated: false,
        limited: false,
        tail: ['$ pnpm test', 'PASS  src/a.test.ts', '\u001b[32m✓\u001b[0m 12 tests', '']
      }
    }),
    'terminal.wait': ok({
      wait: {
        handle: 'term-active-1',
        condition: 'exit',
        satisfied: true,
        status: 'exited',
        exitCode: 0
      }
    }),
    'terminal.list': ok({
      terminals: [
        {
          handle: 'term-1',
          title: 'dev',
          connected: true,
          executionHostId: 'local',
          worktreePath: worktree,
          preview: 'ready on :3000'
        },
        {
          handle: 'term-2',
          title: null,
          connected: false,
          worktreePath: nested,
          preview: ''
        }
      ],
      totalCount: 2,
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: [] }
    }),
    'terminal.show': ok({
      terminal: {
        handle: 'term-active-1',
        title: null,
        worktreePath: worktree,
        branch: 'main',
        leafId: 'leaf-1',
        ptyId: null,
        connected: true,
        writable: true,
        agentWait: null,
        preview: 'idle'
      }
    }),
    'browser.snapshot': ok({
      browserPageId: 'page-0',
      snapshot: '- heading "Hello" [ref=e1]\n- button "Go" [ref=e2]',
      refs: [],
      url: 'https://example.test/',
      title: 'Example — Home'
    }),
    'browser.screenshot': ok({
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      format: 'png'
    }),
    'browser.goto': ok({ url: 'https://example.test/next', title: 'Next' }),
    'browser.back': ok({ url: 'https://example.test/', title: 'Back' }),
    'browser.reload': ok({ url: 'https://example.test/', title: 'Reloaded' }),
    'browser.forward': ok({ url: 'https://example.test/fwd' }),
    'browser.eval': ok({
      result: '{"count":3,"ok":true}',
      origin: 'https://example.test'
    }),
    'browser.scroll': ok({ scrolled: 'down' }),
    'browser.wait': ok({ waited: true }),
    'browser.click': ok({ clicked: '@e2' }),
    'browser.dblclick': ok({}),
    'browser.fill': ok({ filled: '@e3' }),
    'browser.type': ok({ typed: true }),
    'browser.keypress': ok({ pressed: 'Enter' }),
    'browser.focus': ok({ focused: '@e1' }),
    'browser.hover': ok({ hovered: '@e1' }),
    'browser.clear': ok({ cleared: '@e1' }),
    'browser.selectAll': ok({ selected: '@e1' }),
    'browser.tabList': ok({
      tabs: [tab(0), tab(1, { profileLabel: 'Work' }), tab(2, { profileId: 'p-9' })]
    }),
    'browser.tabShow': ok({ tab: tab(1, { profileLabel: 'Work' }) }),
    'browser.tabCurrent': ok({ tab: tab(0, { worktreeId: null }) }),
    'browser.tabSwitch': ok({ switched: 1, browserPageId: 'page-1' }),
    'browser.tabCreate': ok({ browserPageId: 'page-new' }),
    'browser.tabClose': ok({ closed: true }),
    'browser.openUrl': ok({ browserPageId: 'page-url' }),
    'browser.exec': ok({
      output: ['a', 1, null, { b: [true] }],
      empty: {},
      list: []
    })
  }
}
