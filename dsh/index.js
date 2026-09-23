// Host half of the TokensAPI login plugin.
//
// One job: turn a TokensAPI (new-api) account sign-in into the credentials
// the rest of the product already consumes. The sign-in itself happens in the
// user's own browser: the desktop openExternal capability hands over the
// deployment's hand-off page, every method the site offers works there
// (password, Google, wallet extensions, passkeys), and the signed-in session
// comes back over a single-shot loopback callback. From there this host:
//
//   1. stores the console access token the page hands back,
//   2. reuses or auto-creates the account's sk- key (GET/POST /api/token/),
//   3. validates it against /v1/models and writes TOKENSAPI_API_KEY plus the
//      TOKENSAPI_API_KEY_VERIFIED_SHA256 marker — the exact format the
//      model-manager plugin verifies, so everything downstream just works.
//
// Manual key entry stays as the only fallback (the legacy gate behaviour).
// Zero runtime dependencies: global fetch and node:crypto only.

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

export const TOKENS_LOGIN = Object.freeze({
  site: 'https://tokensapi.ai',
  apiKeyRef: 'TOKENSAPI_API_KEY',
  apiKeyVerificationRef: 'TOKENSAPI_API_KEY_VERIFIED_SHA256',
  accessTokenRef: 'TOKENSAPI_ACCESS_TOKEN',
  userIdRef: 'TOKENSAPI_USER_ID',
  tokenName: 'TokensCowork',
  routePath: '/tokens/login',
  // The site's desktop hand-off page: the browser signs in with everything
  // it has (wallet extensions, passkeys, an existing session), then posts
  // the session back to the loopback listener below.
  desktopAuthPath: '/desktop-auth',
})

export const name = 'tokens-login'
export const inject = ['credentials']

const REQUEST_TIMEOUT_MS = 20_000
const LOGIN_TIMEOUT_MS = 5 * 60_000

class LoginError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// Per-context state: the captured desktop bridge, the signed-in user for
// status display, and a guard so a second click cannot open two browsers.
const runtimes = new WeakMap()

function loginRuntime(ctx) {
  let runtime = runtimes.get(ctx)
  if (!runtime) {
    runtime = { desktopRuntime: null, user: null, loginInFlight: null, loginTarget: '', sessionCheck: null }
    runtimes.set(ctx, runtime)
  }
  return runtime
}

export function apply(ctx, config = {}) {
  const settings = Object.freeze({
    site: normalizeSite(config.site),
    desktopAuthPath: normalizeSitePath(config.desktopAuthPath),
    tokenName: normalizeTokenName(config.tokenName),
    autoCreateApiKey: config.autoCreateApiKey !== false,
  })
  // Both services are optional: webServer exists only under the web profile,
  // desktopRuntime only on the desktop. Scoped injects keep this plugin
  // loadable everywhere, the same stance as the model-manager plugin.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      try {
        registerLoginRoute(scope, ctx, settings)
      } catch (error) {
        console.error(`[tokens-login] login route skipped: ${error}`)
      }
    })
    ctx.inject(['desktopRuntime'], (scope) => {
      loginRuntime(ctx).desktopRuntime = scope.desktopRuntime
    })
  }
}

// ---------------------------------------------------------------------------
// Normalization and credentials

function normalizeSite(value) {
  if (typeof value !== 'string' || value.trim() === '') return TOKENS_LOGIN.site
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new TypeError('site 必须是有效的 URL')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new TypeError('site 必须使用 HTTPS；本机回环地址可使用 HTTP')
  }
  return parsed.origin
}

/** A site-relative path; anything absolute or off-site is refused. */
function normalizeSitePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return TOKENS_LOGIN.desktopAuthPath
  const path = value.trim()
  if (!path.startsWith('/') || path.startsWith('//')) throw new TypeError('desktopAuthPath 必须是以 / 开头的站内路径')
  return path
}

function normalizeTokenName(value) {
  const tokenName = typeof value === 'string' ? value.trim() : ''
  return tokenName === '' || tokenName.length > 50 ? TOKENS_LOGIN.tokenName : tokenName
}

/** Identical to the model-manager marker so both plugins accept each other's writes. */
export function credentialFingerprint(apiKey) {
  return `sha256:${createHash('sha256').update(apiKey, 'utf8').digest('hex')}`
}

