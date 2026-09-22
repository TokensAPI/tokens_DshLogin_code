# Changelog

All notable changes to this project are documented in this file.

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
