// Boot an installed Host for real and run this plugin inside it.
//
// Why this exists: every other case in this repo supplies the host services
// itself. That cannot see a Host whose own services changed shape — dsh 0.2.1
// made the typert gateway's `peer` argument mandatory and the connection-centre
// plugin was broken for four product releases while thousands of mocked cases
// stayed green (agent-hub T0043/T0047). So these cases script nothing on the
// host side: the installed Host's own launcher boots a throwaway `$DSH_HOME`
// profile, the real loader mounts `@tokensapi/dsh-login` from the files the
// package ships, and the plugin then talks to the real credential service, the
// real web server and the real Cordis bus.
//
// Two things are necessarily simulated, and only these two:
//   - the TokensAPI deployment, which answers on loopback HTTP from this
//     process (see `live-host-console.mjs`), because the live site is not a
//     test dependency;
//   - the user's own browser, which the probe plays by fetching the plugin's
//     loopback callback. The Host's own `openExternal` fence still runs for
//     real on the URL the plugin hands over.
//
// Cost: one Node process and a Host boot per configured host root, so the
// suite boots each one once and every case reads the same report.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { startConsole } from './live-host-console.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const PROBE_URL = pathToFileURL(join(here, 'live-host-probe.mjs')).href
const PROFILE = 'login-host-contract'
/** The launcher boots a whole Host; a slow cold start must not read as a failure. */
const BOOT_TIMEOUT_MS = 240_000

/**
 * Installed Host roots to run against (`dsh-plugin-desktop` directories).
 *
 * `DSH_HOST_ROOTS` takes a `;`-separated list so one run can cover every
 * runtime line the product supports; `DSH_HOST_ROOT` takes a single one.
 */
export function hostRoots() {
  const configured = process.env.DSH_HOST_ROOTS ?? process.env.DSH_HOST_ROOT ?? ''
  return configured.split(';').map((entry) => entry.trim()).filter((entry) => entry !== '')
}

/** Reason these cases did not execute, or false when at least one Host is configured. */
export const SKIP_WITHOUT_LIVE_HOST = hostRoots().length > 0
  ? false
  : 'NOT EXECUTED: set DSH_HOST_ROOT (or DSH_HOST_ROOTS, ";"-separated) to an installed host root — the directory holding dsh-plugin-desktop/package.json'

