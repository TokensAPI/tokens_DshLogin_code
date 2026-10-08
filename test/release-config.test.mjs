// Parse the actual workflows, and exercise Registry success and refusal paths.
import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse } from 'yaml'
import { validateRelease } from '../scripts/validate-release.mjs'
import { verifyPackage } from '../scripts/verify-package.mjs'
import { ensureUnpublished, verifyPublished } from '../scripts/registry-release.mjs'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const workflow = parse(readFileSync(new URL('.github/workflows/publish-npm.yml', root), 'utf8'))
const checks = parse(readFileSync(new URL('.github/workflows/checks.yml', root), 'utf8'))
const tag = `v${manifest.version}`
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status })
const metadata = versions => ({ name: manifest.name, versions })

test('manifest pins the private registry as the publish target', () => {
  assert.equal(manifest.name, '@tokensapi/dsh-login')
  assert.equal(manifest.publishConfig.registry, 'https://npm.tokensapi.ai/')
  assert.notEqual(manifest.publishConfig.access, 'public')
})

test('market metadata provides distinct Chinese and English display names and summaries', () => {
  for (const key of ['displayName', 'summary']) {
    const translations = manifest.tokenscowork[key]
    for (const locale of ['zh-CN', 'en-US']) assert.ok(translations[locale].trim())
    assert.notEqual(translations['zh-CN'], translations['en-US'])
  }
})

test('manifest lockfile version and changelog describe the current release', () => {
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'))
  assert.equal(lock.version, manifest.version)
  assert.equal(lock.packages[''].version, manifest.version)
  assert.equal(lock.packages[''].engines.node, manifest.engines.node)
  const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8')
  assert.ok(changelog.split(/\r?\n/u).includes('## ' + manifest.version))
  assert.ok(changelog.includes('/compare/v0.1.4...v0.1.5'))
})

test('validateRelease accepts a tag matching a stable version', () => {
  assert.equal(validateRelease(manifest, tag), manifest.version)
})

test('validateRelease rejects the wrong package registry repository version or tag', () => {
  assert.throws(() => validateRelease({ ...manifest, name: '@other/plugin' }, tag), /package name/u)
  assert.throws(() => validateRelease({ ...manifest, publishConfig: { registry: 'https://registry.npmjs.org/' } }, tag), /private registry/u)
  assert.throws(() => validateRelease({ ...manifest, publishConfig: { ...manifest.publishConfig, access: 'public' } }, tag), /private registry/u)
  assert.throws(() => validateRelease({ ...manifest, publishConfig: undefined }, tag), /private registry/u)
  for (const url of ['https://github.com/other/tokens_DshLogin_code.git', 'https://github.com.evil.test/TokensAPI/tokens_DshLogin_code.git',
    'https://github.com/TokensAPI/tokens_DshLogin_code.git?owner=other']) {
    assert.throws(() => validateRelease({ ...manifest, repository: { url } }, tag), /repository identity/u)
  }
  assert.throws(() => validateRelease({ ...manifest, version: manifest.version + '-beta.1' }, tag + '-beta.1'), /stable/u)
  assert.throws(() => validateRelease(manifest, tag + '-wrong'), /must match/u)
  assert.throws(() => validateRelease(manifest, undefined), /must match/u)
})

test('parsed workflows separate branch checks from tag-only publishing', () => {
  assert.deepEqual(checks.on.push.branches, ['**'])
  assert.ok(Object.hasOwn(checks.on, 'pull_request'))
  assert.deepEqual(workflow.on, { push: { tags: ['v*'] } })
  assert.deepEqual(workflow.jobs.check.strategy.matrix, checks.jobs.check.strategy.matrix)
  assert.deepEqual(checks.jobs.check.strategy.matrix.node, ['22.19.0', 24])
  assert.equal(manifest.engines.node, '^22.19.0 || ^24.0.0')
  assert.equal(workflow.jobs.publish.needs, 'check')
  assert.equal(workflow.jobs.publish.if, "github.repository == 'TokensAPI/tokens_DshLogin_code' && startsWith(github.ref, 'refs/tags/v')")
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
  for (const config of [checks, workflow]) {
    assert.deepEqual(config.permissions, { contents: 'read' })
    for (const job of Object.values(config.jobs)) {
      const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout'))
      assert.equal(checkout.with['persist-credentials'], false)
    }
    const commands = config.jobs.check.steps.map(step => step.run).filter(Boolean)
    assert.ok(commands.some(command => command.startsWith('npm ci --ignore-scripts')))
    assert.ok(commands.includes('npm run check'))
  }
})

