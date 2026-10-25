// Real-host contract cases: every host interface this plugin uses, called once
// against an installed Host rather than against a fixture.
//
// Inventoried in `test/test_cases.csv` as the `host-contract` module and run by
// `npm run check:host` (and by `npm test`, which reports them as NOT EXECUTED
// when no Host is configured rather than counting them as passed).
//
// The host interface list these cases cover, one by one, is in
// `docs/host-interfaces.md`; a new host call belongs in both.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TOKENS_LOGIN } from '../dsh/index.js'
import { ACCOUNT } from './support/live-host-console.mjs'
import { forEachHost, hostRoots, liveHostReports, liveValue, SKIP_WITHOUT_LIVE_HOST } from './support/live-host.mjs'
import { admissionVerdicts, eventShapedLiterals, hasAdmissionEvaluator, hostRuntimeVersion, reportedRequirements, sessionVocabulary } from './support/host-modules.mjs'
import { hostModuleSeed, hostSlotContract, hostUiDeclarations, mountClientOnHostSlots, PLUGIN_SLOTS, PLUGIN_UI_EXPORTS, PLUGIN_UI_PACKAGE } from './support/live-slots.mjs'

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const skip = SKIP_WITHOUT_LIVE_HOST
/** The runtime lines this plugin supports; one installed Host can judge all of them. */
const SUPPORTED_RUNTIMES = ['0.1.5-rc.2', '0.2.0-rc.2', '0.2.1-rc.2']

/** Semver-ish compare, enough to ask "is this host older than 0.2.0". */
function olderThan(version, floor) {
  const parts = (text) => text.split('-')[0].split('.').map(Number)
  const [a, b] = [parts(version), parts(floor)]
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index]
  }
  return false
}

// ---------------------------------------------------------------------------
// The booted Host: the plugin mounted by the real loader, driven through the
// real web server, reading and writing through the real credential service.

test('the host loader mounts this package and its route answers on the host web server', { skip }, async () => {
  const reports = await liveHostReports()
  assert.ok(reports.length > 0, 'no host reports')
  forEachHost(reports, (report) => {
    const mount = liveValue(report, 'mount')
    // First, that these cases are testing this working tree at all. This
    // plugin is a built-in, so an installed host carries its own pinned link
    // to `@tokensapi/dsh-login`; if the loader resolved that one, every case
    // below would be checking the shipped build and would pass no matter what
    // this tree says.
    assert.ok(typeof mount.resolvedFrom === 'string', 'the probe could not resolve the plugin at all')
    assert.ok(!mount.resolvedFrom.startsWith(report.root),
      `the host resolved its own pinned copy instead of this working tree: ${mount.resolvedFrom}`)
    // `apply` ran, `ctx.inject(['webServer'])` fired, `webServer.register` took the route.
    assert.equal(mount.routeStatus, 200, 'the route did not answer')
    assert.ok(mount.routes.includes(TOKENS_LOGIN.routePath), `registered routes: ${mount.routes.join(', ')}`)
    assert.ok(mount.webServerMethods.includes('register'), 'webServer.register is gone')
    // The credential surface this plugin calls.
    for (const method of ['resolve', 'set', 'unset']) {
      assert.ok(mount.credentialMethods.includes(method), `credentials.${method} is gone`)
    }
  })
})

test('the live route reports a clean status before anything is stored', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const status = liveValue(report, 'status.initial')
    const mount = liveValue(report, 'mount')
    assert.equal(status.site, mount.consoleOrigin, 'the profile config did not reach the plugin')
    assert.equal(status.signedIn, false)
    assert.equal(status.authenticated, false)
    assert.equal(status.sessionExpired, false)
    assert.equal(status.user, null)
    assert.equal(status.apiKeyMasked, '')
  })
})

test('the host listener enforces the route fence it was registered with', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const fence = liveValue(report, 'route.fence')
    assert.equal(fence.foreignHost, 403, 'a spoofed Host header was answered')
    assert.equal(fence.crossSite, 403, 'a cross-site caller was answered')
    assert.equal(fence.foreignOrigin, 403, 'a foreign Origin was answered')
    assert.equal(fence.sameOrigin, 200, 'a same-origin caller was refused')
    assert.equal(fence.methodNotAllowed, 405)
  })
})

