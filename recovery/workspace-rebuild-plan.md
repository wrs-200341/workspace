# workspace 历史工作台完整复刻计划

目标：以 `E:\.codex` 中可验证的历史对话、恢复报告和接口证据为准，逐阶段复刻 3000 放映厅的工作台布局、路由、资产、提示词缓存、上传、生产队列和 provider 接入；所有演示参数先恢复为 0，禁止使用无法追溯的假数字。

## 执行规则

- 项目代码、数据库、上传、缓存、日志、任务和构建产物只允许位于 `D:\all_projects\workspace`。
- 不复制历史 API key、Bearer token、Cookie、密码或认证文件。
- 默认不发起真实计费请求；真实 provider 验收必须在密钥通过环境变量注入、明确 provider/模型、明确费用和用户确认后进行。
- 每个阶段都必须先写测试/验收条件，再实现，再运行 typecheck、测试和 build。
- 所有阶段结束后做一条完整链路验收：登录 → 工作台 → 账号 → 资产 → 提示词模板 → 上传素材 → 生产任务 → 队列轮询 → 任务详情 → 入库状态。

## 阶段表

| 阶段 | 复刻范围 | 主要路由/模块 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| 0 | 历史证据盘点与数据归零 | `recovery/*`、`src/data/*`、`src/lib/workspace/*` | 历史证据可追溯；界面演示数字全部为 0；D 盘存储检查通过 | 进行中 |
| 1 | 全局壳层与导航布局 | `/`、`/downstream`、`/workspace`、`AppShell`、全局 CSS | 顶栏、侧栏、面包屑、角色入口与历史布局一致；375/768/1024/1440 宽度无横向滚动 | 待开始 |
| 2 | 角色与账号控制 | `/login`、`/admin/accounts`、`/api/auth/*` | `admin/workspace/operator` 权限矩阵一致；越权页面重定向；API 返回 401/403 | 待开始 |
| 3 | 工作台账号与运营计划 | `/workspace`、`/api/workspace/accounts*` | 运营员筛选、精选/混剪切换、账号卡编辑、新增、计划保存与刷新持久化 | 待开始 |
| 4 | 账号资产四分支 | `/workspace/accounts/:id/assets/*`、files/asset store | 提示词、图片、库存视频、音频各自独立页面；列表、空状态、上传和 D 盘持久化正确 | 待开始 |
| 5 | 提示词缓存与生产材料 | prompt assets、模板编辑器、`generate-prompt` | 模板可创建/编辑/保存；生产页可快速选择模板；最终提示词和子提示词可复核 | 待开始 |
| 6 | 生图生产 | `production?mode=image`、image APIs | 模型、比例、分辨率、参考图参数按 provider 适配；任务可创建、轮询、失败恢复 | 待开始 |
| 7 | 生视频生产 | `production?mode=video`、video APIs | Grok/MGRouter/Wan 参数、参考图/视频/音频、时长/比例/分辨率和拖拽素材链路可用 | 待开始 |
| 8 | 生产队列 | `ProductionQueue`、task store、任务动作 | 全部/进行中/完成/失败、上海日期、8 秒轮询、未入库跳转、高亮、暂停/继续/取消/恢复/删除 | 待开始 |
| 9 | 任务详情与库存 | TaskReview、任务详情 API、inventory | 持久化任务详情可见；提示词/输出/元数据可复核；入库幂等；完成不等于入库 | 待开始 |
| 10 | Provider 真实适配验收 | provider client/config/payloads | 先 mock 合同测试，再使用用户确认的环境变量做单次低风险真实请求；禁止硬编码凭据 | 待开始 |
| 11 | 全链路回归与交付 | Playwright/HTTP smoke、README、recovery | 登录到入库完整流程通过；typecheck/test/build/audit/storage 全通过；D/C 盘边界复核 | 待开始 |

## 当前已知历史契约

- 工作台生产页右侧是 `PRODUCTION QUEUE / 生产队列`，不是模型目录。
- 生产队列按上海时区筛选，支持全部/进行中/完成/失败。
- “未入库 N 条”只统计当天已完成但没有 `inventorySavedAt` 的视频任务。
- 只有真实入库后的视频才计入今日成功视频。
- 3000 是观测与复盘系统，不替代 9001 选品或 9999/10000 视频执行器。
- 历史源码镜像主要为零字节壳，当前项目采用 clean-room 复刻，不能把目录清单误当成可运行源码。

## 每阶段固定验收命令

```powershell
cd D:\all_projects\workspace
npm run typecheck
npm test -- --run
npm run build
.\check-storage.ps1
```

