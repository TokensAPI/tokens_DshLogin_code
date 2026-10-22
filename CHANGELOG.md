# Changelog

All notable changes to this project are documented in this file.

## 0.1.12

- Add the real-host contract cases, `LOGIN-HOST-01`…`LOGIN-HOST-15`, run by
  `npm run check:host`. An installed host's own launcher boots a throwaway
  `$DSH_HOME` profile, its real loader mounts this package from the file set it
  publishes, and every host interface the plugin uses is called once against
  that running host: `credentials.resolve` / `set` / `unset`, the scoped
  `ctx.inject` of `webServer` and `desktopRuntime`, `webServer.register` and the
  route's same-origin fence on the host's own listener, the
  `credentials/reference-updated` fan-out, the desktop bridge's `openExternal`
  behind the host's own HTTPS fence, the whole browser sign-in loopback
  including a refused nonce, the account key actions, the plugin-admission
  evaluator, the host's slot contract and its real `SlotRegistry`.
  `docs/host-interfaces.md` maps each interface to its case.
- Report a case with no host to run against as `NOT EXECUTED` instead of
  counting it as passed: `npm test` lists those separately and stays green on
  what it could check, while `npm run check:host` exits non-zero. A case that
  ran on some configured hosts and not others says which, and why.
- No behaviour change in the plugin itself.