test('credentials.set and resolve round-trip through the host credential service', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const write = liveValue(report, 'credentials.write')
    assert.equal(write.status, 200, 'the manual key path failed on the live host')
    assert.equal(write.authenticated, true)
    // The one field the plugin reads off a resolved credential. Anything else
    // the host puts on it is its own business, so only this one is asserted.
    assert.equal(write.value, true, 'credentials.resolve did not return the stored key under .value')
    assert.ok(write.resolvedShape.includes('value'), `the resolved credential carried ${write.resolvedShape.join(', ')}`)
    assert.equal(write.markerMatches, true, 'the verification marker does not match the stored key')
    // Written through, not just held in memory: the host's own document names them.
    assert.ok(write.documented.includes(TOKENS_LOGIN.apiKeyRef), 'the key never reached the credential document')
    assert.ok(write.documented.includes(TOKENS_LOGIN.apiKeyVerificationRef))
  })
})

test('the host fans credentials/reference-updated out of credentials.set', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const events = liveValue(report, 'credentials.events')
    // The native model catalogue refreshes on this event; without it a key
    // written here would not reach the model dropdown until a restart.
    assert.ok(events.busEvents.includes('credentials/reference-updated'),
      `the host emitted ${events.busEvents.join(', ') || 'nothing'}`)
    for (const reference of [TOKENS_LOGIN.apiKeyRef, TOKENS_LOGIN.apiKeyVerificationRef]) {
      assert.ok(events.references.includes(reference), `no reference-updated for ${reference}`)
    }
  })
})

test('a host with no desktop bridge reports it cannot sign in, and refuses to try', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const absent = liveValue(report, 'desktop.absent')
    assert.equal(absent.canSignIn, false, 'the plugin offered sign-in without a browser')
    assert.equal(absent.loginStatus, 501)
    assert.equal(absent.loginCode, 'browser_unavailable')
  })
})

test('the host openExternal fence accepts exactly the sites this plugin accepts', { skip }, async (t) => {
  const reports = await liveHostReports()
  const unavailable = []
  let exercised = 0
  forEachHost(reports, (report) => {
    const fence = liveValue(report, 'desktop.fence')
    if (fence.available !== true) {
      unavailable.push(`${report.version}: ${fence.reason}`)
      return
    }
    exercised += 1
    assert.ok(fence.bridgeMembers.includes('openExternal'), 'the host bridge lost openExternal')
    assert.ok(fence.bridgeMembers.includes('locale'), 'the host bridge lost locale')
    const verdicts = new Map(fence.verdicts.map((entry) => [entry.href, entry.verdict]))
    for (const [href, expected] of verdicts.entries()) {
      // HTTPS anywhere and HTTP on loopback are what the plugin's own
      // `normalizeSite` accepts; the host's door must agree, or a configured
      // deployment would be refused at sign-in time.
      const target = new URL(href)
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname.toLowerCase())
      const allowed = target.protocol === 'https:' || (target.protocol === 'http:' && loopback)
      assert.equal(expected, allowed ? 'accepted' : 'refused', `the host fence disagreed about ${href}`)
    }
  })
  // Visible, never silent, and one self-contained line per host so the runner
  // can forward it: a host that could not answer says so, with the reason.
  for (const entry of unavailable) process.stderr.write(`NOT EXECUTED (host openExternal fence) ${entry}\n`)
  // No configured host could answer at all, so this case did not run. Not a
  // pass: the runner lists it under NOT EXECUTED.
  if (exercised === 0) t.skip(`NOT EXECUTED: no configured host could answer:\n  ${unavailable.join('\n  ')}`)
})

test('providing desktopRuntime makes the plugin offer sign-in and carry the app language', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const provided = liveValue(report, 'desktop.provide')
    // `ctx.inject(['desktopRuntime'])` is reactive: the plugin picks the
    // service up when it appears, which is what the desktop shell relies on.
    assert.equal(provided.canSignIn, true, 'the plugin never saw the desktop bridge')
    assert.equal(provided.locale, 'zh-CN', 'the bridge locale did not reach the status payload')
    assert.ok(['ctx.provide', 'ctx.reflect.provide'].includes(provided.how))
  })
})

