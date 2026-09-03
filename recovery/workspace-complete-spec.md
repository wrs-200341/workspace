# workspace（3000 放映厅）工作台完整布局与功能规格

> 文档用途：这是在继续实现前供业务确认的唯一基线。内容来自 `E:\.codex` 历史对话、历史源码路径/接口契约、当前 D 盘 clean-room 项目，以及你补充的“图片分素材与商品、商品 PID 文件夹按三天清理”要求。
>
> 本文只记录接口、字段、状态和目录规则，不包含任何 API key、Bearer token、Cookie、密码或可直接登录的秘密。真实调用必须由当前环境在 `D:\all_projects\workspace\.env.local` 重新配置。

## 1. 产品边界与系统关系

### 1.1 3000 的定位

3000 是“放映厅 + workspace 工作台”的观测、复核和生产编排界面。它负责：

- 展示 9001 回流的选品/出单趋势和账号表现；
- 管理工作台账号、运营员和账号资产；
- 组织提示词、参考素材、模型参数和生产任务；
- 展示生产队列、任务详情、失败恢复、预览和入库状态；
- 把已确认的本地资产以受控短期 HTTPS 引用交给外部 provider。

3000 不替代其他执行器：

| 系统 | 历史职责 | 本项目处理方式 |
| --- | --- | --- |
| 9001 | 选品、商品/PID、出单趋势、来源数据 | 通过受控 API 读取；没有上游数据时显示 0/空状态 |
| 9999 | 人工精细视频执行器 | 保持独立；3000 只复现其 provider 契约和任务观测逻辑 |
| 10000 | 批量视频执行器、统一后缀、Excel/PID 匹配 | 保持独立；3000 复现工作台侧的输入字段与队列契约 |
| BitBrowser/TikTok | 账号、商品、发布或抓取 | 不在 3000 内伪造；需要明确的外部服务地址和凭据后再接 |

### 1.2 数据真实性原则

- 没有真实来源的数据一律显示 `0`、空数组或“暂无同步数据”。
- 账号槽位可以保留用于布局和新增入口，但账号统计必须来自真实存储。
- `completed` 不等于“今日成功”：只有存在有效输出并写入库存（`inventorySavedAt`）才计入入库统计。
- 任务数量、输出数量、播放、订单、GMV、转化率不能使用演示数字。

## 2. 全局布局

### 2.1 顶部栏

从左到右：

1. `W` 品牌标识；
2. `workspace / 放映厅 · 3000` 项目名；
3. 数据源状态（当前历史文案为“数据源待同步 · 9001”，不能宣称已连接）；
4. 当前用户显示名；
5. 角色标签：管理员、工作台账号、运营账号；
6. 退出登录按钮。

右上角不显示 provider 密钥、原始错误堆栈或本地绝对路径。

### 2.2 左侧全局导航

桌面端为固定侧栏，移动端折叠菜单。历史导航项：

| 文案 | 路由 | 权限 |
| --- | --- | --- |
| 放映厅 | `/` | admin/workspace/operator |
| 工作台 | `/workspace` | admin/workspace/operator |
| 下游看板 | `/downstream` | admin/operator |
| 账号资产 | `/accounts` | admin/operator |
| 商品 / PID | `/products` | admin/operator |
| 账号控制 | `/admin/accounts` | admin |

侧栏 Today 区域显示上海时区动态日期。禁止硬编码日期。

### 2.3 响应式与交互

- 目标宽度：375、768、1024、1440 均无横向滚动。
- 使用 Lucide SVG 图标，不使用 emoji 作为图标。
- 所有按钮/卡片有 `cursor-pointer`、hover/focus 状态和键盘焦点。
- 表单控件均有可读标签；图片有 `alt`；状态不能只依赖颜色。
- 队列、表格和空状态优先保证可读性，动画仅用于加载/状态变化。

## 3. 路由地图

| 路由 | 页面职责 | 关键组件/数据 |
| --- | --- | --- |
| `/` | 放映厅总览、趋势、账号排行、视频归因 | Dashboard、9001 earnings proxy |
| `/workspace` | 运营员筛选、精选/混剪账号、今日入库和生产队列概览 | WorkspaceClient |
| `/workspace/accounts/:id/assets` | 账号资产默认页 | AccountAssetsPage |
| `/workspace/accounts/:id/assets/prompts` | 提示词模板 | prompt assets |
| `/workspace/accounts/:id/assets/images` | 图片资产，内部再分“素材 / 商品” | image assets、PID 商品图 |
| `/workspace/accounts/:id/assets/videos` | 库存视频 | inventory-video assets |
| `/workspace/accounts/:id/assets/audio` | 音频资产 | audio assets |
| `/workspace/accounts/:id/production?mode=prompt` | 提示词生产 | 模板、子提示词、最终提示词 |
| `/workspace/accounts/:id/production?mode=image` | 图片生产 | 图片 provider、参考图、任务队列 |
| `/workspace/accounts/:id/production?mode=video` | 视频生产 | 模型/供应商、参考图/视频/音频、队列 |
| `/workspace/accounts/:id/production/video-tasks/:taskId` | 视频任务详情、预览、入库 | TaskReview |
| `/workspace/accounts/:id/production/image-tasks/:taskId` | 图片任务详情、重试、下载 | TaskReview |
| `/admin/accounts` | 账号控制、角色和账号槽位 | AccountControlPage |
| `/downstream` | 发布后视频、PID、播放、订单、GMV | DataTablePage |
| `/accounts` | 账号资产和表现 | AccountsPage |
| `/products` | 商品/PID 货盘 | products |
| `/records`、`/tracked` | 发布记录、账号追踪 | 兼容外围路由 |

