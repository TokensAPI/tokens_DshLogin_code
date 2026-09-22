// Browser half of the TokensAPI login plugin: the sign-in gate.
//
// A full-screen, fail-closed overlay mounted before React, the same stance
// as the model-manager gate it supersedes. One primary action — hand the
// TokensAPI login page to the user's own browser, where password, Google,
// wallet and passkey all work — plus a manual API-key fallback. All work happens on the host
// route /tokens/login; no credential lives in this file beyond the fallback
// input and the single POST that carries it.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), so no build step and no
// imports from dsh client packages.
window.__ModuleLoader__.load({
  id: '@tokens/dsh-login',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var GATE_ID = 'tokens-login-gate'
    var LEGACY_GATE_ID = 'tokens-model-manager-gate'
    var ROUTE = '/tokens/login'

    /*
     * The app's language is the one the locale plugin publishes onto
     * <html lang>, and that is the answer the gate wants. But the gate mounts
     * before React, and so before that attribute exists; until it appears the
     * host's own locale, carried on every status payload, is the closest
     * thing, and the browser underneath an Electron window answers en-US
     * whatever the user picked, so it comes last.
     */
    var appLocale = ''

    function chinese() {
      var lang = (document.documentElement?.lang || appLocale || globalThis.navigator?.language || 'en').toLowerCase()
      return lang.indexOf('zh') === 0
    }

    function rememberLocale(body) {
      if (typeof body?.locale === 'string' && body.locale !== '') appLocale = body.locale
      return body
    }

    function labels() {
      return chinese()
        ? {
            title: '登录 TokensAPI',
            intro: '将在系统默认浏览器中打开登录页面，登录后自动配置 API Key。',
            login: '登录 TokensAPI 账号',
            waiting: '请在浏览器中完成登录…（没打开？再点一次）',
            useApiKey: '改用 API Key 登录',
            backToLogin: '返回账号登录',
            apiKeyIntro: '粘贴 TokensAPI 控制台中的 API Key。',
            verify: '验证并继续',
            verifying: '正在验证…',
            checking: '正在检查登录状态…',
            missing: '请输入 API Key',
            keyWarnPrefix: '已登录，但 API Key 配置未完成：',
          }
        : {
            title: 'Sign in to TokensAPI',
            intro: 'Your default browser opens the sign-in page; the API key is set up automatically.',
            login: 'Sign in with TokensAPI',
            waiting: 'Finish signing in in your browser… (click to reopen)',
            useApiKey: 'Use an API key instead',
            backToLogin: 'Back to account sign-in',
            apiKeyIntro: 'Paste an API key from the TokensAPI console.',
            verify: 'Verify and continue',
            verifying: 'Verifying…',
            checking: 'Checking sign-in status…',
            missing: 'Please enter an API key',
            keyWarnPrefix: 'Signed in, but the API key setup did not finish: ',
          }
    }

    function accountLabels() {
      return chinese()
        ? {
            nav: '账户管理',
            title: '账户管理',
            intro: '管理 TokensAPI 登录状态与模型流量所用的 API Key。',
            account: '账号',
            signedOut: '未登录',
            signedIn: '已登录',
            signIn: '登录 TokensAPI 账号',
            signingIn: '请在浏览器中完成登录…',
            signOut: '注销',
            signOutHint: '注销只清除登录会话，API Key 保留；下次进入需重新登录。',
            apiKey: 'API Key',
            apiKeyNone: '未配置',
            apiKeyOk: '已验证',
            refresh: '重新获取',
            refreshing: '正在获取…',
            manual: '手动填入 API Key',
            save: '保存',
            saving: '正在验证…',
            done: '已更新',
            browserUnavailable: '当前版本不支持浏览器登录，请手动填入 API Key。',
            keysLoading: '正在读取账户中的 API Key…',
            keysEmpty: '账户中还没有 API Key。',
            inUse: '当前使用',
            keyDisabled: '已禁用',
            show: '显示',
            hide: '隐藏',
          }
        : {
            nav: 'Account',
            title: 'Account',
            intro: 'Manage TokensAPI sign-in and the API key used for model traffic.',
            account: 'Account',
            signedOut: 'Not signed in',
            signedIn: 'Signed in',
            signIn: 'Sign in with TokensAPI',
            signingIn: 'Finish signing in in your browser…',
            signOut: 'Sign out',
            signOutHint: 'Signing out clears the session only; the API key stays. You will be asked to sign in again.',
            apiKey: 'API key',
            apiKeyNone: 'Not configured',
            apiKeyOk: 'Verified',
            refresh: 'Fetch again',
            refreshing: 'Fetching…',
            manual: 'Enter an API key manually',
            save: 'Save',
            saving: 'Verifying…',
            done: 'Updated',
            browserUnavailable: 'This build cannot open a browser sign-in; enter an API key manually.',
            keysLoading: 'Loading the keys on this account…',
            keysEmpty: 'This account has no API keys yet.',
            inUse: 'In use',
            keyDisabled: 'Disabled',
            show: 'Show',
            hide: 'Hide',
          }
    }

    function postAction(body) {
      return fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((response) =>
        response
          .json()
          .catch(() => ({}))
          .then((data) => ({ response: response, body: rememberLocale(data) })),
      )
    }

    /**
     * Full-screen, fail-closed sign-in gate. Plain DOM so it mounts before
     * React slots and cannot briefly expose the chat shell.
     */
    function registerLoginGate() {
      var root = document.body || document.documentElement
      if (!root || typeof document.createElement !== 'function' || typeof root.appendChild !== 'function')
        return () => {}
      var previous = document.getElementById?.(GATE_ID)
      if (previous) previous.remove()
      var t = labels()
      var overlay = document.createElement('div')
      overlay.id = GATE_ID
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:linear-gradient(145deg,var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-1) 45%,var(--dsw-alias-bg-layer-2));font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary)'
      var oldOverflow = document.documentElement?.style?.overflow || ''
      if (document.documentElement?.style) document.documentElement.style.overflow = 'hidden'
      root.appendChild(overlay)
      var closed = false
      var canSignIn = true

      // The model-manager is not modified for us: it mounts its own API-key
      // gate whenever no verified key is stored, and mount order decides who
      // lands on top. This gate supersedes it — same credential references,
      // own manual-key fallback — so keep that overlay out while this one
      // lives, whenever it appears. Once we write the key, its gate settles
      // on its own.
      function dropLegacyGate() {
        var legacy = document.getElementById?.(LEGACY_GATE_ID)
        if (legacy) legacy.remove()
      }
      dropLegacyGate()
      // The same watcher also follows <html lang>: the app's language is
      // published after the gate is already on screen, and the user can switch
      // it while the gate is still up. Repaint only when it actually changed —
      // the legacy-gate half fires on every body mutation.
      var repaint = null
      var painted = chinese()
      function follow() {
        dropLegacyGate()
        if (repaint && chinese() !== painted) repaint()
      }
      var legacyWatcher = null
      if (typeof MutationObserver === 'function') {
        legacyWatcher = new MutationObserver(follow)
        legacyWatcher.observe(root, { childList: true })
        if (document.documentElement) {
          legacyWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
        }
      }

      function close() {
        if (closed) return
        closed = true
        overlay.remove()
        if (document.documentElement?.style) document.documentElement.style.overflow = oldOverflow
        if (legacyWatcher) legacyWatcher.disconnect()
        dropLegacyGate()
      }

      function node(tag, text, css) {
        var element = document.createElement(tag)
        if (text !== undefined) element.textContent = text
        if (css) element.style.cssText = css
        return element
      }

      function card(message, errored) {
        overlay.replaceChildren()
        var shell = node(
          'div',
          undefined,
          'width:min(440px,100%);box-sizing:border-box;padding:32px;border:1px solid var(--dsw-alias-bg-layer-3);border-radius:20px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 24px 70px rgba(30,64,175,.16)',
        )
        shell.appendChild(
          node(
            'div',
            'TokensAPI',
            'font-size:14px;font-weight:750;letter-spacing:.12em;color:var(--dsw-alias-state-business-primary);margin-bottom:16px',
          ),
        )
        shell.appendChild(node('h1', t.title, 'font-size:25px;line-height:1.25;margin:0 0 12px'))
        var note = node(
          'p',
          message,
          'margin:0 0 22px;line-height:1.6;color:' +
            (errored ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)'),
        )
        if (errored) note.setAttribute('role', 'alert')
        shell.appendChild(note)
        overlay.appendChild(shell)
        return shell
      }

      /**
       * The gate is about the account session, not about the relay key: a
       * leftover sk- key must not let anyone past, and a key that failed to
       * provision must not keep a signed-in user out. The one exception is a
       * host with no sign-in door at all, where the manual key is the only
       * way in.
       */
      function settle(body) {
        var passed = body?.signedIn === true || (body?.canSignIn !== true && body?.authenticated === true)
        if (passed) close()
        return passed
      }

      function renderLogin(message, errored) {
        repaint = () => renderLogin(message, errored)
        // Re-read the labels before anything reads them: the app's language
        // arrives after the gate is already on screen, and the intro below is
        // picked out of `t` on the way into card().
        t = labels()
        painted = chinese()
        var shell = card(message || t.intro, Boolean(errored))
        // One door: the user's own browser, which carries the wallet
        // extensions, passkeys and existing sessions an embedded window never
        // could, so anything the site offers works there.
        if (canSignIn) {
          var button = node(
            'button',
            t.login,
            'width:100%;padding:12px 16px;border-radius:10px;font:inherit;cursor:pointer;border:0;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-layer-2);font-weight:700',
          )
          button.type = 'button'
          button.addEventListener('click', () => {
            // Deliberately still clickable. A browser tab is easy to close by
            // accident, and the host answers a repeat click by re-opening the
            // same hand-off page; disabling the button would leave the user
            // staring at a dead screen until the attempt times out.
            button.textContent = t.waiting
            // The browser page speaks whatever language that browser prefers;
            // send the app's so the hand-off page comes up in the same one.
            postAction({ action: 'login', locale: chinese() ? 'zh' : 'en' })
              .then(({ response, body }) => {
                if (!response.ok) throw new Error(body?.error || 'login failed')
                if (settle(body)) return
                renderLogin(body?.apiKeyError ? t.keyWarnPrefix + body.apiKeyError : '', true)
              })
              .catch((error) => renderLogin(String(error.message || error), true))
          })
          shell.appendChild(button)
        }
        var footer = node('div', undefined, 'margin-top:16px;text-align:center')
        var toggle = node(
          'button',
          t.useApiKey,
          'border:0;background:none;padding:0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;text-decoration:underline',
        )
        toggle.type = 'button'
        toggle.addEventListener('click', () => renderApiKey('', false))
        footer.appendChild(toggle)
        shell.appendChild(footer)
      }

      function renderApiKey(message, errored) {
        repaint = () => renderApiKey(message, errored)
        t = labels()
        painted = chinese()
        var shell = card(message || t.apiKeyIntro, Boolean(errored))
        var form = node('form')
        var input = node(
          'input',
          undefined,
          'width:100%;box-sizing:border-box;padding:12px 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;outline:none;margin-bottom:12px',
        )
        input.id = 'tokens-login-key'
        input.type = 'password'
        input.autocomplete = 'off'
        input.spellcheck = false
        var submit = node(
          'button',
          t.verify,
          'width:100%;padding:12px 16px;border:0;border-radius:10px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-layer-2);font:inherit;font-weight:700;cursor:pointer',
        )
        submit.type = 'submit'
        form.appendChild(input)
        form.appendChild(submit)
        form.addEventListener('submit', (event) => {
          event.preventDefault()
          var apiKey = input.value.trim()
          if (!apiKey) {
            renderApiKey(t.missing, true)
            return
          }
          input.disabled = true
          submit.disabled = true
          submit.textContent = t.verifying
          postAction({ action: 'setApiKey', apiKey: apiKey })
            .then(({ response, body }) => {
              input.value = ''
              if (!response.ok) throw new Error(body?.error || t.missing)
              // Submitting a key here is an explicit act of entry, so it opens
              // the gate even without a session. A key merely *found* at boot
              // does not — that is what settle() refuses.
              if (body?.authenticated === true) {
                close()
                return
              }
              renderApiKey(body?.error || '', true)
            })
            .catch((error) => renderApiKey(String(error.message || error), true))
        })
        shell.appendChild(form)
        if (canSignIn) {
          var footer = node('div', undefined, 'margin-top:16px;text-align:center')
          var toggle = node(
            'button',
            t.backToLogin,
            'border:0;background:none;padding:0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;text-decoration:underline',
          )
          toggle.type = 'button'
          toggle.addEventListener('click', () => renderLogin('', false))
          footer.appendChild(toggle)
          shell.appendChild(footer)
        }
        setTimeout(() => input.focus(), 0)
      }

      card(t.checking, false)
      fetch(ROUTE, { cache: 'no-store' })
        .then((response) =>
          response
            .json()
            .catch(() => ({}))
            .then((body) => ({ response: response, body: rememberLocale(body) })),
        )
        .then(({ response, body }) => {
          if (!response.ok) throw new Error(body?.error || 'status unavailable')
          if (settle(body)) return
          canSignIn = body?.canSignIn === true
          if (canSignIn) renderLogin('', false)
          else renderApiKey('', false)
        })
        .catch((error) => {
          canSignIn = false
          renderApiKey(String(error.message || error), true)
        })
      return close
    }

    /**
     * The Settings > 账户管理 page. Plain react.createElement (no JSX, no build
     * step) in the same house style as the model-manager section: one account
     * row and one API-key row, both driven by /tokens/login.
     */
    function AccountSection(react) {
      var h = react.createElement
      var row = (title, value, controls, hint) =>
        h(
          'div',
          {
            style: {
              border: '1px solid var(--dsw-alias-border-l2, #ddd)',
              borderRadius: 12,
              padding: 16,
              marginBottom: 16,
            },
          },
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, title),
          h('div', { style: { color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 12 } }, value),
          controls,
          hint
            ? h(
                'div',
                { style: { marginTop: 10, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)' } },
                hint,
              )
            : null,
        )
      var action = (label, onClick, disabled, primary) =>
        h(
          'button',
          {
            type: 'button',
            disabled: disabled === true,
            onClick: onClick,
            style: {
              padding: '8px 14px',
              borderRadius: 8,
              border: primary ? 0 : '1px solid var(--dsw-alias-border-l2, #ddd)',
              background: primary ? 'var(--dsw-alias-state-business-primary, #2563eb)' : 'transparent',
              color: primary ? 'var(--dsw-alias-bg-layer-2, #fff)' : 'inherit',
              font: 'inherit',
              fontWeight: primary ? 600 : 400,
              cursor: disabled === true ? 'default' : 'pointer',
              opacity: disabled === true ? 0.6 : 1,
            },
          },
          label,
        )
      return function TokensAccount() {
        var statePair = react.useState(null)
        var notePair = react.useState('')
        var erroredPair = react.useState(false)
        var busyPair = react.useState('')
        var manualPair = react.useState(false)
        var keyPair = react.useState('')
        // The account's keys, loaded once signed in: null while unknown, [] when
        // the account has none. revealed holds only the keys the user asked to
        // see, and hiding one drops it again — nothing is kept around.
        var keysPair = react.useState(null)
        var keysErrorPair = react.useState('')
        var revealedPair = react.useState({})
        var state = statePair[0]
        var note = notePair[0]
        var busy = busyPair[0]
        var t = accountLabels()

        react.useEffect(() => {
          var alive = true
          fetch(ROUTE, { cache: 'no-store' })
            .then((response) => response.json().then((body) => ({ response: response, body: rememberLocale(body) })))
            .then(({ response, body }) => {
              if (alive && response.ok) statePair[1](body)
            })
            .catch(() => {})
          return () => {
            alive = false
          }
        }, [])

        var loadKeys = () => {
          keysErrorPair[1]('')
          postAction({ action: 'listApiKeys' })
            .then(({ response, body }) => {
              if (!response.ok) throw new Error(body?.error || 'request failed')
              keysPair[1](Array.isArray(body?.apiKeys) ? body.apiKeys : [])
            })
            .catch((error) => keysErrorPair[1](String(error?.message || error)))
        }

        // Plain text on demand, masked again on the next click. The full key
        // only ever travels for the row the user opened.
        var toggleReveal = (item) => {
          var revealed = revealedPair[0]
          if (revealed[item.id] !== undefined) {
            var hidden = Object.assign({}, revealed)
            delete hidden[item.id]
            revealedPair[1](hidden)
            return
          }
          postAction({ action: 'revealApiKey', id: item.id })
            .then(({ response, body }) => {
              if (!response.ok) throw new Error(body?.error || 'request failed')
              var shown = Object.assign({}, revealedPair[0])
              shown[item.id] = String(body?.apiKey || '')
              revealedPair[1](shown)
            })
            .catch((error) => keysErrorPair[1](String(error?.message || error)))
        }

        var run = (kind, body) => {
          busyPair[1](kind)
          notePair[1]('')
          erroredPair[1](false)
          postAction(body)
            .then(({ response, body: result }) => {
              busyPair[1]('')
              if (!response.ok) {
                erroredPair[1](true)
                notePair[1](String(result?.error || 'request failed'))
                return
              }
              statePair[1](result)
              // Signing out must put the gate back in front of the shell.
              // Reloading is the whole of it: the plugin remounts, the status
              // now says unauthenticated, and the gate blocks fail-closed.
              if (kind === 'logout') {
                globalThis.location?.reload?.()
                return
              }
              if (result?.apiKeyError) {
                erroredPair[1](true)
                notePair[1](String(result.apiKeyError))
                return
              }
              notePair[1](t.done)
              if (kind === 'setApiKey') {
                keyPair[1]('')
                manualPair[1](false)
              }
              // Which key is in use may have just changed. After a sign-in the
              // list loads on its own, when signedIn flips.
              revealedPair[1]({})
              if (kind !== 'login') loadKeys()
            })
            .catch((error) => {
              busyPair[1]('')
              erroredPair[1](true)
              notePair[1](String(error?.message || error))
            })
        }

        var signedIn = state?.signedIn === true
        // The list belongs to the account, so it is only worth asking for once
        // there is a session, and worth asking for again whenever one appears.
        react.useEffect(() => {
          if (signedIn) loadKeys()
          else keysPair[1](null)
        }, [signedIn])

        var who = state?.user?.displayName || state?.user?.username || ''
        var accountValue = signedIn ? (who ? t.signedIn + ' · ' + who : t.signedIn) : t.signedOut
        // The same single door as the gate.
        var accountControls = signedIn
          ? action(t.signOut, () => run('logout', { action: 'logout' }), busy !== '')
          : state?.canSignIn !== true
            ? h('div', { style: { color: 'var(--dsw-alias-label-secondary, #666)' } }, t.browserUnavailable)
            : action(busy === 'login' ? t.signingIn : t.signIn, () => run('login', { action: 'login' }), busy !== '', true)

        var manualForm = manualPair[0]
          ? h(
              'form',
              {
                onSubmit: (event) => {
                  event.preventDefault()
                  var apiKey = keyPair[0].trim()
                  if (apiKey) run('setApiKey', { action: 'setApiKey', apiKey: apiKey })
                },
                style: { display: 'flex', gap: 8, marginTop: 12 },
              },
              h('input', {
                type: 'password',
                value: keyPair[0],
                autoComplete: 'off',
                spellCheck: false,
                placeholder: 'sk-…',
                onChange: (event) => keyPair[1](event.target.value),
                style: {
                  flex: 1,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-l2, #ddd)',
                  background: 'var(--dsw-alias-bg-layer-2, transparent)',
                  color: 'inherit',
                  font: 'inherit',
                },
              }),
              h(
                'button',
                {
                  type: 'submit',
                  disabled: busy !== '' || keyPair[0].trim() === '',
                  style: {
                    padding: '8px 14px',
                    borderRadius: 8,
                    border: 0,
                    background: 'var(--dsw-alias-state-business-primary, #2563eb)',
                    color: 'var(--dsw-alias-bg-layer-2, #fff)',
                    font: 'inherit',
                    fontWeight: 600,
                    cursor: busy !== '' ? 'default' : 'pointer',
                  },
                },
                busy === 'setApiKey' ? t.saving : t.save,
              ),
            )
          : null

        var muted = 'var(--dsw-alias-label-secondary, #666)'
        var keyRow = (item) => {
          var shown = revealedPair[0][item.id]
          return h(
            'div',
            {
              key: item.id,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 0',
                borderTop: '1px solid var(--dsw-alias-border-l2, #eee)',
              },
            },
            h(
              'div',
              { style: { flex: '0 0 34%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              item.name || '#' + item.id,
              item.inUse
                ? h(
                    'span',
                    {
                      style: {
                        marginLeft: 6,
                        padding: '1px 6px',
                        borderRadius: 6,
                        fontSize: 12,
                        background: 'var(--dsw-alias-state-business-primary, #2563eb)',
                        color: 'var(--dsw-alias-bg-layer-2, #fff)',
                      },
                    },
                    t.inUse,
                  )
                : null,
              item.enabled ? null : h('span', { style: { marginLeft: 6, fontSize: 12, color: muted } }, t.keyDisabled),
            ),
            h(
              'code',
              {
                style: {
                  flex: 1,
                  minWidth: 0,
                  fontFamily: 'var(--dsw-font-family-mono, monospace)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              shown === undefined ? item.masked : shown,
            ),
            action(shown === undefined ? t.show : t.hide, () => toggleReveal(item), busy !== ''),
          )
        }

        var keyList = !signedIn
          ? null
          : h(
              'div',
              { style: { marginTop: 16 } },
              keysErrorPair[0]
                ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #b91c1c)' } }, keysErrorPair[0])
                : null,
              keysPair[0] === null
                ? h('div', { style: { color: muted } }, t.keysLoading)
                : keysPair[0].length === 0
                  ? h('div', { style: { color: muted } }, t.keysEmpty)
                  : keysPair[0].map(keyRow),
            )

        var keyControls = h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          signedIn
            ? action(
                busy === 'refreshApiKey' ? t.refreshing : t.refresh,
                () => run('refreshApiKey', { action: 'refreshApiKey' }),
                busy !== '',
              )
            : null,
          action(t.manual, () => manualPair[1](!manualPair[0]), busy !== ''),
        )

        return h(
          'div',
          { style: { maxWidth: 760, padding: '8px 0 32px' } },
          h('h2', { style: { margin: '0 0 8px' } }, t.title),
          h('p', { style: { margin: '0 0 20px', color: 'var(--dsw-alias-label-secondary, #666)' } }, t.intro),
          note
            ? h(
                'div',
                {
                  role: 'alert',
                  style: {
                    marginBottom: 16,
                    color: erroredPair[0]
                      ? 'var(--dsw-alias-state-error-primary, #b91c1c)'
                      : 'var(--dsw-alias-label-secondary, #666)',
                  },
                },
                note,
              )
            : null,
          row(t.account, accountValue, accountControls, signedIn ? t.signOutHint : ''),
          row(
            t.apiKey,
            state?.authenticated === true ? (state.apiKeyMasked || '') + ' · ' + t.apiKeyOk : t.apiKeyNone,
            h('div', undefined, keyControls, manualForm, keyList),
          ),
        )
      }
    }

    /** Mount the account page under Settings, just below the desktop page. */
    function registerAccountSection(ctx) {
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['slots'], (scope) => {
        try {
          var react = require('react')
          var Section = AccountSection(react)
          scope.slots.inject('settings.section', function* () {
            yield scope.slots.register(
              {
                name: 'settings.section',
                id: 'tokens-account',
                order: 110,
                label: () => accountLabels().nav,
                inject: () => ({}),
              },
              Section,
            )
          })
        } catch (error) {
          console.error(`[tokens-login] account section skipped: ${error}`)
        }
      })
    }

    function apply(ctx) {
      var disposeGate = registerLoginGate()
      registerAccountSection(ctx)
      // cordis effect: unregister on plugin disposal (HMR, profile reload).
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => disposeGate(), 'tokens-login: sign-in gate')
      }
    }

    exports.apply = apply
    // Exposed for the repo's tests only; not part of the plugin contract.
    exports.__gate = {
      registerLoginGate: registerLoginGate,
      labels: labels,
      accountLabels: accountLabels,
      AccountSection: AccountSection,
      registerAccountSection: registerAccountSection,
    }
    exports.inject = []
    return module.exports
  },
})
