// The probe the live-host fixture inserts into a real, fully booted Host.
//
// It is a Cordis plugin, mounted as a profile entry next to the plugin under
// test, and it only *records*: the cases in the suite do the asserting. A step
// that throws is recorded with its raw error, so a host-contract break reads as
// the Host's own message rather than an assertion diff.
//
// Everything it touches belongs to the running Host: the credential service
// that writes the profile's credential document, the web server the plugin
// registered its route on, the Cordis bus that carries
// `credentials/reference-updated`, and the Host's own `native:openExternal`
// fence. The two simulated parts are the TokensAPI deployment (a loopback
// console in the test process) and the user's browser, which this probe plays
// by fetching the plugin's own loopback callback with the nonce the Host's
// fence just received.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ACCOUNT } from './live-host-console.mjs'
import { TOKENS_LOGIN, credentialFingerprint } from '../../dsh/index.js'

export const name = 'tokens-login-live-probe'
export const inject = []

const REPORT = process.env.TOKENS_LOGIN_LIVE_REPORT
const CONSOLE_ORIGIN = process.env.TOKENS_LOGIN_LIVE_CONSOLE
const HOST_ROOT = process.env.TOKENS_LOGIN_LIVE_HOST_ROOT
const HOME = process.env.DSH_HOME
/** How long the probe waits for the Host's own services to come up. */
const READY_TIMEOUT_MS = 90_000
/** How long the probe waits for the plugin's route to appear on the web server. */
const ROUTE_TIMEOUT_MS = 30_000

function describe(error, depth = 0) {
  if (typeof error !== 'object' || error === null) return { name: typeof error, message: String(error) }
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    stack: typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 12) : undefined,
    ...(error.cause !== undefined && depth < 3 ? { cause: describe(error.cause, depth + 1) } : {}),
  }
}

async function step(steps, id, run) {
  try {
    steps.push({ id, ok: true, value: await run() })
  } catch (error) {
    steps.push({ id, ok: false, error: describe(error) })
  }
  return steps.at(-1)
}

// ---------------------------------------------------------------------------
// Talking to the plugin's route on the Host's own listener

/**
 * One request to the plugin's route, with headers set verbatim.
 *
 * `node:http` rather than `fetch`, because `Host`, `Origin` and
 * `Sec-Fetch-Site` are forbidden fetch headers and the route's fence is
 * precisely what they exercise.
 */
function routeRequest(port, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((settle, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const call = request({
      host: '127.0.0.1',
      port,
      path: TOKENS_LOGIN.routePath,
      method,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
        settle({ status: response.statusCode, body: parsed, text: parsed === undefined ? text.slice(0, 400) : undefined })
      })
    })
    call.on('error', fail)
    if (payload !== undefined) call.write(payload)
    call.end()
  })
}