未登录页面重定向 `/login?next=...`；API 返回 401；角色不符返回 403。

### 3.1 页面线框（历史布局复刻目标）

放映厅/普通工作台壳层：

```text
┌─────────────────────────────────────────────────────────────────────┐
│ W  workspace / 放映厅·3000     数据源待同步·9001   用户 角色 退出 │
├───────────────┬─────────────────────────────────────────────────────┤
│ Workspace     │ 面包屑 / 页面标题 / 当前筛选 / 操作按钮             │
│ 放映厅         │                                                     │
│ 工作台         │ ┌──────────── KPI/状态卡 ─────────────┐             │
│ 下游看板       │ │ 真实数据；无数据为 0 或空状态        │             │
│ 账号资产       │ └─────────────────────────────────────┘             │
│ 商品 / PID     │ 主内容：表格、账号卡、趋势或任务列表                 │
│                 │                                                     │
│ System        │                                                     │
│ 账号控制(admin)│                                                     │
│ Today         │                                                     │
└───────────────┴─────────────────────────────────────────────────────┘
```

工作台首页：

```text
┌────────────── 工作台 rail ──────────────┬──────── 账号主区 ──────────┐
│ 运营人员选择器                          │ 当前运营员 / 精选或混剪     │
│ 精选账号 [n]                            │                             │
│ 混剪账号 [n]                            │ ┌账号卡┐ ┌账号卡┐ ┌账号卡┐  │
│ INVENTORY COUNTER                       │ │计划  │ │计划  │ │计划  │  │
│  今日成功入库 0                         │ │提示词│ │图片  │ │视频  │  │
│  今日未入库 0                           │ │资产/生产入口             │  │
│  处理中 0                               │ └──────┘ └──────┘ └──────┘  │
│  失败待重试 0                           │ [+ 添加账号]                │
└────────────────────────────────────────┴─────────────────────────────┘
```

账号图片资产页：

```text
┌──── DATA ASSETS ────┬─────────────────────────────────────────────────┐
│ 提示词              │ 图片资产                                        │
│ 图片                │ [素材图片] [商品图片]                           │
│  ├ 素材图片         │ 筛选/上传/按 PID 或日期搜索                      │
│  └ 商品图片         │ ┌PID 商品卡┐ ┌PID 商品卡┐                       │
│ 库存视频            │ │多张图片  │ │标题描述  │                       │
│ 音频                │ │导入日期  │ │清理状态  │                       │
│                     │ └─────────┘ └─────────┘                         │
└─────────────────────┴─────────────────────────────────────────────────┘
```

生产页：

```text
┌─ Production Desk ─┬────────── 生产参数/素材 ──────────┬─ PRODUCTION QUEUE ─┐
│ 生图               │ 供应商/模型                       │ 日期                │
│ 生提示词           │ promptMode / 模板 / PID           │ 全部 进行中 完成 失败│
│ 生视频             │ 参考图/视频/音频/拖拽上传          │ 任务进度/错误/入库    │
│                    │ 比例/时长/分辨率/count/后缀       │ 恢复/暂停/继续/取消   │
│                    │ [加入生产队列]                    │ 写入库存/查看详情     │
└────────────────────┴──────────────────────────────────┴─────────────────────┘
```

## 4. 账号与权限

### 4.1 三个角色

| 角色 | 能力 |
| --- | --- |
| `admin` 管理员 | 全部页面；新增/编辑/停用用户；切换任意运营员；查看和操作所有账号与任务 |
| `workspace` 工作台账号 | 工作台、账号资产、提示词/图片/视频生产、队列动作；不能访问账号控制和下游管理 |
| `operator` 运营账号 | 放映厅、下游、账号/PID 资产；工作台可按策略只读或执行；不能访问账号控制 |

当前 clean-room 的 owner 映射保留历史默认策略：`workspace` 映射到指定工作台 owner，`operator` 允许查看账号范围。是否改为严格 owner 隔离，需要业务确认。

### 4.2 管理员初始化

管理员初始登录名为 `admin`。密码只能通过当前环境初始化脚本/环境变量写入 scrypt 哈希；不得把明文密码写入源码、报告或日志。当前项目已支持在 D 盘 auth 数据目录初始化。

## 5. `/workspace` 工作台布局

### 5.1 左侧工作台 rail

- 运营人员选择器；管理员可切换，其他角色按 owner 限制。
- 账号类型：`精选账号`、`混剪账号`；显示真实分类计数。
- `INVENTORY COUNTER`：今日成功入库、今日完成未入库、处理中、失败待重试。
- 返回放映厅；管理员额外显示账号控制入口。

### 5.2 主区账号卡

每个账号卡为固定比例的横向卡片（接近历史截图比例），支持：