function resolvedValue(resolved) {
  if (typeof resolved === 'string') return resolved
  if (resolved && typeof resolved.value === 'string') return resolved.value
  return ''
}

async function storedApiKeyAuthenticated(ctx) {
  const [key, verification] = await Promise.all([
    ctx.credentials.resolve(TOKENS_LOGIN.apiKeyRef),
    ctx.credentials.resolve(TOKENS_LOGIN.apiKeyVerificationRef),
  ])
  const apiKey = resolvedValue(key)
  return apiKey.length > 0 && resolvedValue(verification) === credentialFingerprint(apiKey)
}

/** Whether the key we hold is one of the keys this account actually has. */
async function storedApiKeyListed(ctx, items) {
  if (!(await storedApiKeyAuthenticated(ctx))) return false
  const stored = resolvedValue(await ctx.credentials.resolve(TOKENS_LOGIN.apiKeyRef)).replace(/^sk-/u, '')
  const masked = maskLikeConsole(stored)
  return items.some((item) => item.key === masked)
}

async function persistApiKey(ctx, apiKey) {
  await ctx.credentials.set(TOKENS_LOGIN.apiKeyRef, apiKey)
  await ctx.credentials.set(TOKENS_LOGIN.apiKeyVerificationRef, credentialFingerprint(apiKey))
}

// ---------------------------------------------------------------------------
// TokensAPI (new-api) console client

async function consoleFetch(site, path, { method = 'GET', body, accessToken, userId } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (accessToken) headers.authorization = accessToken
  if (userId !== undefined) headers['new-api-user'] = `${userId}`
  let response
  try {
    response = await fetch(`${site}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: controller.signal,
    })
  } catch {
    throw new LoginError('unreachable', '无法连接 TokensAPI，请检查网络后重试')
  } finally {
    clearTimeout(timeout)
  }
  if (response.status >= 500) throw new LoginError('upstream', 'TokensAPI 服务暂时不可用，请稍后重试')
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    parsed = null
  }
  return { status: response.status, body: parsed }
}

/**
 * Validate an sk- relay key against the deployment's OpenAI-compatible
 * surface. Error bodies are never surfaced (gateways sometimes echo request
 * metadata) — the same stance as the model-manager validator.
 */
async function validateApiKey(site, apiKey) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response
  try {
    response = await fetch(`${site}/v1/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    })
  } catch {
    throw new LoginError('unreachable', '无法连接 TokensAPI，请检查网络后重试')
  } finally {
    clearTimeout(timeout)
  }
  if (response.status === 200) return
  if (response.status === 401 || response.status === 403) {
    throw new LoginError('invalid_key', 'API Key 无效，请检查后重试')
  }
  throw new LoginError('upstream', 'TokensAPI 服务暂时不可用，请稍后重试')
}

// ---------------------------------------------------------------------------
// Sign-in

/** The desktop bridge, if this profile has one (web profiles do not). */
function desktopBridge(ctx) {
  const bridged = loginRuntime(ctx).desktopRuntime
  if (bridged) return bridged
  // Some cordis builds throw on undeclared service access; absence just
  // means no desktop bridge here.
  try {
    return ctx.desktopRuntime ?? null
  } catch {
    return null
  }
}

/**
 * The one door: the browser the user already lives in. It carries the wallet
 * extensions, passkeys and existing sessions an embedded window never could,
 * so every method the site offers works there.
 */
function externalBrowser(ctx) {
  const bridged = desktopBridge(ctx)
  return typeof bridged?.openExternal === 'function' ? bridged.openExternal : null
}

/**
 * A single-shot loopback listener for the browser hand-back.
 *
 * Bound to 127.0.0.1 so nothing off-machine can reach it, closed the moment it
 * answers, and it accepts only a callback carrying the nonce generated for
 * this attempt. A stray hit from another local process is answered and
 * discarded rather than mistaken for our sign-in.
 */
