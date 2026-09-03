# workspace 供应商与外部数据源清单

> 目的：记录从 `E:\.codex` 历史对话、历史源码路径和当前 D 盘 clean-room 项目中能够确认的 provider / supplier，以及哪些已经具备可实现契约、哪些仍缺少真实接口信息。
>
> 安全边界：本文不包含 API key、Bearer token、Cookie、浏览器 auth state、密码或 natapp authtoken。所有真实凭据只能由部署者在 `D:\all_projects\workspace\.env.local` 重新配置。本文的“已接入”只表示代码层有契约/adapter，不表示当前环境已经配置密钥或已经开启计费调用。

## 1. 状态定义

| 状态 | 含义 | UI 行为 |
| --- | --- | --- |
| A — 契约完整，可实现 | 历史证据同时给出 endpoint、认证方式、请求字段、状态/结果解析或明确的成功响应；可以在 clean-room 中写 adapter 和测试 | 可以进入 provider 目录；只有环境变量齐全才显示为可用 |
| B — 历史证据部分完整 | 有模型名、代码路径或部分字段，但缺少当前可验证的 endpoint、鉴权、轮询或下载协议 | 只能显示“待补契约”，不得标记已配置，不允许 live 提交 |
| C — 只有 UI/讨论痕迹 | 仅在目录、截图、讨论或旧配置中出现，没有足够信息安全复刻 | 不进入可用 provider 选择器，保留在缺失清单 |
| Disabled | 契约可能完整，但当前没有用户重新配置的凭据、没有公网素材授权或 live 开关关闭 | 显示为“未配置/需授权”，只能走 mock |

## 2. A 级：已有完整契约、可以实现或已经有 clean-room adapter

### A1. 原生 Grok Imagine Video（snumom）

- 历史 supplier id：`grok-video`。
- 历史显示名：`Grok Imagine Video 1.5`。
- 历史请求中出现的 model 字符串：`grok-imagine-video-1.5（按次）`。
- 历史讨论也提出过不带文案的 `grok-imagine-video-1.5` 可能才是远端 model id；最终必须以一次用户授权的最小真实请求/供应商响应确认，不能只凭 UI 文案猜测。
- 创建：`POST https://snumom.com/v1/videos`。
- 查询：`GET /v1/videos/{providerTaskId}`。
- 内容回退：`GET /v1/videos/{providerTaskId}/content`。
- 认证：服务端从 `GROK_VIDEO_API_KEY` 读取 Bearer token。
- 基址：`GROK_VIDEO_BASE_URL`，默认 `https://snumom.com/v1`，实现时必须做 host/origin allowlist。
- 参数证据：`duration` 6–30 秒；比例 `9:16 / 16:9 / 1:1`；分辨率 `480p / 720p`；参考图 0–7 张。
- 参考图映射：1 张使用 `input_reference`；2–7 张使用 `extra.reference_images`，每项为 `{ url, role: "reference_image" }`。
- `count` 不是上游字段；3000 为每个数量创建独立本地任务，避免一次请求产生不可追踪的重复扣费。
- 当前状态：clean-room 已有 capability/任务契约；live 默认关闭，需配置环境变量并完成最小真实验收。

### A2. MGRouter Grok Image

- supplier id：`mgrouter-grok-image`。
- 基址：`https://raw.mgrouter.com/v1`，环境变量 `MGROUTER_BASE_URL`，精确 host allowlist。
- 认证：`MGROUTER_API_KEY`，仅服务端使用。
- 创建：`POST /images/generations`；有参考图时使用 `POST /images/edits`。
- 请求字段证据：`model`、`prompt`、`aspect_ratio`、`resolution`、`images: [{ url }]`。
- 参考图最多 3 张；支持 `1k`、`2k`；历史实测拒绝 `4k`，UI 和服务端都必须明确拒绝 4K，不做偷偷降级。
- 历史成功响应：2K、9:16、三参考图返回 1584×2816 PNG（仅作契约证据，不复制历史媒体）。
- 当前状态：clean-room 已有 provider config/capability；live 仍由环境变量和总开关决定。

### A3. MGRouter Grok Video

