# 3000 放映厅 / 工作台历史深度扫描

扫描时间：2026-09-02（北京时间）  
扫描范围：`E:\.codex\thread_history_1.sqlite`、`E:\.codex\state_5.sqlite`、`E:\11\Users\EDY\Desktop\集成`、`E:\22\Users\EDY\Desktop\集成`。  
安全边界：只读历史数据库和恢复镜像；没有覆盖当前 `.codex`，没有复制认证文件、cookie、API key 或 token。

## 1. 历史数据库和恢复边界

- `thread_history_1.sqlite` 可正常打开，`PRAGMA integrity_check` 为 `ok`；`thread_items` 约 38,953 条。
- 正文中命中“3000”的线程共 20 个、命中文本 item 139 条（用户 12 条、助手 127 条）。
- `state_5.sqlite` 中能看到每个线程的 `rollout_path`，主要指向 `C:\Users\EDY\.codex\sessions\2026\08-09\rollout-*.jsonl`。
- E 盘当前未发现可用的 `sessions` rollout JSONL，因此不能可靠 `resume` 原线程；应以 `thread_items.item_json` 提取的用户/助手正文作为恢复证据。
- 恢复镜像 `E:\11\Users\EDY\Desktop\集成` 与 `E:\22\Users\EDY\Desktop\集成` 的源码文件虽然保留原始长度和目录结构，但抽样检查显示全部内容为零字节（例如 `package.json`、`src/app/api/dashboard/route.ts` 首字节全为 `00`）。它们只能作为目录/文件清单线索，不能直接作为可运行源码基线。
- 当前 clean-room 克隆位于 `D:\all_projects\workspace`，依据历史契约重建，并明确将数据、日志、上传和导出隔离在 D 盘。

## 2. 关键业务定义（线程证据）

### 线程 `01a01e71-0bda-7dc3-adaa-5d625a4a5af1`

用户时间：2026-08-20 18:23、19:33（上海时间）。

- 业务优先级：提高商品成交额/利润；让更多 TikTok 账号稳定出单；提高视频爆款率。核心痛点是选品后整条链路没有系统化、可追踪、可反馈的闭环。
- 系统边界：`9001` 是已有选品系统；`3000` 是放映厅；`9999` 与 `10.1.10.146:10000` 是搓视频系统。不要把所有执行器粗暴合成单体。
- `PID` 始终表示 TikTok 商品 ID；`TAP` 是全托货盘发货；`CAP` 是本土发货货盘。
- “挂车”实际是把商品挂入账号橱窗；TAP/CAP 的挂车方法不同。只有挂车成功后，发布视频时才能选择对应橱窗商品。
- 搓视频由人工选择模型、提示词和参考商品图；10000 侧根据商品图文件名提 PID，再匹配标题/描述 Excel，用 AI 母提示词生成子提示词后批量生视频。
- 四位运营负责账号分类和计划，账号数量/类目可由运营维护；运营应明确 PID 投放到哪些账号、每个 PID 生成几条视频。
- 发布以前主要是随机账号、随机视频、随机商品，缺少 `PID—账号—视频文件—发布时间—结果` 关系；需要通过统一计划和 3000 回收数据形成复盘闭环。

### 线程 `01a01eb2-d2c0-7571-8439-fc7993924e3c`

用户/助手时间：2026-08-20 18:24-18:25。

- 放映厅职责被明确为流程之外/流程之后的数据看板，用于观测机构账号发布视频的播放、点击、订单和成交等表现，不替代 9001 选品或 9999/10000 生产执行。
- 建议流程：`9001 选品 → 商品资料/图片 → AI 分类与人工复核 → PID/账号计划 → TAP/CAP 挂车 → 人工确认挂车成功 → 视频生产 → 发布任务 → 发布结果/PID 归因 → 3000 放映厅 → 运营复盘`。
- 计划模型：一个运营总计划包含挂车批次、视频生产批次、发布批次；系统统一任务状态、失败重试、异常处理和数据回流，执行器保持解耦。

### 线程 `01a018fd-6d63-7c52-9138-41dbcec0da99`

用户时间：2026-08-19 15:48；助手结论：

- 3000 服务端访问 `127.0.0.1:9001/api/earnings/daily-trend`。
- 该 9001 接口被设计为内部趋势接口，回环请求不经过网页登录校验；3000 不应模拟或硬编码管理员密码。
- 如果未来 3000 与 9001 跨机器/容器部署，使用两端一致的 `EARNINGS_TREND_TOKEN`，而不是 `admin` 密码。

