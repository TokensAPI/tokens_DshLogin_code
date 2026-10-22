// The parts of an installed Host that answer without booting it.
//
// Two host facts this plugin depends on are decided by host code that runs
// before the plugin loads, so no amount of in-plugin testing can see them:
//   - the admission verdict `dsh-app-boot` reaches for this package's manifest
//     (this plugin deliberately declares no dsh peer — agent-hub T0035 — so the
//     verdict has to stay "nothing to check" on every supported runtime);
//   - the Host's session-event vocabulary, against which the names a plugin
//     reads are either present or silently dead (agent-hub T0008/T0010).
//
// Both are read out of the installed Host's own packages with `createRequire`,
// which costs a module load rather than a Host boot.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Require from inside an installed host root, so its own packages answer. */
export function hostRequire(root) {
  return createRequire(join(root, 'package.json'))
}

/** The dsh runtime version a host root ships. */
export function hostRuntimeVersion(root) {
  return JSON.parse(readFileSync(hostRequire(root).resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version
}

/**
 * Whether this Host gates plugins at all.
 *
 * The 0.1 line has no `evaluatePluginCompatibility`: it admits every plugin and
 * the verdict question does not exist there. Judging the 0.1 runtime is still
 * possible — any newer Host's evaluator takes the runtime version as an
 * argument (agent-hub T0027/T0034) — so a 0.1 Host is the one place this check
 * reports "not executed" rather than a result.
 */
export function hasAdmissionEvaluator(root) {
  return typeof hostRequire(root)('@deepseek-ai/dsh-app-boot').evaluatePluginCompatibility === 'function'
}

/**
 * Run the Host's own plugin-admission evaluator over a manifest.
 *
 * The third argument lets one installed Host judge several runtime versions, so
 * the verdict for every supported line is available from whichever Host is at
 * hand (agent-hub T0027/T0034).
 *
 * @param root - an installed host root.
 * @param manifest - the package manifest to judge.
 * @param runtimes - runtime versions to judge it against.
 * @returns `{ runtime, verdict }` per runtime; `verdict` is undefined when the
 *   Host found nothing to enforce, or its own result object when it did.
 */
export function admissionVerdicts(root, manifest, runtimes) {
  const { evaluatePluginCompatibility } = hostRequire(root)('@deepseek-ai/dsh-app-boot')
  return runtimes.map((runtime) => {
    try {
      return { runtime, verdict: evaluatePluginCompatibility(manifest, {}, runtime) }
    } catch (error) {
      return { runtime, threw: String(error?.message ?? error) }
    }
  })
}

/**
 * Unsatisfiable requirements the Host reports, under either field name.
 *
 * 0.2.0 calls them `peers` and 0.2.1 renamed them `requirements`; a check that
 * reads only one name reads "blocked" as "clean" (agent-hub knowledge).
 *
 * @param verdict - one verdict from {@link admissionVerdicts}.
 * @returns the reported entries, or undefined when the Host reported none.
 */
export function reportedRequirements(verdict) {
  if (verdict === undefined || verdict === null) return undefined
  return verdict.requirements ?? verdict.peers
}

/** The Host's own persistent session-event vocabulary. */
export function sessionVocabulary(root) {
  const { KNOWN_SESSION_EVENT_TYPES } = hostRequire(root)('@deepseek-ai/dsh-session')
  return new Set(KNOWN_SESSION_EVENT_TYPES)
}

/** Every `<segment>/<segment>` literal in the given plugin sources. */
export function eventShapedLiterals(paths) {
  const found = new Set()
  for (const path of paths) {
    const source = readFileSync(path, 'utf8')
    for (const [, literal] of source.matchAll(/'([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*)'/gu)) found.add(literal)
  }
  return found
}
