// Fork-only (Pod): a Linear GraphQL server on 127.0.0.1 for tests and probes, and a fetch guard
// that fails a test on any request off loopback. No test of Pod's ever talks to real Linear.
import { createServer, type IncomingMessage } from 'node:http'

export type LinearMockRequest = { authorization: string | null; query: string; variables: unknown }

export type LinearMockReply = { status?: number; headers?: Record<string, string>; body: unknown }

export type LinearMockServer = {
  apiUrl: string
  requests: LinearMockRequest[]
  close: () => Promise<void>
}

export const LINEAR_MOCK_VIEWER = {
  id: 'user-mock-1',
  name: 'Ada Lovelace',
  displayName: 'ada',
  email: 'ada@mock.invalid'
}

// The SDK's Organization model maps projectStatuses unconditionally.
export const LINEAR_MOCK_ORGANIZATION = {
  id: 'org-mock-1',
  name: 'Mock Co',
  urlKey: 'mock-co',
  projectStatuses: []
}

/** The answer to a request: the viewer and its organization by default, else no data. */
export function defaultLinearMockReply(request: LinearMockRequest): LinearMockReply {
  if (/\bviewer\b/.test(request.query)) {
    return { body: { data: { viewer: LINEAR_MOCK_VIEWER } } }
  }
  if (/\borganization\b/.test(request.query)) {
    return { body: { data: { organization: LINEAR_MOCK_ORGANIZATION } } }
  }
  return {
    body: {
      data: null,
      errors: [
        { message: 'not mocked', extensions: { type: 'invalid input', code: 'INVALID_INPUT' } }
      ]
    }
  }
}

/** Linear's answer to a key it doesn't accept; the SDK maps it to AuthenticationLinearError. */
export function linearMockAuthErrorReply(): LinearMockReply {
  return {
    status: 401,
    body: {
      errors: [
        {
          message: 'Authentication required, not authenticated',
          extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR' }
        }
      ]
    }
  }
}

/** Linear's answer once a user is over the limit: HTTP 400 with RATELIMITED. */
export function linearMockRateLimitedReply(resetAtMs: number): LinearMockReply {
  return {
    status: 400,
    headers: {
      'X-RateLimit-Requests-Limit': '2500',
      'X-RateLimit-Requests-Remaining': '0',
      'X-RateLimit-Requests-Reset': String(resetAtMs)
    },
    body: {
      errors: [
        { message: 'Rate limit exceeded', extensions: { type: 'ratelimited', code: 'RATELIMITED' } }
      ]
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function startLinearMockServer(
  reply: (request: LinearMockRequest) => LinearMockReply = defaultLinearMockReply
): Promise<LinearMockServer> {
  const requests: LinearMockRequest[] = []
  const server = createServer((req, res) => {
    void readBody(req).then((text) => {
      let parsed: { query?: unknown; variables?: unknown } = {}
      try {
        parsed = JSON.parse(text)
      } catch {
        // An unparsable body is recorded with an empty query and answered as not mocked.
      }
      const request: LinearMockRequest = {
        authorization: req.headers.authorization ?? null,
        query: typeof parsed.query === 'string' ? parsed.query : '',
        variables: parsed.variables
      }
      requests.push(request)
      const answer = reply(request)
      res.writeHead(answer.status ?? 200, { 'Content-Type': 'application/json', ...answer.headers })
      res.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    apiUrl: `http://127.0.0.1:${port}/graphql`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Throws on every fetch off loopback until restored; `blocked` lists the hosts it refused. */
export function guardFetchToLoopback(): { blocked: string[]; restore: () => void } {
  const original = globalThis.fetch
  const blocked: string[] = []
  globalThis.fetch = (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const host = new URL(href).hostname
    if (!LOOPBACK_HOSTS.has(host)) {
      blocked.push(host)
      return Promise.reject(new Error(`fetch guard: ${host} is not loopback`))
    }
    return original(input, init)
  }
  return { blocked, restore: () => (globalThis.fetch = original) }
}

export function linearMockIssueNode(id: string, identifier: string) {
  return {
    id,
    identifier,
    title: `Fix ${identifier}`,
    url: `https://linear.app/mock-co/issue/${identifier}`,
    priority: 0,
    updatedAt: '2026-10-19T00:00:00.000Z',
    state: { name: 'Todo', type: 'unstarted', color: '#999999' },
    team: { id: 'team-1', name: 'Engineering', key: identifier.split('-')[0] ?? '' },
    labels: { nodes: [] }
  }
}

type LinearMockIssueNode = ReturnType<typeof linearMockIssueNode>

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

// As the API documents it: id.in takes issue UUIDs (an "ENG-9" there matches nothing), and an
// identifier is its team key plus its number.
function issueMatches(node: LinearMockIssueNode, clause: unknown): boolean {
  const ids = field(field(clause, 'id'), 'in')
  if (Array.isArray(ids)) {
    return ids.includes(node.id)
  }
  const key = field(field(field(clause, 'team'), 'key'), 'eq')
  const numbers = field(field(clause, 'number'), 'in')
  return (
    typeof key === 'string' &&
    Array.isArray(numbers) &&
    node.team.key === key &&
    numbers.includes(Number(node.identifier.split('-')[1]))
  )
}

/** issues(filter: {or: [...]}) over `nodes`, for linear.getIssues; anything else as the default. */
export function linearMockIssuesReply(
  nodes: LinearMockIssueNode[]
): (request: LinearMockRequest) => LinearMockReply {
  return (request) => {
    if (!request.query.includes('PodLinearIssuesByIds')) {
      return defaultLinearMockReply(request)
    }
    const or = field(field(request.variables, 'filter'), 'or')
    const clauses: unknown[] = Array.isArray(or) ? or : []
    const matched = nodes.filter((node) => clauses.some((clause) => issueMatches(node, clause)))
    return { body: { data: { issues: { nodes: matched } } } }
  }
}
