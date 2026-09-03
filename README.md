# workspace（3000 放映厅）

这是根据 E 盘 Codex 历史对话和恢复镜像重建的 3000 端口放映厅。项目正式名称为 `workspace`，所有项目文件、构建产物、依赖、日志、数据库和运行数据统一放在 `D:\all_projects\workspace` 下。原始源码路径为 `E:\11\Users\EDY\Desktop\集成`，但恢复镜像中的源码文件被清零，因此本项目最大化保留了历史确认的技术形态、路由和业务契约，并用脱敏 mock 数据恢复可运行闭环。

## 启动

```powershell
cd D:\all_projects\workspace
$env:npm_config_cache = 'D:\all_projects\.npm-cache'
npm install
npm run dev
```

访问 `http://127.0.0.1:3000/`。推荐使用 `start-workspace.ps1` 启动，它会在 D 盘创建数据、缓存、上传和导出目录。

## 验证

```powershell
npm test
npm run typecheck
npm run build
Invoke-RestMethod http://127.0.0.1:3000/api/health
```

## 路由

- `/`：放映厅首页，KPI、9001 出单趋势、账号排行、视频表现和同步提醒
- `/workspace`：运营工作台（运营员/分类筛选、账号卡、计划抽屉、入库计数、生产队列、日志和交付）
- `/workspace/accounts/[id]/assets`：按 PID 聚合的账号素材中心
- `/workspace/accounts/[id]/production?mode=image|prompt|video`：账号生产三模式工作区
- `/workspace/accounts/[id]/production/video-tasks/[taskId]`、`image-tasks/[taskId]`：任务详情与复核
- `/downstream`：下游视频明细看板
- `/accounts`：账号资产
- `/api/earnings-trend`：服务端代理 9001 `/api/earnings/daily-trend`，上游不可用时显示最近 mock 缓存
- `/api/health`：健康检查
- `/login`：三级账号登录
- `/admin/accounts`：管理员账号控制
- `/entry`：历史发布记录兼容入口

工作台 API：

- `/api/workspace/accounts`：运营员和账号列表，支持 `ownerId`、`category` 筛选
- `/api/workspace/video-stats`、`/api/workspace/earnings`：入库计数和工作台收益数据
- `/api/workspace/providers`：供应商目录与能力声明；默认 mock，只有显式设置 `WORKSPACE_ENABLE_LIVE_PROVIDERS=true` 且提供对应 key 才会发起外部请求
- `/api/workspace/accounts/[id]/video-tasks`：视频任务列表、创建、重试、暂停、取消和入库动作
- `/api/workspace/accounts/[id]/files`：账号资产读取
- `/api/workspace/accounts/[id]/generate-image`：MGRouter Grok 生图（无 key 时返回 mock）

真实 9001 接入使用 `EARNINGS_API_URL`；跨机器时使用 `EARNINGS_TREND_TOKEN`。不在代码中保存 `admin` 密码、API key、Token 或 Cookie。运行时数据根目录由 `WORKSPACE_DATA_ROOT` 指向 `D:\all_projects\workspace\data`，不得改回 C 盘。

### 生产模型供应商

历史 provider 契约审计见 [provider-source-audit.md](D:/all_projects/workspace/recovery/provider-source-audit.md)。当前已实现统一 provider 目录、能力约束、Grok/MGRouter/Wan/YuanAI payload 构造、安全 HTTPS 素材校验和 mock fallback。默认不向外部供应商发请求；只有在 D 盘启动环境中显式设置 `WORKSPACE_ENABLE_LIVE_PROVIDERS=true`，并配置对应 key 后才会启用真实调用。真实调用可能产生费用，且参考素材必须是受控的 HTTPS 地址。

## D 盘存储约束

- 项目根目录：`D:\all_projects\workspace`
- 数据、上传、导出、缓存：`D:\all_projects\workspace\data`
- 运行日志：`D:\all_projects\workspace\logs`
- npm 缓存：`D:\all_projects\.npm-cache`
- SQLite（预留）：`D:\all_projects\workspace\data\workspace.db`

`src/lib/storagePaths.ts` 会拒绝 C 盘和目录穿越路径；未来新增持久化代码必须通过该模块生成路径。

## 账号控制

系统有三个账号级别：

- `admin` 管理员：全部页面、账号控制和系统配置；
- `workspace` 工作台账号：工作台、生产任务和素材接口；
- `operator` 运营账号：放映厅、下游看板、账号/PID 数据、复盘，并可进入工作台执行任务。

首次使用时执行：

```powershell
cd D:\all_projects\workspace
.\setup-auth.ps1
```

脚本会交互式设置三个账号的密码，并只把 scrypt 哈希写入 D 盘 `data\auth\users.json`，不会把明文密码写入 `.env.local`、源码或 C 盘。重启服务后访问 `/login`。会话文件保存在 `D:\all_projects\workspace\data\auth\sessions.json`。如需重置账号密码，执行 `.\setup-auth.ps1 -Force`。

可用 `.\check-storage.ps1` 检查是否重新引入旧项目名或 C 盘路径。
-
## 实现基线

继续扩展前，请先审阅 [完整工作台布局与功能规格](recovery/workspace-complete-spec.md)。该文档汇总了 E 盘 Codex 历史对话中可验证的 3000 路由、布局、角色、资产、生产、provider、队列和入库契约，并列出需要业务确认的商品图片清理规则与真实 provider 验收条件。
