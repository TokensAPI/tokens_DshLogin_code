# 发布到私有 npm

包名 `@tokensapi/dsh-login`，目标仓库 `TokensAPI/tokens_DshLogin_code`，Registry 为 `https://npm.tokensapi.ai/`。运行时代码是手写的 `dsh/*.js`，无编译步骤。

## 工作流

| 文件 | 触发 | 行为 |
| --- | --- | --- |
| checks.yml | 所有分支 push / PR | Node 22.19.0、24 执行 npm run check |
| publish-npm.yml | 仅 v* 标签 push | 同一检查矩阵通过后打包、校验、发布、核对 Registry |

两份矩阵必须保留：`needs` 无法跨工作流文件，发布依赖的检查必须来自同一次标签运行。检查触发不含标签，避免与发布重复运行。版本支持声明与矩阵覆盖的 Node LTS 主版本一致。

发布工作流没有手动入口；失败后在 Actions 对原标签运行选择 **Re-run jobs**。检查任务使用冻结锁文件，发布用已校验的同一 tarball，并关闭 pack/publish 生命周期脚本，避免重复 prepack。

## 凭据

仓库 Secret 名为 `VERDACCIO_PUBLISH_TOKEN`，仅提供给发布步骤，`npm whoami` 必须返回 `tokenscowork`。缺失、鉴权失败或账号不符均停止。令牌不要写入代码或日志；过期后替换同名 Secret，再重试原运行。

## 发布前

1. 更新 package.json 与 package-lock.json 版本，新增对应 CHANGELOG 小节和链接。
2. 运行 `npm ci --ignore-scripts`、`npm run check` 与 `node scripts/validate-release.mjs v<版本>`。
3. 按项目流程提交、推送，创建并推送匹配的标签。只有标签推送才发布。

身份校验使用完整仓库 URL，拒绝包名、Registry、仓库、稳定版本或标签不匹配。发布前读取私有 Registry 的包元数据，只有成功响应明确证明准确版本不存在才继续；404、401、网络失败、5xx 或错误元数据都停止，绝不把查询失败当成版本不存在。

## 发布后

核对准确版本、`latest`、包身份、双语元数据、Registry shasum/integrity 与下载的 tarball 字节。未就绪时有界重试查询，不重新发布；检查失败会令工作流失败。已存在版本拒绝覆盖，即便是重试也不能撤销或覆盖。

npm 的 access 字段不替代私有 Registry ACL。独立包发布不会改变产品内置版本钉定；本插件已是内置组件，不应因 npm 可下载就重新登记为市场可安装条目。
