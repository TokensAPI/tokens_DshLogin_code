# TokensAPI 账户登录插件

通过系统浏览器登录 TokensAPI（new-api）账号，自动配置 API Key，供 TokensCowork 模型插件共用。

[English](docs/README.en-US.md) · [发布说明](docs/publishing.md)

## 使用与宿主要求

当前 TokensCowork 产品将本插件作为内置组件打包；是否内置、启用及版本以产品清单为准，独立 npm 发布不会自动更新桌面产品。包名为 `@tokensapi/dsh-login`，发布源为 `https://npm.tokensapi.ai/`。

需要宿主提供 `credentials`、`webServer` 和 `desktopRuntime.openExternal`。支持 Node 22（至少 22.19.0）与 Node 24。缺少浏览器桥时门禁退回手动 API Key。仅在支持可选安装且未内置此包的宿主中，通过其插件管理器安装；无需自行执行安装脚本。

## 登录与重启

1. 点击“登录 TokensAPI 账号”，在系统浏览器完成站点登录并确认授权。
2. 站点通过一次性 `127.0.0.1` 回调交回 access token 和用户 ID，插件调用宿主凭证服务保存。
3. 查询账号的 Key 列表，复用可用 Key；没有时默认创建一把 `TokensCowork`，取明文并验证后保存。

账号登录没有插件自设的固定有效期。正常重启会读取已保存会话，并通过 `/api/user/self` 验证；暂时断网保留会话，明确拒绝才清除。站点重新签发 access token 会使旧值失效，包括在另一设备重新授权。

“改用 API Key 临时登录”仅在当前页面放行；它不建立账号会话，下一次启动可能再次显示登录门禁。API Key 本身会保留。注销只清 access token 和用户 ID，模型流量 Key 与验证标记保留。

## 账户管理

设置中的“账户管理”显示账号与其 Key 列表。Key 始终掩码显示，复制按钮按需取明文直接写剪贴板，“使用”按钮切换当前 Key。“刷新列表”重新读取列表；若当前 Key 属于该账号，保持选择。发现外来 Key 或无可用 Key 时会自动认领或创建，不要求用户点创建。空列表在下次进入页面时重新加载。

## 配置

在 `cordis.patch.yml` 的 `config` 配置：

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| site | https://tokensapi.ai | 站点 origin，HTTPS；本机回环可 HTTP |
| desktopAuthPath | /desktop-auth | 站内交握页路径 |
| tokenName | TokensCowork | 优先复用或自动创建的 Key 名称 |
| autoCreateApiKey | true | 账户无可用 Key 时自动创建 |

站点必须部署 `/desktop-auth` 交握页，复用站点登录并要求明确授权。只接收 port/state，回调目标固定为本机；OAuth 登录往返须保留交握页路径。回环监听使用随机端口和 128 位 nonce，等待最多 5 分钟；这不是登录有效期。

## 凭证契约

| 引用 | 内容 |
| --- | --- |
| TOKENSAPI_ACCESS_TOKEN | 账号 access token |
| TOKENSAPI_USER_ID | 数字用户 ID，随请求发送 New-Api-User 头 |
| TOKENSAPI_API_KEY | 模型流量 Key |
| TOKENSAPI_API_KEY_VERIFIED_SHA256 | sha256 指纹验证标记 |

会话决定登录门禁；模型插件读取后两项。插件使用宿主凭证服务，不自行读写用户凭证文件。界面文案已有中文和英文，市场双语元数据须随下一次 npm 发布后才能生效。

## 开发与测试

```sh
npm ci --ignore-scripts
npm test
# 同一功能用例入口：
npm run test:cases
```

- [功能用例清单](test/test_cases.csv)：逐条列出前置条件、步骤、预期与对应测试。
- [执行器](test/run-test-cases.mjs)：校验映射并执行；跳过、缺失或失败均不算通过。
- 测试目录仅保留[用例清单](test/test_cases.csv)和[统一执行器](test/run-test-cases.mjs)。登录、真实凭证跨进程恢复、界面语言、发布与产物的断言均在执行器内实现。

真实凭证测试使用固定版 `@deepseek-ai/dsh-credentials-local@0.1.5-rc.2` 与 Cordis 4.0.2，模拟两次独立启动，只操作临时目录和假凭证。网络、系统浏览器仍是模拟边界；没有自动重启用户应用，也没有验证真实站点 OAuth 或界面视觉。

## 发布与许可

仅推送 `v*` 标签发布；版本号、标签和 CHANGELOG 必须一致。失败重试使用 Actions 的 Re-run。详见[发布说明](docs/publishing.md)。

MIT。
