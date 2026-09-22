# @tokensapi/dsh-login — TokensAPI sign-in for TokensCowork Desktop

Sign in to TokensCowork Desktop with a TokensAPI (new-api) **account** instead of
pasting an API key by hand.

[中文文档](./README.zh-CN.md)

## How it works

The startup gate offers a single door: **sign in to your TokensAPI account**. The
plugin opens a one-shot callback listener on `127.0.0.1` and hands
`/desktop-auth?port=…&state=…` to the system's default browser. Everything the
browser already has works there — wallet extensions, passkeys, an existing
session. Once the user authorizes, the site returns an access token and account
id to that loopback port.

An embedded sign-in window was removed: it cannot host wallet extensions or
passkeys, while the browser runs every method the site offers, so keeping it
meant maintaining two code paths.

After the loopback receives the session:

1. store the long-lived access token and account id issued by the site;
2. look for an API key on the account (`GET /api/token/`), creating one named
   `TokensCowork` when none exists, and read back the full `sk-` key;
3. verify it with `GET /v1/models` and write it to the credential plane, so
   downstream plugins such as the model manager work with no changes.

A manual "use an API key instead" entry stays on the gate as a fallback. A
manually submitted key that passes verification admits the user immediately, but
it does **not** replace sign-in on the next launch — unless the host cannot open
a browser (`canSignIn` is false), where the manual key is the only way in.

The door's capability comes from the desktop shell: `desktopRuntime.openExternal`
(HTTPS only, plus HTTP for loopback). Hosts without it fall back to manual key
entry automatically.

## Site-side requirement

Browser sign-in needs a handshake page on the site: `desktop-auth` in new-api's
web app. That page:

- accepts only `port` (an integer in 1024–65535) and `state` (an opaque nonce)
  and **never a URL** — the callback target is fixed in-page as
  `http://127.0.0.1:{port}/callback`;
- opens the site's own sign-in dialog in place when signed out, so `port` and
  `state` survive;
- requires an **explicit authorization** before calling `GET /api/user/token`.
  That endpoint **re-issues** the token, invalidating the previous one, which
  the page states.

The loopback listener binds `127.0.0.1` only, on a random port, accepts exactly
one request, and waits at most 5 minutes. `state` is a 128-bit random value; a
mismatch is answered with 403.

## Credential references

| Reference | Contents |
| --- | --- |
| `TOKENSAPI_API_KEY` | the relay `sk-` key used for model traffic |
| `TOKENSAPI_API_KEY_VERIFIED_SHA256` | `sha256:<hex>` verification marker |
| `TOKENSAPI_ACCESS_TOKEN` | console access token (`Authorization` header) |
| `TOKENSAPI_USER_ID` | numeric account id (required `New-Api-User` header) |

The first two are **downstream traffic credentials**; the last two are **sign-in
state**. Neither decides the other: the gate appears based on the session alone,
and downstream plugins look only for a usable `sk-` key. Signing out clears the
session only — the key and its verification marker are left in place.

## Configuration (`cordis.patch.yml` → `config`)

| Key | Default | Meaning |
| --- | --- | --- |
| `site` | `https://tokensapi.ai` | deployed site origin (HTTPS; loopback may use HTTP) |
| `desktopAuthPath` | `/desktop-auth` | in-site path of the handshake page |
| `tokenName` | `TokensCowork` | name of the API key to reuse or create |
| `autoCreateApiKey` | `true` | create a key when the account has none |

## Tests

```bash
npm test
```

## Publishing

Releases go to the self-hosted registry `https://npm.tokensapi.ai/`, published by GitHub Actions
when a `v*` tag is pushed. See [docs/publishing.md](docs/publishing.md).

## License

MIT
