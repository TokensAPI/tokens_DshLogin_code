import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const fixture = fileURLToPath(new URL('fixtures/credential-process.mjs', import.meta.url))

function processStep(action, directory) {
  const result = spawnSync(process.execPath, [fixture, action, directory], { encoding: 'utf8', timeout: 15_000 })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return JSON.parse(result.stdout.trim())
}

test('browser account sign-in survives a new process with the real credential provider', () => {
  const directory = mkdtempSync(join(tmpdir(), 'login-real-credentials-'))
  try {
    assert.equal(processStep('sign-in', directory).signedIn, true)
    const restored = processStep('restore', directory)
    assert.equal(restored.signedIn, true)
    assert.equal(restored.authenticated, true)
    assert.equal(restored.user.displayName, 'Test User')
    assert.equal(restored.providerVersion, '0.1.5-rc.2')
    assert.equal(restored.cordisVersion, '4.0.2')
    assert.equal(restored.authorizationMatches, true)
    assert.equal(restored.source, 'file')
    const document = readFileSync(join(directory, '.credentials.yaml'), 'utf8')
    assert.ok(document.includes('TOKENSAPI_ACCESS_TOKEN'))
    assert.equal(processStep('offline', directory).signedIn, true)
    assert.equal(processStep('restore', directory).signedIn, true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('logout persists across a new process while keeping the real stored API key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'login-real-logout-'))
  try {
    processStep('sign-in', directory)
    assert.equal(processStep('logout', directory).signedIn, false)
    const restored = processStep('restore', directory)
    assert.equal(restored.signedIn, false)
    assert.equal(restored.authenticated, true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('manual API key persists but does not become an account session after restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'login-real-manual-'))
  try {
    assert.equal(processStep('manual', directory).authenticated, true)
    const restored = processStep('restore', directory)
    assert.equal(restored.authenticated, true)
    assert.equal(restored.signedIn, false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