/** GET a loopback URL and report its status; used to play the user's browser. */
function plainGet(url) {
  return new Promise((settle, fail) => {
    const target = new URL(url)
    const call = request({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: 'GET' }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => settle({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8').slice(0, 200) }))
    })
    call.on('error', fail)
    call.end()
  })
}

const wait = (ms) => new Promise((settle) => { setTimeout(settle, ms).unref?.() })

/** Wait until the plugin's route answers on the Host's listener. */
async function awaitRoute(port) {
  const deadline = Date.now() + ROUTE_TIMEOUT_MS
  let last
  while (Date.now() < deadline) {
    last = await routeRequest(port).catch((error) => ({ status: 0, text: error.message }))
    if (last.status !== 404 && last.status !== 0) return last
    await wait(200)
  }
  throw new Error(`the plugin's ${TOKENS_LOGIN.routePath} route never appeared on the Host's web server (last status ${last?.status}: ${last?.text ?? ''})`)
}

// ---------------------------------------------------------------------------
// The Host's own desktop runtime bridge

/**
 * Find the installed Host's own `native:openExternal` plumbing.
 *
 * The desktop shell's chunk names and export names are build artefacts, so the
 * two functions are located by behaviour instead: both carry the
 * `native:openExternal` RPC method name, one *registers* that handler
 * (`bindNativeRuntime`, the Electron side) and the other *returns* an object
 * carrying `openExternal` (`createHostRuntime`, the Host side). That is the
 * real pair the product wires together, so the plugin under test receives the
 * Host-side bridge object the product gives it, and the URL it hands over is
 * judged by the product's own fence.
 */
async function findDesktopBridgeFactories() {
  if (HOST_ROOT === undefined) return { available: false, reason: 'TOKENS_LOGIN_LIVE_HOST_ROOT was not set' }
  const lib = join(HOST_ROOT, 'lib')
  if (!existsSync(lib)) {
    return { available: false, reason: `the installed host at ${HOST_ROOT} ships no compiled lib/ (this staged host was never built), so its openExternal fence cannot be called` }
  }
  const carriers = readdirSync(lib)
    .filter((file) => file.endsWith('.js'))
    .filter((file) => {
      try {
        return readFileSync(join(lib, file), 'utf8').includes('native:openExternal')
      } catch {
        return false
      }
    })
  for (const file of carriers) {
    let namespace
    try {
      namespace = await import(pathToFileURL(join(lib, file)).href)
    } catch {
      continue
    }
    const candidates = Object.entries(namespace)
      .filter(([, value]) => typeof value === 'function' && /native:openExternal/u.test(String(value)))
    let bind
    let create
    for (const [, candidate] of candidates) {
      const probe = new Map()
      const rpc = { handle: (method, fn) => { probe.set(method, fn); return () => probe.delete(method) }, call: async () => undefined }
      let returned
      try {
        returned = candidate(rpc, desktopRuntimeStub())
      } catch {
        continue
      }
      if (probe.has('native:openExternal')) bind ??= candidate
      else if (typeof returned?.openExternal === 'function') create ??= candidate
    }
    if (bind !== undefined && create !== undefined) return { available: true, chunk: file, bind, create }
  }
  return { available: false, reason: `no module under ${lib} exported both halves of the native:openExternal bridge` }
}

/**
 * The Electron-side runtime object `bindNativeRuntime` installs handlers onto.
 *
 * Only `locale` matters here: `native:openExternal` does not go through this
 * object at all — the product's fence owns it — and the plugin reads nothing
 * else from the bridge.
 */
function desktopRuntimeStub() {
  return new Proxy({ platform: process.platform, locale: 'zh-CN', updates: {} }, {
    get: (target, property) => (property in target ? target[property] : () => undefined),
  })
}

/**
 * Wire the Host's two bridge halves to each other in this process.
 *
 * The one substitution: `productOpenExternal` ends at
 * `electron.shell.openExternal`, and a Host booted by the launcher has no
 * Electron. So the fence runs for real and its verdict is classified —
 * refused, or accepted and stopped at the Electron boundary — and only the
 * final window-opening call is treated as done. That is the same seam as
 * "the user's browser is simulated".
 */
function wireDesktopBridge(factories, onOpen) {
  const handlers = new Map()
  const rpc = {
    handle: (method, fn) => { handlers.set(method, fn); return () => handlers.delete(method) },
    call: async (method, args = []) => {
      const handler = handlers.get(method)
      if (handler === undefined) throw new Error(`the Host bridge has no handler for ${method}`)
      if (method !== 'native:openExternal') return handler(args, new AbortController().signal)
      try {
        await handler(args, new AbortController().signal)
        onOpen({ href: args[0], verdict: 'opened' })
        return undefined
      } catch (error) {
        if (/HTTPS origin required/u.test(String(error?.message ?? ''))) {
          onOpen({ href: args[0], verdict: 'refused', message: String(error.message) })
          throw error
        }
        // Past the fence and into Electron, which a launcher-booted Host has not got.
        onOpen({ href: args[0], verdict: 'accepted', message: String(error?.message ?? error) })
        return undefined
      }
    },
  }
  factories.bind(rpc, desktopRuntimeStub())
  return {
    runtime: factories.create(rpc, { platform: process.platform, locale: 'zh-CN', updates: {} }),
    openHandler: handlers.get('native:openExternal'),
  }
}

/** Classify the Host's verdict on one URL without opening anything. */
async function fenceVerdict(openHandler, href) {
  try {
    await openHandler([href], new AbortController().signal)
    return { href, verdict: 'opened' }
  } catch (error) {
    const message = String(error?.message ?? error)
    return {
      href,
      verdict: /HTTPS origin required/u.test(message) ? 'refused' : 'accepted',
      message: message.split('\n')[0],
    }
  }
}

// ---------------------------------------------------------------------------
// Reading what the Host wrote

/** The credential document the Host's provider keeps under this `$DSH_HOME`. */
function credentialDocuments(directory = HOME, depth = 0) {
  if (directory === undefined || depth > 3) return []
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...credentialDocuments(path, depth + 1))
    else if (/^\.credentials\.ya?ml$/u.test(entry.name)) found.push(path)
  }
  return found
}