- supplier id：`mgrouter-grok-video`。
- 基址：`https://raw.mgrouter.com/v1`，共享 `MGROUTER_*` 服务端配置。
- 创建：`POST /videos/generations`。
- 能力证据：最多 7 张参考图、2 条参考音频；使用 `reference_images`、`reference_audios`。
- 历史固定 voice id：`eve`、`leo`；普通提示词必须由服务端规范化补齐 `<AUDIO_0>`、`<AUDIO_1>` 占位符，否则供应商可能忽略预设音频。
- 状态/结果解析：历史出现 `request_id`、`done`、`expired`、嵌套对象和相对路径 `video.url`，实现必须统一规范化并限制响应体大小。
- 公网素材要求：参考图/音频必须先通过 `WORKSPACE_PUBLIC_BASE_URL` 短期 HTTPS bridge 发布。
- 当前状态：clean-room 已有能力记录和 payload 规则；live 需环境变量、公网 bridge 和最小请求授权。

### A4. Wan 3 / ManjuAI 多参考视频

- supplier id：`wan3-video`（历史对话也使用过 `wan` / `WAN_VIDEO_*` 命名，最终实现应统一配置名并提供兼容读取策略）。
- 基址：`https://api.manjuai.top`，环境变量当前约定为 `WAN_BASE_URL`，密钥为 `WAN_API_KEY`。
- 模型：`wan3.0-prime-r2v`。
- 创建：`POST /v1/videos/generations`。
- 模型查询：`GET /v1/models`。
- 轮询：`GET /v1/videos/tasks/{id}`；状态 `queued/running/succeeded/failed`；成功字段可能为 `video_url` 或 `download_url`。
- 请求字段：`model`、`prompt`、`media`、`resolution`、`ratio`、`duration`、`prompt_extend`。
- 媒体类型：`reference_image`、`reference_video`、`audio`；图片最多 10、视频最多 5、音频最多 5。
- 历史成功证据：3 张图片 + 1 个 8 秒音频，480P/16:9，输出 H.264/AAC。
- 兼容边界：DashScope 兼容端点使用的 `reference_audio` 与标准接口的 `audio` 不能混用。
- 当前状态：clean-room 已有 capability/adapter 方向；需统一 env 命名、补齐下载落盘和真实响应 fixture 后再宣称 live 可用。

本轮补充资料还确认了同一 ManjuAI 服务的其他模型族：`wan3.0-prime-t2v`、`wan3.0-prime-i2v`、`wan3.0-prime-r2v` 以及旧版 `wan3.0-t2v/i2v/r2v`。其中 t2v 不传媒体，i2v 使用 `first_frame`，r2v 使用 `reference_image`、`reference_video`、`audio`。资料同时记录了 DashScope 兼容路径 `/api/v1/services/aigc/video-generation/video-synthesis`、`/v1/videos/integration`、`/v1/video/integration`；这些路径的请求/轮询协议与标准 `/v1/videos/generations` 不同，必须单独 adapter，不能在当前 Wan adapter 中混用。

### A5. YuanAI Gemini Prompt

- 历史用途：提示词/子提示词生成，不是视频 provider。
- 基址：`https://yuanai.uk`，环境变量 `GEMINI_PROMPT_BASE_URL`。
- 创建：`POST /v1beta/models/{model}:generateContent?key=<runtime-key>`。
- 模型历史记录：`gemini-2.5-flash`。
- 认证：运行时 query key，环境变量 `GEMINI_PROMPT_API_KEY`；绝不写入前端或任务日志。
- 任务行为：模板模式生成 `childPrompt`，缓存到本地任务；重试/恢复优先使用缓存，避免重复计费。
- 当前状态：请求契约已确认；clean-room 可在 mock 中使用，live 需重新配置 key 和费用确认。

### A6. YuanAI GPT Image（补充资料）

- 供应商：YuanAI，基址 `https://yuanai.uk`。
- 模型：`gpt-image-2`。
- 图生图：`POST /v1/images/edits`，历史 OpenAPI 记录为 `multipart/form-data`；字段包括 `image`、`prompt`、`n`、`model`、`size`、`response_format`。
- 图片输入资料要求有效 PNG、单张小于 10 MB；`n` 为 1–10；成功响应为 `data[].url`。
- 无参考图的 `/v1/images/generations` 也有历史使用痕迹，但当前资料未给出完整响应约束，需用真实接口资料补 fixture。
- 当前状态：D 盘 clean-room 现有 JSON 图片 adapter 与该 multipart edits 契约不完全相同；在启用 live 前必须增加 multipart transport、PNG/大小校验和响应 URL 解析测试。

### A7. PomoAI Gemini 3.1 Flash Image（契约来自旧源码 + 当前资料）

- 模型：`gemini-3.1-flash-image`。
- 资料确认官网产品页为 PomoAI Gemini 3.1 Flash Image；旧 clean-room 恢复源码包含 PomoAI 的 Gemini generateContent 请求、参考图规范化、响应图片解码和 PNG/JPEG/MIME 校验。
- 当前可接入的 endpoint、认证 header 和响应 schema 必须以恢复源码测试和用户后续接口资料共同确认；不能仅凭官网 URL 猜测 API host。
- 当前状态：应从 B 级提升为“待验证 A”，在补齐当前 endpoint 后再加入正式 provider catalog。