[0.1.12](https://github.com/TokensAPI/tokens_DshLogin_code/compare/v0.1.11...v0.1.12)

## 0.1.11

- Show sign-in and API-key errors in the app's language. The sign-in page, the
  API key page, Account settings and the sidebar menu now map the host's error
  code (`unreachable`, `upstream`, `invalid_key`, `session_expired`,
  `browser_unavailable`, `cancelled`, `no_api_key`, `invalid_input`,
  `signin_required`) to localized text, and use a localized generic message for
  unknown codes. The host's fixed Chinese messages are no longer shown.
- Pass the error code of a failed API-key setup after browser sign-in
  (`apiKeyErrorCode`), which was previously sent as message text only.
- Re-render an error already on the sign-in gate when the app language changes.
- Announce a failed sign-in from the sidebar menu instead of failing silently.

[0.1.11](https://github.com/TokensAPI/tokens_DshLogin_code/compare/v0.1.10...v0.1.11)

## 0.1.10

- Replace the sidebar-foot account menu with a TokensAPI one: registered in the
  `settings.launcher` slot at priority -10 so the upstream DeepSeek menu is
  shadowed without modifying its package.
- Show the TokensAPI display name (or username) and an initial avatar when signed
  in, **More** when signed out, and the icon only when the sidebar is collapsed.
- Offer **Settings** (with its shortcut), plus **Sign out** with confirmation or
  **Sign in** through the existing browser sign-in; no feedback entry.
- Share one account state between the menu and the Account settings page.
- Run the post-publish package check only when the read-only
  `PLUGIN_CHECK_REGISTRY_TOKEN` secret is configured; without it the release
  warns and continues instead of failing before publishing. A configured
  secret must still belong to the `market` account.

[0.1.10](https://github.com/TokensAPI/tokens_DshLogin_code/compare/v0.1.8...v0.1.10)

## 0.1.9

- Tagged but never published: the release stopped before publishing because the
  package-check secret was not configured. Its changes ship in 0.1.10.

## 0.1.8

- Clarify in Chinese and English that API-key sign-in lasts only for the current
  app launch and requires verification again after quitting; recommend account
  sign-in to stay signed in.
- Leave sign-in, verification and credential storage behavior unchanged.

[0.1.8](https://github.com/TokensAPI/tokens_DshLogin_code/compare/v0.1.7...v0.1.8)

## 0.1.7

- Report rejected account sessions with localized re-sign-in guidance while
  retaining model credentials and avoiding a forced page reload.
- End failed API-key list loading and restore retry controls; confirm ambiguous
  console failures without mistaking network or business errors for expiry.
- Cover account action failures, fresh-login races and bilingual recovery in the
  existing functional case inventory and runner.

[0.1.7](https://github.com/TokensAPI/tokens_DshLogin_code/compare/v0.1.6...v0.1.7)

## 0.1.6

- Add bilingual market metadata and Chinese primary documentation.
- Make releases tag-only and gate publication on the complete Node LTS matrix.
- Stop publication on Registry query errors; verify published metadata and tarball integrity.
- Add a CSV functional case inventory and real credential-provider restart tests.
- Synchronize the package manifest, lockfile and release version.

[0.1.6](https://github.com/TokensAPI/tokens_DshLogin_code/compare/v0.1.5...v0.1.6)

## 0.1.5

- Match the stored API key against the signed-in account's key list; replace
  foreign keys on sign-in and when opening the account page, creating a key
  automatically when the account has none.
- Retry loading an empty cached key list when revisiting the account page.

[0.1.5](https://github.com/TokensAPI/tokens_DshLogin_code/compare/v0.1.4...v0.1.5)

## 0.1.4

- "Refresh" on the account page now only reloads the key list; it never
  touches the key in use. Switching keys is the "Use" button's job alone.
- Keys are copied, never displayed: the eye toggle is gone, and the copy
  icon fetches the key for the clipboard alone, confirming with a check.
- The list's controls sit in two fixed columns (copy, then "Use"), with the
  in-use row leaving its "Use" cell empty, so everything lines up.
- All account-page styling is inline on its own elements: no style tags, no
  classes, nothing that can reach other plugins or the shell.

## 0.1.3

- A stored sign-in is now verified with the console once per boot: a definite
  rejection (HTTP 401/403, or this deployment's 200 + `success:false`) clears
  the session so the gate returns; an unreachable console decides nothing, so
  an offline start is not locked out. A late rejection of an old token can
  never clear a session signed in meanwhile.
- The display name is fetched alongside that verification, so it survives an
  app restart instead of living only in the sign-in flow's memory.
- Account page: keys in the list can be copied (icon button with a check on
  success) and shown/hidden via eye icons; a "Use" button switches the app to
  another of the account's keys through the same verify-then-persist steps.
- Account page: "Fetch again" moved below the list; the manual key form and
  the full-key header line were removed (the gate's manual fallback is
  unchanged); revisiting the page reuses the last answers instead of
  re-requesting — only actions refresh them.
- Host: new `useApiKey` action; `revealApiKey` without an id answers with the
  stored key via a local read.

## 0.1.2

First release published from CI. 0.1.1 was prepared but never published; its
changes ship here.

- The gate's fallback link now reads "Use an API key for this session"
  (改用 API Key 临时登录). Entering a key admits you once; the gate judges
  the account session, so it returns on the next start. The key itself is
  kept — downstream plugins are unaffected.
- Release workflow: pushing to `main` packs the release and verifies the
  packed artifact imports; tagging `v*` additionally checks that the tag
  matches the version and publishes to the private registry. Publishing
  refuses a non-`tokenscowork` token and never overwrites a published
  version.

## 0.1.0

First release.

- Account sign-in through the user's own browser, with a one-shot
  `127.0.0.1` callback listener (random port, 128-bit `state`, 5-minute
  timeout) instead of pasting an API key.
- Automatic API key provisioning: reuse an existing key on the account or
  create one, verify it, and write it to the DSH credential plane so
  downstream plugins need no changes.
- "Settings → Account" page: sign in and out, inspect the key in use, refresh
  it, enter one manually, and list the account's keys with on-demand reveal.
- Sign-in state and the API key are kept independent — signing out clears the
  session only and leaves the key working for downstream plugins.

[0.1.4](https://github.com/TokensAPI/tokens_DshLogin_code/compare/v0.1.3...v0.1.4)
[0.1.3](https://github.com/TokensAPI/tokens_DshLogin_code/compare/v0.1.2...v0.1.3)
[0.1.2](https://github.com/TokensAPI/tokens_DshLogin_code/compare/v0.1.0...v0.1.2)
[0.1.0](https://github.com/TokensAPI/tokens_DshLogin_code/tree/v0.1.0)
