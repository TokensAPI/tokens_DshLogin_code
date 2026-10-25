# Host interfaces this plugin uses, and the case that calls each one

Every host interface this plugin touches is listed here with the resident case
that calls it **against a real, installed host** rather than against a fixture.
A new host call belongs in both this table and `test/test_cases.csv`.

Run them with:

```bash
DSH_HOST_ROOT=<...>/.build/desktop/dsh-plugin-desktop npm run check:host
```

`DSH_HOST_ROOT` is one installed host root — the directory holding
`dsh-plugin-desktop/package.json`. Without it every case reports
`NOT EXECUTED` and `check:host` exits non-zero: these cases are never counted
as passed on a machine that had no host to check them against. To cover several
runtime lines in one pass, `DSH_HOST_ROOTS` takes a `;`-separated list (repo
convenience; the gate uses `DSH_HOST_ROOT`).

## Server half — `dsh/index.js`

| Host interface | What the plugin needs from it | Case |
|---|---|---|
| Profile entry mount: the loader reads `dsh.bundle.patch` (`cordis.patch.yml`) and applies `{ name, inject, apply }` | that the plugin mounts at all, with `inject: ['credentials']` satisfied | `LOGIN-HOST-01` |
| `ctx.inject(['webServer'], cb)` — scoped, optional | that the callback fires when a web profile has the service | `LOGIN-HOST-01` |
| `webServer.register({ name, kind: 'exact', path, handler })` | that the route is taken and reachable on the host's own listener | `LOGIN-HOST-01`, `LOGIN-HOST-02`, `LOGIN-HOST-03` |
| `ctx.inject(['desktopRuntime'], cb)` — scoped, optional, reactive | that the callback fires when the desktop shell provides the service later | `LOGIN-HOST-06`, `LOGIN-HOST-08` |
| `desktopRuntime.openExternal(url)` | that the host opens the deployment's hand-off page — the whole sign-in depends on this one call | `LOGIN-HOST-07`, `LOGIN-HOST-09` |
| `desktopRuntime.locale` | the app language, for a gate that mounts before the locale plugin | `LOGIN-HOST-08` |
| `ctx.credentials.resolve(ref)`, read as `.value` | the four `TOKENSAPI_*` references | `LOGIN-HOST-02`, `LOGIN-HOST-04`, `LOGIN-HOST-09`, `LOGIN-HOST-10`, `LOGIN-HOST-11` |
| `ctx.credentials.set(ref, value)` | that the key, its verification marker and the session persist | `LOGIN-HOST-04`, `LOGIN-HOST-09`, `LOGIN-HOST-10` |
| `ctx.credentials.unset(ref)` | that logout removes the session and nothing else | `LOGIN-HOST-11` |
| `credentials/reference-updated` on the Cordis bus | that the host fans this out of `credentials.set`, which is how the native model catalogue picks up a key without a restart | `LOGIN-HOST-05` |
| Plugin admission (`dsh-app-boot`) | that a manifest with no dsh peer and no `engines.dsh` is admitted (the T0035 decision) | `LOGIN-HOST-12` |
| Session events (`KNOWN_SESSION_EVENT_TYPES`) | nothing: this plugin reads none, and the case says so, so adding one is a deliberate act | `LOGIN-HOST-13` |

## Browser half — `dsh/client.js`

| Host interface | What the plugin needs from it | Case |
|---|---|---|
| `window.__ModuleLoader__.load({ id, factory })` bundle protocol | that the client entry is loadable the way the host loads client bundles | `LOGIN-HOST-15` |
| `ctx.inject(['slots'], cb)` — scoped | that the slot service reaches the client half | `LOGIN-HOST-15` |
| `slots.inject('settings.section' \| 'settings.launcher', cb)` | that both slot names are accepted by the real registry | `LOGIN-HOST-15` |
| The `settings.section` / `settings.launcher` slot declarations (`kind`, `scope`) | that the slots still exist and are still the kind the plugin registers for | `LOGIN-HOST-14` |
| `slots.register({ name, priority }, Component)` | that a lower priority shadows the upstream single-slot default | `LOGIN-HOST-14` for the contract; the component behaviour is covered by `LOGIN-073`…`LOGIN-075` |
| `ctx.effect(fn, label)` | that the gate is disposed with the fiber | `LOGIN-HOST-15` |
| Host-provided `react`, `react-dom` | value imports the host resolves at render time, invisible to `tsc` | `LOGIN-HOST-15` |
| Host-provided `@deepseek-ai/dsh-client-ui-primitives` | that the loader still seeds the name, and that `Button` (`size`, `variant`, `icon`) and `Tag` (`tone`) are still exported — the account page's controls are these components, so the host decides what a secondary button and a tag look like | `LOGIN-HOST-16`; the degradation when they are absent is `LOGIN-084` |

## What is simulated, and what that leaves uncovered

The host side is never scripted — the loader, the web server, the credential
service, the Cordis bus, the admission evaluator, the slot registry and the
`openExternal` fence are all the installed host's own code. Three things are
stood in for, each because it cannot be otherwise:

- **The TokensAPI deployment.** `test/support/live-host-console.mjs` serves the
  console's endpoints over loopback HTTP, and the plugin is configured with
  `site: http://127.0.0.1:<port>` — a value its own `normalizeSite` accepts.
  The plugin's network path is real; only the far end is local.
- **The user's browser.** The host's fence really judges the URL the plugin
  hands over; the probe then plays the browser by fetching the plugin's own
  loopback callback with the nonce that URL carried. What a headless host
  cannot do is the final `electron.shell.openExternal`, so that one call is
  where the substitution sits.
- **Slot declaration.** `slots.inject` waits for the upstream shell that owns
  the slot to declare it, and declaring it by hand would be a copy of the thing
  under test. So the registration *bodies* stay covered by the client cases,
  and these cases cover the slot names, kinds and scopes.
- **The shared UI package.** The renderer bundles
  `@deepseek-ai/dsh-client-ui-primitives` rather than resolving it, and the
  package's own ESM imports `.module.css` and a dozen third-party packages the
  staged tree does not carry, so it cannot be produced here. `LOGIN-HOST-16`
  therefore reads the two host artifacts that decide the question instead: the
  loader's platform seed table in the shipped web frontend, which is what
  answers a plugin's `require`, and the package's shipped declarations. In
  `LOGIN-HOST-15` the module is simply absent, which is deliberate — the mount
  there exercises the path a host that dropped the package would give the
  plugin, and the section still mounts.

Known per-host gaps, reported as `NOT EXECUTED` / `PARTIAL` by name rather than
passed over:

- The staged 0.1.5-rc.2 host ships no compiled `lib/`, so its `openExternal`
  fence cannot be called (`LOGIN-HOST-07`), and the sign-in chain there runs
  with a stand-in bridge.
- The 0.1 line has no plugin-admission evaluator at all, so `LOGIN-HOST-12`
  does not execute on it. Any newer host judges all three runtime versions, so
  one modern host covers the matrix.
- `settings.launcher` arrived in DSH 0.2.0. On 0.1.5 the slot does not exist,
  `slots.inject` waits forever and the sidebar account menu is simply absent —
  not broken. `LOGIN-HOST-14` allows that only below 0.2.0.
