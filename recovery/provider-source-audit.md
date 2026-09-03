# 3000 生产模型供应商历史源码证据审计

扫描范围：`E:\.codex\thread_history_1.sqlite` 的 `thread_items.item_json`；时间：2026-09-02（北京时间）。

## 证据分级

- **A：完整源码/请求片段证据**：历史助手消息给出函数、字段、请求体、状态处理和具体源码行号，可据此安全复刻契约，但仍需在 clean-room 中重新实现和测试。
- **B：路径/接口说明证据**：只有文件路径、接口名称或行为摘要，没有完整源码正文，不能直接复制实现。
- **C：敏感凭据证据**：历史中曾出现 API key、Bearer、Cookie 或环境值；本审计全部脱敏，不能用于恢复/复制。

## A 级：可安全复刻的供应商契约

### 1. 原生 Grok 视频（snumom）

来源线程：`01a03822-54ae-7ea0-af4b-342012c7a819`、`01a03821-d909-7ed3-95bc-11d4faf4189d`。

- 3000 前端先调用 `POST /api/workspace/accounts/{accountId}/generate-video`；服务端写入本地任务并异步执行 `submitVideo(...)`。
- 上游请求：`POST https://snumom.com/v1/videos`（默认基址；也曾通过 `GROK_VIDEO_BASE_URL` 环境变量配置）。
- Header：`Accept: application/json`、`Content-Type: application/json`、`User-Agent: WorkspaceProduction/1.0`、`Authorization: Bearer <环境变量>`。本审计不保存真实值。
- 无参考图请求体：

```json
{
  "model": "grok-imagine-video-1.5（按次）",
  "prompt": "<最终视频提示词>",
  "duration": 10,
  "extra": {"aspect_ratio": "9:16", "resolution": "720p"}
}
```

- 1 张参考图：在顶层增加 `input_reference: "https://<临时公网桥接>/..."`。
- 2–7 张参考图：在 `extra.reference_images` 中发送 `{ url, role: "reference_image" }` 数组，不再发送 `input_reference`。
- 参数限制：`duration` 6–30 秒；比例 `9:16/16:9/1:1`；分辨率 `480p/720p`；参考图 0–7 张；页面 `count` 1–4 只创建多个本地任务，不进入一次上游请求。
- 轮询：`GET https://snumom.com/v1/videos/{providerTaskId}`；必要时 fallback `GET .../{id}/content` 下载 MP4。响应完整读取后解析 JSON；历史实现没有流式字段。
- 参考图会先由服务端发布为临时 HTTPS URL，不能把本地路径直接发送给供应商。

安全实现建议：固定/允许列表校验基址，限制响应体大小，错误文本脱敏；下载跨源视频时不要把供应商 Authorization 透传给任意 URL。

### 2. 独立 MGRouter Grok 图片

来源线程：`01a04273-5444-70a1-84ae-7268a954f8f8`、`01a0465f-5ce0-7aa1-baf0-49ed2d60d9f6`。

- 与原 `grok-image`（MiniMax 网关）并存，独立供应商 ID：`mgrouter-grok-image`。
- 环境变量名：`MGROUTER_API_KEY`、`MGROUTER_BASE_URL`；安全修订后的默认/允许基址为精确 `https://raw.mgrouter.com/v1`，直连、不走代理。
- 图片请求使用 `/images/edits` 或 `/images/generations`；多参考图字段为 `images: [{ url }]`；比例 `9:16` 原样发送；最多 3 张参考图。
- 支持质量 `1k`、`2k`；供应商实测拒绝 `4k`（`resolution must be 1k or 2k`），UI 不应伪装提供 4K。
- 历史成功实测：2K、9:16、三参考图返回 `1584 × 2816` PNG。该文件只作为历史证据，不复制媒体或凭据。

安全实现建议：MGRouter 基址必须 host/origin allowlist 到 `raw.mgrouter.com`；图片错误详情脱敏；不要接受带 query/hash/用户密码的公网桥接基址。

### 3. 独立 MGRouter Grok 视频

来源线程：`01a04273-5444-70a1-84ae-7268a954f8f8`、`01a0465f-5ce0-7aa1-baf0-49ed2d60d9f6`。

- 独立供应商 ID：`mgrouter-grok-video`；使用独立 `MGROUTER_*` 配置；原生 Grok/snumom 供应商保持不变。
- 上游创建：`POST https://raw.mgrouter.com/v1/videos/generations`。
- 顶层发送多参考图、比例、分辨率，并固定预设声线 `eve`、`leo` 的 `reference_audios`。
- 普通提示词会自动补齐 `<AUDIO_0>`、`<AUDIO_1>` 引用，否则供应商可能忽略预设音频；这一点必须写成可测试的纯函数，不要只靠 UI 文案。
- 任务轮询支持 `request_id`、`done`、`expired`、嵌套对象及相对路径 `video.url`；视频响应体应设置约 4 MB 上限。
- 参考图通过临时公网桥接后传入，UI 应明确提示该供应商需要公网 HTTPS 参考图。

安全实现建议：固定 `raw.mgrouter.com` origin；对音频占位符做服务端规范化；对供应商错误脱敏；限制 JSON 响应读取大小。

### 4. Wan 3 / ManjuAI 多参考图+音频

来源线程：`01a04274-f81f-7a70-bd75-c173f62426ae`、`01a04273-5444-70a1-84ae-7268a954f8f8`。

