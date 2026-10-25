// The client half against an installed Host's own slot system.
//
// The browser half of this plugin reaches the Host through exactly one service,
// `slots`, and through two slot names it does not own: `settings.section` and
// `settings.launcher`. Both are resolved by name at render time, so a rename
// upstream is invisible to `tsc`, to the peer gate and to every mocked case —
// the failure mode that broke the update plugin's sidebar button on 0.6/0.7
// (agent-hub T0029). Two things here are read from the installed Host rather
// than from a fixture:
//
//   - its shipped slot contract, which the `.d.ts` files declare as
//     augmentations of `SlotMap`, so the names, kinds and scopes this plugin
//     assumes are checked against the Host's own declaration;
//   - its real `SlotRegistry`, loaded out of the renderer's shipped client
//     bundle, which this plugin's real client entry is then mounted on.
//
// What is *not* covered here, deliberately: the body of each registration runs
// only once the upstream shell that owns the slot declares it, and declaring it
// by hand would just be a copy of the thing under test. The component bodies
// are covered by the client cases in the main suite; these cases cover the
// contract between this plugin and the Host.
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runInContext } from 'node:vm'

import { TOKENS_LOGIN, __login } from '../../dsh/index.js'

/** Slot names this plugin registers into, and what it assumes about each. */
export const PLUGIN_SLOTS = Object.freeze({
  'settings.section': { kind: 'list', scope: 'root' },
  // A single slot: a second entry shadows the upstream default rather than
  // sitting beside it, which is why the plugin registers at a lower priority.
  'settings.launcher': { kind: 'single', scope: 'root' },
})

/**
 * The one host package this plugin's client half requires beyond React, and
 * what it asks of it. The account page's controls are these components, so a
 * host that stopped answering the name, or stopped exporting one of them, is
 * the page losing its chrome.
 */
export const PLUGIN_UI_PACKAGE = '@deepseek-ai/dsh-client-ui-primitives'
export const PLUGIN_UI_EXPORTS = Object.freeze({
  // Button: the compact size and the three variants the page renders.
  Button: ['size', 'variant', 'icon', "'sm'", "'primary'", "'ghost'", "'outline'"],
  // Tag: the tone that names a current selection, and the quiet one.
  Tag: ['tone', "'solid'", "'quiet'"],
})

function hostRequire(root) {
  return createRequire(join(root, 'package.json'))
}

/**
 * The client module loader's platform seed: the specifiers a plugin bundle's
 * `require` is answered with before any package factory is consulted.
 *
 * The renderer bundles these rather than resolving them, so they exist only
 * inside the shipped web frontend; the seed table is the host's own statement
 * of which names it will answer, written as one object literal.
 *
 * @param root - an installed host root.
 * @returns the seed specifiers, or undefined when the frontend cannot be read.
 */
export function hostModuleSeed(root) {
  const assets = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets')
  let entries
  try {
    entries = readdirSync(assets).filter((name) => name.startsWith('index-') && name.endsWith('.js'))
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const source = readFileSync(join(assets, entry), 'utf8')
    // `staticModules: <fn>()`, whose body is the seed object literal. Read the
    // literal's keys rather than its values: the values are minified locals.
    const seeded = /staticModules\s*:\s*([A-Za-z_$][\w$]*)\s*\(\s*\)/u.exec(source)
    if (seeded === null) continue
    const table = new RegExp(`function ${seeded[1]}\\(\\)\\{return\\{([^}]*)\\}\\}`, 'u').exec(source)
    if (table === null) continue
    return table[1]
      .split(',')
      .map((pair) => /^\s*"?([^":]+)"?\s*:/u.exec(pair)?.[1])
      .filter((name) => typeof name === 'string')
  }
  return undefined
}

/**
 * What an installed host's shared UI package declares it exports.
 *
 * The package ships ESM that imports `.module.css` and third-party packages the
 * staged tree does not carry — the renderer bundles it — so it cannot be
 * imported here; its shipped declarations are read instead.
 *
 * @param root - an installed host root.
 * @returns `{ index, members }`: the barrel's text, and each member's own.
 */
export function hostUiDeclarations(root) {
  const types = join(root, 'node_modules', ...PLUGIN_UI_PACKAGE.split('/'), 'lib', 'types')
  const read = (file) => {
    try {
      return readFileSync(join(types, file), 'utf8')
    } catch {
      return undefined
    }
  }
  const members = {}
  for (const name of Object.keys(PLUGIN_UI_EXPORTS)) members[name] = read(`${name}.d.ts`)
  return { index: read('index.d.ts'), members }
}

/** A shipped client bundle's path; these packages do not export `lib/` by name. */
function clientBundle(root, name) {
  const direct = join(root, 'node_modules', ...name.split('/'), 'lib', 'client.js')
  if (existsSync(direct)) return direct
  return join(hostRequire(root).resolve(`${name}/package.json`), '..', 'lib', 'client.js')
}

function* typeDeclarations(directory, depth = 0) {
  if (depth > 6) return
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* typeDeclarations(path, depth + 1)
    else if (entry.name.endsWith('.d.ts')) yield path
  }
}

