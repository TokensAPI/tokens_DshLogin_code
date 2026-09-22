// 发布配置的回归：这条链路平时不跑，一旦写错要等到真发版才暴露，
// 而"发错地方"和"发了个装不起来的包"都是收不回来的，所以在这里钉住。
import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { validateRelease } from '../scripts/validate-release.mjs'
import { verifyPackage } from '../scripts/verify-package.mjs'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const workflow = readFileSync(new URL('.github/workflows/publish-npm.yml', root), 'utf8')

const RELEASE_GATE =
  "(github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')) || (github.event_name == 'workflow_dispatch' && inputs.release_tag != '')"
const REPOSITORY_GUARD = "github.repository == 'TokensAPI/tokens_DshLogin_code'"

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

test('manifest pins the private registry as the publish target', () => {
  assert.equal(manifest.name, '@tokensapi/dsh-login')
  assert.equal(manifest.publishConfig?.registry, 'https://npm.tokensapi.ai/')
  assert.notEqual(manifest.publishConfig?.access, 'public')
})

test('validateRelease accepts a tag matching a stable version', () => {
  assert.equal(validateRelease(manifest, `v${manifest.version}`), manifest.version)
})

test('validateRelease rejects the wrong package, registry, version or tag', () => {
  const ok = { ...manifest, version: '1.2.3' }
  assert.throws(() => validateRelease({ ...ok, name: '@other/plugin' }, 'v1.2.3'), /package name/u)
  assert.throws(
    () => validateRelease({ ...ok, publishConfig: { registry: 'https://registry.npmjs.org/' } }, 'v1.2.3'),
    /private registry/u,
  )
  assert.throws(
    () => validateRelease({ ...ok, publishConfig: { ...ok.publishConfig, access: 'public' } }, 'v1.2.3'),
    /private registry/u,
  )
  assert.throws(() => validateRelease({ ...ok, publishConfig: undefined }, 'v1.2.3'), /private registry/u)
  assert.throws(() => validateRelease({ ...ok, version: '1.2.3-beta.1' }, 'v1.2.3-beta.1'), /stable/u)
  assert.throws(() => validateRelease({ ...ok, version: '01.2.3' }, 'v01.2.3'), /stable/u)
  assert.throws(() => validateRelease(ok, 'v9.9.9'), /must match package\.json/u)
  assert.throws(() => validateRelease(ok, undefined), /must match package\.json/u)
})

test('workflow publishes only to the private registry', () => {
  assert.match(workflow, /PRIVATE_REGISTRY: https:\/\/npm\.tokensapi\.ai\//u)
  assert.match(workflow, /registry-url: https:\/\/npm\.tokensapi\.ai\//u)
  assert.equal(occurrences(workflow, 'registry.npmjs.org'), 1, 'npmjs 只应出现在安装方向')
  assert.match(workflow, /npm ci .*--registry=https:\/\/registry\.npmjs\.org\//u)
})

test('workflow triggers on main, on v* tags, and on manual dispatch with an optional tag', () => {
  assert.match(workflow, /branches:\n\s+- main/u)
  assert.match(workflow, /tags:\n\s+- 'v\*'/u)
  // 默认手动运行只检查：release_tag 必须是可选的。
  assert.match(workflow, /release_tag:\n(?:.*\n)*?\s+required: false/u)
})

test('release-only steps are gated, and publishing is additionally gated on this repository', () => {
  // 校验身份与发布两步走发布闸门；打包与产物校验在 main 上也跑，
  // 这样标签推出去之前就知道产物是好的。
  assert.equal(occurrences(workflow, RELEASE_GATE), 2)
  assert.equal(occurrences(workflow, REPOSITORY_GUARD), 1)
  const publish = workflow.slice(workflow.indexOf('- name: Publish to private registry'))
  assert.ok(publish.includes(REPOSITORY_GUARD), '发布步骤必须带仓库身份闸门')
  assert.ok(publish.includes(RELEASE_GATE), '发布步骤必须带发布闸门')
})

test('workflow refuses to publish without the secret, as the wrong account, or over an existing version', () => {
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.VERDACCIO_PUBLISH_TOKEN \}\}/u)
  assert.match(workflow, /缺少仓库 Secret VERDACCIO_PUBLISH_TOKEN/u)
  assert.match(workflow, /APPROVED_PUBLISHER: tokenscowork/u)
  assert.match(workflow, /npm whoami/u)
  assert.match(workflow, /拒绝覆盖/u)
  // 令牌只能来自 Secret，不能写死在工作流里。
  assert.ok(!/_authToken\s*=/u.test(workflow), '工作流里不得出现令牌字面量')
})

test('the packed artifact carries the plugin and imports cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-login-pack-'))
  try {
    // npm 在 Windows 上是 .cmd，Node 不允许 execFile 直接拉起它，所以走 shell。
    execSync(`npm pack --ignore-scripts --pack-destination "${dir}"`, {
      cwd: fileURLToPath(root),
      stdio: 'ignore',
    })
    const [tarball] = readdirSync(dir).filter((f) => f.endsWith('.tgz')).map((f) => join(dir, f))
    assert.ok(tarball, 'npm pack 应产出 tarball')
    const result = await verifyPackage(tarball)
    assert.equal(result.name, 'tokens-login')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPackage rejects a tarball that is missing the plugin entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-login-bad-'))
  try {
    writeFileSync(join(dir, 'readme.md'), '# not a plugin\n')
    execFileSync('tar', ['-czf', 'broken.tgz', 'readme.md'], { cwd: dir })
    await assert.rejects(() => verifyPackage(join(dir, 'broken.tgz')), /missing package\//u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