### A8. 8765 商品/PID 外部数据源（非 AI provider）

- 角色：商品图片查询、PID 检查、图库同步和 PID 文件夹下载。
- 健康检查：`GET /api/v1/health`。
- 查询：`GET /api/v1/gallery`，支持 `query`、`membership`、`category`、`limit`、`offset`。
- 其他已确认路径：`POST /api/v1/gallery/import`、`POST /api/v1/gallery/check-pids`、`POST /api/v1/gallery/check-file`、`POST /api/v1/gallery/sync-jspace`、`PUT /api/v1/gallery/{pid}`、`GET /api/v1/gallery/{pid}/cover`、`POST /api/v1/gallery/download-folder`。
- 下载请求历史格式：`{ "pids": ["PID_1", "PID_2"] }`。
- 3000 导入目标：`D:\all_projects\workspace\data\product-images\<accountId>\<YYYY-MM-DD>\<pid>\`。
- 当前状态：接口路径已确认；真实下载响应头、压缩包 MIME、文件名编码和错误格式仍需连接本地 8765 实例录制脱敏 fixture 后锁定。

8765 下载实现约束：单次最多 100 个 PID、总下载体积约 500 MiB；请求前校验 PID 格式并调用 `check-pids`；响应按 ZIP/blob 流处理并校验 MIME、长度和 ZIP 签名；解包拒绝绝对路径、`..`、符号链接和跨账号目录；失败或超限时删除临时文件及部分目录；前端支持勾选/全选下载。历史商品池分类（TAP/CAP/同时命中/未收录/待查询/查询失败）与业务分类（服装/非服装/待确认）是两个独立维度，业务分类接口为 `PUT /api/v1/gallery/{pid}/business-category` 与 `POST /api/v1/gallery/business-category/import`，不得互相覆盖。

## 3. B 级：历史有部分字段或代码路径，但缺少当前可验证契约

### B1. OAIRegBox / Omni

- 历史 model id：`omni`。
- 历史 supplier id：`oairegbox`。
- 本轮资料补充 model `omni-fast-no-water` 和文档地址 `https://docs.oairegbox.cc/#omni`，但仍缺当前可验证的创建 endpoint、请求体、异步状态协议、下载字段和最新认证方式。
- 不能复用原生 Grok、MGRouter 或 Wan 的 transport；需要供应商文档或用户提供当前接口样例后单独实现。

### B2. MiniMax H3

- 历史 model id：`minimax-h3`；supplier id：`minimax`。
- 历史有 `minimax_provider.py`、runner 分发和公网图片 bridge 的代码路径证据。
- 当前缺少可直接复用的、经重新验证的 endpoint/请求体/状态和下载协议；旧项目曾出现 `prompt_optimize` 字段不兼容、跨域下载携带 Bearer、Base64 与公网 URL 分叉等问题。
- 不能复用旧 key、旧 Cookie 或旧 `.env.local`；必须补齐当前服务契约和安全测试后再启用。

### B3. Seedance

- 历史 model id：`seedance`。
- 历史 catalog/server-catalog 中出现 supplier 分支。
- 当前没有足够 endpoint、认证、payload、轮询和下载证据；暂不实现 live。

### B4. PomoAI / Gemini Image / YuanAI Image

- 历史图片目录出现 `PomoAI/Gemini Image`、`yuanai-image` 等名称。
- 当前可确认的是“存在图像 provider 选择项和部分模型配置”，但缺少统一、可验证的当前 endpoint、参考图字段、响应下载格式和错误协议。
- `yuanai-image` 已补充 `gpt-image-2` edits multipart 资料，但当前 clean-room transport 仍需改造；PomoAI 已有恢复源码实现，但当前 API host/认证仍需确认；二者在完成请求测试前不得标记 live 已接入。

### B5. GPT-2999 / OpenAI-compatible Prompt Provider

- 历史用途：提示词阶段；当前 workspace 主通道固定为 `POST /v1/responses`（旧 Chat Completions 仅作为响应解析兼容，不再作为请求路径）。
- 历史明确与视频阶段分离，不能把 MiniMax/Grok 的图片 bridge 逻辑错误复用到 GPT Base64 提示词阶段。
- 本轮资料确认模型为 `gpt-5.5`，基址为 `https://2999api.com`；请求为 `POST /v1/responses`，body 使用 `model`、`input`（`input_text` content blocks）和 `max_output_tokens`。响应解析支持 `output_text`、结构化 `output[].content[].text`，并兼容旧 `choices[].message.content`。live 仍默认关闭，必须在用户确认余额后进行最小真实调用。

