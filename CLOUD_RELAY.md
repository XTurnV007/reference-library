# 云端图像转发

云端服务：`https://reference-library-image-relay.amberlyric256.chatgpt.site`

路由固定为 `POST /v1/images/edits`，唯一上游为 `https://ai.cursorai.art/v1/images/edits`。GitHub Pages 保留原来的工作台及素材库，浏览器改为调用云端服务。无需运行本地服务，也不会静默退回供应商直连。

转发 Worker 已部署，并按用户明确确认设为公网可访问，供 GitHub 网页调用。公网访问不提供共享供应商密钥或公共生图余额，每个调用者仍需自带 API Key。网页来源限制仅是浏览器访问规则，不等同于调用者身份认证；供应商密钥由上游验证。

## 请求与数据

- 浏览器只在点击生成后向云端发送密钥、选中的人像/服装/姿势和描述。云端仅向固定上游转发，不接受自定义目标地址或查询参数。
- 允许的网页来源为 `https://xturnv007.github.io`，预检明确允许 Authorization、Content-Type、Accept。更换网页域名时需要同步更新 Worker 的 ORIGINS。
- 密钥仅存在当前请求内存，转发代码不写文件、数据库或日志。参考图和生成 JSON 均采用流式转发，不完整缓冲大图，也不存储图片。
- Cookie 和浏览器其他请求头不向供应商传递。multipart 文件字段及边界保持原始字节；每张图仍使用单独的 `n=1` 请求。
- 所有上游错误停止当前批次，绝不自动重发。响应提供转发请求编号；上游提供请求编号时也一并返回。错误摘要只提取有限的 JSON message 并过滤密钥，不输出完整请求或响应。
- 停止后续任务不等于撤回上游已受理的任务；请求中断或 HTTP 错误仍需先核对供应商结果及账单。

## 免费的部署校验

`GET /health` 只返回本服务的固定状态，不连接供应商，不使用 API Key，不验证模型权限或余额。每次创建批次前，客户端先读取此路由；若服务不可用或权限不对，就在上传密钥和图片之前停止。

部署校验已确认：健康路由返回 200；预检返回 204，明确允许 Authorization；没有密钥的 POST 返回 401 / key_required；错误来源返回 403。另用假密钥且缺少 multipart 请求头的请求确认 Authorization 能到达 Worker，随后在本服务内返回 415 / multipart_required。这些请求都在本服务内结束，不向生图供应商提交请求。

健康检查与跨域检查成功不代表模型已经成功出图。本次未进行付费生图验收。

## 源码与更新

GitHub 中的 `cloud_relay_worker.js` 是运行中 Worker 源码的镜像。Sites 项目源码位于相邻目录 `../reference_cloud_relay/`，站点身份保存在该目录 `.openai/hosting.json`。修改时需要同步 Worker 镜像及该项目 `worker/index.js`，通过 Sites 工作流打包并发布已有项目；不要创建第二个站点。

项目使用无依赖的 Worker ESM；构建脚本只复制 Worker 和托管清单。GitHub 发布脚本只更新前端及源码，不会自动部署 Sites Worker。

离线回归由你按项目约定执行，需要 Node.js 20 或以上：

```powershell
node --test test_cloud_relay.cjs test_image_provider.cjs
```

测试中所有上游 fetch 都由替身替换，覆盖显式跨域头、固定上游、缺少密钥与错误来源的提前拒绝、原始 multipart 字节、错误脱敏、不自动重试及健康检查失败时不提交图片。网站和 Worker 运行不依赖本机 Node.js。
