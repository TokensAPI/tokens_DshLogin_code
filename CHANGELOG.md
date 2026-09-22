# Changelog

All notable changes to this project are documented in this file.

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
