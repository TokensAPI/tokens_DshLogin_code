// 发布产物校验：npm pack 出来的 tarball 就是用户装到机器上的东西，所以这里
// 解包它本身，而不是看仓库里的源码 —— files 配错、入口漏打包这类问题只有
// 在产物上才看得见。
//
// 本包没有构建步骤：dsh/*.js 即产物，"可运行"就等于"能被 import 起来"。
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED = [
  'package/package.json',
  'package/cordis.patch.yml',
  'package/dsh/index.js',
  'package/dsh/client.js',
];

// Git Bash 的 GNU tar 会把 `C:\...` 当成 `host:path`，所以一律
// 在 tarball 所在目录里用相对文件名调用。
function tar(args, cwd) {
  return execFileSync('tar', args, { cwd, encoding: 'utf8' });
}

export async function verifyPackage(tarball) {
  const dir = dirname(tarball);
  const file = basename(tarball);
  const listing = tar(['-tzf', file], dir)
    .split('\n')
    .map((line) => line.trim().replace(/^\.\//u, ''))
    .filter(Boolean);
  for (const entry of REQUIRED) {
    if (!listing.includes(entry)) throw new Error(`Packed release is missing ${entry}`);
  }
  // 凭据绝不能混进产物。
  const leaked = listing.filter((entry) => /(^|\/)\.npmrc$|(^|\/)\.env/u.test(entry));
  if (leaked.length) throw new Error(`Packed release contains credentials: ${leaked.join(', ')}`);

  rmSync(join(dir, 'package'), { recursive: true, force: true });
  tar(['-xzf', file], dir);
  const module = await import(pathToFileURL(join(dir, 'package', 'dsh', 'index.js')).href);
  for (const exported of ['name', 'apply', 'TOKENS_LOGIN']) {
    if (module[exported] === undefined) throw new Error(`Packed entry does not export ${exported}`);
  }
  // 下游插件靠这个引用名读 key，改名等于悄悄断掉它们。
  if (module.TOKENS_LOGIN.apiKeyRef !== 'TOKENSAPI_API_KEY') {
    throw new Error('Packed entry no longer writes the shared credential reference');
  }
  return { name: module.name, files: listing.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = resolve(process.argv[2] ?? '.release');
  const [tarball] = readdirSync(dir).filter((f) => f.endsWith('.tgz')).map((f) => join(dir, f));
  if (!tarball) throw new Error(`No packed release found in ${dir}`);
  const result = await verifyPackage(tarball);
  console.log(`Verified ${result.name} release artifact (${result.files} entries)`);
}
