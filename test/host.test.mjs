import assert from 'node:assert/strict'
import { get as httpGet } from 'node:http'
import { test } from 'node:test'
import { TOKENS_LOGIN, __login, apply, credentialFingerprint, inject, name } from '../dsh/index.js'

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
