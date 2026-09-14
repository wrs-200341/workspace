import type { ProviderTask } from './taskStore';

export type TaskErrorCategory =
  | 'service_restart'
  | 'submission_uncertain'
  | 'prompt_timeout'
  | 'provider_timeout'
  | 'provider_capacity'
  | 'provider_auth'
  | 'provider_quota'
  | 'content_policy'
  | 'reference_rejected'
  | 'invalid_request'
  | 'output_cache'
  | 'provider_unavailable'
  | 'unknown';

export type TaskErrorInfo = {
  code: string;
  category: TaskErrorCategory;
  title: string;
  message: string;
  action: string;
  /** True only when retrying cannot submit an already accepted upstream job. */
  safeToRetry: boolean;
};

function flatten(value: unknown, budget = 12_000): string {
  if (budget <= 0) return '';
  if (typeof value === 'string') return value.slice(0, budget);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return '';
  const parts: string[] = [];
  let remaining = budget;
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries) {
    if (remaining <= 0) break;
    const part = `${key}:${flatten(item, Math.min(remaining, 2_000))}`;
    parts.push(part);
    remaining -= part.length;
  }
  return parts.join(' ').slice(0, budget);
}

function responseText(task: Pick<ProviderTask, 'providerResponse'>): string {
  return flatten(task.providerResponse).toLowerCase();
}

function providerDisplayName(provider?: string): string {
  const names: Record<string, string> = {
    'grok-video': 'snumom',
    'yuanai-grok-video': 'yuanai',
    'mgrouter-grok-video': 'mgrouter',
    'mgrouter-grok-image': 'mgrouter',
    'wan3-video': 'manjuai',
    'wan-3-nsfw': '808relay',
    seedream: 'apiaw',
    'minimax-h3': 'secure-skill',
    'miku-minimax': 'mikuapi',
    'pro666-video': 'pro666',
    'quality-v4': 'quality-v4',
    'oairegbox-omni': 'oairegbox',
    'yuanai-image': 'yuanai',
    'aicloud-gpt-image': 'aicloud',
    'pomoai-gemini-image': 'pomoai',
    'origin-gpt-image': 'origingateway',
    'origin-grok-image': 'origingateway',
    'origin-nano-image': 'origingateway',
    'junze-gpt-image': 'junze',
    'junze-gemini-image': 'junze',
    'pomoai-gpt-prompt': 'pomoai',
    'oairegbox-gpt-prompt': 'oairegbox',
    'gpt-2999-prompt': '2999',
    'bigsnake-prompt': 'bigsnake',
  };
  if (!provider) return '供应商';
  return names[provider] ?? provider;
}

function modelFamily(task: { provider?: string; model?: string }): string {
  const value = `${task.provider ?? ''} ${task.model ?? ''}`.toLowerCase();
  if (value.includes('grok')) return 'grok';
  if (value.includes('gpt')) return 'gpt';
  if (value.includes('gemini')) return 'gemini';
  if (value.includes('minimax') || value.includes('h3')) return 'minimax';
  if (value.includes('wan')) return 'wan';
  if (value.includes('omni')) return 'omni';
  if (value.includes('sd2') || value.includes('933')) return 'sd 933 mini';
  if (value.includes('seedream')) return 'seedream';
  return '';
}

function providerModelSubject(task: { provider?: string; model?: string }): string {
  const provider = providerDisplayName(task.provider);
  const family = modelFamily(task);
  return family ? `${provider}的${family}` : provider;
}

/**
 * Convert internal/provider errors into an operator-facing explanation. This
 * deliberately returns a small, non-sensitive object suitable for queue APIs;
 * the full bounded provider response remains available on the detail page.
 */