test('publication uses the verified artifact private registry and step-scoped secret', () => {
  const steps = workflow.jobs.publish.steps
  const setup = steps.find(step => step.uses?.startsWith('actions/setup-node'))
  assert.equal(setup.with['registry-url'], manifest.publishConfig.registry)
  const authenticated = steps.filter(step => step.env?.NODE_AUTH_TOKEN)
  assert.equal(authenticated.length, 1)
  assert.equal(authenticated[0].env.NODE_AUTH_TOKEN, '${{ secrets.VERDACCIO_PUBLISH_TOKEN }}')
  const command = authenticated[0].run
  assert.ok(command.includes('npm whoami --registry=https://npm.tokensapi.ai/'))
  assert.ok(command.includes('tokenscowork'))
  assert.ok(command.includes('缺少仓库 Secret VERDACCIO_PUBLISH_TOKEN'))
  assert.ok(command.includes('npm publish .release/*.tgz --ignore-scripts --registry=https://npm.tokensapi.ai/ --tag latest'))
  assert.ok(command.indexOf('registry-release.mjs preflight') < command.indexOf('npm publish'))
  assert.ok(command.indexOf('registry-release.mjs verify') > command.indexOf('npm publish'))
  assert.ok(steps.some(step => step.run?.includes('npm pack --ignore-scripts --pack-destination .release')))
})

test('registry preflight permits only a confirmed absent version', async () => {
  await ensureUnpublished(manifest, { fetcher: async () => reply(metadata({})) })
  await assert.rejects(() => ensureUnpublished(manifest, { fetcher: async () => reply(metadata({ [manifest.version]: {} })) }), /already exists/u)
})

test('registry authentication network server and malformed responses stop release', async () => {
  for (const status of [401, 403, 404, 500, 503]) {
    await assert.rejects(() => ensureUnpublished(manifest, { fetcher: async () => reply({}, status) }), /query failed/u)
  }
  await assert.rejects(() => ensureUnpublished(manifest, { fetcher: async () => { throw new Error('offline') } }), /offline/u)
  await assert.rejects(() => ensureUnpublished(manifest, { fetcher: async () => reply({}) }), /invalid package metadata/u)
})

function publishedFixture(bytes) {
  return { ...metadata({ [manifest.version]: {
    name: manifest.name, version: manifest.version, tokenscowork: manifest.tokenscowork,
    dist: { integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      shasum: createHash('sha1').update(bytes).digest('hex'), tarball: 'https://npm.tokensapi.ai/plugin.tgz' },
  } }), 'dist-tags': { latest: manifest.version } }
}

test('published release verifies metadata latest tag and downloaded tarball bytes', async () => {
  const bytes = Buffer.from([0, 255, 128, 42])
  const published = publishedFixture(bytes)
  let calls = 0
  await verifyPublished(manifest, bytes, { fetcher: async () => ++calls === 1 ? reply(published) : new Response(bytes) })
  assert.equal(calls, 2)
})

test('published verification rejects wrong metadata integrity bytes and foreign URLs', async () => {
  const bytes = Buffer.from([0, 255, 128, 42])
  for (const change of [
    data => { data['dist-tags'].latest = 'different' },
    data => { data.versions[manifest.version].tokenscowork = {} },
    data => { data.versions[manifest.version].dist.integrity = 'different' },
    data => { data.versions[manifest.version].dist.tarball = 'https://evil.test/plugin.tgz' },
  ]) {
    const published = publishedFixture(bytes)
    change(published)
    await assert.rejects(() => verifyPublished(manifest, bytes, { fetcher: async () => reply(published) }))
  }
  let calls = 0
  await assert.rejects(() => verifyPublished(manifest, bytes, {
    fetcher: async () => ++calls === 1 ? reply(publishedFixture(bytes)) : new Response('corrupt'),
  }), /bytes differ/u)
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