/** The dsh runtime version a host root ships, for case reporting. */
function hostVersion(root) {
  const hostRequire = createRequire(join(root, 'package.json'))
  return JSON.parse(readFileSync(hostRequire.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version
}

function hostLauncher(root) {
  const hostRequire = createRequire(join(root, 'package.json'))
  return resolve(hostRequire.resolve('@deepseek-ai/dsh/package.json'), '..', 'lib/bin.js')
}

/**
 * Lay out a throwaway `$DSH_HOME` holding the published plugin, the probe and
 * a profile that mounts both on top of the Host's own bundles.
 */
function composeHome(root, console_) {
  const home = mkdtempSync(join(tmpdir(), 'login-live-home-'))

  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))

  // The probe is a reviewed file in this repo; the package the loader resolves
  // is one line pointing at it, so it imports the repo's own modules.
  const probe = join(home, 'node_modules', 'tokens-login-live-probe')
  mkdirSync(probe, { recursive: true })
  writeFileSync(join(probe, 'package.json'), `${JSON.stringify({
    name: 'tokens-login-live-probe',
    version: '0.0.0',
    private: true,
    type: 'module',
    main: 'index.mjs',
    exports: { '.': './index.mjs' },
  }, null, 2)}\n`)
  writeFileSync(join(probe, 'index.mjs'), `export * from ${JSON.stringify(PROBE_URL)};\n`)

  const profile = join(home, 'profiles', PROFILE)
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', manifest.name] } },
  }, null, 2)}\n`)
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  // `tokens-login` is the entry id this plugin's own `cordis.patch.yml` inserts;
  // overriding its config here is how a profile configures an installed plugin.
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- id: web-runtime',
    '  config:',
    '    openBrowser: false',
    '    printUrl: false',
    '',
    '- id: tokens-login',
    '  config:',
    `    site: ${console_.origin}`,
    '    tokenName: TokensCowork',
    '    autoCreateApiKey: true',
    '',
    '- insert:',
    '    - id: tokens-login-live-probe',
    '      name: tokens-login-live-probe',
    '',
  ].join('\n'))
  // This plugin is a *built-in*, so the installed Host already carries
  // `@tokensapi/dsh-login` as a link into its own `product-plugins`. Junctioning
  // the Host's whole `node_modules` in front of the profile would therefore
  // quietly run the pinned build instead of this working tree, so the profile's
  // own `node_modules` is built scope by scope: `@deepseek-ai` points at the
  // Host, and `@tokensapi/dsh-login` is the file set this package publishes.
  // (`$DSH_HOME/profiles/node_modules` is not available for this — dsh manages
  // that path itself and the 0.1 line refuses to boot if anything else owns it.)
  const modules = join(profile, 'node_modules')
  const installed = join(modules, '@tokensapi', 'dsh-login')
  mkdirSync(join(installed, 'dsh'), { recursive: true })
  copyFileSync(join(repo, 'package.json'), join(installed, 'package.json'))
  copyFileSync(join(repo, 'cordis.patch.yml'), join(installed, 'cordis.patch.yml'))
  for (const entry of ['dsh/index.js', 'dsh/client.js']) copyFileSync(join(repo, entry), join(installed, entry))
  symlinkSync(join(root, 'node_modules', '@deepseek-ai'), join(modules, '@deepseek-ai'),
    process.platform === 'win32' ? 'junction' : 'dir')
  return home
}

function launch(root, home, report, console_) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [
      hostLauncher(root), '--profile', PROFILE, '--port', '0', '--no-open',
    ], {
      cwd: home,
      env: {
        ...process.env,
        DSH_HOME: home,
        TOKENS_LOGIN_LIVE_REPORT: report,
        TOKENS_LOGIN_LIVE_CONSOLE: console_.origin,
        TOKENS_LOGIN_LIVE_HOST_ROOT: root,
        TOKENS_LOGIN_LIVE_PROFILE_DIR: join(home, 'profiles', PROFILE),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const collect = (chunk) => {
      output += chunk
      // A runaway Host would otherwise buffer its whole log into this string.
      if (output.length > 200_000) output = output.slice(-200_000)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ output, timedOut: true })
    }, BOOT_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      settle({ output: `${output}\n${error.message}`, spawnFailed: true })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      settle({ output, code })
    })
  })
}

async function bootOne(root) {
  const console_ = await startConsole({ tokens: [{ id: 1, name: 'TokensCowork', status: 1, key: 'live-host-key-1' }] })
  const home = composeHome(root, console_)
  const reportPath = join(home, 'live-report.json')
  const run = await launch(root, home, reportPath, console_)
  await console_.close()
  let parsed
  try {
    parsed = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch {
    parsed = undefined
  }
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 })
  } catch { /* a Host still exiting can hold a handle; the temp dir is disposable. */ }
  if (parsed === undefined) {
    throw new Error(`the live Host at ${root} never reported; launcher said:\n${run.output.slice(-4000)}`)
  }
  return {
    root,
    version: hostVersion(root),
    consoleRequests: console_.requests,
    ...parsed,
    launcher: run,
  }
}

let booted

/**
 * Boot every configured Host once per test process, in sequence.
 *
 * Sequential on purpose: a Host boot is not cheap in memory, and running two
 * at once on a developer machine has knocked the whole suite over.
 *
 * @returns one report per configured host root, in configuration order.
 */
export function liveHostReports() {
  booted ??= (async () => {
    const reports = []
    for (const root of hostRoots()) reports.push(await bootOne(root))
    return reports
  })()
  return booted
}

/**
 * One recorded step from a live run.
 *
 * @param report - one entry from {@link liveHostReports}.
 * @param id - the probe step id.
 * @returns that step; throws when the probe never reached it.
 */
export function liveStep(report, id) {
  const step = report.steps.find((entry) => entry.id === id)
  if (step === undefined) {
    throw new Error(`the probe never reached ${id} on ${report.version} (${report.root}); it recorded ${
      report.steps.map((entry) => entry.id).join(', ') || 'nothing'
    }${report.fatal === undefined ? '' : `, and failed with ${JSON.stringify(report.fatal, null, 2)}`}`)
  }
  return step
}

/**
 * Assert one step succeeded, reporting the Host's own error when it did not.
 *
 * @param report - one entry from {@link liveHostReports}.
 * @param id - the probe step id.
 * @returns the value the step recorded.
 */
export function liveValue(report, id) {
  const step = liveStep(report, id)
  if (!step.ok) {
    throw new Error(`${id} failed on the live Host ${report.version} (${report.root}): ${JSON.stringify(step.error, null, 2)}`)
  }
  return step.value
}

/**
 * Run one assertion against every configured Host, naming the Host on failure.
 *
 * @param reports - the resolved {@link liveHostReports} value.
 * @param check - called once per host report.
 */
export function forEachHost(reports, check) {
  for (const report of reports) {
    try {
      check(report)
    } catch (error) {
      error.message = `host ${report.version} (${report.root}): ${error.message}`
      throw error
    }
  }
}