/** Which of these references the Host's credential document mentions. */
function documentedReferences() {
  const names = []
  for (const path of credentialDocuments()) {
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    for (const reference of Object.values(TOKENS_LOGIN)) {
      if (typeof reference === 'string' && reference.startsWith('TOKENSAPI_') && text.includes(reference)) names.push(reference)
    }
  }
  return [...new Set(names)]
}

const resolvedValue = (resolved) => (typeof resolved === 'string' ? resolved : resolved?.value ?? '')

/** Where the Host's loader resolves this plugin from, as the profile sees it. */
function resolvedPluginPath() {
  const profile = process.env.TOKENS_LOGIN_LIVE_PROFILE_DIR
  if (profile === undefined) return undefined
  try {
    return realpathSync(createRequire(join(profile, 'package.json')).resolve('@tokensapi/dsh-login'))
  } catch (error) {
    return `unresolved: ${error.message}`
  }
}

// ---------------------------------------------------------------------------

async function run(ctx, observed) {
  const steps = []
  const credentials = ctx.credentials
  const webServer = ctx.webServer
  const port = webServer?.listenedPort ?? webServer?.port

  const mount = await step(steps, 'mount', async () => {
    const answer = await awaitRoute(port)
    return {
      // Which copy the Host's loader actually resolved. This plugin is a
      // built-in, so the installed Host carries its own pinned link to it;
      // these cases are worthless if that one answers instead of the working
      // tree, and this is how the suite can tell.
      resolvedFrom: resolvedPluginPath(),
      // `ctx.inject(['webServer'])` fired and `webServer.register` took the route.
      routeStatus: answer.status,
      routes: webServer?.exact instanceof Map ? [...webServer.exact.keys()] : Object.keys(webServer?.exact ?? {}),
      // The credential surface the plugin calls: resolve / set / unset.
      credentialMethods: ['resolve', 'set', 'unset', 'describe'].filter((key) => typeof credentials?.[key] === 'function'),
      webServerMethods: ['register'].filter((key) => typeof webServer?.[key] === 'function'),
      consoleOrigin: CONSOLE_ORIGIN,
    }
  })
  if (!mount.ok) return steps

  await step(steps, 'status.initial', async () => (await routeRequest(port)).body)

  await step(steps, 'route.fence', async () => ({
    foreignHost: (await routeRequest(port, { headers: { host: 'evil.example' } })).status,
    crossSite: (await routeRequest(port, { headers: { 'sec-fetch-site': 'cross-site' } })).status,
    foreignOrigin: (await routeRequest(port, { headers: { origin: 'https://evil.example' } })).status,
    sameOrigin: (await routeRequest(port, { headers: { origin: `http://127.0.0.1:${port}` } })).status,
    methodNotAllowed: (await routeRequest(port, { method: 'PUT' })).status,
  }))

  // `credentials.set` through the plugin's manual-key path: the key is validated
  // against the console and then written by the Host's own provider.
  await step(steps, 'credentials.write', async () => {
    const response = await routeRequest(port, { method: 'POST', body: { action: 'setApiKey', apiKey: 'sk-live-host-key-1' } })
    const stored = await credentials.resolve(TOKENS_LOGIN.apiKeyRef)
    const marker = await credentials.resolve(TOKENS_LOGIN.apiKeyVerificationRef)
    return {
      status: response.status,
      authenticated: response.body?.authenticated,
      apiKeyMasked: response.body?.apiKeyMasked,
      resolvedShape: Object.keys(stored ?? {}),
      source: stored?.source,
      value: resolvedValue(stored) === 'sk-live-host-key-1',
      markerMatches: resolvedValue(marker) === credentialFingerprint(resolvedValue(stored)),
      documented: documentedReferences(),
    }
  })

  await step(steps, 'credentials.events', async () => ({
    // The event the native model catalog refreshes on; the Host fans it out of
    // `credentials.set` itself, so a rename would show up here.
    references: [...new Set(observed.references)],
    busEvents: [...new Set(observed.events)],
  }))

  // Before a desktop bridge exists: this is the web-profile contract, and the
  // only honest answer is "this Host cannot open a browser".
  await step(steps, 'desktop.absent', async () => {
    const status = await routeRequest(port)
    const attempt = await routeRequest(port, { method: 'POST', body: { action: 'login', locale: 'zh' } })
    return {
      canSignIn: status.body?.canSignIn,
      locale: status.body?.locale,
      loginStatus: attempt.status,
      loginCode: attempt.body?.code,
    }
  })

  const factories = await findDesktopBridgeFactories()
  const opens = []
  let announceOpen = () => {}
  const bridge = factories.available
    ? wireDesktopBridge(factories, (record) => { opens.push(record); announceOpen(record) })
    : {
      runtime: { locale: 'zh-CN', openExternal: async (href) => { const record = { href, verdict: 'accepted', message: 'host fence unavailable' }; opens.push(record); announceOpen(record) } },
      openHandler: undefined,
    }

  await step(steps, 'desktop.fence', async () => {
    if (!factories.available) return { available: false, reason: factories.reason }
    const site = new URL(CONSOLE_ORIGIN)
    return {
      available: true,
      chunk: factories.chunk,
      bridgeMembers: ['openExternal', 'locale', 'platform'].filter((key) => bridge.runtime[key] !== undefined),
      verdicts: [
        // The production sign-in URL, and the one these cases actually use.
        await fenceVerdict(bridge.openHandler, `https://tokensapi.ai${TOKENS_LOGIN.desktopAuthPath}?port=1&state=x`),
        await fenceVerdict(bridge.openHandler, `${site.origin}${TOKENS_LOGIN.desktopAuthPath}?port=1&state=x`),
        // Everything the plugin's own `normalizeSite` refuses, the door must refuse too.
        await fenceVerdict(bridge.openHandler, 'http://tokensapi.ai/desktop-auth'),
        await fenceVerdict(bridge.openHandler, 'file:///etc/passwd'),
      ],
    }
  })

  await step(steps, 'desktop.provide', async () => {
    const how = provideDesktopRuntime(ctx, bridge.runtime)
    // `ctx.inject(['desktopRuntime'])` in the plugin is reactive: it fires when
    // the service appears, which is what makes the gate offer sign-in at all.
    const deadline = Date.now() + 15_000
    let status
    while (Date.now() < deadline) {
      status = await routeRequest(port)
      if (status.body?.canSignIn === true) break
      await wait(150)
    }
    return { how, canSignIn: status?.body?.canSignIn, locale: status?.body?.locale, bridgeSource: factories.available ? 'host' : 'fallback' }
  })

  // The whole sign-in chain: the plugin opens the hand-off page through the
  // Host's fence, the browser (this probe) posts the session back to the
  // plugin's loopback callback, and the key is provisioned from the console.
  await step(steps, 'login.chain', async () => {
    const handed = new Promise((settle) => { announceOpen = settle })
    const signIn = routeRequest(port, { method: 'POST', body: { action: 'login', locale: 'zh' } })
    const opened = await Promise.race([handed, wait(30_000).then(() => undefined)])
    if (opened === undefined) throw new Error('the plugin never handed a URL to the Host bridge')
    const target = new URL(opened.href)
    const callbackPort = target.searchParams.get('port')
    const state = target.searchParams.get('state')
    // A callback carrying someone else's nonce must be refused, not believed.
    const spoofed = await plainGet(`http://127.0.0.1:${callbackPort}/callback?state=not-the-nonce&token=${ACCOUNT.accessToken}&id=${ACCOUNT.userId}`)
    const accepted = await plainGet(`http://127.0.0.1:${callbackPort}/callback?state=${state}&token=${ACCOUNT.accessToken}&id=${ACCOUNT.userId}`)
    const response = await signIn
    const session = await ctx.credentials.resolve(TOKENS_LOGIN.accessTokenRef)
    return {
      fenceVerdict: opened.verdict,
      handedOrigin: target.origin,
      handedPath: target.pathname,
      carriesPort: callbackPort !== null && Number.isInteger(Number(callbackPort)),
      carriesNonce: typeof state === 'string' && state.length >= 16,
      language: target.searchParams.get('lng'),
      spoofedCallback: spoofed.status,
      acceptedCallback: accepted.status,
      status: response.status,
      signedIn: response.body?.signedIn,
      authenticated: response.body?.authenticated,
      user: response.body?.user,
      apiKeyMasked: response.body?.apiKeyMasked,
      apiKeyErrorCode: response.body?.apiKeyErrorCode,
      sessionStored: resolvedValue(session) === ACCOUNT.accessToken,
      documented: documentedReferences(),
    }
  })

  await step(steps, 'account.keys', async () => {
    const list = await routeRequest(port, { method: 'POST', body: { action: 'listApiKeys' } })
    const first = list.body?.apiKeys?.[0]
    const reveal = await routeRequest(port, { method: 'POST', body: { action: 'revealApiKey', id: first?.id } })
    const local = await routeRequest(port, { method: 'POST', body: { action: 'revealApiKey' } })
    const use = await routeRequest(port, { method: 'POST', body: { action: 'useApiKey', id: first?.id } })
    const stored = await ctx.credentials.resolve(TOKENS_LOGIN.apiKeyRef)
    const marker = await ctx.credentials.resolve(TOKENS_LOGIN.apiKeyVerificationRef)
    return {
      listStatus: list.status,
      keys: list.body?.apiKeys?.map(({ id, name: keyName, masked, enabled, inUse }) => ({ id, name: keyName, masked, enabled, inUse })),
      revealStatus: reveal.status,
      revealedFull: typeof reveal.body?.apiKey === 'string' && reveal.body.apiKey.startsWith('sk-'),
      localRevealMatches: local.body?.apiKey === resolvedValue(stored),
      useStatus: use.status,
      useAuthenticated: use.body?.authenticated,
      markerMatches: resolvedValue(marker) === credentialFingerprint(resolvedValue(stored)),
    }
  })

  // `credentials.unset`: the console session goes, the relay key stays, so
  // downstream plugins keep working while the gate comes back.
  await step(steps, 'logout', async () => {
    const response = await routeRequest(port, { method: 'POST', body: { action: 'logout' } })
    const token = await ctx.credentials.resolve(TOKENS_LOGIN.accessTokenRef)
    const userId = await ctx.credentials.resolve(TOKENS_LOGIN.userIdRef)
    const key = await ctx.credentials.resolve(TOKENS_LOGIN.apiKeyRef)
    return {
      status: response.status,
      signedIn: response.body?.signedIn,
      authenticated: response.body?.authenticated,
      sessionCleared: resolvedValue(token) === '' && resolvedValue(userId) === '',
      keyKept: resolvedValue(key).startsWith('sk-'),
      documented: documentedReferences(),
    }
  })

  return steps
}

