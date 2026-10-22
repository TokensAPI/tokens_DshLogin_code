// A real HTTP stand-in for the TokensAPI (new-api) console, for the live-host
// contract cases.
//
// The host-side cases boot an installed Host for real, so the plugin's console
// calls are real `fetch` calls out of that Host process. They have to land
// somewhere: the live deployment is not a test dependency, and stubbing
// `globalThis.fetch` inside a running Host would reach into the Host itself.
// So this process serves the console's endpoints over loopback HTTP and the
// plugin is configured with `site: http://127.0.0.1:<port>` — a value its own
// `normalizeSite` accepts (HTTPS anywhere, HTTP on loopback). Nothing about the
// plugin's network path is mocked: real sockets, real headers, real JSON.
//
// It answers only what the plugin asks for, the way the deployment answers it:
// the key list carries masked keys, a single-key read carries the key without
// its `sk-` prefix, and `/v1/models` accepts only keys this console issued.
import { createServer } from 'node:http'

/** The account the simulated browser hands back. */
export const ACCOUNT = Object.freeze({
  accessToken: 'live-host-account-token',
  userId: 7,
  username: 'live-host-user',
  displayName: 'Live Host User',
})

/** The console stores keys without the `sk-` prefix and prepends it when rendering. */
function maskLikeConsole(key) {
  if (key.length <= 4) return '*'.repeat(key.length)
  if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`
  return `${key.slice(0, 4)}**********${key.slice(-4)}`
}

/**
 * Serve the console endpoints this plugin uses on a loopback port.
 *
 * @param options.tokens - keys the account starts with, newest last.
 * @returns the listening origin, a log of every request, and a close function.
 */
export async function startConsole({ tokens = [] } = {}) {
  const state = {
    tokens: tokens.map((token) => ({ ...token })),
    nextId: Math.max(0, ...tokens.map((token) => token.id)) + 1,
    requests: [],
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const authorization = req.headers.authorization ?? ''
      state.requests.push({ method: req.method, path: url.pathname, search: url.search, authorization, user: req.headers['new-api-user'] })
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      // `/v1/models` is the key plane: it authenticates the sk- key itself.
      if (url.pathname === '/v1/models') {
        const key = authorization.replace(/^Bearer /u, '').replace(/^sk-/u, '')
        if (!state.tokens.some((token) => token.key === key)) return send(401, { error: { message: 'invalid key' } })
        return send(200, { data: [{ id: 'deepseek-chat' }] })
      }

      // Everything else is the account plane: it authenticates the session.
      if (authorization !== ACCOUNT.accessToken || req.headers['new-api-user'] !== `${ACCOUNT.userId}`) {
        return send(401, { success: false, message: 'Unauthorized' })
      }
      if (url.pathname === '/api/user/self') {
        return send(200, { success: true, data: { username: ACCOUNT.username, display_name: ACCOUNT.displayName } })
      }
      if (url.pathname === '/api/token/' && req.method === 'GET') {
        return send(200, { success: true, data: { items: state.tokens.map((token) => ({
          id: token.id, name: token.name, status: token.status, key: maskLikeConsole(token.key),
        })) } })
      }
      if (url.pathname === '/api/token/' && req.method === 'POST') {
        const id = state.nextId++
        state.tokens.push({ id, name: body?.name ?? '', status: 1, key: `live-host-key-${id}` })
        return send(200, { success: true, data: {} })
      }
      const reveal = /^\/api\/token\/(\d+)\/key$/u.exec(url.pathname)
      if (reveal !== null && req.method === 'POST') {
        const token = state.tokens.find((entry) => entry.id === Number(reveal[1]))
        if (token === undefined) return send(200, { success: false, message: 'token not found' })
        return send(200, { success: true, data: { key: token.key } })
      }
      send(404, { success: false, message: `unexpected console endpoint ${url.pathname}` })
    })
  })

  await new Promise((settle, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', settle)
  })

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    /** Every request the plugin made, in order; the cases assert on it. */
    requests: state.requests,
    tokens: state.tokens,
    maskLikeConsole,
    close: () => new Promise((settle) => server.close(settle)),
  }
}