test('the whole browser sign-in chain completes on a live host', { skip }, async () => {
  const reports = await liveHostReports()
  const fallbacks = []
  forEachHost(reports, (report) => {
    const chain = liveValue(report, 'login.chain')
    const mount = liveValue(report, 'mount')
    if (liveValue(report, 'desktop.fence').available !== true) fallbacks.push(report.version)
    // The hand-off page, opened through the host's own door.
    assert.equal(chain.fenceVerdict, 'accepted', 'the host fence refused the hand-off page')
    assert.equal(chain.handedOrigin, mount.consoleOrigin, 'the browser was sent off-site')
    assert.equal(chain.handedPath, TOKENS_LOGIN.desktopAuthPath)
    assert.equal(chain.carriesPort, true, 'the hand-off URL carried no callback port')
    assert.equal(chain.carriesNonce, true, 'the hand-off URL carried no nonce')
    assert.equal(chain.language, 'zh', 'the hand-off page was not opened in the app language')
    // The loopback listener believes the nonce it issued, and nothing else.
    assert.equal(chain.spoofedCallback, 403, 'a callback with the wrong nonce was accepted')
    assert.equal(chain.acceptedCallback, 200)
    // The session and the provisioned key, both through the real credential service.
    assert.equal(chain.status, 200)
    assert.equal(chain.signedIn, true)
    assert.equal(chain.authenticated, true)
    assert.equal(chain.apiKeyErrorCode, undefined, 'key provisioning failed')
    assert.equal(chain.sessionStored, true, 'the access token was not stored')
    assert.equal(chain.user?.id, ACCOUNT.userId)
    assert.equal(chain.user?.username, ACCOUNT.username)
    assert.equal(chain.user?.displayName, ACCOUNT.displayName)
    assert.match(chain.apiKeyMasked, /^sk-…/u)
    for (const reference of [TOKENS_LOGIN.accessTokenRef, TOKENS_LOGIN.userIdRef, TOKENS_LOGIN.apiKeyRef, TOKENS_LOGIN.apiKeyVerificationRef]) {
      assert.ok(chain.documented.includes(reference), `${reference} never reached the credential document`)
    }
  })
  for (const version of fallbacks) {
    process.stderr.write(`PARTIAL (sign-in chain) ${version}: this staged host ships no compiled lib/, so the chain ran with a stand-in bridge instead of the host's own\n`)
  }
})

test('the account key actions answer through the live route and the live credential service', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const keys = liveValue(report, 'account.keys')
    assert.equal(keys.listStatus, 200)
    assert.ok(keys.keys.length > 0, 'the account list came back empty')
    for (const key of keys.keys) {
      assert.match(key.masked, /^sk-/u, 'a listed key was not masked the way the console masks it')
      assert.ok(!key.masked.includes('live-host-key'), 'a full key reached the list payload')
    }
    assert.equal(keys.keys.filter((key) => key.inUse).length, 1, 'the key in use was not marked exactly once')
    assert.equal(keys.revealStatus, 200)
    assert.equal(keys.revealedFull, true, 'revealApiKey did not return a full key')
    assert.equal(keys.localRevealMatches, true, 'the local reveal disagreed with the stored key')
    assert.equal(keys.useStatus, 200)
    assert.equal(keys.useAuthenticated, true)
    assert.equal(keys.markerMatches, true, 'switching keys left a stale verification marker')
  })
})

test('logout unsets the session references on the host and leaves the relay key', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const out = liveValue(report, 'logout')
    assert.equal(out.status, 200)
    assert.equal(out.signedIn, false)
    // The two facts stay separate: downstream plugins keep working.
    assert.equal(out.authenticated, true, 'logout took the relay key with it')
    assert.equal(out.sessionCleared, true, 'credentials.unset left the session behind')
    assert.equal(out.keyKept, true)
    assert.ok(out.documented.includes(TOKENS_LOGIN.apiKeyRef), 'the relay key left the credential document')
    assert.ok(!out.documented.includes(TOKENS_LOGIN.accessTokenRef), 'the access token is still in the credential document')
    assert.ok(!out.documented.includes(TOKENS_LOGIN.userIdRef), 'the user id is still in the credential document')
  })
})

// ---------------------------------------------------------------------------
// Host facts decided before this plugin loads, read from the Host's own packages.