function loopbackCallback(state, timeoutMs) {
  let settle = () => {}
  const received = new Promise((resolve) => {
    settle = resolve
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const reply = (status, text) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    }
    if (url.pathname !== '/callback') {
      reply(404, 'not found')
      return
    }
    if (url.searchParams.get('state') !== state) {
      reply(403, '状态校验失败，请回到 TokensCowork 重新发起登录。')
      return
    }
    reply(200, '登录完成，可以关闭此页面并回到 TokensCowork。')
    settle({
      accessToken: url.searchParams.get('token') ?? '',
      userId: Number(url.searchParams.get('id')),
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  }).then((port) => ({
    port,
    // Whichever lands first wins; the listener never outlives the attempt.
    done: Promise.race([
      received,
      new Promise((resolve) => {
        setTimeout(resolve, timeoutMs).unref?.()
      }),
    ]).finally(() => server.close()),
  }))
}

/**
 * The browser hands back an id and a token, not a profile. Ask the console for
 * the display name so the account row reads like a name rather than a number;
 * failing that is cosmetic and never fatal to the sign-in.
 */
async function describeUser(settings, accessToken, userId) {
  try {
    const self = await consoleFetch(settings.site, '/api/user/self', { accessToken, userId })
    return self.body?.success === true ? self.body.data : null
  } catch {
    return null
  }
}

/**
 * A stored session is only a claim until the console has answered for it.
 * Ask /api/user/self on the first status call after boot: a good answer
 * brings the display name back (runtime.user lives in memory, so a restart
 * loses it even after a real sign-in); a definite rejection means the token
 * was revoked or reissued on another device — keeping the claim would leave
 * the app "signed in" on a dead session forever, so clear it and let the
 * gate return. A network failure decides nothing: an offline start must not
 * be locked out, so the claim stands and the next status call asks again.
 */
async function verifySession(ctx, runtime, settings, accessToken, userId) {
  let self
  try {
    self = await consoleFetch(settings.site, '/api/user/self', { accessToken, userId })
  } catch {
    runtime.sessionCheck = null
    return true
  }
  if (self.body?.success === true) {
    runtime.user = {
      id: userId,
      username: typeof self.body.data?.username === 'string' ? self.body.data.username : '',
      displayName: typeof self.body.data?.display_name === 'string' ? self.body.data.display_name : '',
    }
    return true
  }
  // The console does not always speak in status codes: this deployment
  // answers a bad token with 200 + {success:false, "Unauthorized…"}. Any
  // coherent answer that refuses to identify the bearer is a rejection.
  if (self.status === 401 || self.status === 403 || self.body?.success === false) {
    // Sign-in may have raced this check and stored a fresh session. A late
    // rejection only ever speaks for the token it was issued against, so it
    // may clear nothing unless that token is still the one on file.
    const current = resolvedValue(await ctx.credentials.resolve(TOKENS_LOGIN.accessTokenRef))
    if (current !== accessToken) return true
    await logout(ctx, runtime)
    return false
  }
  // An incoherent answer (404, HTML instead of JSON): not proof of a dead
  // session, but not a profile either. Keep the claim, ask again later.
  runtime.sessionCheck = null
  return true
}

/**
 * Sign-in end to end: default browser → loopback callback → access token →
 * sk- key. Resolves with '' on success, or the key-provisioning error when
 * the session landed but the key did not: a failed hand-off never undoes a
 * successful sign-in, it just leaves the manual path visible.
 */
function login(ctx, runtime, settings, locale) {
  // A second click must not start a second listener. But the browser tab is
  // the user's, and closing it is easy, so a repeat click re-opens the very
  // page the first one handed out — still the live one — and then joins the
  // attempt already waiting on it.
  if (runtime.loginInFlight) {
    const open = externalBrowser(ctx)
    // Best effort: that attempt stands either way.
    if (open && runtime.loginTarget !== '') Promise.resolve(open(runtime.loginTarget)).catch(() => {})
    return runtime.loginInFlight
  }
  runtime.loginInFlight = signIn(ctx, runtime, settings, locale).finally(() => {
    runtime.loginInFlight = null
    runtime.loginTarget = ''
  })
  return runtime.loginInFlight
}

async function signIn(ctx, runtime, settings, locale) {
  const open = externalBrowser(ctx)
  if (!open) throw new LoginError('browser_unavailable', '当前版本不支持浏览器登录，请手动填入 API Key')
  const state = randomBytes(16).toString('hex')
  const { port, done } = await loopbackCallback(state, LOGIN_TIMEOUT_MS)
  const target = new URL(`${settings.site}${settings.desktopAuthPath}`)
  target.searchParams.set('port', `${port}`)
  target.searchParams.set('state', state)
  // The page opens in the user's own browser, which has its own idea of what
  // language to speak; hand it the one the app is in so the two match.
  if (locale === 'zh' || locale === 'en') target.searchParams.set('lng', locale)
  runtime.loginTarget = target.href
  await open(target.href)
  const handoff = await done
  if (!handoff) throw new LoginError('cancelled', '浏览器登录超时或已取消')
  const { accessToken, userId } = handoff
  if (accessToken === '' || !Number.isInteger(userId)) {
    throw new LoginError('upstream', '浏览器回传的登录信息不完整，请重试')
  }
  await ctx.credentials.set(TOKENS_LOGIN.accessTokenRef, accessToken)
  await ctx.credentials.set(TOKENS_LOGIN.userIdRef, `${userId}`)
  const user = await describeUser(settings, accessToken, userId)
  runtime.user = {
    id: userId,
    username: typeof user?.username === 'string' ? user.username : '',
    displayName: typeof user?.display_name === 'string' ? user.display_name : '',
  }
  try {
    await ensureApiKey(ctx, settings, { accessToken, userId })
    return ''
  } catch (error) {
    return String(error?.message ?? error)
  }
}

/** Every token on the account; the console masks each key for us. */
async function fetchTokens(settings, auth) {
  const list = await consoleFetch(settings.site, '/api/token/?p=1&page_size=100', auth)
  if (list.body?.success !== true) throw new LoginError('upstream', list.body?.message || '无法读取 API Key 列表')
  const items = Array.isArray(list.body?.data?.items) ? list.body.data.items : []
  return items.filter((item) => item && typeof item.id === 'number')
}

/**
 * One key in full, in the form the site shows it: the console stores keys
 * without the sk- prefix and prepends it when rendering, so normalise once
 * here and both callers — the credential plane and the reveal toggle — agree.
 * Nothing caches it.
 */
async function fetchFullKey(settings, auth, id) {
  const revealed = await consoleFetch(settings.site, `/api/token/${id}/key`, { ...auth, method: 'POST', body: {} })
  const key = revealed.body?.data?.key
  if (revealed.body?.success !== true || typeof key !== 'string' || key === '') {
    throw new LoginError('upstream', revealed.body?.message || '无法读取 API Key 内容')
  }
  return key.startsWith('sk-') ? key : `sk-${key}`
}

/**
 * Make sure a working sk- key sits in the credential plane. An existing
 * verified key is kept; otherwise reuse the account's enabled token
 * (preferring the product-named one) or create it, then read the full key
 * and persist after validation.
 */
async function ensureApiKey(ctx, settings, auth, force = false) {
  const listTokens = async () => (await fetchTokens(settings, auth)).filter((item) => item.status === 1)
  let enabled = await listTokens()
  // A stored key passes its own verification no matter which account it came
  // from, so a key left behind by an earlier sign-in would be kept while its
  // owner is no longer the one here. The account's own list is what settles it.
  if (!force && (await storedApiKeyListed(ctx, enabled))) return
  let target = enabled.find((item) => item.name === settings.tokenName) ?? enabled[0]
  if (!target) {
    if (!settings.autoCreateApiKey) throw new LoginError('no_api_key', '账户中没有可用的 API Key')
    const created = await consoleFetch(settings.site, '/api/token/', {
      ...auth,
      method: 'POST',
      body: { name: settings.tokenName, expired_time: -1, remain_quota: 0, unlimited_quota: true },
    })
    if (created.body?.success !== true) {
      throw new LoginError('upstream', created.body?.message || '自动创建 API Key 失败')
    }
    enabled = await listTokens()
    target = enabled.find((item) => item.name === settings.tokenName)
    if (!target) throw new LoginError('upstream', '自动创建 API Key 后未能在列表中找到它')
  }
  const fullKey = await fetchFullKey(settings, auth, target.id)
  await validateApiKey(settings.site, fullKey)
  await persistApiKey(ctx, fullKey)
}

async function setApiKey(ctx, settings, body) {
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
  if (apiKey === '' || apiKey.length > 512) throw new LoginError('invalid_input', '请输入有效的 API Key')
  await validateApiKey(settings.site, apiKey)
  await persistApiKey(ctx, apiKey)
}

/**
 * End the console session, nothing else. The relay key is a separate fact
 * (see loginStatus) and stays where it is: downstream plugins keep working,
 * and the gate comes back because it judges the session, not the key.
 */
async function logout(ctx, runtime) {
  runtime.user = null
  runtime.sessionCheck = null
  for (const ref of [TOKENS_LOGIN.accessTokenRef, TOKENS_LOGIN.userIdRef]) {
    if (typeof ctx.credentials.unset === 'function') await ctx.credentials.unset(ref)
    else await ctx.credentials.set(ref, '')
  }
}

/** The console session stored at sign-in, or a clear "sign in first". */
async function storedSession(ctx) {
  const [token, id] = await Promise.all([
    ctx.credentials.resolve(TOKENS_LOGIN.accessTokenRef),
    ctx.credentials.resolve(TOKENS_LOGIN.userIdRef),
  ])
  const accessToken = resolvedValue(token)
  const userId = Number(resolvedValue(id))
  if (accessToken === '' || !Number.isInteger(userId)) {
    throw new LoginError('signin_required', '请先登录 TokensAPI 账号')
  }
  return { accessToken, userId }
}

/**
 * Pull a fresh relay key using the stored console session. This is the
 * Settings "重新获取" path: sign-in already happened, so no browser opens.
 */
async function refreshApiKey(ctx, settings) {
  await ensureApiKey(ctx, settings, await storedSession(ctx), true)
}

/**
 * The console's own masking, mirrored. It is how the key list arrives, so
 * reproducing it locally tells us which listed key is the one in use without
 * revealing a single one of them.
 */
function maskLikeConsole(key) {
  if (key.length <= 4) return '*'.repeat(key.length)
  if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`
  return `${key.slice(0, 4)}**********${key.slice(-4)}`
}

/** Every key on the account, masked, with the one this app uses marked. */
async function listApiKeys(ctx, settings) {
  const auth = await storedSession(ctx)
  let items = await fetchTokens(settings, auth)
  // The page is the other place we hold the account's own list, so it is where
  // a key belonging to nobody here gets noticed — and where an account with
  // nothing on it gets its first key, rather than showing an empty dead end.
  const enabled = items.filter((item) => item.status === 1)
  if ((enabled.length > 0 || settings.autoCreateApiKey) && !(await storedApiKeyListed(ctx, enabled))) {
    await ensureApiKey(ctx, settings, auth, true)
    items = await fetchTokens(settings, auth)
  }
  const stored = resolvedValue(await ctx.credentials.resolve(TOKENS_LOGIN.apiKeyRef)).replace(/^sk-/u, '')
  const inUse = stored === '' ? '' : maskLikeConsole(stored)
  return items.map((item) => ({
    id: item.id,
    name: typeof item.name === 'string' ? item.name : '',
    masked: `sk-${typeof item.key === 'string' ? item.key : ''}`,
    enabled: item.status === 1,
    inUse: inUse !== '' && item.key === inUse,
  }))
}

/**
 * Reveal one key for the eye toggle in Settings; nothing is stored. Without
 * an id it answers with the key this app itself uses — a local read, so the
 * Settings header can show it in full even when only the key (no session)
 * is present.
 */
async function revealApiKey(ctx, settings, body) {
  if (body?.id === undefined) {
    return resolvedValue(await ctx.credentials.resolve(TOKENS_LOGIN.apiKeyRef))
  }
  const id = Number(body?.id)
  if (!Number.isInteger(id)) throw new LoginError('invalid_input', '无效的 API Key 编号')
  return fetchFullKey(settings, await storedSession(ctx), id)
}

/**
 * Switch the app to one of the account's keys: the Settings 「使用」 path.
 * The same verify-then-persist steps as every other way a key gets in.
 */
async function useApiKey(ctx, settings, body) {
  const id = Number(body?.id)
  if (!Number.isInteger(id)) throw new LoginError('invalid_input', '无效的 API Key 编号')
  const fullKey = await fetchFullKey(settings, await storedSession(ctx), id)
  await validateApiKey(settings.site, fullKey)
  await persistApiKey(ctx, fullKey)
}

/** Last four characters only; enough to tell two keys apart, useless if leaked. */
function maskApiKey(apiKey) {
  return apiKey === '' ? '' : `sk-…${apiKey.slice(-4)}`
}

/**
 * Two independent facts, deliberately not folded into one:
 *   signedIn      — an account session exists (access token + user id) and,
 *                   once per boot, the console has vouched for it (a definite
 *                   rejection clears it; an unreachable console decides
 *                   nothing). This, and only this, is what the gate judges.
 *   authenticated — a verified relay key sits in the credential plane.
 *                   This is what downstream plugins judge; a key can be
 *                   present without a session, and a session without a key.
 */
async function loginStatus(ctx, runtime, settings) {
  const [token, id, key] = await Promise.all([
    ctx.credentials.resolve(TOKENS_LOGIN.accessTokenRef),
    ctx.credentials.resolve(TOKENS_LOGIN.userIdRef),
    ctx.credentials.resolve(TOKENS_LOGIN.apiKeyRef),
  ])
  let signedIn =
    resolvedValue(token) !== '' && Number.isInteger(Number(resolvedValue(id))) && resolvedValue(id) !== ''
  if (signedIn && runtime.user === null) {
    runtime.sessionCheck ??= verifySession(ctx, runtime, settings, resolvedValue(token), Number(resolvedValue(id)))
    signedIn = await runtime.sessionCheck
  }
  return {
    site: settings.site,
    authenticated: await storedApiKeyAuthenticated(ctx),
    signedIn,
    user: runtime.user,
    canSignIn: externalBrowser(ctx) !== null,
    // The gate mounts before the locale plugin sets <html lang>, so the app's
    // language has to reach it from here.
    locale: desktopBridge(ctx)?.locale ?? '',
    apiKeyMasked: maskApiKey(resolvedValue(key)),
  }
}

// ---------------------------------------------------------------------------
// Route

/**
 * The same fence dsh puts in front of its own /api (and the model-manager
 * route): loopback host only, no cross-site callers, same-origin when an
 * Origin header is present.
 */
function isTrustedRequest(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostUrl.hostname.toLowerCase())) return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function errorStatus(code) {
  if (code === 'invalid_key') return 401
  if (code === 'unreachable') return 503
  if (code === 'upstream') return 502
  if (code === 'browser_unavailable') return 501
  if (code === 'signin_required') return 409
  return 400
}

function registerLoginRoute(scope, host, settings) {
  const runtime = loginRuntime(host)
  scope.webServer.register({
    name: 'tokens-login',
    kind: 'exact',
    path: TOKENS_LOGIN.routePath,
    handler: async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      if (!isTrustedRequest(req)) {
        send(403, { error: 'request refused: this route answers same-origin loopback only' })
        return
      }
      if (req.method === 'GET') {
        send(200, await loginStatus(host, runtime, settings))
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST' }).end()
        return
      }
      try {
        const chunks = []
        let total = 0
        for await (const chunk of req) {
          total += chunk.length
          if (total > 20 * 1024) {
            send(413, { error: 'payload too large' })
            req.destroy()
            return
          }
          chunks.push(chunk)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        // Reads about the account's keys answer with their own payload; every
        // other action answers with the status, which is what the UI re-renders.
        if (body?.action === 'listApiKeys') {
          send(200, { apiKeys: await listApiKeys(host, settings) })
          return
        }
        if (body?.action === 'revealApiKey') {
          send(200, { apiKey: await revealApiKey(host, settings, body) })
          return
        }
        let apiKeyError = ''
        if (body?.action === 'login') apiKeyError = await login(host, runtime, settings, body?.locale)
        else if (body?.action === 'setApiKey') await setApiKey(host, settings, body)
        else if (body?.action === 'logout') await logout(host, runtime)
        else if (body?.action === 'refreshApiKey') await refreshApiKey(host, settings)
        else if (body?.action === 'useApiKey') await useApiKey(host, settings, body)
        else throw new LoginError('invalid_input', 'unknown action')
        send(200, {
          ...(apiKeyError === '' ? {} : { apiKeyError }),
          ...(await loginStatus(host, runtime, settings)),
        })
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'invalid_input'
        send(errorStatus(code), { error: String(error?.message ?? error), code })
      }
    },
  })
}

// Exposed for the repo's tests only; not part of the plugin contract.
export const __login = {
  loopbackCallback,
  normalizeSite,
  normalizeSitePath,
  normalizeTokenName,
  isTrustedRequest,
  errorStatus,
  loginRuntime,
  login,
  externalBrowser,
  ensureApiKey,
  setApiKey,
  refreshApiKey,
  listApiKeys,
  useApiKey,
  revealApiKey,
  maskApiKey,
  maskLikeConsole,
  logout,
  loginStatus,
  validateApiKey,
}
