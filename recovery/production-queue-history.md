# 3000 工作台生产队列历史证据

来源：`E:\\.codex\\thread_history_1.sqlite` 的历史 thread_items；复核快照位于 `provider-history-evidence.md`、`provider-thread-details.txt` 和 `vp_full_50.txt`。本报告不包含 API key、Cookie、Bearer token 或密码。

## 队列筛选契约

历史文件 `src/app/workspace/accounts/[id]/production/production-queue.ts` 定义：

```ts
type ProductionQueueTab = "all" | "active" | "completed" | "failed";
```

`productionQueueGroup(status)` 将 `completed`、`failed` 保留为终态，其余 `queued`、`prompting`、`submitting`、`submitted`、`processing` 统一归入 `active`。`filterProductionQueue(tasks, tab)` 在 `all` 时返回新数组，在其他 tab 中按分组过滤。`preserveTaskAccountName` 用当前账号名回填任务缺失的 `accountName`，用于运营员跨账号队列。

后续历史改动增加 `findFirstUnstoredVideoTask`，只返回 `status === "completed" && inventorySaved === false` 的第一条任务。

## 右侧队列布局

`VideoProductionPanel.tsx` 的生产表单右侧是独立 `aside.queuePanel`，不是模型目录：

1. 头部显示 `PRODUCTION QUEUE` 与“生产队列”。
2. 右侧提供上海时区日期输入，任务加载接口为 `GET /api/workspace/accounts/{id}/video-tasks?date=YYYY-MM-DD`；前端约每 8 秒轮询一次。
3. 头部可显示“未入库 N 条”。统计条件为当天（按所选上海日期）`completed && !inventorySaved`。存在时显示“跳转”，切换到 `all`、定位第一条未入库任务、滚动并高亮；重复点击应重新定位。
4. 状态 tabs：`全部 (n)`、`进行中 (n)`、`完成 (n)`、`失败 (n)`。
5. 无任务时按 tab 显示当天暂无生产任务、暂无进行中的任务、暂无已完成任务、暂无失败任务。

## 任务卡字段与文案

任务卡使用：`id/accountId/accountName/name/supplierId/modelId/promptMode/promptModel/templateId/promptPreview/suffixEnabled/duration/aspectRatio/resolution/status/progress/providerTaskId/videoUrl/childPrompt/finalPrompt/originalPrompt/referenceAssetId(s)/referenceVideoAssetId/referenceWorkbookId/audioAssetId(s)/childPromptAvailable/audioAttached/audioAttachedCount/inventorySaved/error/errorDetail/createdAt/updatedAt`。

状态标签：

| 状态 | 标签 | 阶段说明 |
| --- | --- | --- |
| queued | 排队中 | 等待后台处理 |
| prompting | 提示词中 | 生成提示词中 |
| submitting | 提交中 | 提示词已完成，正在提交视频 |
| submitted | 已提交 | 视频生成中 |
| processing | 生成中 | 视频生成中 · progress% |
| completed | 已完成 | 已完成 |
| failed | 失败 | 任务失败 |

任务卡操作的最终历史版本：

- 始终可查看最终提示词（弹窗）；
- `completed` 显示“视频”链接到任务审核页，并显示“已入库/未入库”；库存写入由审核页处理；
- `failed` 可“恢复”原配置并重新提交；
- `completed` 或 `failed` 可删除，删除已入库成品不会影响库存文件。

较早版本还在队列卡直接提供 `retry/pause/resume/cancel/save-inventory`；后续测试明确把库存处理移到详情审核页。若兼容旧 UI，可保留：`queued/running -> pause`、`paused -> resume`、`failed/cancelled -> retry`、`completed && !inventorySaved -> save-inventory`、活动任务 -> cancel。

## 与当前 D 盘 workspace 的差异及建议

当前 `src/components/ProductionQueue.tsx` 已有日期筛选、进度、入库状态和基础动作，但缺少历史的四个 tabs、未入库跳转提示、任务阶段文案、任务提示词/视频详情入口、跨账号 accountName 处理和“完成/失败删除”行为。建议右侧组件直接按本报告的历史契约增强，模型选择继续保留在左侧 `ProductionForm`。