- 基址：`https://api.manjuai.top`；模型查询 `GET /v1/models`。
- 标准创建：`POST /v1/videos/generations`，Header 使用 Bearer 环境变量。
- 推荐多素材模型：`wan3.0-prime-r2v`；`media` 可包含多个 `{type:"reference_image",url}`、参考视频和 `{type:"audio",url}`。
- 字段：`model`、`prompt`、`media`、`resolution`、`ratio`、`duration`、`prompt_extend`。
- 限制：图片最多 10、视频最多 5、音频最多 5；URL 必须公网 HTTPS。
- 轮询：`GET /v1/videos/tasks/{id}`；状态 `queued/running/succeeded/failed`；完成有 `video_url`/`download_url`。
- 真实历史成功：3 张图 + 1 个 8 秒音频，`wan3.0-prime-r2v`，480P/16:9，输出约 8 秒 H.264/AAC。历史 key 已脱敏且不应复用。
- DashScope 兼容端点另有 `/api/v1/services/aigc/video-generation/video-synthesis`、`/v1/videos/integration`、`/v1/video/integration`；其媒体类型 `reference_audio` 与标准接口的 `audio` 不同，不能混用。

安全实现建议：仅接受 HTTPS URL；本地图片/音频需由用户明确授权后通过受控临时存储发布；不要把历史 key 写入项目。

## B 级：路径与流程证据（无可复制完整源码）

### 生产页和任务链路

历史路径（线程 `01a042a8-c27e-7042-96d0-5da1c2f803fa`）：

- `src/app/workspace/accounts/[id]/production/page.tsx`：加载账号 `image/audio` 文件并注入 `videoSuppliers`。
- `ProductionClient.tsx`：按 `PRODUCTION_SECTIONS` 渲染生产面板，使用 `getPublicVideoSuppliers()`。
- `VideoProductionPanel.tsx`：维护 `modelId`、`promptMode`、参考图/音频选择，轮询 `/api/workspace/accounts/{id}/video-tasks`（历史间隔约 8 秒），提交到 `generate-video`，完成任务用 `<video controls preload="metadata" playsInline>` 播放。
- `catalog.ts`：历史模型 ID 包括 `grok`、`omni`、`minimax-h3`、`seedance`。
- `server-catalog.ts`：历史 provider union 包括 `oairegbox`、`grok-video`、`minimax`、`seedance`，后来新增 MGRouter 独立 provider。
- `video-capabilities.ts`：驱动参考图/音频上限、比例、分辨率和时长选项。

### 图片生成模块

- 历史完整实现路径：`src/lib/workspace/production/image-generation.server.ts`。
- 曾发现的安全问题：图片错误详情未脱敏、MGRouter base URL 仅校验 HTTPS、4K 在服务端和 UI 都被拒绝。后续历史消息称这些问题已修复，但当前 clean-room 仅复刻安全契约，不直接复制旧源码。

### 视频生成模块

- 历史完整实现路径：`src/lib/workspace/production/video-generation.server.ts`。
- 曾发现的安全问题：视频响应整体读取后才截断、MGRouter 预设音频占位符缺少强制保障、MGRouter provider 在 UI 中没有明确公网参考图提示。后续历史消息称已增加响应上限、音频占位符补齐和域名锁定。

## C 级：凭据和外联边界

历史线程曾包含真实 `sk-...`、Bearer token、Cookie 及 `.env.local` 内容（线程 `01a05783...`、`01a04273...`、`01a02359...` 等）。本审计：

- 不回显任何真实值；
- 不复制到 clean-room、报告、日志或提交；
- 真实调用必须由用户在当前环境通过环境变量重新配置，并先确认费用/素材上传授权；
- 历史 key 曾被建议轮换，不能视为当前有效凭据。

## 可安全实现的模块（给主 agent）

1. 供应商目录与能力声明：以纯数据注册 Grok/snumom、MGRouter Grok image/video、Wan/ManjuAI；每个 provider 显式列出 model、base origin、支持的参考图/音频、时长、比例、分辨率。
2. 统一视频任务状态机：本地 `queued/running/prompting/completed/failed/cancelled/paused` 与远端同步阶段分离；轮询适配器只返回规范化状态和视频 URL。
3. Mock provider：在无凭据/无公网素材时模拟 submit/poll/download，供 D 盘 3000 clean-room 离线验收。
4. 安全 URL/凭据边界：环境变量读取、精确 origin allowlist、临时 HTTPS 参考图 token、错误脱敏和响应体大小限制。
5. 生产 UI 契约：模型选择、参考图数量校验、Wan 音频选择、MGRouter 公网素材提示、完成视频直接 `<video controls>` 播放。
6. 真实接入留待用户明确授权：供应商 key、临时公网素材上传、计费任务、远端下载和跨机部署 token。

## 不应直接实现/复制的内容

- 不复制历史 `auth.json`、`.env.local`、Cookie、Bearer、`sk-...`。
- 不把历史 `C:\Users\EDY\Desktop\集成` 路径写进 D 盘项目运行逻辑。
- 不把 4K 选项伪装为已支持；MGRouter 证据明确只支持 1K/2K。
- 不把 Wan 标准 `audio` 与 DashScope `reference_audio` 混用。
- 不把 MiniMax/Quick Tunnel 逻辑错误地用于 GPT Base64 提示词阶段；历史证据表明 GPT 与视频供应商阶段应完全分离。
