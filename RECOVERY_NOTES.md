# workspace / 3000 放映厅复刻说明

本项目是根据 E 盘 Codex 历史对话和恢复镜像目录重建的隔离副本，正式项目名为 `workspace`。

- 项目根目录：`D:\all_projects\workspace`
- 数据根目录：`D:\all_projects\workspace\data`
- 日志目录：`D:\all_projects\workspace\logs`
- Next 构建目录：`D:\all_projects\workspace\.next`

- 原始路径：`E:\11\Users\EDY\Desktop\集成`
- 原始恢复镜像的 `src`、`package.json`、`README.md` 等文件为 0 字节恢复壳，无法直接复制源码。
- 历史中确认的核心路由：`/workspace`、`/downstream`、`/api/health`、`/api/earnings-trend`。
- 本副本保留 Next.js + TypeScript + Vitest 的项目形态，并提供看板、账号、商品/PID、工作台和服务端收益代理的可运行 mock 闭环。
- 9001 真实接入通过服务端 `EARNINGS_API_URL` 代理；跨机器时可使用 `EARNINGS_TREND_TOKEN`。不复制或硬编码任何认证凭据。
- 所有新增数据库、上传、缓存、导出和运行产出必须写入 `WORKSPACE_DATA_ROOT`，默认是上述 D 盘目录；禁止使用 `C:\Users\EDY` 作为项目数据目录。
- 三级账号控制已在 clean-room 复刻中实现：`admin`、`workspace`、`operator`；密码通过 D 盘 `setup-auth.ps1` 初始化，认证数据仅写入 D 盘 `data\auth`，只保存 scrypt 哈希。
- 生产模型只保留能力目录和状态展示，真实 Grok/YuanAI/Wan 请求需要用户后续配置服务地址和环境变量。
