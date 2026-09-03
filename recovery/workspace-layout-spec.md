# Workspace 路由与布局复刻规格

本文档仅记录从 `E:\.codex` 历史对话快照中提取的 3000 放映厅工作台证据，作为 D 盘项目的 clean-room 实现规格；不包含任何 API key、Cookie 或密码。

## 路由

| 路由 | 页面职责 | 历史证据 |
| --- | --- | --- |
| `/` | 放映厅总览、出单趋势、账号排行、视频归因 | 首页快照与 `01a01e71` 流程讨论 |
| `/workspace` | 运营工作台、运营员切换、账号分类、计划状态 | 3000 Chrome snapshot `url=http://127.0.0.1:3000/workspace` |
| `/workspace/accounts/:id/assets` | 账号资产，按 PID 汇总图片、提示词、视频 | 工作台账号卡“账号资产”链接 |
| `/workspace/accounts/:id/production?mode=image` | 生图 | Production Desk 导航 |
| `/workspace/accounts/:id/production?mode=prompt` | 生提示词、模板和子提示词 | Production Desk 导航 |
| `/workspace/accounts/:id/production?mode=video` | 生视频、供应商路由、任务参数 | Production Desk 导航 |
| `/workspace/accounts/:id/production/video-tasks/:taskId` | 视频任务详情、轮询、预览、入库 | 历史实现命名线索 |
| `/workspace/accounts/:id/production/image-tasks/:taskId` | 图片任务详情与重试 | 历史实现命名线索 |
| `/downstream` | 发布后视频、PID、账号、播放、点击、订单、GMV | 下游快照 |
| `/accounts` | 账号资产和表现 | 外围页面 |
| `/products` | 商品/PID、TAP/CAP 货盘 | 外围页面 |
| `/records`、`/tracked` | 发布记录、账号追踪 | 下游导航快照 |
| `/admin/accounts` | 管理员账号控制 | 当前项目角色策略 |

## 工作台页面结构

1. 顶部：当前运营人员选择器、可编辑/只读标记、返回放映厅；管理员可切换查看所有运营员。
2. 左侧分类栏：`WORKSPACE` 类型；`精选账号` 与 `混剪账号` 按钮；分类计数；今日视频入库计数。
3. 主区：当前运营员与分类标题；账号卡网格；每张卡展示计划状态、prompt 数、图片/视频数，并提供“运营计划”“账号资产”“生产”入口。
4. 生产页：左侧 `PRODUCTION DESK` 导航（生图 / 生提示词 / 生视频），主区按模式显示输入、输出和任务结果。

## 生产模式关键字段

- Prompt：商品/PID、标题描述、参考图、模板选择、手写提示词、子提示词、最终提示词、模板保存。
- Image：图片模型、比例、分辨率、1–4 张参考图、任务创建、轮询、失败重试。
- Video：Grok / YuanAI / Wan / MGRouter、提示词、时长、比例、分辨率、参考图/视频/音频、生成数量 1–4、统一后缀、预览与入库。

## 任务状态与计数规则

```text
draft -> queued -> submitting -> submitted -> processing
                                          ├-> completed
                                          ├-> failed
                                          └-> cancelled
```

只有 `completed` 且存在视频文件、真正写入库存（`inventorySavedAt`）的任务，才能进入“今日成功视频”计数。直接上传库存的视频以文件 `createdAt` 计数；同一视频重复入库必须幂等；业务日期使用 Asia/Shanghai。

## 角色矩阵

- `admin`：全部页面、所有账号和生产任务、账号控制。
- `workspace`：工作台、账号资产、生产页及 prompt/video/image 任务执行；不能访问下游和账号控制。
- `operator`：放映厅首页、下游、账号/PID 资产、工作台只读或执行；不能访问账号控制。

未登录页面返回登录重定向；API 未登录 `401`，角色不符 `403`。

## 当前 clean-room 实现状态

- 已实现：工作台两栏布局、运营员选择器、精选/混剪分类筛选、运营计划 Drawer、今日入库/未入库计数、生产队列状态筛选、日志和成品交付面板。
- 已实现路由：`/workspace`、`/workspace/accounts/:id/assets`、`/workspace/accounts/:id/production?mode=image|prompt|video`、视频/图片任务详情、历史兼容入口 `/entry`。
- 已实现 API：`/api/workspace/accounts`、`/api/workspace/video-stats`、`/api/workspace/earnings`、账号 files、prompt/video 任务列表与详情动作接口。
- 已实现规则：Asia/Shanghai 业务日期、`inventorySavedAt` 入库计数、重复入库幂等、任务 retry/pause/resume/cancel、账号归属校验、401/403 角色控制、D 盘存储约束。
- Provider 层已接入安全 clean-room 契约：Grok/snumom 视频、MGRouter Grok 图像/视频、Wan3/ManjuAI 视频、YuanAI Gemini 提示词和 YuanAI 图片；默认 mock，只有显式开启 live 开关并配置环境变量后才会外呼。
- 尚未实现：真实数据库持久化、真实资产上传/删除/下载、provider 轮询与库存文件落盘；这些能力需要在获得明确授权、配置费用与公网素材策略后继续接入。
- 历史 `8765` 的 TK 图像工作台批次/图库快照属于另一项目，不应并入 3000 放映厅路由。
