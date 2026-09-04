# OriginGateway 生图接入说明

本文档记录当前 workspace 对 OriginGateway 的接入契约、参考图请求格式和运行参数。供应商客户版原文档位于本机微信文件目录中的 `Origin-生图接口说明书(1).md`；本文档把其中与 workspace 相关的参数固定下来，并标明尚未被供应商文档正式覆盖的模型。

## 1. 鉴权与地址

| 项目 | 值 |
|---|---|
| OriginGateway 根地址 | `https://origingateway.com` |
| OpenAI 兼容 Base URL | `https://origingateway.com/v1` |
| 鉴权 | `Authorization: Bearer <TOKEN>` |
| GPT Image token 环境变量 | `ORIGIN_GPTIMAGE_API_KEY` |
| Grok Image token 环境变量 | `ORIGIN_GROK_API_KEY` |
| Nano Banana token 环境变量 | `ORIGIN_NANO_API_KEY` |
| 启用真实请求 | `WORKSPACE_ENABLE_LIVE_PROVIDERS=true` |

API key 只放在服务端环境变量，不写入前端、任务 metadata、日志或请求响应快照。Base URL 只允许使用固定的 OriginGateway origin，不能通过不可信配置把 token 发往其他域名。

## 2. 三个 workspace provider

| Provider ID | 模型 | 无参考图 | 有参考图 | 参考图上限 | 供应商文档状态 |
|---|---|---|---|---:|---|
| `origin-gpt-image` | `gpt-image-2` | `POST /v1/images/generations` JSON | `POST /v1/images/edits`，本地文件 multipart，URL JSON | 10 | 客户版文档正式覆盖 |
| `origin-grok-image` | `grok-imagine-image-2.0` | `POST /v1/images/generations` JSON | 同一 `/v1/images/edits` 适配器 | 10 | Origin 文档未列出该模型，需用实际 token 做低成本实测 |
| `origin-nano-image` | `nano-banana-pro` | 方图/横图走 `/v1/chat/completions`；竖图走 Gemini `generateContent` | Gemini `generateContent`，参考图编码为 `inlineData` | 3 | Origin 文档未列出该模型，需用实际 token 做实测 |

Grok 的编辑字段和 Nano 的 Gemini 原生字段是兼容性适配，不应解释为供应商客户版文档对这两个模型的正式能力承诺。若供应商对某个 token 返回模型不可用或参考图拒绝，应以真实响应为准并关闭该 provider 的参考图能力。

## 3. 同步文生图

### 3.1 Endpoint

```http
POST https://origingateway.com/v1/images/generations
Authorization: Bearer <TOKEN>
Content-Type: application/json
```

### 3.2 请求字段

| 字段 | 类型 | 必填 | workspace 默认/规则 | 说明 |
|---|---|---:|---|---|
| `model` | string | 是 | provider catalog 中的模型 | GPT Image 正式值为 `gpt-image-2` |
| `prompt` | string | 是 | 去除首尾空白，不能为空 | 生图提示词 |
| `n` | integer | 否 | `1` | 供应商范围 `1-4`；workspace 的 `count` 会创建多个独立任务，每个上游请求仍为 `n=1` |
| `size` | string | 否 | 由 `aspectRatio` + `resolution` 映射 | 必须使用 ASCII `x`，例如 `1024x1024` |
| `quality` | string | 否 | GPT `high`，Grok `medium` | 供应商文档正式建议 `auto` 或 `high`；Grok 的 `medium` 需实测 |
| `response_format` | string | 否 | `url` | 支持 `url`、`b64_json`；workspace 默认 `url` |

workspace 不发送供应商文档明确不承诺的 `stream`、`style`、`background`、`moderation`、`user` 或任意自定义字段。

### 3.3 workspace 请求示例

```json
{
  "model": "gpt-image-2",
  "prompt": "生成一张未来城市海报，无文字，高清细节",
  "n": 1,
  "size": "3840x2160",
  "quality": "high",
  "response_format": "url"
}
```

### 3.4 返回字段

```json
{
  "created": 1783487667,
  "data": [
    {
      "url": "https://example-image-domain/images/result.png",
      "revised_prompt": "..."
    }
  ],
  "usage": {
    "input_tokens": 30,
    "output_tokens": 8000,
    "total_tokens": 8030
  }
}
```

