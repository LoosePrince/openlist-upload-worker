# OpenList Upload Worker

将客户端文件直接上传到 OpenList 挂载的网盘。OpenList 负责签名、过期时间、路径、文件名、大小、方法和格式校验，并提供网盘上传参数；文件正文由 Cloudflare Worker 发送到网盘。Worker 完成上传后通知 OpenList，确认成功后才向客户端返回结果。

需配合 MyOpenList 中实现 `/api/upload_proxy/verify`、`prepare`、`complete` 的后端版本。支持蓝奏云、蓝奏云优享、光鸭和移动网盘；同时支持通过 OpenList 对外 S3 `PutObject` 接口触发的代理上传。无需修改 MyOpenList-Frontend。

## 配置

使用以下四个环境变量：

```dotenv
ADDRESS=https://your-openlist-server
TOKEN=your-api-token-here
WORKER_ADDRESS=https://your-worker-address
DISABLE_SIGN=false
```

| 变量 | 含义 |
| --- | --- |
| `ADDRESS` | OpenList 基础地址，可包含部署子路径；不要包含查询参数或片段 |
| `TOKEN` | OpenList“设置 → 其他”最下面的长期 Token，签名模式必需 |
| `WORKER_ADDRESS` | Worker 对外基础地址，必须与存储的 `upload_proxy_url` 一致 |
| `DISABLE_SIGN` | `false` 使用 Token 向 OpenList 校验；`true` 免 Token、免签名匿名上传 |

`TOKEN` 始终留在 Worker 服务端，既不下发到客户端，也不发送给网盘。仅使用现有 OpenList Token，没有第二套认证密钥。

## 部署

要求 Node.js 22 或更高版本，安装本项目依赖：

```powershell
Set-Location D:\Win\Documents\GitHub\openlist-upload-worker
npm ci
```

在 `wrangler.jsonc` 的 `vars` 设置实际 `ADDRESS`、`WORKER_ADDRESS` 和 `DISABLE_SIGN`。Token 使用 Wrangler secret：

```powershell
npx wrangler login
npx wrangler secret put TOKEN
npm run deploy
```

此处输入上述 OpenList 长期 Token。保留 `nodejs_compat` 兼容标志，Worker 使用 `node:crypto` 计算 MD5/SHA-256。部署地址须与 `WORKER_ADDRESS` 一致；使用自定义域名时在 Cloudflare 配置相应 Worker 域名/路由。

然后在 OpenList 管理后台：

1. 将 `upload_proxy_enabled` 设为 `true`。
2. 编辑支持的存储，填写 `upload_proxy_url=WORKER_ADDRESS`。
3. 签名模式保持 `disable_upload_proxy_sign=false`；匿名模式同时设置存储 `disable_upload_proxy_sign=true` 和 Worker `DISABLE_SIGN=true`。
4. 网页使用 `HttpDirect` 上传，或客户端使用 API/WebDAV/S3 的 307 上传地址。

本地开发时，将 `.dev.vars.example` 作为 `.dev.vars` 的配置参考，填写实际 OpenList 地址、Token 和本地 Worker 地址，例如 `http://localhost:8787`；存储中的代理网址也填写同一地址。运行：

```powershell
npm run dev -- --port 8787
```

`.dev.vars` 和 `.env` 已被 Git 忽略。未配置可用的 OpenList 地址和存储时，Worker 不能完成真实上传。

## 客户端标准

推荐先向 OpenList 请求上传信息：

```http
POST /api/fs/get_direct_upload_info
Authorization: <OpenList 用户登录凭据>
Content-Type: application/json

{"path":"/网盘","file_name":"example.txt","file_size":3,"tool":"HttpDirect"}
```

将原始文件以响应中的 `method`、`headers` 上传到 `data.upload_url`，保持签名 URL 不变。`chunk_size=0`，只发送一个 PUT 请求。现有 OpenList 用户权限在签发地址时检查；Worker 不要求客户端提供 Token。

Worker 上传入口：

```http
PUT /upload?payload=<OpenList 生成的描述>&sign=<OpenList 签名>
Content-Type: application/octet-stream

<文件字节>
```

签名校验全部通过 OpenList 完成。Worker 先提交实际方法、Content-Type 对应的格式和请求描述，校验通过才读取文件并准备网盘请求。Worker 仅转发 OpenList 下发的网盘请求头，不转发客户端的 Authorization/Cookie。

匿名模式可不带 `payload`、`sign` 和 Token，直接指定目标：

```http
PUT /upload?path=%2F网盘&file_name=example.txt&file_size=3&overwrite=true
Content-Type: application/octet-stream

abc
```

路径和文件名应 URL 编码。目标存储仍需启用代理和匿名模式。`response` 可选 `json`（默认）、`s3`、`webdav`；OpenList 对目标路径及规则作最终检查。

表单上传仅接受一个 `file` 文件字段，文件名和大小必须与签发描述一致，文件内容受缓冲上限约束。实际 Content-Type 会由 Worker 识别并提交 OpenList。浏览器使用 FormData 时应由浏览器生成 boundary。

响应格式：

| 模式 | 成功响应 |
| --- | --- |
| `json` | HTTP 200，`{"code":200,"message":"success","data":null}` |
| `s3` | HTTP 200，空正文，文件 MD5 `ETag` |
| `webdav` | HTTP 201，空正文 |

错误返回对应 HTTP 状态和 JSON `code/message/data`，不会将网盘凭据或上传响应正文暴露给客户端。支持 CORS 预检和上传进度事件。客户端传输进度到 100% 后仍需等待 OpenList 完成确认；重试重新获取地址并上传整个文件。

## 范围与限制

- 仅单次 HTTP 上传，无分片或断点续传。协议使用 multipart/form-data 包装文件与分片上传是不同概念。
- 原生客户端直传优先，网盘上传 URL 仅供 Worker 内部请求使用。
- 蓝奏云和光鸭可流式上传，默认 OpenList 单文件限制 100 MiB。蓝奏优享 MD5、移动新版 SHA-256 需预先缓冲，最大 32 MiB。所有客户端表单上传也受该缓冲限制约束。
- Cloudflare 套餐、网盘单请求上限和账号上传规则可能进一步限制大小。
- S3 只支持单次 `PutObject`；拒绝 multipart、`aws-chunked` 和 streaming 签名正文。S3/WebDAV 客户端必须支持带正文的 307 重定向。
- OpenList 会话在内存中，重启失效；多后端实例需固定到同一实例。签名/会话默认 900 秒，可在 OpenList 配置。
- 蓝奏反爬挑战不自动重放文件；移动旧上传协议不支持空文件。
- Worker 控制请求和 OpenList 网盘初始化/提交是少量控制流量；文件正文经 Worker。直接 PUT 到 OpenList 的客户端提前发送正文或反向代理缓存仍可能占用源站带宽，推荐先获取上传地址。

完整后台配置、控制 API 字段、扩展接口标准见后端仓库 `README/upload_proxy.md`，对应源码为 `internal/model/upload_proxy.go`、`internal/driver/upload_proxy.go` 和 `internal/uploadproxy/proxy.go`。

## 验证

```powershell
npm test
npx wrangler deploy --dry-run
```

测试包括 Token 隔离、拒绝时不读正文、匿名模式、MD5、multipart、大小/校验和错误、S3 ETag、实际格式校验、秒传以及真实 Cloudflare workerd 的 FixedLengthStream 上传。测试使用本地模拟 OpenList/网盘，不能替代真实账号联调。目前未部署 Cloudflare，也未验证真实网盘账号。