## 3. 3000 / 工作台相关历史变更

### 线程 `01a041f1-8393-7042-8d3b-10faef8a00e3`

用户时间：2026-08-27 14:39、14:41；助手结论：

- `/downstream` 顶部增加“工作台 ↗”，只对 `operator` 运营账号显示；工作台原有 `admin/workspace/operator` 访问模型保持不变。
- `/workspace/accounts/{id}/production?mode=prompt|video` 的“手写完整提示词”支持另存为账号私有 `video` 模板；下次页面加载可选择模板。
- 相关契约位置（来自历史）：`src/lib/auth/roles.ts`、`src/components/user-badge-links.ts`、`src/components/UserBadge.tsx`、`src/app/downstream/page.tsx`、`VideoProductionPanel.tsx`、`prompts/route.ts`。
- 历史验证：Vitest 约 84 个测试文件/487 条断言通过，TypeScript、Next build、npm audit 通过；3000 健康检查为 200。

### 线程 `01a05ba1-6742-77c2-997f-3617430ce501`

用户时间：2026-09-01 14:26、18:02；助手结论：

- 工作台“今日成功视频数”先改成“每日点击入库次数”，按上海自然日统计；同一个视频重复点击入库必须幂等。
- 用户随后明确改为按库存视频实际入库时间统计：生成任务使用 `inventorySavedAt`；直接上传库存的视频使用库存文件 `createdAt`；未入库的生成视频不计入；历史 `chenxi` 示例统计为 8 条。
- 生产队列显示“今日未入库 N 条”，只计算上海时间当天、状态 `completed` 且 `inventorySavedAt` 为空的任务；点击“跳转”后切到今天/全部并高亮首条未入库任务。
- 关键状态语义：本地处理与远端同步分开；只有 `sync_stage=synced` 才显示 100% 完成；`completed`、`failed`、`cancelled` 都必须做资源清理；暂停在重启后保持暂停。
- 历史验证：116 个测试文件、698 个测试通过；TypeScript/build/健康检查通过（仓库原有全局覆盖率低于 80%）。

### 线程 `01a03821-d909-7ed3-95bc-11d4faf4189d`

用户时间：2026-08-25 16:55。记录了生产板块 Grok 视频能力契约：

- 浏览器先 POST `/api/workspace/accounts/{accountId}/generate-video` 创建本地任务；后台再调用供应商。
- 上游为视频生成 POST `/v1/videos`，轮询 GET `/v1/videos/{providerTaskId}`；支持 6–30 秒、`9:16/16:9/1:1`、`480p/720p`；1 张参考图使用 `input_reference`，2–7 张使用 `extra.reference_images`。
- 供应商密钥必须走环境变量，不能写源码或历史恢复稿。

### 线程 `01a05783-2715-73b2-a8b5-f5d9db58b459`

用户时间：2026-08-31 19:10。记录了 YuanAI Gemini 生子提示词链路：

- 公开模型 ID `gemini-yuanai`；默认实际模型曾为 `gemini-2.0-flash`，后续因网关可用性改为 `gemini-2.5-flash`。
- 请求地址形如 `https://yuanai.uk/v1beta/models/<model>:generateContent?key=<key>`；密钥只应通过环境变量注入。
- 历史消息中包含过真实 key，但本扫描和恢复项目均已脱敏，不复制、不回显。

### 线程 `01a04273-5444-70a1-84ae-7268a954f8f8`

用户时间：2026-08-27 至 2026-08-28。记录 Wan/MGRouter/Grok 多参考图与音频实验接入，随后用户澄清“先测试供应商，不要擅自接入 3000”；因此恢复项目只保留能力目录和 mock 状态，真实供应商接入需要新的明确授权与环境配置。

## 4. 路由与 API 契约清单

历史确认的核心页面：

| 路由 | 作用 | 权限/数据边界 |
|---|---|---|
| `/` | 放映厅总览/KPI、收益趋势、账号排行、最近视频、同步提醒 | 运营/管理员可见 |
| `/downstream` | 下游视频明细，按 PID/账号/发布时间观察播放、点击、订单、GMV | 运营/管理员；运营账号显示工作台入口 |
| `/workspace` | 运营工作台、生产队列、入库与发布前归因准备 | `operator/workspace/admin` |
| `/workspace/accounts/{id}/production` | 账号生产配置；`mode=prompt|video` | `operator/workspace/admin` |
| `/accounts` | 账号资产、负责人、类目、健康状态 | 运营/管理员 |
| `/products` | 商品/PID、TAP/CAP 货盘、覆盖账号、视频和成交贡献 | 运营/管理员 |
| `/records`、`/tracked` | 记录/追踪账号辅助页面 | 依现有角色策略 |