- 手动添加账号卡；
- 编辑账号名称、平台账号标识、owner、账号分类；
- 显示运营计划状态；
- 显示真实的提示词、图片、库存视频、发布数；
- 入口：运营计划、账号资产、生产；
- 没有数据时显示 0 和空状态，不显示假任务/假视频。

计划 drawer/modal 需要支持查看和保存计划状态；计划字段由业务确认后固定。

## 6. 账号资产模型与页面

### 6.1 四个一级分支

每个账号拥有独立页面：

1. 提示词（`prompt`）；
2. 图片（`image`）；
3. 库存视频（`inventory-video`）；
4. 音频（`audio`）。

### 6.2 图片页的二级板块（本次新增确认点）

图片一级页必须拆成两个可切换板块：

#### A. 素材图片

- 用户手动上传的参考图、拍摄图、风格图、场景图；
- 可在生图/生视频时作为 `referenceImages`；
- 每个资产记录 `assetId`、原始文件名、MIME、大小、创建时间、来源和所属账号；
- 上传文件保存在 `D:\all_projects\workspace\data\uploads\<accountId>`。

#### B. 商品图片

- 通过 PID 导入/商品同步得到的商品图；
- 目录按“账号/导入日期/PID”聚合，商品同一 PID 可有多张图片；
- 商品图片需保留 PID、商品标题、描述、来源日期、导入批次、图片列表和校验状态；
- 生视频模板模式按 PID 将商品图与 Excel 标题/描述匹配。

#### 商品图片定期清理（已按本轮确认固化）

商品图片不是 3000 自己生成的临时素材，而是通过 8765 的 PID 查询/下载接口导入的短期商品资料。清理规则已经确定，不再作为待确认项：

- 清理对象仅为“商品图片”板块，不触碰“素材图片”、提示词、音频、库存视频或生产输出；
- 业务时区固定为 `Asia/Shanghai`；每天凌晨 `00:00` 执行；
- 每次清理删除“当前日期往前三天及更早”的全部商品图片导入目录，即导入业务日期 `<= today - 3 days`；
- 即使商品图被生产任务引用、任务已经完成、任务已经写入库存，过期后仍然强制删除；不延迟、不豁免；
- 删除必须实际移除 PID 文件夹及其中图片文件，不能只标记 `expired`；
- 清理成功后不保留该商品图的 PID 元数据索引、导入批次索引、哈希或缩略图索引；
- 删除失败必须写入脱敏审计日志和失败记录，不能静默忽略；重复执行必须幂等；
- 清理服务支持 `dry-run` 预览和真实执行两种模式；正式定时任务使用真实执行；
- 清理前后记录真实扫描目录数、删除目录数、删除文件数、失败数；不使用演示数字；
- 服务启动时执行一次“错过午夜”的补偿清理，并持续按上海时区每天 `00:00` 调度，避免服务重启导致漏清理。

清理路径约定：

```text
D:\all_projects\workspace\data\product-images\<accountId>\<YYYY-MM-DD>\<pid>\
```

清理时按导入日期目录和 PID 目录执行路径安全校验，只允许删除上述 D 盘工作区内的商品图片目录。任务中的旧 `referenceTokens`、输出视频和库存成品不因商品图清理而删除；商品图本身按本规则删除。

### 6.2.1 8765 商品/PID 数据源与导入流程

商品图片必须通过外部 `8765` 服务取得，3000 不直接读取 NAS、C 盘或 8765 的内部文件系统。默认配置：

```env
WORKSPACE_8765_BASE_URL=http://127.0.0.1:8765
WORKSPACE_8765_TIMEOUT_MS=30000
```

已从历史对话确认的接口：