`response_format=url` 时读取 `data[i].url`；`b64_json` 时读取 `data[i].b64_json`。workspace 会把返回图片缓存为本地 asset，避免前端长期依赖供应商 URL。

## 4. 同步图生图/图片编辑与参考图

### 4.1 Endpoint

```http
POST https://origingateway.com/v1/images/edits
Authorization: Bearer <TOKEN>
```

该接口同步等待编辑结果。JSON 请求使用 `Content-Type: application/json`；multipart 请求不要手工设置 `Content-Type`，由 `FormData` 自动生成 boundary。

### 4.2 JSON URL/base64 请求字段

| 字段 | 类型 | 必填 | workspace 使用方式 |
|---|---|---:|---|
| `model` | string | 是 | `gpt-image-2` 或 provider 当前模型 |
| `prompt` | string | 是 | 去除首尾空白，不能为空 |
| `image` | string | 条件必填 | 单张公网 HTTPS URL；单张参考图使用此字段。供应商协议也接受 data URL/base64，但 workspace 当前入口未直接开放 |
| `images` | string[] | 条件必填 | 多张公网 HTTPS URL；多张参考图使用此字段。供应商协议也接受 data URL/base64，但 workspace 当前入口未直接开放 |
| `mask` | string | 否 | 蒙版 data URL/base64；workspace 当前未开放 UI 字段 |
| `n` | integer | 否 | 默认 `1`，供应商范围 `1-4`；workspace 每个任务固定 `1` |
| `size` | string | 否 | ASCII `x` 尺寸 |
| `quality` | string | 否 | `auto`、`high`；Grok 适配器保留 `medium` |
| `response_format` | string | 否 | `url` 或 `b64_json`，默认 `url` |

JSON 参考图字段必须是 `image` 或 `images`，不能发送 `image_url`。URL 必须由 OriginGateway 服务端直接访问，不能依赖登录态、Cookie、验证码或内网地址。

单图 JSON：

```json
{
  "model": "gpt-image-2",
  "prompt": "把图片改成夜晚霓虹风格，无文字",
  "image": "https://example.com/input.png",
  "size": "2048x1536",
  "quality": "high",
  "response_format": "url"
}
```

多图 JSON：

```json
{
  "model": "gpt-image-2",
  "prompt": "参考这些图片生成一张统一风格海报，无文字",
  "images": [
    "https://example.com/subject.png",
    "https://example.com/style.jpg"
  ],
  "n": 1,
  "size": "2048x1536",
  "quality": "high",
  "response_format": "url"
}
```

### 4.3 multipart 文件请求字段

本地 workspace asset 有二进制内容时，优先使用 multipart：

| FormData 字段 | 值 |
|---|---|
| `model` | 模型名 |
| `prompt` | 编辑提示词 |
| `n` | `1` |
| `size` | ASCII `x` 尺寸 |
| `quality` | `auto`/`high`（Grok 适配器可为 `medium`） |
| `response_format` | `url` 或 `b64_json` |
| `image` | 单张文件 |
| `image[]` | 多张文件；workspace 统一使用该字段名 |
| `mask` | 可选蒙版文件；workspace 当前未开放 |

单图 curl：

```bash
curl https://origingateway.com/v1/images/edits \
  -H "Authorization: Bearer $NEWAPI_TOKEN" \
  -F "model=gpt-image-2" \
  -F "prompt=把这张图改成电影海报风格，无文字" \
  -F "n=1" \
  -F "size=2160x3840" \
  -F "quality=high" \
  -F "response_format=url" \
  -F "image=@input.png"
```

多图 curl：

```bash
curl https://origingateway.com/v1/images/edits \
  -H "Authorization: Bearer $NEWAPI_TOKEN" \
  -F "model=gpt-image-2" \
  -F "prompt=融合这些图片的主体和风格，生成一张统一风格海报，无文字" \
  -F "n=1" \
  -F "response_format=url" \
  -F "image[]=@subject.png" \
  -F "image[]=@style.jpg"
```

workspace 的选择规则：

