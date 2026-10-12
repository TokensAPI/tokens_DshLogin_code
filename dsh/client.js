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
  id: '@tokensapi/dsh-login',
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
            useApiKey: '改用 API Key 临时登录',
            backToLogin: '返回账号登录',
            apiKeyIntro: '粘贴 TokensAPI 控制台中的 API Key。仅本次启动有效，退出后需重新验证。保持登录请使用账户登录。',
            verify: '验证并继续',
            verifying: '正在验证…',
            checking: '正在检查登录状态…',
            missing: '请输入 API Key',
            keyWarnPrefix: '已登录，但 API Key 配置未完成：',
            sessionExpired: '账户登录已失效，可能是在其他设备重新授权。请重新登录 TokensAPI 账号。',
          }
        : {
            title: 'Sign in to TokensAPI',
            intro: 'Your default browser opens the sign-in page; the API key is set up automatically.',
            login: 'Sign in with TokensAPI',
            waiting: 'Finish signing in in your browser… (click to reopen)',
            useApiKey: 'Use an API key for this session',
            backToLogin: 'Back to account sign-in',
            apiKeyIntro: 'Paste an API key from the TokensAPI console. Sign-in lasts only for this app session; verify again after quitting. Use account sign-in to stay signed in.',
            verify: 'Verify and continue',
            verifying: 'Verifying…',
            checking: 'Checking sign-in status…',
            missing: 'Please enter an API key',
            keyWarnPrefix: 'Signed in, but the API key setup did not finish: ',
            sessionExpired: 'Your account sign-in is no longer valid, possibly after authorization on another device. Please sign in to TokensAPI again.',
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
            refresh: '刷新列表',
            refreshing: '正在刷新…',
            done: '已更新',
            browserUnavailable: '当前版本不支持浏览器登录，请手动填入 API Key。',
            keysLoading: '正在读取账户中的 API Key…',
            keysEmpty: '账户中还没有 API Key。',
            inUse: '当前使用',
            keyDisabled: '已禁用',
            copy: '复制',
            copied: '已复制',
            use: '使用',
            switching: '正在切换…',
            sessionExpired: '账户登录已失效',
            signInAgain: '重新登录',
            sessionExpiredHint: '可能是在其他设备重新授权。查看或切换账户中的 API Key，需要重新登录。',
            keyRetainedHint: '已保存的模型 API Key 未被清除，可以继续尝试使用模型；如果模型请求也提示凭证无效，请重新登录或更换 API Key。',
            signInRequiredHint: '请重新登录以配置模型 API Key。',
            requestFailed: '操作未完成，请重试。',
            upstreamError: '暂时无法读取账户信息，请稍后重试。',
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
            refresh: 'Refresh list',
            refreshing: 'Refreshing…',
            done: 'Updated',
            browserUnavailable: 'This build cannot open a browser sign-in; enter an API key manually.',
            keysLoading: 'Loading the keys on this account…',
            keysEmpty: 'This account has no API keys yet.',
            inUse: 'In use',
            keyDisabled: 'Disabled',
            copy: 'Copy',
            copied: 'Copied',
            use: 'Use',
            switching: 'Switching…',
            sessionExpired: 'Account sign-in is no longer valid',
            signInAgain: 'Sign in again',
            sessionExpiredHint: 'This may happen after authorization on another device. Sign in again to view or switch API keys on your account.',
            keyRetainedHint: 'Your saved model API key has not been removed. You can still try using models; if model requests also reject the credentials, sign in again or replace the API key.',
            signInRequiredHint: 'Sign in again to configure a model API key.',
            requestFailed: 'The action could not be completed. Please retry.',
            upstreamError: 'Account information is temporarily unavailable. Please retry later.',
          }
    }

    /**
     * What each host error code means to the user. The host's own messages
     * are fixed Chinese diagnostics, so no surface shows them: everything the
     * user reads comes from here, in the app's language.
     */
    function errorLabels() {
      return chinese()
        ? {
            unreachable: '无法连接 TokensAPI，请检查网络后重试。',
            upstream: 'TokensAPI 服务暂时不可用，请稍后重试。',
            invalid_key: 'API Key 无效，请检查或更换后重试。',
            session_expired: '账户登录已失效，请重新登录 TokensAPI 账号。',
            browser_unavailable: '当前版本不支持浏览器登录，请改用 API Key。',
            cancelled: '浏览器登录已超时或被取消，请重试。',
            no_api_key: '账户中没有可用的 API Key，请在 TokensAPI 控制台创建后重试。',
            invalid_input: '输入内容无效，请检查后重试。',
            signin_required: '请先登录 TokensAPI 账号。',
            signInFailed: '登录失败，请重试。',
            statusUnavailable: '暂时无法读取登录状态，请重试。',
            verifyFailed: 'API Key 验证未完成，请重试。',
          }
        : {
            unreachable: 'Cannot connect to TokensAPI. Check your connection and retry.',
            upstream: 'TokensAPI is temporarily unavailable. Please retry later.',
            invalid_key: 'The API key is invalid. Check or replace it and retry.',
            session_expired: 'Your account sign-in is no longer valid. Please sign in to TokensAPI again.',
            browser_unavailable: 'This build cannot open a browser sign-in. Use an API key instead.',
            cancelled: 'Browser sign-in timed out or was cancelled. Please retry.',
            no_api_key: 'This account has no usable API key. Create one in the TokensAPI console and retry.',
            invalid_input: 'The input is not valid. Check it and retry.',
            signin_required: 'Please sign in to your TokensAPI account first.',
            signInFailed: 'Sign-in failed. Please retry.',
            statusUnavailable: 'Sign-in status is unavailable right now. Please retry.',
            verifyFailed: 'The API key could not be verified. Please retry.',
          }
    }

    var ERROR_CODES = [
      'unreachable',
      'upstream',
      'invalid_key',
      'session_expired',
      'browser_unavailable',
      'cancelled',
      'no_api_key',
      'invalid_input',
      'signin_required',
    ]

    /**
     * The user-facing text for a host error code, in the app's language. An
     * unknown or missing code gets the caller's localized fallback — never the
     * host's raw message.
     */
    function errorText(code, fallback) {
      var table = errorLabels()
      return ERROR_CODES.indexOf(code) >= 0 ? table[code] : fallback || table.signInFailed
    }

    /** The sidebar account menu; wording follows the upstream menu it replaces. */
    function launcherLabels() {
      return chinese()
        ? {
            menu: '账号菜单',
            more: '更多',
            signedIn: '已登录 TokensAPI',
            settings: '设置',
            signIn: '登录',
            signingIn: '请在浏览器中完成登录…',
            signOut: '退出登录',
            signOutTitle: '退出 TokensAPI 账号',
            signOutFailed: '退出登录未完成，请重试。',
            cancel: '取消',
          }
        : {
            menu: 'Account menu',
            more: 'More',
            signedIn: 'Signed in to TokensAPI',
            settings: 'Settings',
            signIn: 'Sign in',
            signingIn: 'Finish signing in in your browser…',
            signOut: 'Sign out',
            signOutTitle: 'Sign out of TokensAPI',
            signOutFailed: 'Sign-out did not finish. Please retry.',
            cancel: 'Cancel',
          }
    }

    /** Clipboard with the execCommand fallback for non-secure contexts. */
    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).catch(() => copyFallback(text))
      }
      return Promise.resolve(copyFallback(text))
    }
    function copyFallback(text) {
      var area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      try {
        document.execCommand('copy')
      } finally {
        document.body.removeChild(area)
      }
    }

    // What the account page shows, kept across visits: entering the page
    // renders the last answer immediately, then refreshes account status.
    // Actions update the cache; sign-out reloads the window and empties it.
    var accountCache = { status: null, keys: null }

    // The account page and the sidebar launcher show one account: every
    // status either of them receives goes through publishStatus, and each
    // follows the other's sign-in or expiry without a refetch.
    var statusListeners = []

    function publishStatus(status) {
      accountCache.status = status
      statusListeners.slice().forEach((listener) => listener(status))
    }

    function subscribeStatus(listener) {
      statusListeners.push(listener)
      return () => {
        statusListeners = statusListeners.filter((item) => item !== listener)
      }
    }

    function refreshStatus() {
      return fetch(ROUTE, { cache: 'no-store' })
        .then((response) => response.json().then((body) => ({ response: response, body: rememberLocale(body) })))
        .then(({ response, body }) => {
          if (response.ok) publishStatus(body)
        })
        .catch(() => {})
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

      // Messages may be passed as functions: a repaint after the app's
      // language changes then re-reads them in the new language.
      function card(message, errored) {
        if (typeof message === 'function') message = message()
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
        var shell = card(message || (() => labels().intro), Boolean(errored))
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
                if (!response.ok) {
                  renderLogin(
                    body?.code === 'session_expired' ? () => labels().sessionExpired : () => errorText(body?.code),
                    true,
                  )
                  return
                }
                if (settle(body)) return
                renderLogin(
                  body?.apiKeyError
                    ? () => labels().keyWarnPrefix + errorText(body.apiKeyErrorCode, errorLabels().upstream)
                    : '',
                  true,
                )
              })
              // No answer at all: the host route was unreachable.
              .catch(() => renderLogin(() => errorText('unreachable'), true))
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
        var shell = card(message || (() => labels().apiKeyIntro), Boolean(errored))
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
            renderApiKey(() => labels().missing, true)
            return
          }
          input.disabled = true
          submit.disabled = true
          submit.textContent = t.verifying
          postAction({ action: 'setApiKey', apiKey: apiKey })
            .then(({ response, body }) => {
              input.value = ''
              // Submitting a key here is an explicit act of entry, so it opens
              // the gate even without a session. A key merely *found* at boot
              // does not — that is what settle() refuses.
              if (response.ok && body?.authenticated === true) {
                close()
                return
              }
              renderApiKey(() => errorText(body?.code, errorLabels().verifyFailed), true)
            })
            .catch(() => renderApiKey(() => errorText('unreachable'), true))
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
          if (!response.ok) {
            canSignIn = false
            renderApiKey(() => errorText(body?.code, errorLabels().statusUnavailable), true)
            return
          }
          if (settle(body)) return
          canSignIn = body?.canSignIn === true
          if (canSignIn) renderLogin(body?.sessionExpired ? () => labels().sessionExpired : '', body?.sessionExpired === true)
          else renderApiKey('', false)
        })
        .catch(() => {
          canSignIn = false
          renderApiKey(() => errorText('unreachable'), true)
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
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: value ? 6 : 10 } }, title),
          value ? h('div', { style: { color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 12 } }, value) : null,
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
      // Icon-only buttons: the standard two-squares copy glyph, and a check
      // for the moment right after a successful copy.
      var copyGlyph = () =>
        h(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
          h('rect', { x: 9, y: 9, width: 13, height: 13, rx: 2 }),
          h('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }),
        )
      var checkGlyph = () =>
        h(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
          h('path', { d: 'M20 6 9 17l-5-5' }),
        )
      var iconAction = (icon, titleText, onClick, disabled, tone) =>
        h(
          'button',
          {
            type: 'button',
            title: titleText,
            'aria-label': titleText,
            disabled: disabled === true,
            onClick: onClick,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              padding: 0,
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2, #ddd)',
              background: 'transparent',
              color: tone || 'inherit',
              cursor: disabled === true ? 'default' : 'pointer',
              opacity: disabled === true ? 0.55 : 1,
              transition: 'background .12s ease',
            },
          },
          icon,
        )
      return function TokensAccount() {
        var statePair = react.useState(accountCache.status)
        var notePair = react.useState('')
        var erroredPair = react.useState(false)
        var busyPair = react.useState('')
        // The account's keys, loaded once signed in: null while unknown, [] when
        // the account has none. revealed holds only the keys the user asked to
        // see, and hiding one drops it again — nothing is kept around.
        var keysPair = react.useState(accountCache.keys)
        var keysErrorPair = react.useState('')
        var keysLoadingPair = react.useState(false)
        var keysRequest = react.useRef(0)
        var statusRequest = react.useRef(0)
        var copiedPair = react.useState(null)
        // Which row 「使用」 was clicked, so only that button says switching.
        var switchTargetPair = react.useState(null)
        var state = statePair[0]
        var note = notePair[0]
        var busy = busyPair[0]
        var t = accountLabels()

        react.useEffect(() => subscribeStatus((status) => statePair[1](status)), [])

        react.useEffect(() => {
          var alive = true
          var request = ++statusRequest.current
          fetch(ROUTE, { cache: 'no-store' })
            .then((response) => response.json().then((body) => ({ response: response, body: rememberLocale(body) })))
            .then(({ response, body }) => {
              if (!response.ok || !alive || request !== statusRequest.current) return
              publishStatus(body)
            })
            .catch(() => {})
          return () => {
            alive = false
            keysRequest.current++
            statusRequest.current++
          }
        }, [])

        // Two codes read better in this page's own words; the rest share the
        // plugin-wide table, and anything unknown is a generic retry.
        var errorMessage = (code) => {
          if (code === 'session_expired') return t.sessionExpired
          if (code === 'upstream') return t.upstreamError
          return errorText(code, t.requestFailed)
        }
        var acceptFailure = (body) => {
          if ((body?.code === 'session_expired' || body?.code === 'signin_required') && body?.status) {
            statusRequest.current++
            accountCache.keys = null
            publishStatus(body.status)
            keysPair[1](null)
            keysRequest.current++
            keysLoadingPair[1](false)
          }
          return errorMessage(body?.code)
        }

        var loadKeys = () => {
          var request = ++keysRequest.current
          keysErrorPair[1]('')
          keysLoadingPair[1](true)
          postAction({ action: 'listApiKeys' })
            .then(({ response, body }) => {
              if (request !== keysRequest.current) return
              if (!response.ok) {
                acceptFailure(body)
                keysErrorPair[1](body?.code || 'request_failed')
                return
              }
              var keys = Array.isArray(body?.apiKeys) ? body.apiKeys : []
              accountCache.keys = keys
              keysPair[1](keys)
            })
            .catch(() => {
              if (request === keysRequest.current) keysErrorPair[1]('unreachable')
            })
            .finally(() => {
              if (request === keysRequest.current) keysLoadingPair[1](false)
            })
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
                notePair[1](acceptFailure(result))
                return
              }
              statusRequest.current++
              publishStatus(result)
              if (kind === 'login') {
                accountCache.keys = null
                keysPair[1](null)
                keysErrorPair[1]('')
              }
              // Signing out must put the gate back in front of the shell.
              // Reloading is the whole of it: the plugin remounts, the status
              // now says unauthenticated, and the gate blocks fail-closed.
              if (kind === 'logout') {
                globalThis.location?.reload?.()
                return
              }
              if (result?.apiKeyError) {
                erroredPair[1](true)
                notePair[1](labels().keyWarnPrefix + errorText(result.apiKeyErrorCode, errorLabels().upstream))
                return
              }
              notePair[1](t.done)
              // Which key is in use may have just changed. After a sign-in the
              // list loads on its own, when signedIn flips.
              if (kind !== 'login' || state?.signedIn === true) loadKeys()
            })
            .catch(() => {
              busyPair[1]('')
              erroredPair[1](true)
              notePair[1](errorText('unreachable'))
            })
        }

        var signedIn = state?.signedIn === true
        // The list belongs to the account, so it is only worth asking for once
        // there is a session, and worth asking for again whenever one appears.
        react.useEffect(() => {
          // An empty list is worth asking about again: the account may have
          // been filled since, and a cached [] would hide it until 「刷新列表」.
          if (signedIn && (keysPair[0] === null || keysPair[0].length === 0)) loadKeys()
          else if (!signedIn) {
            keysRequest.current++
            keysPair[1](null)
            accountCache.keys = null
            keysLoadingPair[1](false)
          }
        }, [signedIn])

        var authenticated = state?.authenticated === true
        // The switching label belongs to one row; once the action settles
        // (either way), every 「使用」 button goes back to rest.
        react.useEffect(() => {
          if (busy === '') switchTargetPair[1](null)
        }, [busy])

        // 「已复制」 flips the one button that was clicked, then flips back.
        var markCopied = (which) => {
          copiedPair[1](which)
          setTimeout(() => copiedPair[1]((current) => (current === which ? null : current)), 1500)
        }
        var copyKey = (which, text) => {
          copyText(text).then(
            () => markCopied(which),
            () => keysErrorPair[1]('request_failed'),
          )
        }
        // Copy a listed key: fetched for this copy alone, never shown.
        var copyRow = (item) => {
          postAction({ action: 'revealApiKey', id: item.id })
            .then(({ response, body }) => {
              if (!response.ok) {
                acceptFailure(body)
                keysErrorPair[1](body?.code || 'request_failed')
                return
              }
              copyKey(item.id, String(body?.apiKey || ''))
            })
            .catch(() => keysErrorPair[1]('unreachable'))
        }

        var who = state?.user?.displayName || state?.user?.username || ''
        var accountValue = signedIn ? (who ? t.signedIn + ' · ' + who : t.signedIn) : state?.sessionExpired ? t.sessionExpired : t.signedOut
        // The same single door as the gate.
        var accountControls = signedIn
          ? action(t.signOut, () => run('logout', { action: 'logout' }), busy !== '')
          : state?.canSignIn !== true
            ? h('div', { style: { color: 'var(--dsw-alias-label-secondary, #666)' } }, t.browserUnavailable)
            : action(busy === 'login' ? t.signingIn : state?.sessionExpired ? t.signInAgain : t.signIn, () => run('login', { action: 'login', locale: chinese() ? 'zh' : 'en' }), busy !== '', true)

        var muted = 'var(--dsw-alias-label-secondary, #666)'
        var keyRow = (item) => {
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
              item.masked,
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' } },
              // Two fixed columns, so the controls line up down the list; the
              // in-use row simply leaves its 「使用」 cell empty.
              copiedPair[0] === item.id
                ? iconAction(checkGlyph(), t.copied, () => {}, false, 'var(--dsw-alias-state-success-primary, #16a34a)')
                : iconAction(copyGlyph(), t.copy, () => copyRow(item), busy !== ''),
              h(
                'div',
                { style: { minWidth: 64, display: 'flex', justifyContent: 'flex-end' } },
                item.enabled && !item.inUse
                  ? action(
                      busy === 'useApiKey' && switchTargetPair[0] === item.id ? t.switching : t.use,
                      () => {
                        switchTargetPair[1](item.id)
                        run('useApiKey', { action: 'useApiKey', id: item.id })
                      },
                      busy !== '',
                    )
                  : null,
              ),
            ),
          )
        }

        var keyList = !signedIn
          ? null
          : h(
              'div',
              { style: { marginTop: 16 } },
              keysErrorPair[0]
                ? h('div', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary, #b91c1c)' } }, errorMessage(keysErrorPair[0]))
                : null,
              keysLoadingPair[0]
                ? h('div', { style: { color: muted } }, t.keysLoading)
                : keysPair[0] === null
                  ? null
                  : keysPair[0].length === 0
                    ? h('div', { style: { color: muted } }, t.keysEmpty)
                    : keysPair[0].map(keyRow),
            )

        // Below the list: the one remaining account-wide action.
        var refreshBar = signedIn
          ? h(
              'div',
              { style: { marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--dsw-alias-border-l2, #eee)' } },
              action(
                keysLoadingPair[0] ? t.refreshing : t.refresh,
                () => {
                  // A list refresh and nothing else: the key in use is not
                  // touched — switching keys is what 「使用」 is for.
                  keysPair[1](null)
                  accountCache.keys = null
                  loadKeys()
                },
                busy !== '' || keysLoadingPair[0],
              ),
            )
          : null

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
          state?.sessionExpired
            ? h('div', { role: 'alert', style: { marginBottom: 16, lineHeight: 1.6 } },
                h('div', undefined, t.sessionExpiredHint),
                h('div', undefined, authenticated ? t.keyRetainedHint : t.signInRequiredHint))
            : null,
          row(t.account, accountValue, accountControls, signedIn ? t.signOutHint : ''),
          row(
            t.apiKey,
            signedIn ? null : authenticated ? (state?.apiKeyMasked || '') + ' · ' + t.apiKeyOk : t.apiKeyNone,
            h('div', undefined, keyList, refreshBar),
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

    // The sidebar-foot account menu. `settings.launcher` is a single slot whose
    // lowest priority renders; the upstream DeepSeek menu sits at the default
    // 0, so registering below it replaces that menu without touching its
    // package.
    var LAUNCHER_SLOT = 'settings.launcher'
    var LAUNCHER_PRIORITY = -10

    // Markup and styles copied from the host's Menu, MenuSurface, Modal and
    // Button primitives and the upstream account menu, under our own class
    // prefix: a plain-JS plugin must not load host UI packages as modules, so
    // the --dsw-alias-* tokens are the only thing shared with the host.
    var LAUNCHER_CSS = [
      '.tkl-root{flex:1;min-width:0;position:relative}',
      '.tkl-trigger{user-select:none;box-sizing:border-box;border-radius:var(--dsw-radius-md);width:100%;height:44px;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;cursor:pointer;background:0 0;border:0;align-items:center;gap:8px;padding:6px;display:flex}',
      '.tkl-trigger[data-collapsed=true]{justify-content:center;gap:0;width:36px;height:36px;padding:0}',
      '.tkl-trigger[data-signed-out=true]:not([data-collapsed=true]){height:32px;padding:6px 2px 6px 6px;line-height:20px}',
      '.tkl-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.tkl-avatar{background:var(--dsw-alias-bg-skeleton);width:24px;height:24px;color:var(--dsw-alias-label-tertiary);border-radius:50%;flex:none;justify-content:center;align-items:center;display:flex;font-size:12px;font-weight:600;line-height:1}',
      '.tkl-label{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.tkl-list{box-sizing:border-box;position:fixed;z-index:1100;display:flex;flex-direction:column;padding:4px;min-width:144px;max-width:360px;border:0;border-radius:var(--dsw-radius-lg);isolation:isolate;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent)}',
      '.tkl-list[data-inline=true]{position:absolute;left:0;bottom:calc(100% + 4px);z-index:100}',
      '.tkl-list[data-signed-out=true]{min-width:124px;max-width:280px}',
      '.tkl-material{position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--dsw-menu-surface-fill);backdrop-filter:var(--dsw-menu-backdrop-filter);pointer-events:none}',
      '.tkl-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left}',
      '.tkl-list[data-signed-out=true] .tkl-item{gap:8px;min-height:40px;padding:8px 10px;font-size:14px;line-height:22px}',
      '.tkl-item:hover:not(:disabled),.tkl-item:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}',
      '.tkl-item:disabled{opacity:.4;cursor:not-allowed}',
      '.tkl-icon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-menu-icon)}',
      '.tkl-icon svg{width:14px;height:14px}',
      '.tkl-list[data-signed-out=true] .tkl-icon,.tkl-list[data-signed-out=true] .tkl-icon svg{width:16px;height:16px}',
      '.tkl-itemLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tkl-keys{flex:none;margin-inline-start:auto;display:inline-flex;align-items:center;gap:3px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;white-space:nowrap}',
      '.tkl-modal{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}',
      '.tkl-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;backdrop-filter:var(--dsw-mask-blur);background:var(--dsw-alias-bg-mask-1)}',
      '.tkl-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(380px,100%);padding:0 0 24px;overflow:hidden;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}',
      '.tkl-dialog:focus{outline:none}',
      '.tkl-title{margin:0;padding:22px 24px 0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.tkl-description{margin:0;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.tkl-description[role=alert]{color:var(--dsw-alias-state-error-primary)}',
      '.tkl-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}',
      '.tkl-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);font:inherit;font-size:14px;line-height:22px;cursor:pointer;color:var(--dsw-alias-label-primary);background:transparent}',
      '.tkl-button:disabled{cursor:not-allowed;opacity:.4}',
      '.tkl-outline{border:.5px solid var(--dsw-alias-border-l3)}',
      '.tkl-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.tkl-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.tkl-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.tkl-toast{position:fixed;top:40px;left:50%;z-index:1100;pointer-events:none;width:max-content;max-width:min(640px,calc(100vw - 48px));padding:12px 16px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);font-size:14px;line-height:22px;box-shadow:var(--dsw-shadow-lv3);transform:translateX(-50%);animation:tkl-toast-in 160ms ease-out,tkl-toast-fade 1000ms ease 3000ms forwards}',
      '@keyframes tkl-toast-in{from{opacity:0;transform:translate(-50%,-4px)}to{opacity:1;transform:translateX(-50%)}}',
      '@keyframes tkl-toast-fade{to{opacity:0}}',
    ].join('\n')

    /**
     * The launcher component. `reactDom` portals the list and the dialog to
     * document.body, as the upstream menu does, so the sidebar's overflow
     * cannot crop them; without it both render in place.
     */
    function AccountLauncher(react, reactDom) {
      var h = react.createElement
      var useLayout = react.useLayoutEffect || react.useEffect
      var portal = (node) => (reactDom && typeof reactDom.createPortal === 'function' && document.body ? reactDom.createPortal(node, document.body) : node)
      var svg = (size, children) =>
        h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, strokeWidth: 1.3 }, children)
      var icons = {
        settings: () =>
          svg(16, [
            h('path', { key: 'a', stroke: 'currentColor', d: 'M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z' }),
            h('path', {
              key: 'b',
              stroke: 'currentColor',
              strokeMiterlimit: 10,
              d: 'M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z',
            }),
          ]),
        user: () =>
          svg(16, [
            h('path', { key: 'a', stroke: 'currentColor', d: 'M8 8.25C9.51878 8.25 10.75 7.01878 10.75 5.5C10.75 3.98122 9.51878 2.75 8 2.75C6.48122 2.75 5.25 3.98122 5.25 5.5C5.25 7.01878 6.48122 8.25 8 8.25Z' }),
            h('path', { key: 'b', stroke: 'currentColor', d: 'M2.5 14.5C2.5 11.5 5.25 10.25 8 10.25C10.75 10.25 13.5 11.5 13.5 14.5' }),
          ]),
        more: () =>
          svg(14, [
            h('path', { key: 'a', fill: 'currentColor', d: 'M3 9C3.55228 9 4 8.55228 4 8C4 7.44772 3.55228 7 3 7C2.44772 7 2 7.44772 2 8C2 8.55228 2.44772 9 3 9Z' }),
            h('path', { key: 'b', fill: 'currentColor', d: 'M8 9C8.55228 9 9 8.55228 9 8C9 7.44772 8.55228 7 8 7C7.44772 7 7 7.44772 7 8C7 8.55228 7.44772 9 8 9Z' }),
            h('path', { key: 'c', fill: 'currentColor', d: 'M13 9C13.5523 9 14 8.55228 14 8C14 7.44772 13.5523 7 13 7C12.4477 7 12 7.44772 12 8C12 8.55228 12.4477 9 13 9Z' }),
          ]),
        signOut: () =>
          h(
            'svg',
            { width: 16, height: 16, viewBox: '-1.168 -1.214 16 16', fill: 'none', 'aria-hidden': true },
            h('path', { fill: 'currentColor', d: 'M3.9961 1.40039C3.37842 1.40039 2.96028 1.40039 2.63867 1.42871C2.32631 1.45627 2.17171 1.50666 2.06641 1.56543C1.85606 1.68288 1.68189 1.85605 1.56446 2.06641C1.50569 2.17173 1.45625 2.32627 1.42871 2.63867C1.40036 2.9603 1.39942 3.37827 1.39942 3.9961L1.39942 9.5752C1.39942 10.193 1.40036 10.611 1.42871 10.9326C1.45625 11.245 1.50569 11.3996 1.56445 11.5049C1.68188 11.7153 1.85605 11.8884 2.06641 12.0059C2.17171 12.0646 2.32631 12.115 2.63867 12.1426C2.96028 12.1709 3.37842 12.1709 3.9961 12.1709V13.5713C3.4033 13.5713 2.91297 13.5721 2.51563 13.5371C2.10906 13.5013 1.73277 13.4233 1.38379 13.2285C0.946838 12.9845 0.585697 12.6235 0.341799 12.1865C0.14725 11.8377 0.0700118 11.4621 0.0341815 11.0557C-0.000847399 10.6583 1.58129e-06 10.1681 1.85029e-06 9.5752L2.09416e-06 3.9961C1.83027e-06 3.40325 -0.000846367 2.91297 0.0341818 2.51563C0.0700164 2.10924 0.147239 1.73362 0.341799 1.38477C0.585703 0.947758 0.946825 0.586744 1.38379 0.342775C1.73277 0.148001 2.10906 0.0700381 2.51563 0.0341813C2.91297 -0.000823893 3.40331 1.37805e-06 3.9961 1.71712e-06L3.9961 1.40039Z' }),
            h('path', { fill: 'currentColor', d: 'M13.6426 6.51953C13.6705 6.6957 13.6705 6.8756 13.6426 7.05176C13.5902 7.38188 13.4302 7.64112 13.2539 7.86035C13.0857 8.06937 12.8546 8.29971 12.6006 8.55371L9.3086 11.8447L8.31836 10.8545L11.6104 7.56348C11.637 7.53681 11.6628 7.51104 11.6875 7.48633H3.74317V6.08594H11.6885C11.6635 6.06088 11.6374 6.03487 11.6104 6.00781L8.31836 2.7168L9.3086 1.72656L12.6006 5.01758C12.8547 5.27169 13.0857 5.50185 13.2539 5.71094C13.4303 5.93018 13.5902 6.18939 13.6426 6.51953Z' }),
          ),
      }

      return function TokensAccountLauncher(props) {
        var statePair = react.useState(accountCache.status)
        var openPair = react.useState(false)
        var confirmPair = react.useState(false)
        var busyPair = react.useState('')
        var failedPair = react.useState(false)
        var placePair = react.useState(null)
        // A failed menu sign-in, announced like the host's Toast: localized
        // from the host's error code, gone after the same 3s hold + 1s fade.
        var noticePair = react.useState('')
        var rootRef = react.useRef(null)
        var listRef = react.useRef(null)
        var triggerRef = react.useRef(null)
        var cancelRef = react.useRef(null)
        var settingsWasOpen = react.useRef(false)
        var state = statePair[0]
        var open = openPair[0]
        var confirming = confirmPair[0]
        var busy = busyPair[0]
        var wide = props.wide !== false
        var t = launcherLabels()

        react.useEffect(() => subscribeStatus((status) => statePair[1](status)), [])
        react.useEffect(() => {
          if (accountCache.status === null) refreshStatus()
        }, [])
        // Entering Settings re-asks the console, as the upstream menu does: the
        // account page is where a stale session would otherwise go unnoticed.
        react.useEffect(() => {
          if (props.settingsOpen === true && !settingsWasOpen.current) refreshStatus()
          settingsWasOpen.current = props.settingsOpen === true
        }, [props.settingsOpen])

        var close = () => openPair[1](false)
        var focusTrigger = () => triggerRef.current?.focus?.()

        // Above the trigger, clamped into the viewport like the host Menu.
        useLayout(() => {
          if (!open || !reactDom) {
            placePair[1](null)
            return
          }
          var anchor = rootRef.current?.getBoundingClientRect?.()
          var list = listRef.current
          if (!anchor || !list) return
          var margin = 12
          var left = Math.min(Math.max(anchor.left, margin), Math.max(margin, globalThis.innerWidth - list.offsetWidth - margin))
          var top = Math.max(margin, anchor.top - list.offsetHeight - 4)
          placePair[1]({ left: left, top: top })
        }, [open])

        // Outside press and Escape close; the arrow keys walk the rows. The
        // first row takes focus on open, and Escape hands it back to the
        // trigger.
        react.useEffect(() => {
          if (!open || typeof document.addEventListener !== 'function') return
          var rows = () => Array.from(listRef.current?.querySelectorAll?.('button:not(:disabled)') || [])
          rows()[0]?.focus?.()
          var onPointerDown = (event) => {
            if (rootRef.current?.contains?.(event.target) || listRef.current?.contains?.(event.target)) return
            close()
          }
          var onKeyDown = (event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              close()
              focusTrigger()
              return
            }
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(event.key) < 0) return
            var focused = document.activeElement
            if (!rootRef.current?.contains?.(focused) && !listRef.current?.contains?.(focused)) return
            var buttons = rows()
            if (buttons.length === 0) return
            var index = buttons.indexOf(document.activeElement)
            var next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : index < 0 ? 0 : -1) + buttons.length) % buttons.length
            event.preventDefault()
            buttons[next].focus()
          }
          document.addEventListener('pointerdown', onPointerDown)
          document.addEventListener('keydown', onKeyDown, true)
          return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown, true)
          }
        }, [open])

        react.useEffect(() => {
          if (noticePair[0] === '') return
          var timer = setTimeout(() => noticePair[1](''), 4000)
          return () => clearTimeout(timer)
        }, [noticePair[0]])

        react.useEffect(() => {
          if (!confirming || typeof document.addEventListener !== 'function') return
          cancelRef.current?.focus?.()
          var onKeyDown = (event) => {
            if (event.key !== 'Escape' || busyPair[0] === 'logout') return
            event.preventDefault()
            confirmPair[1](false)
          }
          document.addEventListener('keydown', onKeyDown, true)
          return () => document.removeEventListener('keydown', onKeyDown, true)
        }, [confirming])

        var signedIn = state?.signedIn === true
        var who = state?.user?.displayName || state?.user?.username || ''

        // The same door as the gate and the account page: the user's own
        // browser. A repeat click while waiting re-opens the same page.
        var signIn = () => {
          if (state?.canSignIn === false) {
            // No browser hand-off in this build; the account page says so and
            // offers the manual key instead.
            props.openSettings?.()
            return
          }
          busyPair[1]('login')
          noticePair[1]('')
          postAction({ action: 'login', locale: chinese() ? 'zh' : 'en' })
            .then(({ response, body }) => {
              if (response.ok) {
                publishStatus(body)
                if (body?.apiKeyError) noticePair[1](labels().keyWarnPrefix + errorText(body.apiKeyErrorCode, errorLabels().upstream))
                return
              }
              if (body?.status) publishStatus(body.status)
              noticePair[1](errorText(body?.code))
            })
            .catch(() => noticePair[1](errorText('unreachable')))
            .finally(() => busyPair[1](''))
        }

        // Sign-out is the account page's own: end the session, keep the key,
        // and reload so the gate stands in front of the shell again.
        var signOut = () => {
          busyPair[1]('logout')
          failedPair[1](false)
          postAction({ action: 'logout' })
            .then(({ response, body }) => {
              if (!response.ok) throw new Error(body?.error || 'logout failed')
              publishStatus(body)
              globalThis.location?.reload?.()
            })
            .catch(() => {
              busyPair[1]('')
              failedPair[1](true)
            })
        }

        var select = (id) => {
          close()
          if (id === 'settings') {
            focusTrigger()
            props.openSettings?.()
          } else if (id === 'signin') signIn()
          else if (id === 'signout') {
            failedPair[1](false)
            confirmPair[1](true)
          }
        }

        var items = [{ id: 'settings', label: t.settings, icon: icons.settings(), shortcut: props.settingsShortcut }].concat(
          signedIn
            ? [{ id: 'signout', label: t.signOut, icon: icons.signOut(), disabled: busy !== '' }]
            : [{ id: 'signin', label: busy === 'login' ? t.signingIn : t.signIn, icon: icons.user() }],
        )

        var row = (item) =>
          h(
            'button',
            {
              key: item.id,
              type: 'button',
              role: 'menuitem',
              className: 'tkl-item',
              disabled: item.disabled === true,
              'aria-keyshortcuts': item.shortcut?.aria,
              onClick: () => select(item.id),
            },
            h('span', { className: 'tkl-icon' }, item.icon),
            h('span', { className: 'tkl-itemLabel' }, item.label),
            item.shortcut?.keys?.length
              ? h(
                  'span',
                  { className: 'tkl-keys', 'aria-hidden': true },
                  item.shortcut.keys.map((key, index) => h('span', { key: index }, key)),
                )
              : null,
          )

        var list = open
          ? portal(
              h(
                'div',
                {
                  ref: listRef,
                  role: 'menu',
                  className: 'tkl-list',
                  'data-inline': reactDom ? undefined : true,
                  'data-signed-out': signedIn ? undefined : true,
                  style: reactDom ? placePair[0] || { visibility: 'hidden', left: 0, top: 0 } : undefined,
                },
                h('div', { className: 'tkl-material', 'aria-hidden': true }),
                items.map(row),
              ),
            )
          : null

        var dialog = confirming
          ? portal(
              h(
                'div',
                { className: 'tkl-modal' },
                h('div', { className: 'tkl-mask', onClick: () => busy === 'logout' || confirmPair[1](false) }),
                h(
                  'div',
                  { role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'tkl-signout-title', className: 'tkl-dialog', tabIndex: -1 },
                  h('h2', { id: 'tkl-signout-title', className: 'tkl-title' }, t.signOutTitle),
                  h('p', { className: 'tkl-description' }, accountLabels().signOutHint),
                  failedPair[0] ? h('p', { className: 'tkl-description', role: 'alert' }, t.signOutFailed) : null,
                  h(
                    'div',
                    { className: 'tkl-actions' },
                    h(
                      'button',
                      { ref: cancelRef, type: 'button', className: 'tkl-button tkl-outline', disabled: busy === 'logout', onClick: () => confirmPair[1](false) },
                      t.cancel,
                    ),
                    h('button', { type: 'button', className: 'tkl-button tkl-primary', disabled: busy === 'logout', onClick: signOut }, t.signOut),
                  ),
                ),
              ),
            )
          : null

        var label = signedIn ? who || t.signedIn : t.more
        var avatar = signedIn
          ? h('span', { className: 'tkl-avatar' }, who ? Array.from(who)[0].toUpperCase() : icons.user())
          : icons.more()

        return h(
          'div',
          { ref: rootRef, className: 'tkl-root' },
          h('style', null, LAUNCHER_CSS),
          h(
            'button',
            {
              ref: triggerRef,
              type: 'button',
              className: 'tkl-trigger',
              'data-collapsed': !wide,
              'data-signed-out': !signedIn,
              'aria-label': t.menu,
              'aria-haspopup': 'menu',
              'aria-expanded': open,
              title: wide ? undefined : label,
              onClick: () => openPair[1]((value) => !value),
            },
            avatar,
            wide ? h('span', { className: 'tkl-label' }, label) : null,
          ),
          list,
          dialog,
          noticePair[0] ? portal(h('div', { role: 'alert', className: 'tkl-toast' }, noticePair[0])) : null,
        )
      }
    }

    /** Replace the upstream sidebar account menu with the TokensAPI one. */
    function registerAccountLauncher(ctx) {
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['slots'], (scope) => {
        try {
          var react = require('react')
          var reactDom = null
          try {
            reactDom = require('react-dom')
          } catch {
            // In-place rendering still works; only overflow cropping is at risk.
          }
          var Launcher = AccountLauncher(react, reactDom)
          scope.slots.inject(LAUNCHER_SLOT, () =>
            scope.slots.register({ name: LAUNCHER_SLOT, priority: LAUNCHER_PRIORITY }, Launcher),
          )
        } catch (error) {
          console.error(`[tokens-login] account launcher skipped: ${error}`)
        }
      })
    }

    function apply(ctx) {
      var disposeGate = registerLoginGate()
      registerAccountSection(ctx)
      registerAccountLauncher(ctx)
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
      launcherLabels: launcherLabels,
      errorLabels: errorLabels,
      errorText: errorText,
      ERROR_CODES: ERROR_CODES,
      AccountLauncher: AccountLauncher,
      registerAccountLauncher: registerAccountLauncher,
      LAUNCHER_SLOT: LAUNCHER_SLOT,
      LAUNCHER_PRIORITY: LAUNCHER_PRIORITY,
    }
    exports.inject = []
    return module.exports
  },
})