| 方法 | 路径 | 用途 | 当前证据 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/health` | 健康检查 | 返回 `{ success: true, data: { status: "ok" } }` |
| `GET` | `/api/v1/gallery` | 查询图库/PID | 支持 `query`、`membership`、`category`、`limit`、`offset` |
| `POST` | `/api/v1/gallery/import` | 导入图库记录 | 具体字段以 8765 实例 OpenAPI/响应为准 |
| `POST` | `/api/v1/gallery/check-pids` | 批量检查 PID | 用于导入前校验 |
| `POST` | `/api/v1/gallery/check-file` | 检查文件 | 用于文件存在性/类型校验 |
| `POST` | `/api/v1/gallery/sync-jspace` | 同步外部图库 | 仅作为 8765 侧同步动作，不并入 3000 执行器 |
| `PUT` | `/api/v1/gallery/{pid}` | 更新 PID 分类/元数据 | 3000 只在授权后调用 |
| `GET` | `/api/v1/gallery/{pid}/cover` | 获取 PID 封面 | 用于商品卡首图 |
| `POST` | `/api/v1/gallery/download-folder` | 下载 PID 文件夹 | 请求体历史格式为 `{ "pids": ["PID_1", "PID_2"] }` |

下载适配器的硬性约束（以历史实现记录为初始契约，接入当前 8765 实例后必须用脱敏 fixture 再锁定）：

- 单次请求最多 100 个 PID；超过上限必须在 3000 侧拆分为多个批次，不能把超限请求直接转发。
- 总下载体积上限约 500 MiB；3000 必须在流式下载时统计字节数，超限立即中止并删除临时文件。
- 请求前必须校验 PID 格式，并通过 `check-pids` 确认 PID 已存在；未知或未验证的 PID 不得进入下载请求。
- 预期响应为 ZIP/blob 文件流；适配器必须检查 `Content-Type`、`Content-Length`（如存在）和压缩包签名，不能仅凭文件扩展名信任响应。
- ZIP 解包必须拒绝绝对路径、`..` 路径、符号链接和跨账号目录；解包后的顶层 PID 目录只能落在当前账号/当前导入日期目录内。
- 文件名使用 UTF-8 或响应头声明的编码解析；无法安全解析的文件名按失败处理，不得写入工作区。
- 下载失败、超时、响应体过大、解包失败时，必须清理临时 ZIP 和部分落盘目录，并写入脱敏审计记录。
- 前端支持勾选下载和批量全选下载；未输入搜索条件时仍显示当前 PID 列表，不能因为 query 为空而伪造空结果。
- 商品封面使用 `GET /api/v1/gallery/{pid}/cover`，商品卡支持点击放大预览；封面失败时显示可读的空状态。

标准导入链路：

```text
3000 选择账号
→ 调用 8765 /gallery 查询 PID
→ 展示 PID、标题、描述、封面和可下载状态
→ 用户确认导入一个或多个 PID
→ 3000 调用 8765 /gallery/download-folder
→ 接收 zip/文件夹响应并校验大小、扩展名和 PID 路径
→ 解包到 D:\all_projects\workspace\data\product-images\<accountId>\<YYYY-MM-DD>\<pid>\
→ 仅写入商品图片二级板块
→ 记录真实导入结果
```

历史商品原图结构为“原图根目录/PID/001.jpg、002.jpg …”。3000 端只接受由 8765 返回的压缩包/文件流或明确的 HTTP 下载响应；禁止把任意本地路径、任意 URL 或跨账号路径直接当成商品图片来源。8765 的实际响应头、压缩包字段和错误格式需要在实现阶段先用本地实例录制为脱敏 fixture，再写 adapter 测试；在契约未被实例响应验证前，UI 显示“待连接 8765”，不能伪造商品图。当前本机只读探针结果：`GET /api/v1/health` 返回 200 和本地 clone 健康信息；历史约定的 `GET /api/v1/gallery` 当前返回 404，因此商品图查询/下载在当前实例仍不可宣称可用，必须先补齐 8765 路由或确认实际新路径。

### 6.2.2 商品池分类与业务商品分类

8765 历史图库同时存在两套互不覆盖的分类维度，3000 必须分开存储、筛选和展示：

| 维度 | 状态/取值 | 用途 |
| --- | --- | --- |
| 商品池归属 | `TAP`、`CAP`、`TAP+CAP`、`未收录`、`待查询`、`查询失败` | 表示 PID 是否属于 TAP/CAP 商品池 |
| 业务商品分类 | `服装`、`非服装`、`待确认` | 表示业务侧商品分类，不改变商品池归属 |

相关 8765 接口：`PUT /api/v1/gallery/{pid}/business-category`、`POST /api/v1/gallery/business-category/import`。业务分类导入接受 `.xlsx` 或 `.txt`：检查 Excel A 列 PID 或 TXT 每行 PID，生成按 TAP/CAP 分 Sheet 的结果 Excel；列表支持直接修改服装/非服装并即时刷新筛选。业务分类不得覆盖 TAP/CAP 字段，反之亦然。

### 6.3 提示词资产

- 名称 + 内容可创建、编辑、保存；
- 生产页快速选择模板；
- 模板内容不能伪造为已调用模型；
- 生产任务记录模板 ID、原始提示词、子提示词、最终提示词。

### 6.4 库存视频和音频

- 库存视频只收录真正完成并写入库存的成品，不能把 `completed` 自动当成库存；
- 音频支持口播、环境声、配乐等，provider 能力决定是否可选；
- 资产引用必须绑定当前账号，不能跨账号读取。

## 7. 提示词生产与缓存

### 7.1 模式

- 手写完整提示词（`manual`）；
- 资产模板生成子提示词（`asset-template-child-prompt`）。

### 7.2 字段

```json
{
  "promptMode": "manual | asset-template-child-prompt",
  "templateId": "账号提示词资产 ID",
  "promptModel": "子提示词模型 ID",
  "originalPrompt": "母提示词/原始输入",
  "childPrompt": "模型生成的子提示词",
  "finalPrompt": "最终发送给视频/图片 provider 的提示词",
  "suffixEnabled": false,
  "suffix": "统一后缀（来自已保存设置）"
}
```

模板模式需要：

- 选择商品图片或 PID；
- 可上传/恢复参考 Excel；
- 用 PID 匹配标题和描述；
- 生成子提示词并缓存到任务；
- 任务恢复时优先使用已缓存的子提示词，避免重复计费调用；
- 最终提示词弹窗可查看、复制和复核。

## 8. 生产表单

### 8.1 共同字段

- 供应商、模型；
- PID（可选，模板/商品图模式建议填写）；
- 原始提示词、最终提示词；
- 账号资产选择器；
- 本地文件拖入上传；
- 显示真实校验错误。

### 8.2 生图

- provider：MGRouter Grok Image、YuanAI Image；
- 比例：provider capability 提供的 `9:16 / 16:9 / 1:1`；
- 分辨率：`1k / 2k`；历史 MGRouter 契约不支持 4k，界面必须明确“不支持”，不能偷偷转换；
- 参考图上限按 provider（MGRouter 3 张、YuanAI 当前配置 4 张）；
- 创建后进入 image task queue；
- 任务完成后可预览/下载/重试。

### 8.3 生视频

- 模型先选、供应商按模型过滤；
- `modelId` / `supplierId`；
- promptMode、templateId、promptModel、childPrompt、finalPrompt；
- 时长、比例、分辨率按 capability 动态生成；
- 参考图片、参考视频、参考音频分别选择；
- 生成数量 `count` 1–4，创建为多个独立本地任务，不把 count 传给单次 provider 请求；
- 统一后缀开关；后缀只有服务端已保存版本才生效；
- 参考 Excel 上传/恢复、PID/标题/描述匹配；
- 生产页右侧固定为 `PRODUCTION QUEUE / 生产队列`，不显示模型目录。

## 9. Provider 契约（不含密钥）

### 9.0 历史模型/供应商目录

历史 `catalog.ts` / `server-catalog.ts` 证据显示，视频生产不是单一 Grok 页面，而是“先选模型，再筛选可用供应商”：

| 历史 modelId | 历史显示名 | 历史供应商 | 当前 clean-room 状态 |
| --- | --- | --- | --- |
| `grok` | Grok Imagine Video 1.5 | snumom / `grok-video` | 已接入契约 |
| `omni` | Omni | OAIRegBox / `oairegbox` | 能力已记录；当前 provider config 需补真实 transport 后再启用 |
| `minimax-h3` | MiniMax H3 | MiniMax / `minimax` | 历史请求依赖独立公网图片桥接；当前未启用旧凭据 |
| `seedance` | Seedance | Seedance / `seedance` | 历史目录存在；当前未启用未知 endpoint |
| `grok` | Grok Video | MGRouter / `mgrouter-grok-video` | 已接入契约 |
| `wan3.0-prime-r2v` | Wan 3.0 Prime R2V | ManjuAI / `wan3-video` | 已接入契约 |

历史图像目录包含 YuanAI、PomoAI/Gemini Image 与 MGRouter Grok Image；当前 D 盘版本明确启用 `mgrouter-grok-image`、`yuanai-image` 两个 provider。任何历史只出现名称、但没有可验证端点/请求体的供应商，必须在补齐契约和环境变量后才能进入 UI 的可用状态，不能显示为“已配置”。

历史提示词目录包含 GPT-2999/兼容 OpenAI Responses 与 YuanAI Gemini。当前实现使用 `promptModel` 字段保留选择能力，真实模型是否可用由当前环境变量决定。

### 9.1 原生 Grok 视频 / snumom

```text
POST https://snumom.com/v1/videos
GET  https://snumom.com/v1/videos/{providerTaskId}
GET  https://snumom.com/v1/videos/{providerTaskId}/content   # 无直接 URL 时 fallback
```

- 模型：`grok-imagine-video-1.5`（历史显示可能带“按次”文案）；
- 6–30 秒；`9:16 / 16:9 / 1:1`；`480p / 720p`；
- 0–7 张参考图；1 张使用 `input_reference`；2–7 张使用 `extra.reference_images`；
- 环境变量名：`GROK_VIDEO_API_KEY`、`GROK_VIDEO_BASE_URL`。

### 9.2 MGRouter Grok 图片

```text
Base: https://raw.mgrouter.com/v1
POST /images/generations
POST /images/edits       # 有参考图时
```

- `images: [{"url": "..."}]`；最多 3 张；分辨率 1k/2k；
- 环境变量名：`MGROUTER_API_KEY`、`MGROUTER_BASE_URL`。

### 9.3 MGRouter Grok 视频

```text
POST https://raw.mgrouter.com/v1/videos/generations
```

- 最多 7 张图、2 条音频；
- 自动补 `<AUDIO_0>`、`<AUDIO_1>` 占位符；
- `reference_images`、`reference_audios`；
- 使用 `MGROUTER_API_KEY`、`MGROUTER_BASE_URL`。

### 9.4 Wan 3 / ManjuAI

```text
POST https://api.manjuai.top/v1/videos/generations
GET  https://api.manjuai.top/v1/videos/tasks/{id}
```

- 模型：`wan3.0-prime-r2v`；
- 参考图最多 10、参考视频最多 5、音频最多 5；
- `media` 使用 `reference_image`、`reference_video`、`audio`；
- 环境变量名：`WAN_API_KEY`（若部署改名，必须同步配置文档和测试）。

### 9.5 YuanAI Gemini 提示词

```text
POST https://yuanai.uk/v1beta/models/{model}:generateContent?key=<runtime-key>
```

- 当前历史可用模型记录为 `gemini-2.5-flash`；
- 环境变量名：`GEMINI_PROMPT_API_KEY`、`GEMINI_PROMPT_MODEL`、`GEMINI_PROMPT_BASE_URL`；
- mock 模式不得冒充真实调用，任务 metadata 需记录 `execution: mock`。

### 9.6 真实调用前提

只有同时满足以下条件才允许开启 live：

1. 你在当前 D 盘 `.env.local` 配置 key；
2. 明确 provider 和 model；
3. 明确允许一次最小计费请求；
4. 明确允许本地素材通过短期公网 HTTPS bridge；
5. 明确允许下载结果到 D 盘；
6. 先跑 payload/mock/状态解析测试，再发起一次小任务。

## 10. 本地资产与公网引用桥接

### 10.1 D 盘目录

```text
D:\all_projects\workspace\data\uploads\<accountId>\...
D:\all_projects\workspace\data\assets\<accountId>.json
D:\all_projects\workspace\data\reference-bridge\cache\...
D:\all_projects\workspace\data\reference-bridge\registry.json
```

### 10.2 桥接规则

- 只接受当前账号已有的 image/video/audio 资产；
- 只允许 D 盘工作区内真实文件；
- 发布时复制为随机高熵 token，TTL 默认 1 小时；
- `WORKSPACE_PUBLIC_BASE_URL` 必须是纯 HTTPS origin；
- 公开路由只读、no-store、nosniff；
- provider Authorization 不透传给桥接请求；
- 任务完成/失败/取消后撤销引用，定时清理过期缓存；
- 禁止任意 URL 下载和跨账号 assetId。

## 11. 异步任务与生产队列

### 11.1 状态机

```text
draft → queued → prompting → submitting → submitted → processing/running
                                                        ├→ completed
                                                        ├→ failed
                                                        ├→ paused → queued
                                                        └→ cancelled
