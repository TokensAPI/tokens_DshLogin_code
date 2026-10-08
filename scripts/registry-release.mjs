// Only a successful, coherent Registry response can prove a version absent.
// Never print response bodies here: authentication errors may contain secrets.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { validateRelease } from './validate-release.mjs'

const REGISTRY = 'https://npm.tokensapi.ai/'

async function readMetadata(manifest, fetcher, token) {
  validateRelease(manifest, `v${manifest.version}`)
  const response = await fetcher(new URL(encodeURIComponent(manifest.name), REGISTRY), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`Registry metadata query failed (HTTP ${response.status})`)
  const metadata = await response.json()
  if (metadata.name !== manifest.name || !metadata.versions || typeof metadata.versions !== 'object'
      || Array.isArray(metadata.versions)) throw new Error('Registry returned invalid package metadata')
  return metadata
}

export async function ensureUnpublished(manifest, { fetcher = fetch, token = '' } = {}) {
  const metadata = await readMetadata(manifest, fetcher, token)
  if (Object.hasOwn(metadata.versions, manifest.version)) {
    throw new Error('Accurate version already exists; refusing to overwrite')
  }
}

export async function verifyPublished(manifest, tarball, { fetcher = fetch, token = '' } = {}) {
  const metadata = await readMetadata(manifest, fetcher, token)
  const published = metadata.versions[manifest.version]
  if (!published || published.name !== manifest.name || published.version !== manifest.version
      || metadata['dist-tags']?.latest !== manifest.version
      || !isDeepStrictEqual(published.tokenscowork, manifest.tokenscowork)) {
    throw new Error('Published version, latest tag or metadata does not match')
  }
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  const shasum = createHash('sha1').update(tarball).digest('hex')
  if (published.dist?.integrity !== integrity || published.dist?.shasum !== shasum) {
    throw new Error('Registry tarball integrity does not match the verified artifact')
  }
  const url = new URL(published.dist.tarball)
  // Never forward a publishing token to a Registry-supplied third-party URL.
  if (url.origin !== new URL(REGISTRY).origin || url.username || url.password) {
    throw new Error('Published tarball URL is outside the private Registry')
  }
  const response = await fetcher(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`Published tarball download failed (HTTP ${response.status})`)
  if (!Buffer.from(await response.arrayBuffer()).equals(tarball)) {
    throw new Error('Downloaded tarball bytes differ from the verified artifact')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const options = { token: process.env.NODE_AUTH_TOKEN ?? '' }
  if (process.argv[2] === 'preflight') {
    await ensureUnpublished(manifest, options)
    console.log('Registry confirms this exact version has not been published')
  } else if (process.argv[2] === 'verify') {
    const directory = resolve(process.argv[3] ?? '.release')
    const files = readdirSync(directory).filter(file => file.endsWith('.tgz'))
    if (files.length !== 1) throw new Error('Expected exactly one verified tarball')
    const bytes = readFileSync(join(directory, files[0]))
    for (let attempt = 1; ; attempt++) {
      try {
        await verifyPublished(manifest, bytes, options)
        break
      } catch (error) {
        if (attempt >= 4) throw error
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
    console.log('Published version, latest tag, metadata and tarball bytes verified')
  } else {
    throw new Error('Usage: registry-release.mjs preflight | verify <tarball-directory>')
  }
}