const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu
const SLOT_ENTRY = /'([a-zA-Z][\w.-]*)':\s*\{[^{}]*?kind:\s*'([a-z-]+)'[^{}]*?scope:\s*'([a-z-]+)'/gu

/**
 * The slot contract an installed Host ships.
 *
 * Upstream declares every slot by augmenting `SlotMap` in the owning package's
 * `.d.ts`, so the declaration set is readable without booting a client.
 *
 * @param root - an installed host root.
 * @returns slot name -> `{ kind, scope, source }`, last declaration winning.
 */
export function hostSlotContract(root) {
  const contract = new Map()
  for (const path of typeDeclarations(join(root, 'node_modules', '@deepseek-ai'))) {
    let source
    try {
      source = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    if (!source.includes('interface SlotMap')) continue
    const body = source.replace(COMMENTS, '')
    for (const [, name, kind, scope] of body.matchAll(SLOT_ENTRY)) {
      contract.set(name, { kind, scope, source: path })
    }
  }
  return contract
}

/**
 * The plugin's own status payload, produced by its real host half.
 *
 * The gate fetches its route the moment it mounts. In a browser that is a real
 * request to the real route; here it is the same function that answers that
 * route, over a credential store held in memory, so the client is never fed a
 * hand-written payload shape that the host half could have stopped producing.
 */
async function statusPayload() {
  const store = new Map()
  const ctx = {
    credentials: {
      set: async (reference, value) => void store.set(reference, value),
      unset: async (reference) => void store.delete(reference),
      resolve: async (reference) => store.get(reference) ?? '',
    },
  }
  const settings = { site: TOKENS_LOGIN.site, desktopAuthPath: TOKENS_LOGIN.desktopAuthPath, tokenName: TOKENS_LOGIN.tokenName, autoCreateApiKey: true }
  return __login.loginStatus(ctx, __login.loginRuntime(ctx), settings)
}

/**
 * Mount this plugin's real client entry on an installed Host's real slot service.
 *
 * @param root - an installed host root.
 * @returns what the Host's slot service exposed, and what the plugin asked of it.
 */
export async function mountClientOnHostSlots(root) {
  const required = hostRequire(root)
  const { JSDOM } = required('jsdom')
  const dom = new JSDOM('<!doctype html><html lang="zh-CN"><body><div id="dsh-root"></div></body></html>', {
    url: 'http://127.0.0.1:5173/',
    runScripts: 'outside-only',
  })
  const context = dom.getInternalVMContext()
  const bundles = new Map()
  dom.window.__ModuleLoader__ = { load: (entry) => bundles.set(entry.id, entry.factory) }
  // The gate's own first request. A browser has `fetch`; jsdom does not hand
  // one to the VM realm, so the plugin's own status producer answers it.
  const payload = await statusPayload()
  context.fetch = async () => ({ ok: true, status: 200, json: async () => payload })

  // Loaded as the Host loads them: the bundle protocol, not an ESM import.
  // One recorder per bundle, so "what this plugin asks the Host for" is not
  // confused with what the renderer asks for.
  // The browser gets these from the module loader's own table; here they come
  // from the host's `node_modules`, which answers for everything except the
  // pre-bundled UI packages — `dsh-client-ui-primitives` ships ESM that imports
  // `.module.css` and a dozen third-party packages the staged tree does not
  // carry, because the renderer bundles it rather than resolving it. A miss is
  // recorded and rethrown, so the plugin takes the same path it would take on a
  // host that stopped exporting it, and the case can see that it did.
  const track = (into, failures) => (name) => {
    into.add(name)
    try {
      return required(name)
    } catch (error) {
      failures.set(name, String(error.message ?? error))
      throw error
    }
  }
  const rendererAsked = new Set()
  const clientAsked = new Set()
  const rendererFailed = new Map()
  const clientFailed = new Map()
  runInContext(readFileSync(clientBundle(root, '@deepseek-ai/dsh-client-ui-renderer'), 'utf8'), context,
    { filename: '@deepseek-ai/dsh-client-ui-renderer/lib/client.js' })
  runInContext(readFileSync(new URL('../../dsh/client.js', import.meta.url), 'utf8'), context,
    { filename: '@tokensapi/dsh-login/dsh/client.js' })

  const { Context } = required('@deepseek-ai/cordis')
  const ctx = new Context()
  const renderer = bundles.get('@deepseek-ai/dsh-client-ui-renderer')(track(rendererAsked, rendererFailed))
  await ctx.plugin({ name: 'ui-renderer', inject: renderer.inject, apply: renderer.apply })

  const slots = ctx.get('slots')
  const injected = []
  const registered = []
  if (slots !== undefined) {
    // A Cordis service is reached through a proxy, so the methods have to be
    // replaced with defineProperty rather than assigned (agent-hub knowledge).
    for (const [method, log] of [['inject', injected], ['register', registered]]) {
      const original = slots[method]
      Object.defineProperty(slots, method, {
        configurable: true,
        value: function observed(first, ...rest) {
          log.push(typeof first === 'string' ? first : first?.name)
          return original.call(this, first, ...rest)
        },
      })
    }
  }

  const client = bundles.get('@tokensapi/dsh-login')
  let mountError
  let fiber
  try {
    const half = client(track(clientAsked, clientFailed))
    fiber = ctx.plugin({ name: 'tokens-login-client', inject: half.inject, apply: half.apply })
    await fiber
  } catch (error) {
    mountError = error
  }

  const result = {
    bundleIds: [...bundles.keys()],
    slotServiceMethods: ['register', 'inject', 'install', 'registerFactory'].filter((method) => typeof slots?.[method] === 'function'),
    injected,
    registered,
    rendererModulesAsked: [...rendererAsked],
    clientModulesAsked: [...clientAsked],
    clientModulesUnresolved: Object.fromEntries(clientFailed),
    rendererModulesUnresolved: Object.fromEntries(rendererFailed),
    mountError: mountError === undefined ? undefined : String(mountError.message ?? mountError),
  }
  // The gate installs a MutationObserver; dispose the fiber and let jsdom drain
  // the callback it may already have queued before the window goes away, or the
  // callback runs against a torn-down realm and reports a phantom failure.
  await fiber?.dispose?.()
  await new Promise((settle) => { setTimeout(settle, 0) })
  dom.window.close()
  return result
}