test('the host admission evaluator finds nothing to enforce for this manifest', { skip }, async (t) => {
  // What this plugin depends on: being admitted. It deliberately declares no
  // dsh peer and no `engines.dsh` (agent-hub T0035) — zero dsh module imports,
  // host services probed by shape — so the only thing to check is that the
  // host's own gate still has nothing to hold against it. Whatever shape the
  // host answers "nothing to enforce" in, that is the answer this reads.
  const peers = Object.keys(manifest.peerDependencies ?? {})
    .filter((entry) => entry === '@deepseek-ai/dsh' || entry.startsWith('@deepseek-ai/dsh-'))
  assert.deepEqual(peers, [], 'this plugin now declares a dsh peer; the admission case needs rewriting')
  assert.equal(manifest.engines?.dsh, undefined, 'engines.dsh would become the sole judge on 0.7 and be ignored on 0.6/0.5')

  const unavailable = []
  let exercised = 0
  for (const root of hostRoots()) {
    const label = `${hostRuntimeVersion(root)} (${root})`
    if (!hasAdmissionEvaluator(root)) {
      unavailable.push(`${label}: this host's app-boot has no plugin-admission evaluator — the 0.1 line admits every plugin`)
      continue
    }
    exercised += 1
    for (const { runtime, verdict, threw } of admissionVerdicts(root, manifest, SUPPORTED_RUNTIMES)) {
      assert.equal(threw, undefined, `${label}: the evaluator threw for ${runtime}: ${threw}`)
      // Nothing unsatisfied, under either field name the host has used.
      const requirements = reportedRequirements(verdict)
      assert.ok(requirements === undefined || Object.keys(requirements).length === 0,
        `${label}: the host would block this plugin on ${runtime}: ${JSON.stringify(verdict)}`)
    }
    // The reverse control: an unsatisfiable dsh peer must be reported, or the
    // verdicts above are an evaluator that is not running at all.
    const control = { ...manifest, peerDependencies: { ...manifest.peerDependencies, '@deepseek-ai/dsh': '>=99.0.0' } }
    for (const { runtime, verdict } of admissionVerdicts(root, control, SUPPORTED_RUNTIMES)) {
      const requirements = reportedRequirements(verdict)
      assert.ok(requirements !== undefined && Object.keys(requirements).length > 0,
        `${label}: the evaluator did not report an impossible peer on ${runtime}; it is idling`)
    }
  }
  for (const entry of unavailable) process.stderr.write(`NOT EXECUTED (host admission evaluator) ${entry}\n`)
  // One modern host judges every supported runtime, so this only goes
  // unexecuted when every configured host predates the gate.
  if (exercised === 0) t.skip(`NOT EXECUTED: no configured host has an admission evaluator:\n  ${unavailable.join('\n  ')}`)
})

test('this plugin reads no session event the host could rename out from under it', { skip }, async () => {
  const shipped = ['dsh/index.js', 'dsh/client.js'].map((entry) => join(repo, entry))
  const literals = eventShapedLiterals(shipped)
  for (const root of hostRoots()) {
    const vocabulary = sessionVocabulary(root)
    const read = [...literals].filter((literal) => vocabulary.has(literal))
    // Nothing today, and the case says so out loud: this plugin is credential
    // driven, not event driven. The day it subscribes to a session event, this
    // assertion is the reminder to pin the name against the host vocabulary.
    assert.deepEqual(read, [],
      `${hostRuntimeVersion(root)}: this plugin now reads session events (${read.join(', ')}); pin them against the host vocabulary here`)
    // A liveness control, not a size assertion: an empty vocabulary would
    // make the intersection above trivially empty for the wrong reason.
    assert.notEqual(vocabulary.size, 0, 'the host exported an empty session vocabulary; the check is not running')
  }
})

// ---------------------------------------------------------------------------
// The client half against the Host's own slot system.

test('the host slot contract still declares the slots this plugin registers into', { skip }, async () => {
  const absent = []
  for (const root of hostRoots()) {
    const version = hostRuntimeVersion(root)
    const contract = hostSlotContract(root)
    assert.ok(contract.size > 0, `${version}: no slot declarations found in the installed host`)
    for (const [name, assumed] of Object.entries(PLUGIN_SLOTS)) {
      const declared = contract.get(name)
      if (declared === undefined) {
        // `settings.launcher` arrived in 0.2.0. On an older host the plugin's
        // `slots.inject` simply waits forever, so the sidebar account menu is
        // absent rather than broken — but a 0.2+ host dropping the slot is a
        // real break, so only the older line may be missing it.
        assert.ok(name === 'settings.launcher' && olderThan(version, '0.2.0'),
          `${version}: the host no longer declares ${name}`)
        absent.push(`${version}: ${name}`)
        continue
      }
      assert.equal(declared.kind, assumed.kind, `${version}: ${name} changed kind`)
      assert.equal(declared.scope, assumed.scope, `${version}: ${name} changed scope`)
    }
  }
  for (const entry of absent) process.stderr.write(`NOT DECLARED (plugin degrades to absent, not broken) ${entry}\n`)
})

