import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

function client(language = '', browserLanguage = 'en-US') {
  let registration
  const document = { documentElement: { lang: language } }
  runInNewContext(readFileSync(new URL('../dsh/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { registration = value } } },
    document,
    navigator: { language: browserLanguage },
  })
  return { gate: registration.factory(() => { throw new Error('No dependencies needed for labels') }).__gate, document }
}

test('client language tables have matching nonempty translated user-visible labels', () => {
  const { gate, document } = client('zh-CN')
  for (const name of ['labels', 'accountLabels']) {
    const zh = gate[name]()
    document.documentElement.lang = 'en-US'
    const en = gate[name]()
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
    for (const key of Object.keys(zh)) {
      assert.ok(zh[key].trim() && en[key].trim(), key)
      assert.notEqual(zh[key], en[key], key)
    }
    document.documentElement.lang = 'zh-CN'
  }
})

test('client locale chooses application language then browser fallback', () => {
  const { gate, document } = client('zh-CN', 'en-US')
  assert.equal(gate.labels().login, '登录 TokensAPI 账号')
  document.documentElement.lang = 'en-US'
  assert.equal(gate.labels().login, 'Sign in with TokensAPI')
  const fallback = client('', 'zh-TW')
  assert.equal(fallback.gate.accountLabels().nav, '账户管理')
  fallback.document.documentElement.lang = 'fr-FR'
  assert.equal(fallback.gate.accountLabels().nav, 'Account')
})