历史确认的 API：

| 方法与路径 | 用途 |
|---|---|
| `GET /api/health` | 应用与数据库健康检查，目标 HTTP 200 |
| `GET /api/earnings-trend?range=week|month|year` | 3000 服务端代理 9001 daily-trend；上游不可用时返回脱敏 mock/cache |
| `GET /api/dashboard` | 放映厅 KPI/汇总数据（历史项目接口） |
| `GET /api/downstream/accounts` | 下游账号数据 |
| `GET /api/downstream/products` | 下游商品/PID 数据 |
| `GET /api/downstream/videos` | 下游视频明细与归因指标 |
| `POST /api/workspace/accounts/{id}/generate-video` | 创建视频生产任务；后台供应商调用与轮询解耦 |
| `POST /api/workspace/accounts/{id}/generate-prompt` | 生成子提示词/提示词任务 |
| `GET /api/workspace/accounts/{id}/files` | 账号素材/任务文件列表 |
| `GET/POST /api/auth/me`、`/api/auth/login`、`/api/auth/logout` | 会话和角色鉴权 |

## 5. 工作台状态机（恢复实现应遵守）

视频任务的最小状态路径：

```text
queued → running → completed → (inventorySavedAt 写入) → ready_for_publish
                  ↘ failed → retry / cancelled
queued/running → paused → queued/running（重启后仍保持 paused）
```

约束：

1. `completed` 只表示视频生成完成，不等于已经入库或同步完成。
2. 入库动作要以库存实际写入时间为准；重复入库必须原子幂等。
3. 终态（`completed`、`failed`、`cancelled`）统一清理临时标签页、浏览器窗口、临时文件和锁。
4. 本地处理进度、远程同步进度分开展示；只有远程 `synced` 才显示 100%。
5. 生产队列“今日未入库”只统计上海当天完成但没有 `inventorySavedAt` 的任务。

## 6. E 盘恢复目录证据

- `E:\11\Users\EDY\Desktop\集成`、`E:\22\Users\EDY\Desktop\集成` 目录结构完整，包含 `src/app/api/dashboard`、`src/app/api/downstream/*`、`src/app/workspace`、`src/lib/workspace/production`、`prisma`、`README.md` 等。
- 但抽样的 40+ 个 `.ts/.tsx/.json/.md` 文件内容全部为 0 字节填充，无法解析 AST、运行 TypeScript 或恢复 Prisma schema；不要从其“文件大小”误判源码可用。
- `E:\22\Users\EDY\TKWorkflowData` 与 `E:\11\Users\EDY\TKWorkflowData` 保留了大量批次/商品 JSON 和媒体产物，可作为脱敏样本和目录结构参考；不要复制其中认证 cookie 或供应商凭据。

## 7. 当前 D 盘 clean-room 项目状态（供主 agent 继续）

项目：`D:\all_projects\workspace`。已提供：

- Next.js + TypeScript + Vitest 隔离副本；所有运行数据写入 `D:\all_projects\workspace\data`。
- `/` 放映厅首页、`/downstream`、`/workspace`、账号/商品页面、生产页、登录/管理员页面。
- `GET /api/health`、`GET /api/earnings-trend` 及 mock downstream/workspace API。
- 角色：`admin`、`workspace`、`operator`；密码只存 D 盘 scrypt 哈希。
- `EARNINGS_API_URL` + 可选 `EARNINGS_TREND_TOKEN` 的 9001 服务端代理；无硬编码凭据。
- `RECOVERY_NOTES.md` 已说明源码壳为 0 字节、D 盘隔离和真实供应商接入边界。

后续实现建议：先用 D 盘 mock 数据和现有页面完成可验证闭环（路由、鉴权、KPI、收益趋势、视频/账号/PID 明细、工作台任务状态），再根据用户明确授权逐个接入 9001、8003、9999/10000、BitBrowser、Grok/YuanAI/Wan；不要把历史密钥或 cookie 写入代码、`.env` 以外的报告或提交。