test('the client half mounts on the host own slot service and asks it for nothing else', { skip }, async () => {
  for (const root of hostRoots()) {
    const version = hostRuntimeVersion(root)
    const mounted = await mountClientOnHostSlots(root)
    assert.equal(mounted.mountError, undefined, `${version}: the client half failed to mount: ${mounted.mountError}`)
    assert.ok(mounted.bundleIds.includes(manifest.name), `${version}: the client bundle did not register itself`)
    // The real registry, not a stand-in.
    for (const method of ['register', 'inject', 'install']) {
      assert.ok(mounted.slotServiceMethods.includes(method), `${version}: the host slot service lost ${method}`)
    }
    // Both slot names went to the real service and were accepted by it.
    assert.deepEqual([...mounted.injected].sort(), Object.keys(PLUGIN_SLOTS).sort(),
      `${version}: the plugin injected ${mounted.injected.join(', ')}`)
    // A client bundle resolves its dependencies from the host at render time,
    // so a host that stopped shipping one would break only in the browser.
    assert.deepEqual([...mounted.clientModulesAsked].sort(), [PLUGIN_UI_PACKAGE, 'react', 'react-dom'].sort(),
      `${version}: the client half asked the host for ${mounted.clientModulesAsked.join(', ')}`)
    // The shared UI package is the one the renderer bundles rather than
    // resolves, so this harness cannot produce it and the plugin takes the
    // same path a host that dropped it would give it. That it still mounts, on
    // the real slot service, is the degradation this page is supposed to have:
    // losing the host's Button and Tag costs the page its chrome, not the
    // section (agent-hub T0029). Whether the real host answers that name is
    // the next case's job.
    assert.deepEqual(Object.keys(mounted.clientModulesUnresolved), [PLUGIN_UI_PACKAGE],
      `${version}: unresolved ${Object.keys(mounted.clientModulesUnresolved).join(', ')}`)
  }
})

test('the host answers the shared UI package this page renders its controls with', { skip }, async () => {
  for (const root of hostRoots()) {
    const version = hostRuntimeVersion(root)
    // One: the name resolves. `require` inside a client bundle is answered
    // from the loader's platform seed before any package factory, and the
    // shipped web frontend is where that table lives — so this is the host's
    // own statement that a plugin asking for this name will be answered. It is
    // also why the plugin needs no dependency on the package, and why no
    // second copy can reach the page.
    const seed = hostModuleSeed(root)
    assert.ok(Array.isArray(seed) && seed.length > 0, `${version}: could not read the loader's platform seed`)
    assert.ok(seed.includes('react'), `${version}: the seed table read back wrong (${seed.join(', ')})`)
    assert.ok(seed.includes(PLUGIN_UI_PACKAGE),
      `${version}: the loader no longer seeds ${PLUGIN_UI_PACKAGE}; the account page would lose its controls`)

    // Two: it still exports the components, and still takes the props the page
    // passes. Additions are compatible, so each is an inclusion check — what
    // breaks the page is a name or a value disappearing.
    const declared = hostUiDeclarations(root)
    assert.ok(typeof declared.index === 'string', `${version}: ${PLUGIN_UI_PACKAGE} ships no declarations`)
    for (const [name, required] of Object.entries(PLUGIN_UI_EXPORTS)) {
      assert.match(declared.index, new RegExp(`export \\{[^}]*\\b${name}\\b`, 'u'),
        `${version}: ${PLUGIN_UI_PACKAGE} no longer exports ${name}`)
      const member = declared.members[name]
      assert.ok(typeof member === 'string', `${version}: no declaration for ${name}`)
      for (const token of required) {
        assert.ok(member.includes(token), `${version}: ${name} no longer declares ${token}`)
      }
    }
  }
})