## 4. C 级：只有 UI/讨论痕迹，不纳入当前实现

以下名称在历史目录、截图、讨论或外围项目中出现过，但没有足够当前契约，不能安全接入：

- FunAI（仅见旧批量执行器分支名称）；
- RegBox（除 OAIRegBox/Omni 外的泛称）；
- 其他仅在旧 `catalog.ts`、截图或 `.env` 片段中出现而没有完整 transport 的模型/供应商；
- 9999 人工执行器、10000 批量执行器、BitBrowser/TikTok 发布器本身（它们是外部系统，不是 3000 provider）。

## 5. 当前 clean-room 代码目录与配置状态

| provider id | 当前代码/配置 | live 默认状态 | 允许的下一步 |
| --- | --- | --- | --- |
| `grok-video` | capability、任务字段和生成路由已有 | 关闭 | 用户确认模型字符串后做最小真实请求 |
| `mgrouter-grok-image` | capability 和图片请求契约已有 | 关闭 | 配置 `MGROUTER_*` 后做 payload/响应验收 |
| `mgrouter-grok-video` | capability、音频占位符和 bridge 规则已有 | 关闭 | 配置公网 HTTPS bridge 后做最小任务 |
| `wan3-video` | capability 和多媒体映射已有 | 关闭 | 统一 env 命名并录制真实响应 fixture |
| `yuanai-gemini-prompt` | prompt 路由和缓存字段已有 | 关闭 | 配置 `GEMINI_PROMPT_*` 后做最小提示词请求 |
| `yuanai-image` | 已增加 `gpt-image-2` multipart edits payload builder/client 分支；完整二进制引用仍需接入任务 worker | 关闭 | 补齐本地 asset bytes、PNG 限制和响应 fixture |
| `pomoai-gemini-image` | 已增加 Gemini 3.1 Flash Image payload/client 分支；正式 API 响应仍需真实 fixture | 关闭 | 验证 endpoint/header/响应图片解码 |
| `gpt-2999-prompt` | 已切换到 Responses API（`POST /v1/responses`）并加入 output_text/structured output/choices 兼容解析 | 关闭 | 用户确认余额后做一次最小真实提示词请求；当前历史实测曾返回 403 预扣费额度不足 |
| `oairegbox-omni` | 已增加 Omni provider catalog、JSON/multipart payload builder；引用文件 bytes 仍需接入 | 关闭 | 补齐当前 multipart 文件字段和状态/下载协议 |
| `oairegbox` | 历史能力记录 | 关闭 | 获取当前接口样例后再实现 |
| `minimax` | 历史路径证据 | 关闭 | 重新确认契约，禁止复用旧凭据 |
| `seedance` | 历史目录项 | 关闭 | 获取 endpoint/认证/状态协议 |

## 6. 真实接入验收门槛

任何 provider 只有同时满足以下条件，才能在 UI 中显示“可用”并执行 live：

1. 当前 D 盘 `.env.local` 配置了该 provider 的新凭据；
2. endpoint、model id、请求体、状态/结果解析已由测试锁定；
3. 用户明确允许一次最小计费请求；
4. 如带本地素材，用户明确允许通过 `WORKSPACE_PUBLIC_BASE_URL` 临时 HTTPS bridge 暴露；
5. 输出只下载到 D 盘，并能在任务详情和库存流程中复核；
6. 错误信息已脱敏，响应体大小和 URL 域名均有限制。

## 7. 缺失契约清单（待用户/供应商补充）

| provider | 必须补充的资料 |
| --- | --- |
| OAIRegBox / Omni | 当前 base URL、认证方式、创建请求样例、轮询响应、下载字段、模型名 |
| MiniMax H3 | 当前 API 文档、图片输入字段、任务状态、视频下载方式、音频支持、费用 |
| Seedance | endpoint、认证、模型 id、请求体、异步状态、结果 URL、限制 |
| PomoAI/Gemini Image/YuanAI Image | 当前图像 endpoint、参考图字段、比例/分辨率限制、响应图片格式、错误码；YuanAI edits 的 multipart 资料已部分具备 |
| GPT-2999 | 当前兼容端点、模型清单、Responses/Chat Completions schema、认证和 Base64 限制 |
| 8765 下载接口 | 实例响应头、压缩包 MIME、文件名编码、错误体、单次 PID 数量/大小限制 |

