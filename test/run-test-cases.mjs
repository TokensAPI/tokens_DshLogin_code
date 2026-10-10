// One CSV inventory and one executable implementation; no parallel test suites.
// Normal mode reports CSV results. The isolated suite and credential child
// modes reuse this file so process-restart tests still exercise real persistence.
import { run, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { get as httpGet } from 'node:http'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { parse } from 'yaml'
import { TOKENS_LOGIN, __login, apply, credentialFingerprint, inject, name } from '../dsh/index.js'
import { validateRelease } from '../scripts/validate-release.mjs'
import { verifyPackage } from '../scripts/verify-package.mjs'
import { ensureUnpublished, verifyPublished } from '../scripts/registry-release.mjs'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const root = dirname(directory)
const suiteFlag = '--conditions=tokens-login-case-suite'
const headers = ['用例编号', '所属模块', '用例标题', '前置条件', '测试数据', '操作步骤', '预期结果', '优先级', '自动化状态', '对应测试']

export function parseCases(source) {
  const rows = []
  let row = [], field = '', quoted = false
  source = source.replace(/^\uFEFF/u, '')
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index++ }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(field); field = '' }
    else if (char === '\n') { row.push(field.replace(/\r$/u, '')); rows.push(row); row = []; field = '' }
    else field += char
  }
  if (quoted) throw new Error('Unclosed CSV quote')
  if (field || row.length) { row.push(field.replace(/\r$/u, '')); rows.push(row) }
  if (JSON.stringify(rows.shift()) !== JSON.stringify(headers)) throw new Error('Incorrect case CSV headers')
  const seen = new Set()
  const cases = rows.filter(row => row.some(Boolean)).map(row => {
    if (row.length !== headers.length) throw new Error('Incorrect CSV column count')
    const item = Object.fromEntries(headers.map((header, index) => [header, row[index]]))
    const id = item['用例编号']
    if (!id || seen.has(id)) throw new Error('Missing or duplicate case ID: ' + id)
    seen.add(id)
    if (item['自动化状态'] !== '已自动化') throw new Error(id + ': incomplete automation')
    item.references = item['对应测试'].split(' | ')
    for (const reference of item.references) {
      if (!/^test\/run-test-cases\.mjs :: .+$/u.test(reference)) throw new Error(id + ': invalid mapping ' + reference)
    }
    return item
  })
  if (!cases.length) throw new Error('No functional cases')
  return cases
}

export function evaluateCases(cases, results) {
  return cases.map(item => ({ id: item['用例编号'], errors: item.references.flatMap(reference => {
    const result = results.get(reference)
    return result?.passed ? [] : [reference + ': ' + (result?.reason ?? 'missing test / not executed')]
  }) }))
}

async function main() {
  const cases = parseCases(readFileSync(join(directory, 'test_cases.csv'), 'utf8'))
  const files = [...new Set(cases.flatMap(item => item.references.map(reference => reference.split(' :: ')[0])))]
  const results = new Map()
  let failedTests = 0
  for await (const event of run({ files: files.map(file => join(root, file)), isolation: 'process', execArgv: [suiteFlag] })) {
    if (!['test:pass', 'test:fail'].includes(event.type)) continue
    const data = event.data
    const file = data.file ? relative(root, resolve(data.file)).replaceAll('\\', '/') : ''
    const passed = event.type === 'test:pass' && !data.skip && !data.todo
    const reason = data.skip || data.todo ? 'skipped/TODO'
      : String(data.details?.error?.cause?.stack ?? data.details?.error?.message ?? 'test failed')
    const key = file + ' :: ' + data.name
    if (results.has(key)) throw new Error('Ambiguous duplicate test name: ' + key)
    results.set(key, { passed, reason })
    if (!passed) { failedTests++; console.error(key + '\n' + reason) }
  }
  const evaluated = evaluateCases(cases, results)
  const failures = evaluated.filter(item => item.errors.length)
  const passedCases = cases.length - failures.length
  for (const failure of failures) console.error(failure.id + '\n' + failure.errors.join('\n'))
  console.log(`${passedCases}/${cases.length} cases passed; ${failures.length || failedTests ? 'failed/incomplete' : 'all passed'}.`)
  process.exitCode = failures.length || failedTests ? 1 : 0
}

