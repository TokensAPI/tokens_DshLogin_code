# 发布到私有 npm

本插件发布到自建的 Verdaccio：`https://npm.tokensapi.ai/`，包名 `@tokensapi/dsh-login`。

**不要发到公共 npmjs。** `package.json` 的 `publishConfig.registry` 已经钉死私有源，
CI 还会再校验一次——因为公共源上发出去的版本收不回来。

## 谁在跑什么

| 工作流 | 触发 | 做什么 |
| --- | --- | --- |
| `ci.yml` | 任意 push / PR | Node 22.19.0 与 24 两个版本跑 `npm run check` |
| `publish-npm.yml` | push `main` | 打包并解包验证产物，确认这个包发出去是能用的 |
| `publish-npm.yml` | push `v*` 标签 | 上面那些 + 校验标签与版本一致 + 发布 |
| `publish-npm.yml` | 手动运行 | 默认只检查；填了 `release_tag` 才发布 |

push `main` 这条跑的不是重复检查：它比 `ci.yml` 多做 `npm pack` 和产物校验，
所以在你打标签之前，"`files` 配漏了"或"入口 import 不起来"这类问题就已经暴露了。

## 一次性准备

1. **配置发布凭据。** 在仓库 Settings → Secrets and variables → Actions 添加
   `VERDACCIO_PUBLISH_TOKEN`，值是 `tokenscowork` 账号在私有源上的发布令牌
   （本机登录过的话，它在 `~/.npmrc` 的 `//npm.tokensapi.ai/:_authToken=` 那一行）。

   令牌只能放在 Secret 里。**不要**写进工作流、脚本、日志或提交记录。
   缺这个 Secret 时 CI 会直接报错说明，不会静默跳过发布。

   **令牌会过期。** Verdaccio 发的是 JWT，有效期 60 天；当前这枚签发于 2026-09-18，
   2026-11-17 到期。过期后发布会停在 `npm whoami` 那一步（报的是账号不符或鉴权失败，
   不是"包有问题"）。重新登录再把新值覆盖进同名 Secret 即可：

   ```sh
   npm login --registry=https://npm.tokensapi.ai/   # 用 tokenscowork 账号
   # 从 ~/.npmrc 的 //npm.tokensapi.ai/:_authToken= 取值，经管道灌进 Secret，别回显
   gh secret set VERDACCIO_PUBLISH_TOKEN --repo TokensAPI/tokens_DshLogin_code
   ```

2. **如果这是个 fork：确认 Actions 真的启用了。** 登录后打开仓库的 Actions 页面，
   如果出现 `I understand my workflows, go ahead and enable them` 就点掉它。
   只看 API 返回的 `active` 状态不算数——API 会在人工确认之前就把工作流报成 active，
   而实际推送不会触发任何运行。确认方式是真推一次看有没有产生 run。

## 发一个版本

```sh
# 1. 改版本号与 CHANGELOG，提交到 main
npm version 0.1.2 --no-git-tag-version
# 2. 本地先自查一遍（CI 跑的就是这些）
npm run check
node scripts/validate-release.mjs v0.1.2
# 3. 提交、推 main，等 push 那次运行绿掉
# 4. 打标签并推送，发布就会自动跑
git tag v0.1.2
git push origin v0.1.2
```

标签名必须是 `v` + `package.json` 里的版本号，且只能是稳定版（`x.y.z`，不带预发布后缀）。
对不上时 CI 在装依赖之前就会停。

## 发布前 CI 会挡下的情况

- 标签与 `package.json` 版本对不上；
- 版本不是稳定版（预发布版本会占用 `latest`，需要另行指定 dist-tag，这里不支持）；
- `publishConfig` 缺失或指向 npmjs；
- 打出来的包缺 `dsh/index.js`、`dsh/client.js`、`cordis.patch.yml`，或解包后 import 不起来；
- 包里混进了 `.npmrc` / `.env`；
- 缺 `VERDACCIO_PUBLISH_TOKEN`；
- 令牌对应的账号不是 `tokenscowork`；
- 这个版本号在私有源上已经存在（**拒绝覆盖**，请改用新版本号）。

## 重试

发布那一步挂了（网络、令牌过期等），改完之后不用重新打标签：

```sh
gh workflow run publish-npm.yml --ref main -f release_tag=v0.1.2
```

它会检出 `v0.1.2` 这个标签本身、重跑全部检查、再发布。
不填 `release_tag` 就只检查不发布。

注意"拒绝覆盖"是有意的：如果发布已经成功了一半（包已进 registry），
重试会被这条挡住，此时应该发新版本号，而不是想办法覆盖。

## 发完之后

市场条目 `tokens-dsh-login` 用的是 live catalog，版本号由市场服务端向 Registry 实时解析，
所以发布之后**不需要**去后台改条目版本。验证一下就行：

```sh
curl -s https://market.tokensapi.ai/registry/by-package/@tokensapi/dsh-login | \
  python -c "import json,sys; print(json.load(sys.stdin)['dist-tags'])"
```