```

### 11.2 任务持久化字段

```json
{
  "id": "local task id",
  "accountId": "账号 ID",
  "mode": "image | video | prompt",
  "provider": "provider id",
  "model": "provider model",
  "prompt": "原始/最终提示词",
  "status": "queued",
  "progress": 0,
  "providerTaskId": "上游任务 ID",
  "outputUrls": [],
  "outputBase64": [],
  "inventorySavedAt": null,
  "metadata": {
    "pid": "",
    "assetIds": [],
    "referenceTokens": [],
    "promptMode": "manual",
    "templateId": "",
    "childPrompt": "",
    "finalPrompt": "",
    "execution": "mock | live"
  }
}
```

### 11.3 队列 UI

- 日期按 Asia/Shanghai；
- 全部 / 进行中 / 完成 / 失败；
- 8 秒轮询；
- 任务按创建时间倒序且按 ID 去重；
- 显示 provider、model、状态、进度、错误、provider task ID、入库状态；
- 未入库数量可跳转并高亮；
- 失败/取消：恢复；活跃：暂停/取消；暂停：继续；完成未入库：写入库存；终态允许删除；
- 活跃任务禁止删除；
- 右侧不放模型目录。

### 11.4 Mock 与 Live

- mock 任务也推进状态机，不能永远停在 queued；
- mock 不生成伪造视频 URL 或伪造统计，完成但无输出时输出数为 0；
- live 任务由后台 worker 提交、轮询、下载和落盘；GET 详情不应放大上游请求；
- provider 错误对前端分类化，详细信息只写脱敏日志。

## 12. 成品目录与入库

历史对话确认的视频导出聚合规则：

```text
导出根目录/<用户名>/YYYYMMDD/<PID>/
```

同一账号、同一天、同一 PID 的参考图和多个视频放在同一 PID 文件夹，视频使用不覆盖的序号命名（例如 `PID_001.mp4`、`PID_002.mp4`）。

入库动作必须：

- 幂等；
- 验证任务属于当前账号；
- 只有 completed 且有真实输出才允许写入库存；
- 写入 `inventorySavedAt`；
- 成功后更新账号资产和今日统计；
- 失败保留任务错误，不把 completed 改成成功入库。

### 12.1 账号—PID—视频—发布关系

生产、入库和发布必须是可追溯的独立关系，不能只保存一个“账号有视频”的计数：

- 每条任务记录 `accountId`、`pid`、`provider`、`model`、输出文件和创建/完成时间。
- 每个账号可配置负责人（owner）、账号类型（精选/混剪）和每日运营计划；账号与 PID 的归属关系单独记录，不覆盖商品池 TAP/CAP 状态。
- “生产视频”“写入库存”“挂车”“发布”是四个不同动作；完成生产不代表已入库，已入库也不代表已发布。
- 发布记录必须保留账号、PID、视频文件、发布时间、发布结果以及外部平台视频 ID/链接（如外部发布器返回）。
- TAP 挂车流程与 CAP 挂车流程分开记录：TAP 为商品列表→链接/二维码→账号扫码；CAP 为加入后台→创建商品集→分享给账号。
- 同一账号、日期和 PID 下的多条输出必须聚合到同一 PID 目录，并使用不覆盖的序号文件名。

### 12.2 批次与同步处理规则

涉及 PID 批量处理时，批次名固定为 `YYYY-MM-DD_<PID数量>PID_<序号>`，序号使用阿拉伯数字。批次列表默认显示当天批次，可按日期回溯历史；一个批次只保存一个 Excel，结果继续清洗汇总到主表，更新主表时不得生成“汇总1/汇总2”等副本，也不得因本次结果为空覆盖历史有效数据。

批次状态必须包含本地处理和极空间同步结果；批次支持暂停、删除，前一批完成后可自动开始下一批。暂停时关闭对应 BitBrowser 窗口，后续批次可复用窗口；批次结束清理临时标签页和窗口。以上执行器仍属于 8765/9001/10000 等外部系统，3000 仅展示状态、输入和回流结果。

## 13. API 清单

### 13.1 认证

```text
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
GET  /api/auth/users              # admin
```

### 13.2 工作台和账号

```text
GET/POST       /api/workspace/accounts
GET/PATCH      /api/workspace/accounts/:id
GET            /api/workspace/accounts/:id/files?kind=...
POST           /api/workspace/accounts/:id/files
```

### 13.3 生产

```text
POST GET       /api/workspace/accounts/:id/generate-prompt
POST GET       /api/workspace/accounts/:id/generate-image
POST GET       /api/workspace/accounts/:id/generate-video
GET            /api/workspace/accounts/:id/prompt-tasks
GET/POST       /api/workspace/accounts/:id/prompt-tasks/:taskId
GET            /api/workspace/accounts/:id/image-tasks
GET/POST/DELETE /api/workspace/accounts/:id/image-tasks/:taskId
GET            /api/workspace/accounts/:id/video-tasks
GET/POST/DELETE /api/workspace/accounts/:id/video-tasks/:taskId
GET            /api/workspace/references/:token
HEAD           /api/workspace/references/:token
```

### 13.4 观测

```text
GET /api/dashboard
GET /api/earnings-trend
GET /api/workspace/earnings
GET /api/workspace/video-stats
GET /api/health
```

## 14. D 盘存储边界

项目代码、`.next`、数据库、Prisma、上传、任务、桥接缓存、日志、npm cache、测试临时目录和导出结果必须位于：

```text
D:\all_projects\workspace
```

运行脚本必须将 npm cache 指向 `D:\all_projects\.npm-cache`。不得新增 C 盘项目备份、数据库、上传、日志或构建产物。历史 C 盘源码仅作为 clean-room 证据，不能继续写入。

## 15. 验收流程

### 15.1 本地无费用验收

```text
登录 admin
→ /workspace
→ 添加/编辑账号
→ 账号资产：提示词、素材图片、商品图片、视频、音频
→ 保存提示词模板
→ 生产页选择模板/PID/资产
→ 拖入本地图片/视频/音频
→ 创建 mock 生图/生视频/提示词任务
→ 队列轮询推进
→ 查看详情、提示词、输出和错误
→ 重试/暂停/继续/取消
→ 完成后写入库存
→ inventorySavedAt 和真实统计更新
→ 运行商品图片清理 dry-run
```

### 15.2 真实 provider 验收

一次只验一个 provider/model；先确认费用与公网桥接，再执行最小素材、最短时长、最低分辨率任务。验收记录必须包含：请求端点、脱敏请求体、响应状态、providerTaskId、轮询终态、输出文件路径、库存时间和清理结果。

### 15.3 交付命令

```powershell
cd D:\all_projects\workspace
npm run typecheck
npm test -- --run
npm run build
.\check-storage.ps1
```

## 16. 已确认事项与仍待确认事项

### 16.1 本轮已经确认并写入实现基线

1. 图片页正式采用“素材图片 / 商品图片”两个二级板块。
2. 商品图片通过 8765 的 PID 查询接口发现，通过 8765 的下载接口导入，不从 3000 伪造或直接读取外部文件系统。
3. 商品图片每天按上海时区凌晨 `00:00` 清理。
4. 清理范围为当前日期往前三天及更早（导入日期 `<= today - 3 days`）的全部 PID 商品图片目录。
5. 被任务引用、已经入库或被其他业务标记使用的商品图片，过期后仍然强制清理。
6. 清理时实际删除商品图片目录，同时删除 PID 元数据索引、导入批次索引、哈希和缩略图索引，不保留“已清理”索引。
7. `grok-imagine-video-1.5` 是否需要带“（按次）”必须以一次用户授权的最小真实请求/供应商响应为准；历史文案和历史请求体出现过带“（按次）”版本，当前不能仅凭猜测固化其中一个。
8. 供应商清单必须区分“契约完整可实现”“有部分历史证据但缺契约”“只有 UI/讨论痕迹”，缺契约的 provider 不得显示为已配置。
9. natapp 仅作为暴露 3000 的外部隧道，不纳入业务数据或 provider 逻辑；authtoken 不写入项目、文档、日志或源码。

### 16.2 仍需你在进入真实生产前确认

1. `operator` 是否可以查看全部账号，还是必须按 owner 隔离。
2. 账号卡上的运营计划字段、状态值和保存方式是否需要增加。
3. 8765 导入是否还需要在 3000 侧支持 Excel/PID 批量导入和手动上传入口；当前已确认的商品图来源是 8765 查询/下载。
4. 真实验收优先的 provider/model 顺序，以及每个 provider 是否只做一次最小计费请求。
5. 是否允许临时公网 bridge 使用你的服务器/Cloudflare 域名；`WORKSPACE_PUBLIC_BASE_URL` 由谁维护。
6. 是否允许真实 provider 任务下载成品到 D 盘，并在任务详情中写入库存。

### 16.3 本轮不阻塞文档审阅的技术验证项

- 8765 的具体下载响应头、压缩包 MIME、文件名编码和错误体，需要连接实际 8765 实例后录制脱敏 fixture，再锁定 adapter 测试；在此之前 UI 只能显示待连接/空状态。
- natapp 的隧道建立问题需要读取本机 natapp 版本、参数和前台脱敏日志；本文件不保存 authtoken，也不代表隧道已建立。
- Grok 模型显示名与远端 model id 的“按次”差异需要真实响应或供应商文档验证，历史记录本身不足以证明当前网关接受哪一种字符串。

## 17. natapp 暴露 3000 的边界与诊断记录

natapp 只负责把本地 3000 HTTP 服务暴露到公网，业务请求、商品图片、provider 凭据和任务数据仍由 workspace 自己处理。natapp authtoken 属于秘密凭据，不写入本项目、审阅文档、日志、截图或回复。

当前已知本机状态：

- 3000 服务曾监听 IPv6 wildcard `:::3000`；
- 历史启动方式建议绑定 IPv4 `0.0.0.0:3000`，以兼容只回源 IPv4 的隧道客户端；
- 本机存在 `C:\Users\EDY\natapp.exe` 和历史启动脚本，但隧道是否建立不能仅凭文件存在判断；
- 诊断必须前台运行 natapp，读取并脱敏版本、参数、回源错误和远端 URL；禁止把 token 拼进新的项目脚本或日志；
- 在确认隧道可回源前，不把 natapp URL 当作 `WORKSPACE_PUBLIC_BASE_URL`，也不允许 live provider 使用未验证的公网桥接。

推荐诊断顺序：

```text
确认 natapp 版本/帮助
→ 确认 3000 绑定 0.0.0.0 且本机 curl 可访问
→ 前台启动 natapp（token 只从本机已有安全配置读取）
→ 记录脱敏的连接阶段、远端 URL、HTTP 回源状态
→ 从公网访问健康检查和 reference bridge HEAD
→ 仅在回源稳定后配置 WORKSPACE_PUBLIC_BASE_URL
```

## 附录 A：历史证据索引与可信度

本规格不是凭空设计，主要证据来源如下：

| 证据文件 | 内容 | 可信度/用途 |
| --- | --- | --- |
| `recovery/workspace-layout-spec.md` | 3000 路由、全局壳层、工作台两栏布局、角色矩阵 | 已整理的 3000 专项摘要，作为路由和布局基线 |
| `recovery/production-queue-history.md` | 生产队列日期筛选、状态、轮询、未入库跳转和任务动作 | 已整理的队列行为证据 |
| `recovery/vp_full_50.txt` | 历史 VideoProductionPanel 字段、模板/子提示词、Excel、后缀、队列与预览 | 接近完整的历史组件快照，字段复刻依据 |
| `recovery/vp_01a05be7-24bc-7ac2-a51a-6b5d182aff14_44.txt` | 视频生产组件类型、资产选择、恢复和提交逻辑 | 组件细节补充 |
| `recovery/provider-concrete-messages.txt` | Grok、MGRouter、Wan、Gemini 的端点、请求体、轮询和真实验收记录（密钥已排除） | provider 契约与错误边界依据 |
| `recovery/provider-history-evidence.md` | 历史源码路径、图片/视频 provider 变更、原图/PID/图库逻辑 | 交叉验证和边界说明 |
| `recovery/provider-thread-details.txt` | 资产目录、原图归档、任务处理器、数据库和历史工作流讨论 | 资产与异步处理的补充证据 |
| `recovery/queue_ui_snapshot.txt` | 队列右栏视觉结构、未入库跳转、日期控件 | 生产队列 UI 细节 |
| `recovery/all_keyword_history.txt` | 工作台、账号、PID、TAP/CAP、原图/商品资产和外围系统关键词索引 | 发现遗漏功能和外围边界 |
| `E:\.codex\thread_history_1.sqlite` | 原始 Codex 线程数据库 | 只用于查证；不复制其中的 key、Cookie、密码或 auth 文件 |

### 证据等级

- **A：历史明确出现并有接口/字段/路径证据**：路由、角色、队列状态、Grok/MGRouter/Wan/Gemini 契约、模板字段、导出聚合目录。
- **B：历史对话多次提及但缺少当前可运行源码**：账号计划字段、部分商品导入来源、部分 provider 的真实下载细节。
- **C：由你本轮明确补充、现已确认并纳入实现**：图片页“素材/商品”二级板块、商品 PID 图片三天清理精确定义、8765 查询/下载来源和每日午夜清理约束。

### 明确排除的内容

- 历史对话中的 API key、Bearer token、Cookie、密码、浏览器 auth state、第三方登录态；
- 历史 C 盘项目的构建产物和备份；
- 8765 TK 图像工作台或 9001/9999/10000 的执行器源码直接并入 3000；
- 没有真实来源的统计数字、任务、视频、商品和趋势数据。
