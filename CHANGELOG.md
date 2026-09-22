# Changelog

All notable changes to this project are documented in this file.

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
