// Real upstream Cordis + file credentials in independent child processes.
// The browser hand-off and console are simulated. No user secrets are read.
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { createRequire } from 'node:module'
import { get } from 'node:http'
import { join } from 'node:path'
import { TOKENS_LOGIN, __login } from '../../dsh/index.js'

const require = createRequire(import.meta.url)
const [action, directory] = process.argv.slice(2)
const settings = { site: 'https://example.test', desktopAuthPath: '/desktop-auth', tokenName: 'TokensCowork', autoCreateApiKey: true }
const ctx = new Context()
ctx[DSH_LAUNCH_ENVIRONMENT_KEY] = createLaunchEnvironmentSnapshot([])
const fiber = ctx.plugin(LocalCredentialProvider, { path: join(directory, '.credentials.yaml'), watch: false })
await fiber
let authorizationMatches = false
globalThis.fetch = async (url, init = {}) => {
  if (action === 'offline') throw new Error('simulated offline')
  const path = new URL(url).pathname
  if (path === '/api/user/self') {
    authorizationMatches = init.headers.authorization === 'test-account-token' && init.headers['new-api-user'] === '7'
    return { status: 200, json: async () => ({ success: true, data: { username: 'test-user', display_name: 'Test User' } }) }
  }
  if (path === '/api/token/') return { status: 200, json: async () => ({ success: true, data: { items: [
    { id: 1, name: 'TokensCowork', status: 1, key: __login.maskLikeConsole('test-relay-key') },
  ] } }) }
  if (path === '/api/token/1/key') return { status: 200, json: async () => ({ success: true, data: { key: 'test-relay-key' } }) }
  if (path === '/v1/models') return { status: 200, json: async () => ({ data: [] }) }
  throw new Error('Unexpected test endpoint')
}
try {
  const runtime = __login.loginRuntime(ctx)
  runtime.desktopRuntime = { openExternal: async (href) => {
    const target = new URL(href)
    await new Promise((resolve, reject) => {
      get(`http://127.0.0.1:${target.searchParams.get('port')}/callback?state=${target.searchParams.get('state')}&token=test-account-token&id=7`, res => {
        res.resume()
        res.on('end', resolve)
      }).on('error', reject)
    })
  } }
  if (action === 'sign-in') await __login.login(ctx, runtime, settings)
  if (action === 'logout') await __login.logout(ctx, runtime)
  if (action === 'manual') await __login.setApiKey(ctx, settings, { apiKey: 'sk-test-relay-key' })
  const status = await __login.loginStatus(ctx, runtime, settings)
  const stored = await ctx.credentials.resolve(TOKENS_LOGIN.accessTokenRef)
  console.log(JSON.stringify({ ...status, authorizationMatches, source: stored?.source,
    providerVersion: require('@deepseek-ai/dsh-credentials-local/package.json').version,
    cordisVersion: require('@deepseek-ai/cordis/package.json').version }))
} finally {
  await fiber.dispose()
}