/** Provide a service onto the running Host, whichever way this Cordis offers. */
function provideDesktopRuntime(ctx, runtime) {
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide('desktopRuntime', runtime)
      return 'ctx.provide'
    } catch { /* fall through to the reflection API */ }
  }
  if (typeof ctx.reflect?.provide === 'function') {
    ctx.reflect.provide('desktopRuntime', runtime)
    return 'ctx.reflect.provide'
  }
  throw new Error('this Host context offers no way to provide a service')
}

function finish(report) {
  const text = JSON.stringify(report, null, 2)
  if (REPORT) {
    try {
      writeFileSync(REPORT, text)
    } catch {
      process.stdout.write(`TOKENS-LOGIN-LIVE ${text}\n`)
    }
  }
  // The Host owns this process; the fixture reads the report after it exits.
  setTimeout(() => process.exit(0), 100).unref?.()
}

export function apply(ctx) {
  const observed = { references: [], events: [] }
  // Installed before anything writes a credential, so the fan-out the native
  // model catalog depends on is observed from the first `credentials.set`.
  for (const event of ['credentials/reference-updated', 'credentials/record-updated']) {
    ctx.on(event, (reference) => {
      observed.events.push(event)
      observed.references.push(typeof reference === 'string' ? reference : String(reference?.reference ?? reference))
    })
  }

  const timer = setTimeout(
    () => finish({ booted: true, steps: [], fatal: 'the Host services never became ready' }),
    READY_TIMEOUT_MS,
  )
  timer.unref?.()
  ctx.inject(['credentials', 'webServer'], (readyCtx) => {
    clearTimeout(timer)
    run(readyCtx, observed).then(
      (steps) => finish({ booted: true, steps }),
      (error) => finish({ booted: true, steps: [], fatal: describe(error) }),
    )
  })
}