- 只有公网 URL 参考图：JSON，单图使用 `image`，多图使用 `images`。
- 有本地 asset：multipart，单个文件使用 `image`，多个文件使用 `image[]`。
- 本地文件和公网 URL 混合：multipart 的 `image[]` 中同时追加 URL 字符串和文件。
- 不发送 `file_id`；OriginGateway 当前图像链路不支持 `file_id`。

### 4.4 参考图限制

| 限制 | 值 |
|---|---:|
| 单张输入图最大大小 | 25 MB |
| 单次最多输入图 | 10 张 |
| 单次总输入大小 | 150 MB |
| 单张最大像素数 | 33,554,432 像素 |

超过限制通常返回 `400` 或 `413`。workspace 在入口先按 provider capability 限制数量，文件格式只接受 PNG、JPEG、WEBP；供应商仍会对实际大小、像素和内容进行最终校验。

## 5. Nano Banana 参考图适配

Origin 客户版文档没有 Nano Banana 的正式字段说明。workspace 对 `origin-nano-image` 的参考图适配使用 Gemini-compatible 请求，仅在 token 实际开放该路由时启用。

```http
POST https://origingateway.com/v1beta/models/nano-banana-pro:generateContent
Authorization: Bearer <TOKEN>
Content-Type: application/json
```