export function classifyTaskError(task: Pick<ProviderTask, 'error' | 'providerResponse' | 'providerTaskId' | 'metadata' | 'mode'> & Partial<Pick<ProviderTask, 'provider' | 'model'>>): TaskErrorInfo | undefined {
  const error = typeof task.error === 'string' ? task.error.trim() : '';
  if (!error) return undefined;
  const lower = error.toLowerCase();
  const response = responseText(task);
  const metadata = task.metadata ?? {};
  // Restart and capacity metadata must not make an ambiguous paid request
  // eligible for the safe-recovery batch.
  if (lower === 'provider_submission_uncertain' || metadata.providerSubmissionUncertain === true) {
    return {
      code: 'provider_submission_uncertain',
      category: 'submission_uncertain',
      title: '提交结果待供应商确认',
      message: '无法确认供应商是否已收到请求，任务可能仍在处理或已产生费用。为避免重复提交扣费，系统已暂停自动重试。',
      action: task.providerTaskId
        ? '请先在供应商后台核对该任务编号和处理结果；不要直接重新提交。'
        : '请管理员按供应商、提交时间和请求内容核对后台记录与扣费情况；确认原请求未受理后，再决定是否重新提交。',
      safeToRetry: false,
    };
  }
  const promptPending = metadata.promptGenerationPending === true || metadata.promptGenerationFailed === true;
  const hasUpstreamId = Boolean(task.providerTaskId);
  const retryInterrupted = lower === 'scheduler_retry_interrupted';
  const interrupted = Boolean(metadata.schedulerInterruptedAt)
    || lower === 'scheduler_interrupted'
    || lower === 'scheduler_prompt_interrupted'
    || retryInterrupted;

  if (interrupted && promptPending) {
    return {
      code: 'scheduler_prompt_interrupted',
      category: 'service_restart',
      title: '服务重启，子提示词生成被中断',
      message: '任务还没有提交到视频供应商，服务重启时中断了子提示词生成。',
      action: '可以安全恢复，系统会沿用原来的参考图和参数重新生成。',
      safeToRetry: !hasUpstreamId,
    };
  }
  if (retryInterrupted) {
    return {
      code: 'scheduler_retry_interrupted',
      category: 'service_restart',
      title: '服务重启，自动重试被中断',
      message: '任务之前尝试过一次，但服务重启后本地重试计时器已经结束，供应商没有收到新的任务编号。',
      action: '可以安全恢复，系统会沿用原来的参考素材和参数重新提交。',
      safeToRetry: !hasUpstreamId,
    };
  }
  if (interrupted) {
    return {
      code: 'scheduler_interrupted',
      category: 'service_restart',
      title: '服务重启，任务被中断',
      message: '任务还没有确认提交到供应商，服务重启时中断了本地调度。',
      action: '可以安全恢复，系统会沿用原来的配置重新提交。',
      safeToRetry: !hasUpstreamId,
    };
  }

  const promptTimeout = promptPending && (lower.includes('timeout') || lower.includes('timed out') || /provider_(408|504|524)/.test(lower));
  if (promptTimeout) {
    return {
      code: 'prompt_provider_timeout',
      category: 'prompt_timeout',
      title: '子提示词服务响应超时',
      message: '提示词模型在视频提交前没有及时返回结果，因此视频供应商还没有收到任务。',
      action: '可以安全恢复，建议稍后再次生成。',
      safeToRetry: !hasUpstreamId,
    };
  }

  const quotaOrBalance = /额度|限额|余额|点数|积分|额度等待恢复|可用账号额度|insufficient[_\s-]?(balance|quota|credit|funds)|quota|credit|balance|billing|payment required/.test(`${lower} ${response}`);
  if (quotaOrBalance) {
    const provider = providerDisplayName(task.provider);
    return {
      code: 'provider_quota',
      category: 'provider_quota',
      title: `${provider}额度不足`,
      message: `${provider}账号余额、额度、积分或可用账号资源不足，供应商没有继续处理这条任务。`,
      action: `请管理员检查 ${provider} 的账号额度/密钥可用范围；额度恢复后再重新提交或切换供应商。`,
      safeToRetry: false,
    };
  }

  const contentRejected = /内容审核|审核不通过|安全策略|违规|敏感|content[_\s-]?policy|content review|moderation|safety|policy violation|blocked by policy|rejected by policy/.test(`${lower} ${response}`);
  if (contentRejected) {
    const subject = providerModelSubject(task);
    return {
      code: 'provider_content_policy',
      category: 'content_policy',
      title: `${subject}内容审核失败`,
      message: `${subject}拒绝了当前提示词或参考素材，任务没有生成可用结果。`,
      action: '请调整提示词、减少敏感描述或更换参考素材后再提交；如果是误判，可以切换同模型的其他供应商再试。',
      safeToRetry: false,
    };
  }

  const capacity = /capacity|queue.?full|overload|busy|too many requests|temporarily unavailable/.test(`${lower} ${response}`)
    || lower === 'provider_429';
  if (capacity) {
    return {
      code: 'provider_capacity',
      category: 'provider_capacity',
      title: '供应商当前繁忙',
      message: '供应商容量不足或排队已满，本次没有拿到可继续查询的任务编号。',
      action: '可以安全恢复，建议等待供应商恢复后重试。',
      safeToRetry: !hasUpstreamId,
    };
  }

  if (lower === 'provider_not_configured') {
    return {
      code: lower,
      category: 'provider_unavailable',
      title: '供应商尚未配置',
      message: '当前供应商没有配置可用的 API 密钥，任务没有发送出去。',
      action: '请管理员补充供应商密钥后，再手动重试。',
      safeToRetry: false,
    };
  }
  if (lower === 'provider_response_unrecognized') {
    return {
      code: lower,
      category: 'unknown',
      title: '供应商返回了无法识别的结果',
      message: hasUpstreamId ? '任务编号已存在，但返回状态不完整。' : '系统无法确认供应商是否已经收到任务。',
      action: hasUpstreamId ? '请刷新任务详情，系统会继续查询。' : '请先确认供应商后台是否有这条任务，再决定是否重试。',
      safeToRetry: false,
    };
  }
  if (lower === 'provider_task_stale') {
    return {
      code: lower,
      category: 'provider_timeout',
      title: '供应商任务长时间没有更新',
      message: '这条任务已经提交给供应商，但超过系统等待时间仍没有返回新状态；系统已释放并发槽，避免后续任务一直排队。',
      action: '请先打开任务详情或供应商后台确认是否已有结果；确认没有结果后再人工重试，避免重复提交扣费。',
      safeToRetry: false,
    };
  }
  if (lower === 'provider_upstream_failed' || lower === 'image_provider_failed' || lower === 'video_outputs_unavailable' || lower === 'image_outputs_unavailable') {
    return {
      code: lower,
      category: 'unknown',
      title: task.mode === 'prompt' ? '提示词供应商生成失败' : '供应商生成失败',
      message: '供应商没有返回可用的生成结果，系统也没有拿到更具体的失败原因。',
      action: hasUpstreamId ? '请稍后刷新，或打开详情查看供应商原始响应；不要重复提交。' : '请打开详情查看供应商原始响应，确认没有重复任务后再重试。',
      safeToRetry: false,
    };
  }
  if (lower === 'provider_request_failed' || lower === 'provider request failed' || lower === 'scheduler_dispatch_failed') {
    return {
      code: lower,
      category: 'unknown',
      title: hasUpstreamId ? '供应商处理异常' : '提交供应商时发生网络异常',
      message: hasUpstreamId ? '任务可能已经在供应商处理中，但系统没有拿到完整状态。' : '系统没有确认供应商是否已经收到请求。',
      action: '请先查看供应商后台或任务详情，确认后再重试，避免重复扣费。',
      safeToRetry: false,
    };
  }
  if (lower === 'reference_asset_not_found' || lower === 'reference_asset_kind_invalid' || lower.includes('reference_images_too_large')) {
    return {
      code: lower,
      category: 'invalid_request',
      title: '参考素材不可用',
      message: '任务引用的图片、视频或音频在本地项目中不存在，或超出了模型允许的大小。',
      action: '重新选择仍存在的参考素材后提交。',
      safeToRetry: false,
    };
  }

  if (lower === 'provider_401' || lower === 'provider_402' || lower === 'provider_403' || lower.includes('unauthorized') || lower.includes('insufficient balance') || /余额|quota|credit|积分/.test(response)) {
    return {
      code: lower === 'provider_403' ? 'provider_403' : 'provider_auth',
      category: lower.includes('quota') || /余额|quota|credit|积分/.test(response) ? 'provider_quota' : 'provider_auth',
      title: lower.includes('quota') || /余额|quota|credit|积分/.test(response) ? '供应商额度不足' : '供应商鉴权失败',
      message: lower.includes('quota') || /余额|quota|credit|积分/.test(response) ? '供应商账户余额、积分或每日额度不足。' : '供应商密钥无效、过期或没有调用权限。',
      action: '请管理员检查供应商密钥和账户余额后，再手动重试。',
      safeToRetry: false,
    };
  }
  if (lower.includes('content') || lower.includes('moderation') || lower.includes('safety') || lower.includes('policy') || lower.includes('审核')) {
    return {
      code: 'provider_content_policy',
      category: 'content_policy',
      title: '内容审核未通过',
      message: '供应商拒绝了提示词或参考素材，任务没有生成结果。',
      action: '请修改提示词或更换参考图后重新提交。',
      safeToRetry: false,
    };
  }
  if (lower.includes('reference') && (lower.includes('reject') || lower.includes('invalid') || lower.includes('moder'))) {
    return {
      code: 'provider_reference_rejected',
      category: 'reference_rejected',
      title: '参考素材未通过审核',
      message: '供应商无法接受当前参考图、参考视频或参考音频。',
      action: '请更换参考素材或减少素材数量后重试。',
      safeToRetry: false,
    };
  }
  if (lower.includes('invalid') || lower.includes('400') || lower === 'provider_400' || lower === 'provider_invalid_request') {
    return {
      code: 'provider_invalid_request',
      category: 'invalid_request',
      title: '请求参数不符合模型要求',
      message: '供应商拒绝了本次请求，常见原因是提示词长度、素材数量、时长、比例或分辨率不符合模型限制。',
      action: '请修改参数或提示词后重试；如果仍失败，请打开任务详情查看供应商原始响应。',
      safeToRetry: false,
    };
  }
  if (lower === 'image_output_cache_failed' || lower === 'video_output_cache_failed' || lower.includes('output_cache')) {
    return {
      code: lower,
      category: 'output_cache',
      title: '生成完成，但本地保存失败',
      message: '供应商已经返回结果，但系统保存到本地项目数据时失败了。',
      action: '系统会继续尝试恢复本地文件；如果仍失败，请重新下载或重新生成。',
      safeToRetry: !hasUpstreamId,
    };
  }
  if (lower.includes('404') || lower.includes('model_unavailable') || lower.includes('not found')) {
    return {
      code: 'provider_model_unavailable',
      category: 'provider_unavailable',
      title: '供应商或模型暂时不可用',
      message: '当前供应商没有找到所选模型或接口暂时不可用。',
      action: '请确认模型和供应商配置，或切换同模型的其他供应商后重试。',
      safeToRetry: false,
    };
  }
  if (lower.includes('timeout') || lower.includes('timed out') || /provider_(408|500|502|503|504|524)/.test(lower)) {
    return {
      code: 'provider_timeout',
      category: 'provider_timeout',
      title: hasUpstreamId ? '供应商处理超时' : '提交供应商时网络超时',
      message: hasUpstreamId ? '任务已经交给供应商，但查询结果超时或暂时没有返回。' : '系统没有确认供应商是否已经收到任务。',
      action: hasUpstreamId ? '请稍后刷新，系统会继续查询；不要重复提交。' : '无法确认是否已经提交，请人工确认供应商状态后再重试。',
      safeToRetry: false,
    };
  }
  return {
    code: error,
    category: 'unknown',
    title: task.mode === 'prompt' ? '子提示词生成失败' : '任务生成失败',
    message: '系统没有拿到足够明确的失败原因。',
    action: '请打开任务详情查看供应商原始响应，确认后再重试。',
    safeToRetry: false,
  };
}