## 8. 证据索引

- `recovery/provider-source-audit.md`：A/B/C 级 provider 契约审计；
- `recovery/provider-history-evidence.md`：历史源码路径、图库/PID 和 provider 变更交叉证据；
- `recovery/provider-concrete-messages.txt`：脱敏端点、payload、轮询和历史实测记录；
- `recovery/provider-thread-details.txt`：账号资产、任务处理器、环境变量命名和旧项目边界；
- `recovery/production-queue-history.md`：生产队列和任务状态契约；
- `E:\.codex\thread_history_1.sqlite`：原始线程数据库，仅用于查证，不复制其中的秘密。

## 9. 本轮新增参考资料（桌面目录）

本轮用户提供了两个桌面参考目录：

```text
C:\Users\EDY\Desktop\集成-codex-db-recovered-20260902
C:\Users\EDY\Desktop\key和token资料
```

前者包含可复核的恢复源码、逐步 diff、测试、缺失文件清单和历史 Prisma schema；后者包含当前供应商接口说明、模型名称和部署资料。实现时采用以下规则：

- 从恢复源码迁移请求构建、状态轮询、下载、素材校验和 UI 逻辑；
- 从供应商资料迁移 endpoint、字段、模型和限制；
- 不把恢复目录中的 `供应商账密统计.txt`、旧 `.env`、Cookie 或浏览器登录态当作源码；
- 当前 `.env.local` 中的凭据只能由用户明确提供的当前资料写入，不能从历史 SQLite 自动推断；
- `WORKSPACE_ENABLE_LIVE_PROVIDERS` 默认保持 `false`，写入凭据不等于自动发起计费请求；
- 旧源码依赖的 Prisma 模型、任务租约和库存文件结构与当前 clean-room store 不完全相同，迁移时必须适配当前 D 盘数据层并补测试。

新增资料对应关系：

| 资料 | 可确认内容 | 当前实现动作 |
| --- | --- | --- |
| `minimax h3.txt` | 实际是 ManjuAI/Wan 3/Prime 的 endpoint、模型、media、轮询和价格资料 | 作为 Wan adapter 的当前契约来源；不把文件名误当成 MiniMax endpoint |
| `yuanai.txt` | `gpt-image-2` edits multipart 字段和 `data[].url` 响应 | 补 YuanAI multipart edits transport |
| `PomoAI的Gemini Image.txt` | PomoAI `gemini-3.1-flash-image` 模型资料和官网 | 对照恢复源码补 PomoAI image adapter，待 API host/header fixture 验证 |
| `2999api.txt` | `gpt-5.5` 和 OpenAI-compatible 说明 | 作为 GPT prompt provider 的模型资料；endpoint 仍需以当前资料补齐 |
| `omin.txt` | `omni-fast-no-water` 和 OAIRegBox 文档地址 | 作为 OAIRegBox model 名；transport 仍需 API 文档/响应样例确认 |
| `natapp.txt` | 3000 隧道用途和 token 资料 | 只用于本机用户环境变量；不进入业务代码、文档或日志 |
## 10. 2026-09-02 真实 smoke 验证记录

本轮真实测试均使用 D 盘项目 `.env.local` 中的运行时凭据，测试脚本和日志不输出密钥。真实生成可能产生费用；工作区总开关仍保持 `WORKSPACE_ENABLE_LIVE_PROVIDERS=false`。

| provider / model | 验证内容 | 结果 |
| --- | --- | --- |
| ManjuAI / `wan3.0-prime-t2v` | 模型列表、创建任务、状态轮询、视频 HEAD | 成功：`queued → succeeded`，返回 `video/mp4`；该次真实任务已计费 |
| PomoAI / `gemini-3.1-flash-image` | 无引用及本地 PNG 引用生成 | 成功：返回真实 PNG inlineData；已接入完成归一化和 D 盘输出落盘 |
| YuanAI / `gpt-image-2` | `/v1/images/generations` 及 `/v1/images/edits` multipart 本地 PNG | 成功：返回真实 `b64_json`；编辑引用从 D 盘读取 |
| GPT / `gpt-5.5` | `/v1/models` 只读检查；Responses 主协议 mock 契约 | 模型可见；真实生成未执行，曾返回余额不足/预扣费失败 |
| OAIRegBox / `omni-fast-no-water` | `/v1/models` 与多种认证头探测 | 401 `Invalid token`；需要新 token 和完整接口资料 |
| Grok / MGRouter | 认证探测 | 当前项目未配置可用 key，无法真实生成 |