请求体：

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "inlineData": {
            "mimeType": "image/png",
            "data": "<base64>"
          }
        },
        { "text": "保持主体不变，生成新的商业海报" }
      ]
    }
  ],
  "generationConfig": {
    "responseModalities": ["IMAGE"],
    "imageConfig": {
      "aspectRatio": "9:16",
      "imageSize": "1K"
    }
  }
}
```

workspace 的 Nano 规则：

- 有参考图时，所有比例都切到 `generateContent`，不再走没有图片槽位的 `/v1/chat/completions`。
- 本地参考图转为 `inlineData.mimeType` 和 base64 `data`。
- 当前不能把公网 URL 直接转换为 Nano 的 `inlineData`；如果只传外部 URL，workspace 会明确返回 `origin_nano_external_reference_unsupported`，不会静默忽略参考图。
- 当前最多 3 张参考图；最终上限以供应商真实响应为准。
- Origin Nano 当前适配器只发送 `aspectRatio`，有意不发送 `imageSize`，以保持现有 Origin native 路由兼容；`resolution=1k` 仍作为 workspace 能力配置保留。
- 没有参考图时保留历史路径：`9:16` 使用 Gemini native，`1:1`/`16:9` 使用 chat-compatible 路径。
- Native 响应从 `candidates[].content.parts[].inlineData` 提取；chat 响应兼容 Markdown data URI。

## 6. 4K 参数

4K 不使用新的模型名，仍然发送 `model: "gpt-image-2"`，必须使用已开通 4K 权限的专用 token。4K 同步图生图正式建议使用 multipart 文件上传。

| 画幅 | `size` |
|---|---|
| `1:1` | `2880x2880` |
| `5:4` | `3200x2560` |
| `4:5` | `2560x3200` |
| `4:3` | `3264x2448` |
| `3:4` | `2448x3264` |
| `3:2` | `3504x2336` |
| `2:3` | `2336x3504` |
| `16:9` | `3840x2160` |
| `9:16` | `2160x3840` |
| `21:9` | `3696x1584` |

4K 同步请求固定 `n=1`；`quality` 只影响兼容字段，不负责切换 4K；4K 能力由 token 权限决定。同步读取超时建议至少 700 秒，workspace 服务端图片请求超时为 15 分钟。

## 7. 异步接口（当前 workspace 尚未接入）

异步接口必须由调用方显式实现提交、轮询、分页和结果持久化，不能把它当成普通 OpenAI client 会自动调用的路径。

| 能力 | Method | Path |
|---|---|---|
| 异步纯文生图 | POST | `/v1/image-batches/generations` |
| 异步图生图 | POST | `/v1/image-batches/edits` |
| 批次状态 | GET | `/v1/image-batches/{batch_id}` |
| 批次明细 | GET | `/v1/image-batches/{batch_id}/items` |
| 取消批次 | POST | `/v1/image-batches/{batch_id}/cancel` |
| 重排失败项 | POST | `/v1/image-batches/{batch_id}/retry-failed` |

异步提交必须带 `Idempotency-Key`，长度 `8-128` 字符。`images` 和 `tasks` 在 `/edits` 中二选一；每个任务支持 `1-10` 张公网 URL 参考图并只生成 1 张结果图；单批最多 1000 个任务。异步只接受公网 HTTP(S) URL，不接受 multipart、base64、data URL 或 `file_id`，且只支持 `response_format=url`。

轮询间隔建议 3-10 秒。终态为 `succeeded`、`partially_succeeded`、`failed` 或 `canceled` 后，再按 `next_cursor` 分页读取 `/items`，成功项读取 `output_url`。`unknown` 不应自动重试；提交超时重试必须复用原 `Idempotency-Key` 和原请求体。

## 8. 错误、重试和响应归一化

| HTTP | 含义 | workspace 处理 |
|---:|---|---|
| 400 | 参数、图片、模型或内容策略错误 | 不自动重试 |
| 401 | token 无效 | 标记 provider 未授权 |
| 403 | 模型或能力无权限 | 标记模型不可用 |
| 404 | 异步 batch 不存在 | 不自动重试 |
| 409 | 幂等键冲突 | 使用原请求体或新业务键 |
| 413 | 图片/像素/请求体过大 | 压缩图片或减少数量 |
| 429 | 限流 | 有限退避重试 |
| 500/502/503/504 | 服务端、上游或超时 | 有限退避重试 |

常见错误码包括 `content_policy_violation`、`image file exceeds maximum size limit`、`image dimensions exceed maximum pixel limit`、`image is required`、`model is required`、`invalid_input_mode`、`invalid_image_count`、`unsupported_response_format` 和 `execution_timeout_unknown`。

workspace 将供应商错误归一化为稳定代码，例如 `provider_content_policy`、`provider_reference_rejected`、`provider_unauthorized`、`provider_model_unavailable`、`provider_upstream_failed` 和 `provider_invalid_request`，并丢弃可能包含 token、URL 或账号信息的原始错误文本。

## 9. 代码映射

| 能力 | 文件 |
|---|---|
| provider capability、模型、token 环境变量 | `src/lib/providers/config.ts` |
| JSON/multipart/Gemini payload | `src/lib/providers/payloads.ts` |
| endpoint、鉴权、超时、响应解析 | `src/lib/providers/client.ts` |
| 参考素材读取、校验、任务入队 | `src/app/api/workspace/accounts/[id]/generate-image/route.ts` |
| 数量、比例、分辨率和参考图数量校验 | `src/lib/providers/validation.ts`、`src/components/ProductionForm.tsx` |

### 当前实现的关键行为

- Origin GPT/Grok 无参考图使用 `/images/generations`。
- Origin GPT/Grok 有公网 URL 使用 `/images/edits` JSON；有本地 asset 使用 multipart。
- JSON 单图字段为 `image`，多图字段为 `images`；绝不发送 `image_url`。
- workspace JSON 参考图当前只接受可由服务端访问的 HTTPS URL；供应商原协议支持的 data URL/base64 未在本项目 UI/API 入口开放。
- Origin Nano 有参考图使用 `generateContent`，参考图位于 `contents[0].parts[].inlineData`。
- 每个 workspace 图片任务上游固定生成 1 张；前端 `count` 会创建多个独立任务。
- 本地生成结果会在任务完成前缓存到 workspace asset inventory。

## 10. 验收清单

1. 使用真实 token 调用 `/v1/models`，确认 `gpt-image-2` 已授权。
2. GPT 文生图：确认 `data[0].url` 可读取。
3. GPT 单图 multipart：确认请求命中 `/v1/images/edits`，返回 200 和图片 URL。
4. GPT 多图 JSON：确认字段为 `images`，不是 `image_url`。
5. 本地 workspace asset：确认上传文件出现在 `image`/`image[]` FormData 中，且没有手写 multipart boundary。
6. Origin Grok 和 Nano：使用低成本请求确认 token、模型和参考图路由是否被供应商开放。
7. 4K：使用专用 token 和文档尺寸表验证 `9:16=2160x3840`、`16:9=3840x2160`。
8. 对 25 MB、10 张、150 MB 和超像素输入分别验证前端/供应商错误处理。
9. 断开网络、模拟 429/5xx，确认只做有限重试，不重复创建不确定的异步任务。