function registerCases() {
  // 登录、Key 与账户会话
  {
    const {
      loopbackCallback,
      normalizeSite, normalizeSitePath, normalizeTokenName, isTrustedRequest, errorStatus, loginRuntime, login,
      setApiKey, refreshApiKey, listApiKeys, revealApiKey, useApiKey, maskLikeConsole, logout, loginStatus,
    } = __login

    const SETTINGS = Object.freeze({
      site: 'https://tokensapi.ai',
      tokenName: 'TokensCowork',
      autoCreateApiKey: true,
      desktopAuthPath: '/desktop-auth',
    })

    function fakeCtx() {
      const store = new Map()
      return {
        store,
        credentials: {
          set: async (ref, value) => void store.set(ref, value),
          unset: async (ref) => void store.delete(ref),
          resolve: async (ref) => store.get(ref) ?? '',
        },
      }
    }

    /**
     * Console fetch mock over the token APIs. Keys come back the way the console
     * sends them: masked in the list, unprefixed in the single-key reveal.
     */
    function mockConsole({ tokens = [], failCreate = false } = {}) {
      const state = { tokens: [...tokens], created: 0 }
      globalThis.fetch = async (url, init = {}) => {
        const path = String(url).replace(SETTINGS.site, '')
        const reply = (body, status = 200) => ({ status, json: async () => body })
        if (path.startsWith('/api/token/?')) return reply({ success: true, data: { items: state.tokens } })
        if (path === '/api/token/' && init.method === 'POST') {
          if (failCreate) return reply({ success: false, message: '已达到最大令牌数量限制' })
          state.created += 1
          state.tokens.push({ id: 99, name: JSON.parse(init.body).name, status: 1 })
          return reply({ success: true })
        }
        if (/\/api\/token\/\d+\/key$/.test(path)) {
          return reply({ success: true, data: { key: `full-${path.match(/token\/(\d+)\/key/)[1]}` } })
        }
        if (path === '/api/user/self') return reply({ success: true, data: { username: 'alice', display_name: 'Alice' } })
        if (path === '/v1/models') return reply({ data: [] })
        throw new Error(`unmatched fetch: ${url}`)
      }
      return state
    }

    /**
     * The one door: a host that can open a browser, standing in for the user
     * completing sign-in on the site's hand-off page. `seen` records what the
     * browser was actually sent to, for the tests that care.
     */
    function signIn(ctx, options = {}, seen = {}) {
      loginRuntime(ctx).desktopRuntime = {
        openExternal: async (href) => {
          const url = new URL(href)
          seen.href = href
          seen.status = await hit(
            url.searchParams.get('port'),
            options.callback ?? `state=${url.searchParams.get('state')}&token=access-token-xyz&id=7`,
          )
        },
      }
      return mockConsole(options)
    }

    /** A stored console session, without going through sign-in. */
    async function seedSession(ctx) {
      await ctx.credentials.set(TOKENS_LOGIN.accessTokenRef, 't')
      await ctx.credentials.set(TOKENS_LOGIN.userIdRef, '7')
    }

    /** A real request at the plugin's loopback listener; resolves the status code. */
    function hit(port, query) {
      return new Promise((resolve, reject) => {
        httpGet({ host: '127.0.0.1', port, path: `/callback?${query}` }, (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
        }).on('error', reject)
      })
    }

    const realFetch = globalThis.fetch
    test.afterEach(() => {
      globalThis.fetch = realFetch
    })

    test('module contract and fingerprint format', () => {
      assert.equal(name, 'tokens-login')
      assert.deepEqual(inject, ['credentials'])
      assert.equal(typeof apply, 'function')
      assert.match(credentialFingerprint('sk-test'), /^sha256:[0-9a-f]{64}$/)
    })

    test('normalizeSite accepts HTTPS origins and loopback HTTP only', () => {
      assert.equal(normalizeSite(undefined), TOKENS_LOGIN.site)
      assert.equal(normalizeSite('https://dev.tokensapi.ai/'), 'https://dev.tokensapi.ai')
      assert.equal(normalizeSite('http://127.0.0.1:3000'), 'http://127.0.0.1:3000')
      assert.throws(() => normalizeSite('http://tokensapi.ai'))
      assert.throws(() => normalizeSite('not a url'))
    })

    test('normalizeTokenName falls back on empty or oversized values', () => {
      assert.equal(normalizeTokenName('  My Key '), 'My Key')
      assert.equal(normalizeTokenName(''), TOKENS_LOGIN.tokenName)
      assert.equal(normalizeTokenName('x'.repeat(51)), TOKENS_LOGIN.tokenName)
    })

    test('isTrustedRequest fences non-loopback and cross-site callers', () => {
      assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:5299' } }), true)
      assert.equal(isTrustedRequest({ headers: { host: 'localhost:5299', origin: 'http://localhost:5299' } }), true)
      assert.equal(isTrustedRequest({ headers: { host: 'evil.example' } }), false)
      assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:5299', 'sec-fetch-site': 'cross-site' } }), false)
      assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:5299', origin: 'https://evil.example' } }), false)
    })

    test('errorStatus maps login error codes onto HTTP', () => {
      assert.equal(errorStatus('invalid_key'), 401)
      assert.equal(errorStatus('unreachable'), 503)
      assert.equal(errorStatus('upstream'), 502)
      assert.equal(errorStatus('browser_unavailable'), 501)
      assert.equal(errorStatus('anything_else'), 400)
    })

    test('login stores the handed-back session and auto-creates the API key', async () => {
      const ctx = fakeCtx()
      const state = signIn(ctx)
      const apiKeyError = await login(ctx, loginRuntime(ctx), SETTINGS)
      assert.equal(apiKeyError, '')
      assert.equal(state.created, 1)
      assert.equal(ctx.store.get(TOKENS_LOGIN.accessTokenRef), 'access-token-xyz')
      assert.equal(ctx.store.get(TOKENS_LOGIN.userIdRef), '7')
      assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyRef), 'sk-full-99')
      assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyVerificationRef), credentialFingerprint('sk-full-99'))
      const status = await loginStatus(ctx, loginRuntime(ctx), SETTINGS)
      assert.equal(status.authenticated, true)
      assert.equal(status.signedIn, true)
      assert.equal(status.user.username, 'alice')
    })

    test('login reuses an existing enabled token instead of creating one', async () => {
      const ctx = fakeCtx()
      const state = signIn(ctx, { tokens: [{ id: 3, name: 'disabled', status: 2 }, { id: 5, name: 'existing', status: 1 }] })
      await login(ctx, loginRuntime(ctx), SETTINGS)
      assert.equal(state.created, 0)
      assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyRef), 'sk-full-5')
    })

    test('login keeps a stored key the account itself lists', async () => {
      const ctx = fakeCtx()
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyRef, 'sk-abcdefgh12345678')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyVerificationRef, credentialFingerprint('sk-abcdefgh12345678'))
      const state = signIn(ctx, { tokens: [{ id: 3, name: 'laptop', status: 1, key: 'abcd**********5678' }] })
      assert.equal(await login(ctx, loginRuntime(ctx), SETTINGS), '')
      assert.equal(state.created, 0)
      assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyRef), 'sk-abcdefgh12345678')
    })

    test('login replaces a verified key the account does not have', async () => {
      const ctx = fakeCtx()
      // What account 102 left behind: locally verified, and nowhere on this account.
      await ctx.credentials.set(TOKENS_LOGIN.userIdRef, '102')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyRef, 'sk-someone-else')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyVerificationRef, credentialFingerprint('sk-someone-else'))
      const state = signIn(ctx)
      assert.equal(await login(ctx, loginRuntime(ctx), SETTINGS), '')
      assert.equal(state.created, 1)
      assert.equal(ctx.store.get(TOKENS_LOGIN.userIdRef), '7')
      assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyRef), 'sk-full-99')
    })

    test('signing in again as the same account still drops a foreign key', async () => {
      const ctx = fakeCtx()
      await ctx.credentials.set(TOKENS_LOGIN.userIdRef, '7')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyRef, 'sk-someone-else')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyVerificationRef, credentialFingerprint('sk-someone-else'))
      signIn(ctx, { tokens: [{ id: 5, name: 'existing', status: 1, key: 'zzzz**********wwww' }] })
      assert.equal(await login(ctx, loginRuntime(ctx), SETTINGS), '')
      assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyRef), 'sk-full-5')
    })

    test('a failed key provisioning keeps the sign-in and reports the message', async () => {
      const ctx = fakeCtx()
      signIn(ctx, { failCreate: true })
      const apiKeyError = await login(ctx, loginRuntime(ctx), SETTINGS)
      assert.match(apiKeyError, /最大令牌数量/)
      assert.equal(ctx.store.get(TOKENS_LOGIN.accessTokenRef), 'access-token-xyz')
      assert.equal(ctx.store.has(TOKENS_LOGIN.apiKeyRef), false)
    })

    test('login without a desktop bridge reports browser_unavailable', async () => {
      const ctx = fakeCtx()
      await assert.rejects(
        () => login(ctx, loginRuntime(ctx), SETTINGS),
        (error) => error.code === 'browser_unavailable',
      )
    })

    test('setApiKey validates against /v1/models before persisting', async () => {
      const ctx = fakeCtx()
      globalThis.fetch = async () => ({ status: 200, json: async () => ({}) })
      await setApiKey(ctx, SETTINGS, { apiKey: ' sk-manual ' })
      assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyRef), 'sk-manual')
      globalThis.fetch = async () => ({ status: 401, json: async () => ({}) })
      await assert.rejects(() => setApiKey(ctx, SETTINGS, { apiKey: 'sk-bad' }), /API Key 无效/)
      await assert.rejects(() => setApiKey(ctx, SETTINGS, { apiKey: '' }), /有效的 API Key/)
    })

    test('logout clears the console session and leaves the relay key alone', async () => {
      const ctx = fakeCtx()
      const runtime = loginRuntime(ctx)
      await ctx.credentials.set(TOKENS_LOGIN.accessTokenRef, 't')
      await ctx.credentials.set(TOKENS_LOGIN.userIdRef, '7')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyRef, 'sk-keep')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyVerificationRef, credentialFingerprint('sk-keep'))
      runtime.user = { id: 7 }
      await logout(ctx, runtime)
      assert.equal(ctx.store.has(TOKENS_LOGIN.accessTokenRef), false)
      assert.equal(ctx.store.has(TOKENS_LOGIN.userIdRef), false)
      assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyRef), 'sk-keep')
      assert.equal(runtime.user, null)
      // The gate comes back because the session went, not because the key did:
      // downstream plugins still see a working key.
      const status = await loginStatus(ctx, runtime, SETTINGS)
      assert.equal(status.signedIn, false)
      assert.equal(status.authenticated, true)
    })

    test('status masks the relay key to its last four characters', async () => {
      const ctx = fakeCtx()
      assert.equal((await loginStatus(ctx, loginRuntime(ctx), SETTINGS)).apiKeyMasked, '')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyRef, 'sk-abcdefgh1234')
      assert.equal((await loginStatus(ctx, loginRuntime(ctx), SETTINGS)).apiKeyMasked, 'sk-…1234')
    })

    test('signedIn tracks the account session, never the relay key', async () => {
      const ctx = fakeCtx()
      mockConsole()
      // A verified key on its own is not a session: the gate must still appear.
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyRef, 'sk-leftover')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyVerificationRef, credentialFingerprint('sk-leftover'))
      let status = await loginStatus(ctx, loginRuntime(ctx), SETTINGS)
      assert.equal(status.authenticated, true)
      assert.equal(status.signedIn, false)
      // A session on its own is a session, with or without a usable key.
      await ctx.credentials.set(TOKENS_LOGIN.accessTokenRef, 't')
      await ctx.credentials.set(TOKENS_LOGIN.userIdRef, '7')
      status = await loginStatus(ctx, loginRuntime(ctx), SETTINGS)
      assert.equal(status.signedIn, true)
      // Verification doubles as hydration: the name survives a restart now.
      assert.equal(status.user?.username, 'alice')
      // A half-written session (token, no user id) is not one either.
      await ctx.credentials.set(TOKENS_LOGIN.userIdRef, '')
      assert.equal((await loginStatus(ctx, loginRuntime(ctx), SETTINGS)).signedIn, false)
    })

    test('a stored session is verified against the console exactly once per boot', async () => {
      const ctx = fakeCtx()
      await seedSession(ctx)
      let selfCalls = 0
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/api/user/self')) {
          selfCalls += 1
          return { status: 200, json: async () => ({ success: true, data: { username: 'alice', display_name: 'Alice' } }) }
        }
        throw new Error(`unmatched fetch: ${url}`)
      }
      const runtime = loginRuntime(ctx)
      const first = await loginStatus(ctx, runtime, SETTINGS)
      assert.equal(first.signedIn, true)
      assert.equal(first.user?.displayName, 'Alice')
      const second = await loginStatus(ctx, runtime, SETTINGS)
      assert.equal(second.signedIn, true)
      assert.equal(selfCalls, 1)
    })

    test('a session the console rejects is cleared; the relay key stays', async () => {
      const ctx = fakeCtx()
      await seedSession(ctx)
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyRef, 'sk-keep')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyVerificationRef, credentialFingerprint('sk-keep'))
      // The deployed console rejects a bad token with 200 + success:false
      // ("Unauthorized, invalid access token"), not an HTTP 401 — pin the real
      // shape so only-status-code checks cannot sneak back in.
      globalThis.fetch = async () => ({
        status: 200,
        json: async () => ({ success: false, message: 'Unauthorized, invalid access token' }),
      })
      const status = await loginStatus(ctx, loginRuntime(ctx), SETTINGS)
      // The token was reissued on another device: the claim is dead, the gate
      // must come back — but the key is a separate fact and keeps working.
      assert.equal(status.signedIn, false)
      assert.equal(status.user, null)
      assert.equal(ctx.store.has(TOKENS_LOGIN.accessTokenRef), false)
      assert.equal(ctx.store.has(TOKENS_LOGIN.userIdRef), false)
      assert.equal(status.authenticated, true)
    })

    test('a console that speaks in status codes is understood too', async () => {
      const ctx = fakeCtx()
      await seedSession(ctx)
      globalThis.fetch = async () => ({ status: 401, json: async () => null })
      const status = await loginStatus(ctx, loginRuntime(ctx), SETTINGS)
      assert.equal(status.signedIn, false)
      assert.equal(ctx.store.has(TOKENS_LOGIN.accessTokenRef), false)
    })

    test('an unreachable console decides nothing, and the next status asks again', async () => {
      const ctx = fakeCtx()
      await seedSession(ctx)
      globalThis.fetch = async () => {
        throw new Error('offline')
      }
      const runtime = loginRuntime(ctx)
      const offline = await loginStatus(ctx, runtime, SETTINGS)
      // An offline start must not be locked out of a session it really has.
      assert.equal(offline.signedIn, true)
      assert.equal(offline.user, null)
      // Back online: the memo was reset, so this status call verifies and names.
      mockConsole()
      const online = await loginStatus(ctx, runtime, SETTINGS)
      assert.equal(online.signedIn, true)
      assert.equal(online.user?.username, 'alice')
    })

    test('a late rejection of an old token never clears a fresh session', async () => {
      const ctx = fakeCtx()
      await seedSession(ctx)
      let release
      globalThis.fetch = () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 401, json: async () => ({ success: false }) })
        })
      const runtime = loginRuntime(ctx)
      const pending = loginStatus(ctx, runtime, SETTINGS)
      // While the console is still chewing on the old token, a browser sign-in
      // lands a fresh session…
      await ctx.credentials.set(TOKENS_LOGIN.accessTokenRef, 'fresh-token')
      await ctx.credentials.set(TOKENS_LOGIN.userIdRef, '7')
      release()
      await pending
      // …and the stale 401 must not wipe it.
      assert.equal(ctx.store.get(TOKENS_LOGIN.accessTokenRef), 'fresh-token')
      assert.equal(ctx.store.get(TOKENS_LOGIN.userIdRef), '7')
    })

    function loginRoute(ctx) {
      let route
      ctx.inject = (services, callback) => {
        if (services.includes('webServer')) callback({ webServer: { register: value => { route = value } } })
      }
      apply(ctx, SETTINGS)
      return async (body) => {
        let status, payload
        const req = {
          method: 'POST', headers: { host: '127.0.0.1:5299' },
          async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
        }
        const res = { writeHead(value) { status = value; return this }, end(value) { payload = JSON.parse(value) } }
        await route.handler(req, res)
        return { status, body: payload }
      }
    }

    test('account actions report expired sessions without clearing the model key', async () => {
      for (const rejection of [200, 401, 403]) {
        for (const action of ['listApiKeys', 'revealApiKey', 'useApiKey', 'refreshApiKey']) {
          const ctx = fakeCtx()
          await seedSession(ctx)
          await ctx.credentials.set(TOKENS_LOGIN.apiKeyRef, 'sk-keep')
          await ctx.credentials.set(TOKENS_LOGIN.apiKeyVerificationRef, credentialFingerprint('sk-keep'))
          const runtime = loginRuntime(ctx)
          runtime.user = { id: 7, username: 'alice' } // Already verified this boot.
          let calls = 0
          globalThis.fetch = async (url) => {
            assert.ok(!String(url).includes('/v1/'), 'expiry must not validate or replace the model key')
            calls++
            return { status: rejection, json: async () => ({ success: false, message: 'Unauthorized, invalid access token' }) }
          }
          const result = await loginRoute(ctx)({ action, id: 1 })
          assert.equal(result.status, 401)
          assert.equal(result.body.code, 'session_expired')
          assert.equal(result.body.status.signedIn, false)
          assert.equal(result.body.status.sessionExpired, true)
          assert.equal(result.body.status.authenticated, true)
          assert.equal(ctx.store.has(TOKENS_LOGIN.accessTokenRef), false)
          assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyRef), 'sk-keep')
          assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyVerificationRef), credentialFingerprint('sk-keep'))
          assert.ok(!JSON.stringify(result.body).includes('Unauthorized'))
          assert.ok(!JSON.stringify(result.body).includes('sk-keep'))
          assert.equal(calls, rejection === 200 ? 2 : 1)
          assert.equal((await loginStatus(ctx, runtime, SETTINGS)).sessionExpired, true)
          const repeated = await loginRoute(ctx)({ action, id: 1 })
          assert.equal(repeated.body.code, 'session_expired')
          assert.equal(repeated.body.status.sessionExpired, true)
          assert.equal(calls, rejection === 200 ? 2 : 1, 'a cleared session must not be sent again')
        }
      }
    })

    test('account business errors and uncertain confirmation do not expire sessions', async () => {
      for (const confirmation of ['valid', 'offline', 'server', 'html']) {
        const ctx = fakeCtx()
        await seedSession(ctx)
        const runtime = loginRuntime(ctx)
        runtime.user = { id: 7 }
        globalThis.fetch = async (url) => {
          if (String(url).endsWith('/api/user/self')) {
            if (confirmation === 'offline') throw new Error('offline')
            if (confirmation === 'server') return { status: 503, json: async () => null }
            if (confirmation === 'html') return { status: 404, json: async () => { throw new Error('HTML') } }
            return { status: 200, json: async () => ({ success: true, data: { id: 7 } }) }
          }
          return { status: 200, json: async () => ({ success: false, message: '账户业务错误' }) }
        }
        const result = await loginRoute(ctx)({ action: 'listApiKeys' })
        assert.equal(result.status, 502)
        assert.equal(result.body.code, 'upstream')
        assert.equal(ctx.store.get(TOKENS_LOGIN.accessTokenRef), 't')
        assert.equal(runtime.sessionExpired, false)
      }
    })

    test('a late account action rejection leaves a newer login intact', async () => {
      const ctx = fakeCtx()
      await seedSession(ctx)
      const runtime = loginRuntime(ctx)
      runtime.user = { id: 7 }
      let release, started
      const ready = new Promise(resolve => { started = resolve })
      globalThis.fetch = async () => new Promise(resolve => {
        release = () => resolve({ status: 401, json: async () => ({ success: false }) })
        started()
      })
      const pending = loginRoute(ctx)({ action: 'listApiKeys' })
      await ready
      await ctx.credentials.set(TOKENS_LOGIN.accessTokenRef, 'fresh-token')
      runtime.user = { id: 7, username: 'fresh' }
      release()
      const result = await pending
      assert.equal(result.body.code, 'upstream')
      assert.equal(ctx.store.get(TOKENS_LOGIN.accessTokenRef), 'fresh-token')
      assert.equal(runtime.sessionExpired, false)
      assert.equal(runtime.user.username, 'fresh')
    })

    test('signing in again resets the expired notice and verifies the new session', async () => {
      const ctx = fakeCtx()
      const runtime = loginRuntime(ctx)
      runtime.sessionExpired = true
      signIn(ctx)
      await login(ctx, runtime, SETTINGS)
      const status = await loginStatus(ctx, runtime, SETTINGS)
      assert.equal(status.signedIn, true)
      assert.equal(status.sessionExpired, false)
      assert.equal(status.authenticated, true)
      await logout(ctx, runtime)
      assert.equal((await loginStatus(ctx, runtime, SETTINGS)).sessionExpired, false)
    })

    test('a rejected browser handoff is not reported as a successful login', async () => {
      for (const point of ['profile', 'keys']) {
        const ctx = fakeCtx()
        signIn(ctx)
        const original = globalThis.fetch
        globalThis.fetch = async (url, init) => {
          if (String(url).endsWith('/api/user/self') && point === 'keys') return original(url, init)
          return { status: 401, json: async () => ({ success: false }) }
        }
        const result = await loginRoute(ctx)({ action: 'login' })
        assert.equal(result.status, 401)
        assert.equal(result.body.code, 'session_expired')
        assert.equal(result.body.status.signedIn, false)
        assert.equal(result.body.status.sessionExpired, true)
      }
    })

    test('refreshApiKey refuses before sign-in and re-provisions after it', async () => {
      const ctx = fakeCtx()
      await assert.rejects(() => refreshApiKey(ctx, SETTINGS), /请先登录/)
      await seedSession(ctx)
      // A verified key is already stored; refresh must still go upstream.
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyRef, 'sk-old')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyVerificationRef, credentialFingerprint('sk-old'))
      globalThis.fetch = async (url, init) => {
        const path = String(url)
        if (path.includes('/api/token/?')) {
          return { status: 200, json: async () => ({ success: true, data: { items: [{ id: 3, name: 'TokensCowork', status: 1 }] } }) }
        }
        if (path.includes('/api/token/3/key')) {
          return { status: 200, json: async () => ({ success: true, data: { key: 'new' } }) }
        }
        if (path.includes('/v1/models')) return { status: 200, json: async () => ({ data: [] }) }
        throw new Error(`unexpected request: ${path} ${init?.method ?? 'GET'}`)
      }
      await refreshApiKey(ctx, SETTINGS)
      assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyRef), 'sk-new')
      assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyVerificationRef), credentialFingerprint('sk-new'))
    })

    test('desktopAuthPath defaults to the hand-off page and refuses off-site values', () => {
      assert.equal(normalizeSitePath(undefined), TOKENS_LOGIN.desktopAuthPath)
      assert.equal(normalizeSitePath('  '), TOKENS_LOGIN.desktopAuthPath)
      assert.equal(normalizeSitePath('/hand-off'), '/hand-off')
      assert.throws(() => normalizeSitePath('https://evil.example/login'), /站内路径/)
      assert.throws(() => normalizeSitePath('//evil.example/login'), /站内路径/)
    })

    test('login sends the browser to the hand-off page carrying a port and nonce', async () => {
      const ctx = fakeCtx()
      const seen = {}
      signIn(ctx, {}, seen)
      assert.equal(await login(ctx, loginRuntime(ctx), SETTINGS), '')
      const sent = new URL(seen.href)
      assert.equal(sent.origin + sent.pathname, 'https://tokensapi.ai/desktop-auth')
      assert.match(sent.searchParams.get('state'), /^[0-9a-f]{32}$/)
      assert.match(sent.searchParams.get('port'), /^\d+$/)
      assert.equal(seen.status, 200)
      assert.equal(ctx.store.get(TOKENS_LOGIN.accessTokenRef), 'access-token-xyz')
      assert.equal(ctx.store.get(TOKENS_LOGIN.userIdRef), '7')
      assert.equal(loginRuntime(ctx).user.displayName, 'Alice')
    })

    test('a callback carrying the wrong nonce is refused, not believed', async () => {
      const ctx = fakeCtx()
      const seen = {}
      loginRuntime(ctx).desktopRuntime = {
        openExternal: async (href) => {
          const url = new URL(href)
          const port = url.searchParams.get('port')
          // Another local process guessing the port must not be able to plant a token.
          seen.forged = await hit(port, 'state=forged&token=attacker-token&id=99')
          seen.real = await hit(port, `state=${url.searchParams.get('state')}&token=access-token-xyz&id=7`)
        },
      }
      mockConsole()
      await login(ctx, loginRuntime(ctx), SETTINGS)
      assert.equal(seen.forged, 403)
      assert.equal(seen.real, 200)
      assert.equal(ctx.store.get(TOKENS_LOGIN.accessTokenRef), 'access-token-xyz')
    })

    test('a second click joins the sign-in already in flight', async () => {
      const ctx = fakeCtx()
      let opened = 0
      const seen = {}
      signIn(ctx, {}, seen)
      const outer = loginRuntime(ctx).desktopRuntime.openExternal
      loginRuntime(ctx).desktopRuntime.openExternal = async (href) => {
        opened += 1
        return outer(href)
      }
      const runtime = loginRuntime(ctx)
      const [first, second] = await Promise.all([login(ctx, runtime, SETTINGS), login(ctx, runtime, SETTINGS)])
      assert.equal(first, '')
      assert.equal(second, '')
      assert.equal(opened, 1)
    })

    test('the hand-off page is opened in the language the app is in', async () => {
      const ctx = fakeCtx()
      mockConsole()
      const opened = []
      let handedOff
      const browserOpen = new Promise((resolve) => {
        handedOff = resolve
      })
      loginRuntime(ctx).desktopRuntime = {
        openExternal: async (href) => {
          opened.push(href)
          handedOff()
        },
      }
      const runtime = loginRuntime(ctx)
      const attempt = login(ctx, runtime, SETTINGS, 'zh')
      await browserOpen
      const url = new URL(opened[0])
      assert.equal(url.searchParams.get('lng'), 'zh', 'the browser would otherwise pick its own language')
      const status = await hit(url.searchParams.get('port'), `state=${url.searchParams.get('state')}&token=access-token-xyz&id=7`)
      assert.equal(status, 200)
      assert.equal(await attempt, '')
    })

    test('clicking again once the browser is open re-opens the same hand-off page', async () => {
      const ctx = fakeCtx()
      mockConsole()
      const opened = []
      let handedOff
      const browserOpen = new Promise((resolve) => {
        handedOff = resolve
      })
      loginRuntime(ctx).desktopRuntime = {
        openExternal: async (href) => {
          opened.push(href)
          handedOff()
        },
      }
      const runtime = loginRuntime(ctx)
      const first = login(ctx, runtime, SETTINGS)
      // The browser is open and the listener is waiting; the user closes the tab
      // and clicks again.
      await browserOpen
      assert.equal(login(ctx, runtime, SETTINGS), first, 'the attempt in flight is joined, not restarted')
      assert.equal(opened.length, 2, 'the user is sent back to the page, not left staring at the button')
      assert.equal(opened[1], opened[0], 'same port and same nonce: still one listener')
      const url = new URL(opened[0])
      const status = await hit(
        url.searchParams.get('port'),
        `state=${url.searchParams.get('state')}&token=access-token-xyz&id=7`,
      )
      assert.equal(status, 200)
      assert.equal(await first, '')
    })

    test('status carries the app locale, which the gate mounts too early to read', async () => {
      const ctx = fakeCtx()
      assert.equal((await loginStatus(ctx, loginRuntime(ctx), SETTINGS)).locale, '')
      loginRuntime(ctx).desktopRuntime = { openExternal: async () => {}, locale: 'zh' }
      assert.equal((await loginStatus(ctx, loginRuntime(ctx), SETTINGS)).locale, 'zh')
    })

    test('canSignIn reports whether the host can open a browser at all', async () => {
      const ctx = fakeCtx()
      assert.equal((await loginStatus(ctx, loginRuntime(ctx), SETTINGS)).canSignIn, false)
      loginRuntime(ctx).desktopRuntime = { openExternal: async () => {} }
      assert.equal((await loginStatus(ctx, loginRuntime(ctx), SETTINGS)).canSignIn, true)
    })

    test('maskLikeConsole mirrors the console masking, so short keys stay short', () => {
      assert.equal(maskLikeConsole('abc'), '***')
      assert.equal(maskLikeConsole('abcdefgh'), 'ab****gh')
      assert.equal(maskLikeConsole('abcdefgh12345678'), 'abcd**********5678')
    })

    test('listApiKeys shows every key masked and marks the one in use', async () => {
      const ctx = fakeCtx()
      await assert.rejects(() => listApiKeys(ctx, SETTINGS), /请先登录/)
      await seedSession(ctx)
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyRef, 'sk-abcdefgh12345678')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyVerificationRef, credentialFingerprint('sk-abcdefgh12345678'))
      mockConsole({
        tokens: [
          { id: 3, name: 'laptop', status: 1, key: 'abcd**********5678' },
          { id: 5, name: 'retired', status: 2, key: 'zzzz**********wwww' },
        ],
      })
      assert.deepEqual(await listApiKeys(ctx, SETTINGS), [
        { id: 3, name: 'laptop', masked: 'sk-abcd**********5678', enabled: true, inUse: true },
        { id: 5, name: 'retired', masked: 'sk-zzzz**********wwww', enabled: false, inUse: false },
      ])
    })

    test('listApiKeys marks nothing when no key is stored', async () => {
      const ctx = fakeCtx()
      await seedSession(ctx)
      mockConsole({ tokens: [{ id: 3, name: 'laptop', status: 1, key: 'abcd**********5678' }] })
      assert.equal((await listApiKeys(ctx, SETTINGS))[0].inUse, false)
    })

    test('listApiKeys adopts one of the account keys when the stored key is foreign', async () => {
      const ctx = fakeCtx()
      await seedSession(ctx)
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyRef, 'sk-someone-else')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyVerificationRef, credentialFingerprint('sk-someone-else'))
      const state = mockConsole({ tokens: [{ id: 5, name: 'existing', status: 1, key: 'zzzz**********wwww' }] })
      const keys = await listApiKeys(ctx, SETTINGS)
      assert.equal(state.created, 0)
      assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyRef), 'sk-full-5')
      assert.equal(keys.length, 1)
    })

    test('listApiKeys leaves a key the account lists alone', async () => {
      const ctx = fakeCtx()
      await seedSession(ctx)
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyRef, 'sk-abcdefgh12345678')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyVerificationRef, credentialFingerprint('sk-abcdefgh12345678'))
      mockConsole({
        tokens: [
          { id: 3, name: 'laptop', status: 1, key: 'abcd**********5678' },
          { id: 5, name: 'other', status: 1, key: 'zzzz**********wwww' },
        ],
      })
      assert.equal((await listApiKeys(ctx, SETTINGS)).find((item) => item.inUse).id, 3)
      assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyRef), 'sk-abcdefgh12345678')
    })

    test('listApiKeys provisions the first key when the account has none', async () => {
      const ctx = fakeCtx()
      await seedSession(ctx)
      const state = mockConsole({ tokens: [] })
      const keys = await listApiKeys(ctx, SETTINGS)
      assert.equal(state.created, 1)
      assert.equal(keys.length, 1)
      assert.equal(keys[0].name, SETTINGS.tokenName)
      assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyRef), 'sk-full-99')
    })

    test('listApiKeys stays empty when auto-creation is off', async () => {
      const ctx = fakeCtx()
      await seedSession(ctx)
      const state = mockConsole({ tokens: [] })
      assert.deepEqual(await listApiKeys(ctx, { ...SETTINGS, autoCreateApiKey: false }), [])
      assert.equal(state.created, 0)
    })

    test('revealApiKey returns one full key and refuses a bad id', async () => {
      const ctx = fakeCtx()
      await assert.rejects(() => revealApiKey(ctx, SETTINGS, { id: 3 }), /请先登录/)
      await seedSession(ctx)
      mockConsole()
      assert.equal(await revealApiKey(ctx, SETTINGS, { id: 3 }), 'sk-full-3')
      await assert.rejects(() => revealApiKey(ctx, SETTINGS, { id: 'nope' }), /无效的 API Key 编号/)
    })

    test('revealApiKey without an id answers with the stored key, session or not', async () => {
      const ctx = fakeCtx()
      // No key stored yet: an empty answer, not an error.
      assert.equal(await revealApiKey(ctx, SETTINGS, {}), '')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyRef, 'sk-mine')
      // A local read: no session, no network — the header works for key-only users.
      assert.equal(await revealApiKey(ctx, SETTINGS, {}), 'sk-mine')
    })

    test('useApiKey switches the app to a listed key, verify-then-persist', async () => {
      const ctx = fakeCtx()
      await assert.rejects(() => useApiKey(ctx, SETTINGS, { id: 5 }), /请先登录/)
      await seedSession(ctx)
      mockConsole()
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyRef, 'sk-old')
      await ctx.credentials.set(TOKENS_LOGIN.apiKeyVerificationRef, credentialFingerprint('sk-old'))
      await useApiKey(ctx, SETTINGS, { id: 5 })
      // The stored key and its fingerprint move together, so downstream plugins
      // see the new key as verified with no extra step.
      assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyRef), 'sk-full-5')
      assert.equal(ctx.store.get(TOKENS_LOGIN.apiKeyVerificationRef), credentialFingerprint('sk-full-5'))
      await assert.rejects(() => useApiKey(ctx, SETTINGS, { id: 'nope' }), /无效的 API Key 编号/)
    })

    test('an attempt nobody answers expires, and the next one starts clean', async () => {
      // Five real minutes is the product timeout; the listener's own deadline is
      // the part under test, so hand it a short one and watch the same path.
      const expired = await loopbackCallback('nonce-one', 20)
      assert.equal(await expired.done, undefined, 'nothing came back, so there is nothing to believe')
      await assert.rejects(
        () => hit(expired.port, 'state=nonce-one&token=late&id=1'),
        'the listener must not outlive the attempt it was opened for',
      )

      // Starting over is a fresh nonce on a fresh listener: the expired attempt's
      // callback, arriving late in some forgotten tab, is refused.
      const retry = await loopbackCallback('nonce-two', 5000)
      assert.equal(await hit(retry.port, 'state=nonce-one&token=late&id=1'), 403)
      assert.equal(await hit(retry.port, 'state=nonce-two&token=access-token-xyz&id=7'), 200)
      assert.deepEqual(await retry.done, { accessToken: 'access-token-xyz', userId: 7 })
    })
  }

  // 包配置、发布与产物
  {
    // Parse the actual workflows, and exercise Registry success and refusal paths.

    const root = new URL('../', import.meta.url)
    const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
    const workflow = parse(readFileSync(new URL('.github/workflows/publish-npm.yml', root), 'utf8'))
    const checks = parse(readFileSync(new URL('.github/workflows/checks.yml', root), 'utf8'))
    const tag = `v${manifest.version}`
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status })
    const metadata = versions => ({ name: manifest.name, versions })

    test('manifest pins the private registry as the publish target', () => {
      assert.equal(manifest.name, '@tokensapi/dsh-login')
      assert.equal(manifest.publishConfig.registry, 'https://npm.tokensapi.ai/')
      assert.notEqual(manifest.publishConfig.access, 'public')
    })

    test('market metadata provides distinct Chinese and English display names and summaries', () => {
      for (const key of ['displayName', 'summary']) {
        const translations = manifest.tokenscowork[key]
        for (const locale of ['zh-CN', 'en-US']) assert.ok(translations[locale].trim())
        assert.notEqual(translations['zh-CN'], translations['en-US'])
      }
    })

    test('manifest lockfile version and changelog describe the current release', () => {
      const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'))
      assert.equal(lock.version, manifest.version)
      assert.equal(lock.packages[''].version, manifest.version)
      assert.equal(lock.packages[''].engines.node, manifest.engines.node)
      const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8')
      assert.ok(changelog.split(/\r?\n/u).includes('## ' + manifest.version))
      assert.ok(changelog.includes('/compare/v0.1.4...v0.1.5'))
    })

    test('validateRelease accepts a tag matching a stable version', () => {
      assert.equal(validateRelease(manifest, tag), manifest.version)
    })

    test('validateRelease rejects the wrong package registry repository version or tag', () => {
      assert.throws(() => validateRelease({ ...manifest, name: '@other/plugin' }, tag), /package name/u)
      assert.throws(() => validateRelease({ ...manifest, publishConfig: { registry: 'https://registry.npmjs.org/' } }, tag), /private registry/u)
      assert.throws(() => validateRelease({ ...manifest, publishConfig: { ...manifest.publishConfig, access: 'public' } }, tag), /private registry/u)
      assert.throws(() => validateRelease({ ...manifest, publishConfig: undefined }, tag), /private registry/u)
      for (const url of ['https://github.com/other/tokens_DshLogin_code.git', 'https://github.com.evil.test/TokensAPI/tokens_DshLogin_code.git',
        'https://github.com/TokensAPI/tokens_DshLogin_code.git?owner=other']) {
        assert.throws(() => validateRelease({ ...manifest, repository: { url } }, tag), /repository identity/u)
      }
      assert.throws(() => validateRelease({ ...manifest, version: manifest.version + '-beta.1' }, tag + '-beta.1'), /stable/u)
      assert.throws(() => validateRelease(manifest, tag + '-wrong'), /must match/u)
      assert.throws(() => validateRelease(manifest, undefined), /must match/u)
    })

    test('parsed workflows separate branch checks from tag-only publishing', () => {
      assert.deepEqual(checks.on.push.branches, ['**'])
      assert.ok(Object.hasOwn(checks.on, 'pull_request'))
      assert.deepEqual(workflow.on, { push: { tags: ['v*'] } })
      assert.deepEqual(workflow.jobs.check.strategy.matrix, checks.jobs.check.strategy.matrix)
      assert.deepEqual(checks.jobs.check.strategy.matrix.node, ['22.19.0', 24])
      assert.equal(manifest.engines.node, '^22.19.0 || ^24.0.0')
      assert.equal(workflow.jobs.publish.needs, 'check')
      assert.equal(workflow.jobs.publish.if, "github.repository == 'TokensAPI/tokens_DshLogin_code' && startsWith(github.ref, 'refs/tags/v')")
      assert.equal(workflow.concurrency['cancel-in-progress'], false)
      const packageCheck = workflow.jobs['package-check']
      assert.equal(packageCheck.needs, 'publish')
      const checker = packageCheck.uses.match(/^TokensAPI\/tokens_DshPluginCheck_code\/\.github\/workflows\/check-plugin-package\.yml@([a-f0-9]{40})$/u)
      assert.ok(checker, '包检查必须调用固定提交的公共流程')
      assert.deepEqual(packageCheck.with, { package: '${{ needs.publish.outputs.package }}', checker_ref: checker[1] })
      assert.deepEqual(packageCheck.secrets, { PLUGIN_CHECK_REGISTRY_TOKEN: '${{ secrets.PLUGIN_CHECK_REGISTRY_TOKEN }}' })
      for (const config of [checks, workflow]) {
        assert.deepEqual(config.permissions, { contents: 'read' })
        for (const job of Object.values(config.jobs)) {
          if (job.uses) {
            assert.equal(job, packageCheck)
            assert.equal(job.steps, undefined)
            continue
          }
          const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout'))
          assert.equal(checkout.with['persist-credentials'], false)
        }
        const commands = config.jobs.check.steps.map(step => step.run).filter(Boolean)
        assert.ok(commands.some(command => command.startsWith('npm ci --ignore-scripts')))
        assert.ok(commands.includes('npm run check'))
      }
    })

    test('publication uses the verified artifact private registry and step-scoped secret', () => {
      const steps = workflow.jobs.publish.steps
      const setup = steps.find(step => step.uses?.startsWith('actions/setup-node'))
      assert.equal(setup.with['registry-url'], manifest.publishConfig.registry)
      const authenticated = steps.filter(step => step.env?.NODE_AUTH_TOKEN)
      assert.equal(authenticated.length, 2)
      const publisher = authenticated.find(step => step.env.NODE_AUTH_TOKEN === '${{ secrets.VERDACCIO_PUBLISH_TOKEN }}')
      const inspection = authenticated.find(step => step.env.NODE_AUTH_TOKEN === '${{ secrets.PLUGIN_CHECK_REGISTRY_TOKEN }}')
      assert.ok(publisher && inspection)
      assert.ok(steps.indexOf(inspection) < steps.indexOf(publisher))
      assert.match(inspection.run, /NODE_AUTH_TOKEN:-/u)
      assert.match(inspection.run, /npm whoami.*== market/u)
      assert.doesNotMatch(inspection.run, /npm publish/u)
      const command = publisher.run
      assert.ok(command.includes('npm whoami --registry=https://npm.tokensapi.ai/'))
      assert.ok(command.includes('tokenscowork'))
      assert.ok(command.includes('缺少仓库 Secret VERDACCIO_PUBLISH_TOKEN'))
      assert.ok(command.includes('npm publish .release/*.tgz --ignore-scripts --registry=https://npm.tokensapi.ai/ --tag latest'))
      assert.ok(command.indexOf('registry-release.mjs preflight') < command.indexOf('npm publish'))
      assert.ok(command.indexOf('registry-release.mjs verify') > command.indexOf('npm publish'))
      assert.ok(steps.some(step => step.run?.includes('npm pack --ignore-scripts --pack-destination .release')))
      const output = steps.find(step => step.id === 'package')
      assert.ok(steps.indexOf(output) > steps.indexOf(publisher))
      assert.equal(workflow.jobs.publish.outputs.package, '${{ steps.package.outputs.package }}')
    })

    test('registry preflight permits only a confirmed absent version', async () => {
      await ensureUnpublished(manifest, { fetcher: async () => reply(metadata({})) })
      await assert.rejects(() => ensureUnpublished(manifest, { fetcher: async () => reply(metadata({ [manifest.version]: {} })) }), /already exists/u)
    })

    test('registry authentication network server and malformed responses stop release', async () => {
      for (const status of [401, 403, 404, 500, 503]) {
        await assert.rejects(() => ensureUnpublished(manifest, { fetcher: async () => reply({}, status) }), /query failed/u)
      }
      await assert.rejects(() => ensureUnpublished(manifest, { fetcher: async () => { throw new Error('offline') } }), /offline/u)
      await assert.rejects(() => ensureUnpublished(manifest, { fetcher: async () => reply({}) }), /invalid package metadata/u)
    })

    function publishedFixture(bytes) {
      return { ...metadata({ [manifest.version]: {
        name: manifest.name, version: manifest.version, tokenscowork: manifest.tokenscowork,
        dist: { integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
          shasum: createHash('sha1').update(bytes).digest('hex'), tarball: 'https://npm.tokensapi.ai/plugin.tgz' },
      } }), 'dist-tags': { latest: manifest.version } }
    }

    test('published release verifies metadata latest tag and downloaded tarball bytes', async () => {
      const bytes = Buffer.from([0, 255, 128, 42])
      const published = publishedFixture(bytes)
      let calls = 0
      await verifyPublished(manifest, bytes, { fetcher: async () => ++calls === 1 ? reply(published) : new Response(bytes) })
      assert.equal(calls, 2)
    })

    test('published verification rejects wrong metadata integrity bytes and foreign URLs', async () => {
      const bytes = Buffer.from([0, 255, 128, 42])
      for (const change of [
        data => { data['dist-tags'].latest = 'different' },
        data => { data.versions[manifest.version].tokenscowork = {} },
        data => { data.versions[manifest.version].dist.integrity = 'different' },
        data => { data.versions[manifest.version].dist.tarball = 'https://evil.test/plugin.tgz' },
      ]) {
        const published = publishedFixture(bytes)
        change(published)
        await assert.rejects(() => verifyPublished(manifest, bytes, { fetcher: async () => reply(published) }))
      }
      let calls = 0
      await assert.rejects(() => verifyPublished(manifest, bytes, {
        fetcher: async () => ++calls === 1 ? reply(publishedFixture(bytes)) : new Response('corrupt'),
      }), /bytes differ/u)
    })

    test('the packed artifact carries the plugin and imports cleanly', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-login-pack-'))
      try {
        // npm 在 Windows 上是 .cmd，Node 不允许 execFile 直接拉起它，所以走 shell。
        execSync(`npm pack --ignore-scripts --pack-destination "${dir}"`, {
          cwd: fileURLToPath(root),
          stdio: 'ignore',
        })
        const [tarball] = readdirSync(dir).filter((f) => f.endsWith('.tgz')).map((f) => join(dir, f))
        assert.ok(tarball, 'npm pack 应产出 tarball')
        const result = await verifyPackage(tarball)
        assert.equal(result.name, 'tokens-login')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('verifyPackage rejects a tarball that is missing the plugin entry', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-login-bad-'))
      try {
        writeFileSync(join(dir, 'readme.md'), '# not a plugin\n')
        execFileSync('tar', ['-czf', 'broken.tgz', 'readme.md'], { cwd: dir })
        await assert.rejects(() => verifyPackage(join(dir, 'broken.tgz')), /missing package\//u)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  // 中英文界面行为
  {
    function client(language = '', browserLanguage = 'en-US', environment = {}) {
      let registration
      const document = environment.document ?? { documentElement: { lang: language } }
      runInNewContext(readFileSync(new URL('../dsh/client.js', import.meta.url), 'utf8'), {
        window: { __ModuleLoader__: { load: value => { registration = value } } },
        document,
        navigator: { language: browserLanguage },
        ...environment,
      })
      return { gate: registration.factory(() => { throw new Error('No dependencies needed for labels') }).__gate, document }
    }

    // Deterministic hook harness: executes the real component, request promises,
    // effect dependencies and rendered button handlers, without a desktop/DOM.
    function accountView(language, request) {
      let reloaded = false
      const { gate } = client(language, 'en-US', {
        fetch: request, setTimeout, location: { reload: () => { reloaded = true } },
        navigator: { language: 'en-US', clipboard: { writeText: async () => {} } },
      })
      const hooks = []
      let cursor = 0, dirty = true, tree, pendingEffects = []
      const react = {
        createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
        useState(initial) {
          const index = cursor++
          hooks[index] ??= { value: initial }
          return [hooks[index].value, value => {
            const next = typeof value === 'function' ? value(hooks[index].value) : value
            if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true }
          }]
        },
        useRef(initial) {
          const index = cursor++
          hooks[index] ??= { current: initial }
          return hooks[index]
        },
        useEffect(effect, deps) {
          const index = cursor++
          const old = hooks[index]
          if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
            hooks[index] = { deps }
            pendingEffects.push(() => { old?.cleanup?.(); hooks[index].cleanup = effect() })
          }
        },
      }
      const Component = gate.AccountSection(react)
      function render() {
        for (let attempts = 0; dirty; attempts++) {
          assert.ok(attempts < 30, 'component must settle without a render loop')
          dirty = false; cursor = 0
          tree = Component()
          const effects = pendingEffects; pendingEffects = []
          for (const effect of effects) effect()
        }
      }
      const flatten = value => Array.isArray(value) ? value.flatMap(flatten)
        : value && typeof value === 'object' ? [value, ...flatten(value.children)] : [value]
      return {
        async flush() { for (let i = 0; i < 8; i++) { render(); await new Promise(resolve => setImmediate(resolve)) } render() },
        text() { return flatten(tree).filter(value => typeof value === 'string').join('\n') },
        button(label) { return flatten(tree).find(value => value?.type === 'button' && value.children.includes(label)) },
        buttonByTitle(label) { return flatten(tree).find(value => value?.type === 'button' && value.props.title === label) },
        get reloaded() { return reloaded },
      }
    }

    const clientReply = (body, ok = true) => ({ ok, json: async () => body })
    const accountStatus = { signedIn: true, authenticated: true, canSignIn: true, sessionExpired: false, user: { username: 'alice' } }

    test('account expiry renders localized guidance and recovers through sign-in', async () => {
      for (const language of ['zh-CN', 'en-US']) {
        const zh = language === 'zh-CN'
        let expired = true, loginBody
        const view = accountView(language, async (_url, init) => {
          if (init?.method !== 'POST') return clientReply(accountStatus)
          const body = JSON.parse(init.body)
          if (body.action === 'login') { expired = false; loginBody = body; return clientReply(accountStatus) }
          assert.equal(body.action, 'listApiKeys')
          return expired ? clientReply({ code: 'session_expired', error: 'Unauthorized, invalid access token',
            status: { ...accountStatus, signedIn: false, sessionExpired: true, user: null } }, false)
            : clientReply({ apiKeys: [{ id: 1, name: 'laptop', masked: 'sk-…1234', enabled: true, inUse: true }] })
        })
        await view.flush()
        const text = view.text()
        assert.ok(text.includes(zh ? '账户登录已失效' : 'Account sign-in is no longer valid'))
        assert.ok(text.includes(zh ? '其他设备重新授权' : 'authorization on another device'))
        assert.ok(text.includes(zh ? '未被清除' : 'has not been removed'))
        assert.ok(!text.includes('Unauthorized'))
        assert.ok(!text.includes(zh ? '正在读取' : 'Loading the keys'))
        assert.ok(!text.includes(zh ? '已登录' : 'Signed in'))
        assert.equal(view.button(zh ? '刷新列表' : 'Refresh list'), undefined)
        const login = view.button(zh ? '重新登录' : 'Sign in again')
        assert.equal(login.props.disabled, false)
        assert.equal(view.reloaded, false, 'expiry must not reload or interrupt the shell')
        if (!zh) assert.ok(!/[\u3400-\u9fff]/u.test(text), 'English guidance must not contain Chinese server messages')
        login.props.onClick()
        await view.flush()
        assert.equal(loginBody.locale, zh ? 'zh' : 'en')
        assert.ok(view.text().includes('laptop'))
        assert.ok(!view.text().includes(zh ? '账户登录已失效' : 'Account sign-in is no longer valid'))
        assert.equal(view.reloaded, false)
      }
    })

    test('account list failures stop loading and permit a localized retry', async () => {
      for (const language of ['zh-CN', 'en-US']) {
        for (const failure of ['upstream', 'network']) {
          const zh = language === 'zh-CN'
          let attempts = 0
          const view = accountView(language, async (_url, init) => {
            if (init?.method !== 'POST') return clientReply(accountStatus)
            if (++attempts === 1) {
              if (failure === 'network') throw new Error('raw network details')
              return clientReply({ code: 'upstream', error: '原始中文服务错误' }, false)
            }
            return clientReply({ apiKeys: [] })
          })
          await view.flush()
          const text = view.text()
          assert.ok(text.includes(failure === 'network' ? (zh ? '检查网络' : 'Check your connection')
            : (zh ? '暂时无法读取' : 'temporarily unavailable')))
          assert.ok(!text.includes('raw network details') && !text.includes('原始中文服务错误'))
          assert.ok(!text.includes(zh ? '正在读取' : 'Loading the keys'))
          assert.ok(!text.includes(zh ? '还没有 API Key' : 'no API keys yet'), 'failed is not empty')
          const retry = view.button(zh ? '刷新列表' : 'Refresh list')
          assert.equal(retry.props.disabled, false)
          retry.props.onClick()
          await view.flush()
          assert.equal(attempts, 2)
          assert.ok(view.text().includes(zh ? '还没有 API Key' : 'no API keys yet'))
          assert.ok(!view.text().includes(zh ? '请稍后重试' : 'Please retry later'))
        }
      }
    })

    test('account expiry without a verified model key does not promise continued use', async () => {
      for (const language of ['zh-CN', 'en-US']) {
        const view = accountView(language, async () => clientReply({ ...accountStatus,
          signedIn: false, authenticated: false, sessionExpired: true, user: null }))
        await view.flush()
        assert.ok(view.text().includes(language === 'zh-CN' ? '请重新登录以配置' : 'Sign in again to configure'))
        assert.ok(!view.text().includes(language === 'zh-CN' ? '可以继续' : 'still try using models'))
      }
    })

    test('copying and switching account keys also handle session expiry', async () => {
      for (const action of ['revealApiKey', 'useApiKey']) {
        const view = accountView('en-US', async (_url, init) => {
          if (init?.method !== 'POST') return clientReply(accountStatus)
          const body = JSON.parse(init.body)
          if (body.action === 'listApiKeys') return clientReply({ apiKeys: [{ id: 1, name: 'laptop', masked: 'sk-…1234', enabled: true }] })
          assert.equal(body.action, action)
          return clientReply({ code: 'session_expired', error: 'Unauthorized', status: { ...accountStatus,
            signedIn: false, sessionExpired: true, user: null } }, false)
        })
        await view.flush()
        if (action === 'useApiKey') view.button('Use').props.onClick()
        else {
          // Icon-only copy button is found by its accessible label.
          // The harness searches children for ordinary controls.
          view.buttonByTitle('Copy').props.onClick()
        }
        await view.flush()
        assert.ok(view.text().includes('Account sign-in is no longer valid'))
        assert.equal(view.button('Sign in again').props.disabled, false)
        assert.equal(view.reloaded, false)
      }
    })

    test('startup gate explains expiry in the app language without changing admission rules', async () => {
      for (const language of ['zh', 'en']) {
        function element(tag) {
          return { tag, textContent: '', children: [], style: {}, events: {}, attributes: {},
            appendChild(child) { child.parent = this; this.children.push(child) },
            replaceChildren() { this.children = [] },
            setAttribute(key, value) { this.attributes[key] = value },
            addEventListener(key, fn) { this.events[key] = fn },
            remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this) },
          }
        }
        const body = element('body')
        const document = { body, documentElement: { lang: '', style: {} }, createElement: element,
          getElementById: () => null }
        const { gate } = client('', 'en-US', { document, fetch: async (_url, init) => init?.method === 'POST'
          ? clientReply({ code: 'session_expired', error: '原始中文失效信息', locale: language }, false)
          : clientReply({ ...accountStatus, signedIn: false, sessionExpired: true, locale: language }) })
        const dispose = gate.registerLoginGate()
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
        const flatten = node => [node, ...node.children.flatMap(flatten)]
        const nodes = () => body.children.flatMap(flatten)
        const text = () => nodes().map(node => node.textContent).join('\n')
        assert.ok(text().includes(language === 'zh' ? '账户登录已失效' : 'Your account sign-in is no longer valid'))
        assert.equal(body.children.length, 1, 'a retained key alone must not bypass the existing startup gate')
        const login = nodes().find(node => node.tag === 'button' && node.textContent === gate.labels().login)
        assert.ok(login)
        login.events.click()
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
        assert.ok(text().includes(language === 'zh' ? '请重新登录' : 'Please sign in to TokensAPI again'))
        assert.ok(!text().includes('原始中文失效信息'))
        if (language === 'en') assert.ok(!/[\u3400-\u9fff]/u.test(text()))
        dispose()
        assert.equal(body.children.length, 0)
      }
    })

    test('client language tables have matching nonempty translated user-visible labels', () => {
      const { gate, document } = client('zh-CN')
      for (const name of ['labels', 'accountLabels']) {
        const zh = gate[name]()
        document.documentElement.lang = 'en-US'
        const en = gate[name]()
        assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
        for (const key of Object.keys(zh)) {
          assert.ok(zh[key].trim() && en[key].trim(), key)
          assert.notEqual(zh[key], en[key], key)
        }
        document.documentElement.lang = 'zh-CN'
      }
    })

    test('client locale chooses application language then browser fallback', () => {
      const { gate, document } = client('zh-CN', 'en-US')
      assert.equal(gate.labels().login, '登录 TokensAPI 账号')
      document.documentElement.lang = 'en-US'
      assert.equal(gate.labels().login, 'Sign in with TokensAPI')
      const fallback = client('', 'zh-TW')
      assert.equal(fallback.gate.accountLabels().nav, '账户管理')
      fallback.document.documentElement.lang = 'fr-FR'
      assert.equal(fallback.gate.accountLabels().nav, 'Account')
    })
  }

  // 真实凭证跨进程恢复
  {
    const fixture = fileURLToPath(import.meta.url)

    function processStep(action, directory) {
      const result = spawnSync(process.execPath, [fixture, '--credential-fixture', action, directory], { encoding: 'utf8', timeout: 15_000 })
      assert.equal(result.status, 0, result.stderr || result.error?.message)
      return JSON.parse(result.stdout.trim())
    }

    test('browser account sign-in survives a new process with the real credential provider', () => {
      const directory = mkdtempSync(join(tmpdir(), 'login-real-credentials-'))
      try {
        assert.equal(processStep('sign-in', directory).signedIn, true)
        const restored = processStep('restore', directory)
        assert.equal(restored.signedIn, true)
        assert.equal(restored.authenticated, true)
        assert.equal(restored.user.displayName, 'Test User')
        assert.equal(restored.providerVersion, '0.1.5-rc.2')
        assert.equal(restored.cordisVersion, '4.0.2')
        assert.equal(restored.authorizationMatches, true)
        assert.equal(restored.source, 'file')
        const document = readFileSync(join(directory, '.credentials.yaml'), 'utf8')
        assert.ok(document.includes('TOKENSAPI_ACCESS_TOKEN'))
        assert.equal(processStep('offline', directory).signedIn, true)
        assert.equal(processStep('restore', directory).signedIn, true)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    test('logout persists across a new process while keeping the real stored API key', () => {
      const directory = mkdtempSync(join(tmpdir(), 'login-real-logout-'))
      try {
        processStep('sign-in', directory)
        assert.equal(processStep('logout', directory).signedIn, false)
        const restored = processStep('restore', directory)
        assert.equal(restored.signedIn, false)
        assert.equal(restored.authenticated, true)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    test('manual API key persists but does not become an account session after restart', () => {
      const directory = mkdtempSync(join(tmpdir(), 'login-real-manual-'))
      try {
        assert.equal(processStep('manual', directory).authenticated, true)
        const restored = processStep('restore', directory)
        assert.equal(restored.authenticated, true)
        assert.equal(restored.signedIn, false)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }

  // 用例执行器自检
  {
    const header = '用例编号,所属模块,用例标题,前置条件,测试数据,操作步骤,预期结果,优先级,自动化状态,对应测试\n'
    const row = 'LOGIN-001,模块,标题,前提,数据,步骤,预期,P1,已自动化,test/run-test-cases.mjs :: named test\n'

    test('case runner parses quoted CSV fields and rejects duplicate IDs and incomplete mappings', () => {
      assert.equal(parseCases(header + row.replace('标题', '"标题,含逗号"'))[0]['用例标题'], '标题,含逗号')
      assert.throws(() => parseCases(header + row + row), /duplicate/u)
      assert.throws(() => parseCases(header + row.replace('已自动化', '待自动化')), /incomplete/u)
      assert.throws(() => parseCases(header + row.replace('test/run-test-cases.mjs', '../outside.test.mjs')), /invalid mapping/u)
      assert.throws(() => parseCases(header + row.replace('test/run-test-cases.mjs', 'test/legacy.test.mjs')), /invalid mapping/u)
      assert.throws(() => parseCases(header), /No functional cases/u)
    })

    test('case runner does not pass missing failed skipped or TODO tests', () => {
      const cases = parseCases(header + row)
      for (const result of [undefined, { passed: false, reason: 'failed' }, { passed: false, reason: 'skipped/TODO' }]) {
        const results = new Map(result ? [['test/run-test-cases.mjs :: named test', result]] : [])
        assert.equal(evaluateCases(cases, results)[0].errors.length, 1)
      }
      assert.equal(evaluateCases(cases, new Map([['test/run-test-cases.mjs :: named test', { passed: true }]]))[0].errors.length, 0)
    })

    test('case runner requires every mapped test of a multi-test case to pass', () => {
      const cases = parseCases(header + row.replace('named test', 'named test | test/run-test-cases.mjs :: another test'))
      const results = new Map([['test/run-test-cases.mjs :: named test', { passed: true }]])
      assert.equal(evaluateCases(cases, results)[0].errors.length, 1)
      results.set('test/run-test-cases.mjs :: another test', { passed: true })
      assert.equal(evaluateCases(cases, results)[0].errors.length, 0)
    })
  }
}

async function credentialProcess() {
  // Real upstream Cordis + file credentials in independent child processes.
  // The browser hand-off and console are simulated. No user secrets are read.
  const { Context } = await import('@deepseek-ai/cordis')
  const { LocalCredentialProvider } = await import('@deepseek-ai/dsh-credentials-local')
  const { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } = await import('@deepseek-ai/dsh-launch-environment')
  const { createRequire } = await import('node:module')
  const { get } = await import('node:http')
  const { join } = await import('node:path')

  const require = createRequire(import.meta.url)
  const [action, directory] = process.argv.slice(3)
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--credential-fixture') await credentialProcess()
  else if (process.execArgv.includes(suiteFlag)) registerCases()
  else await main()
}
