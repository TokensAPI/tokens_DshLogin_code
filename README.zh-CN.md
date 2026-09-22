# @tokensapi/dsh-login — TokensAPI 登录插件

用 TokensAPI（new-api）**账号**登录 TokensCowork 桌面端，取代手动粘贴 API Key 的旧门禁。

## 流程

启动门禁只有一扇门：**登录 TokensAPI 账号**。插件在 `127.0.0.1` 上开一个一次性回调监听，把站点的 `/desktop-auth?port=…&state=…` 交给系统默认浏览器打开。浏览器里该有的全都有——钱包扩展、通行密钥、已登录的会话——用户确认授权后，站点把 access token 与账号 id 回传到那个回环端口。

（早先还有一扇内嵌登录窗口，已删除：它承载不了钱包扩展与通行密钥，而浏览器能跑通站点提供的全部登录方式，留着只是两份要维护的代码。）

回环拿到会话之后：

1. 存下站点页面签发的长期 access token 与账号 id；
2. 检查账户下的 API Key（`GET /api/token/`）——没有就自动创建（默认名 `TokensCowork`），取出完整 `sk-` key；
3. 用 `GET /v1/models` 验证后写入凭证平面，模型管理等下游插件零改动直接可用。

兜底：门禁上保留「改用 API Key 登录」手动入口。手动提交一把通过校验的 key 属于显式进入，当场放行；但下次启动时这把 key **不会**替代登录——除非宿主开不了浏览器（`canSignIn` 为 false），那时手动 key 是唯一入口。

这扇门的能力来自桌面壳：`desktopRuntime.openExternal`（超级仓库 `build/modules/runtime/open-external-overlay.mjs` 提供，只放 HTTPS）；没有它的环境自动退到手动 key 模式。

## 站点侧依赖

浏览器登录需要站点有一个交握页：new-api 的 `web/tokensapi/src/routes/desktop-auth.tsx`（`routeTree.gen.ts` 构建时自动重生）。new-api 就动两处：新增这一个路由文件，外加 `src/routes/oauth/$provider.tsx` 里十来行小补丁。该页：

- 只收 `port`（1024–65535 的整数）与 `state`（不透明 nonce），**不收任何 URL**；回调目标在页内写死为 `http://127.0.0.1:{port}/callback`；
- 未登录时就地开登录弹窗（不跳走，`port`/`state` 不会丢）；
- 跳离本页的 OAuth（Google）会把整个应用带走，回来时 `/oauth/{provider}` 默认跳 `/dashboard`，`port`/`state` 就丢了。解法就是一张 sessionStorage 便条（`oauth:return-to`）：交握页点登录前存下自己的路径，`$provider.tsx` 登录成功后在 `search.redirect` 之后、`/dashboard` 之前读一次并抹掉，只认单个 `/` 开头的同源路径；不跳走的方式登录后交握页会把便条清掉。
- 已登录时先要用户**明确授权**，再调 `GET /api/user/token` 取令牌。注意该接口是**重新签发**，旧 access token 会失效，页上已写明。

回环监听只绑 `127.0.0.1`、随机端口、只接一次、最多等 5 分钟；`state` 是 128 位随机数，对不上直接 403。

## 凭证引用

| 引用名 | 内容 |
| --- | --- |
| `TOKENSAPI_API_KEY` | 中转 `sk-` key（模型流量用） |
| `TOKENSAPI_API_KEY_VERIFIED_SHA256` | `sha256:<hex>` 验证标记（与 model-manager 同格式） |
| `TOKENSAPI_ACCESS_TOKEN` | 控制台 access token（`Authorization` 头） |
| `TOKENSAPI_USER_ID` | 账号数字 id（`New-Api-User` 头必填） |

上两项（`sk-` key 与验证标记）是**下游流量凭证**，下三行的会话是**登录状态**，两者互不判定：

- 门禁是否出现，只看有没有账号会话（`TOKENSAPI_ACCESS_TOKEN` + `TOKENSAPI_USER_ID`）。留着一把旧 key 不会让人免登录进来；key 没配好也不会把已登录的人挡在外面。
- 模型管理等下游插件只看有没有可用的 `sk-` key，与本插件的登录状态无关，探到就直接放行。

注销**只清除会话**（后两行），`sk-` key 与验证标记原样保留：门禁会回来，下游插件照常工作。要换掉 key 走「账户管理 → 重新获取」或手动填入。

## 设置 > 账户管理

插件在设置页左侧（「桌面设置」下方，order 110）挂一个「账户管理」页，两行：

- **账号**：未登录时一个按钮「登录 TokensAPI 账号」（与门禁同一条路；宿主开不了浏览器时改为提示，只剩手动 key）；已登录时显示账号并提供「注销」。
- **API Key**：显示当前在用 key 的掩码与验证状态；「重新获取」用已存的会话重拉一把，「手动填入 API Key」是兼容入口。登录后下面还列出**账户下的全部 key**：每行是名称、掩码（列表接口本来就只给掩码）、正在使用的那把标「使用中」、停用的标「已停用」，右侧「显示 / 隐藏」按需拉取该行完整明文（`POST /api/token/:id/key`，一次一把，不缓存、不落盘，再点一次就丢掉）。

「使用中」是本地比对出来的：把凭证里存的 key 按站点同款规则打码（`maskLikeConsole`）再与列表里的掩码比，既不用多存一个引用，也不用为此多取任何一把明文；手动粘贴进来的 key 同样能认出来。

注意：门禁只在**未登录**时出现，与 key 无关。本页的「账号」行反映会话，「API Key」行反映流量凭证，两行可以各自为空。

## 配置（cordis.patch.yml `config`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `site` | `https://tokensapi.ai` | 部署站点 origin（HTTPS；回环可 HTTP） |
| `desktopAuthPath` | `/desktop-auth` | 浏览器登录交握页的站内路径（必须以 `/` 开头）|
| `tokenName` | `TokensCowork` | 自动创建/优先复用的 API Key 名称 |
| `autoCreateApiKey` | `true` | 账户无可用 key 时是否自动创建 |

## 路由

`/tokens/login`（仅回环同源）：

- `GET` 返回 `{authenticated, signedIn, user, canSignIn, apiKeyMasked}`。
- `POST` 动作 `login` / `setApiKey` / `refreshApiKey` / `logout`，响应附带最新状态。
- `POST` 动作 `listApiKeys` 返回 `{apiKeys: [{id, name, masked, enabled, inUse}]}`，`revealApiKey`（带 `id`）返回 `{apiKey}`；这两个是读账户的 key，各自返回自己的载荷，不附带状态。

## 与 model-manager 的关系

**model-manager 不做任何改动**，靠的是凭证契约完全一致：

| | model-manager | 本插件 |
| --- | --- | --- |
| key | `TOKENSAPI_API_KEY` | 同 |
| 验证标记 | `TOKENSAPI_API_KEY_VERIFIED_SHA256` | 同 |
| 标记格式 | `sha256:<hex(sha256(key))>` | 同 |

登录成功后本插件写进去的就是它要读的那两行，它的门禁下次判定即自动通行。启动瞬间两块遮罩可能同时挂（谁先挂由加载顺序决定），本插件的门禁会把 `tokens-model-manager-gate` 摘掉并用 MutationObserver 盯住，直到自己关闭为止。

## 测试

```bash
node --test
```
