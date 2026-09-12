/** User-facing Chinese messages for provider and task error codes. */
const PROVIDER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  pro666_reference_video_unsupported: 'Pro666 sd2-933-mini 暂不支持参考视频。',
  pro666_prompt_required: 'Pro666 视频提示词不能为空。',
  pro666_too_many_reference_images: 'Pro666 sd2-933-mini 最多支持 1 张参考图。',
  pro666_too_many_reference_audios: 'Pro666 sd2-933-mini 最多支持 1 条参考音频。',
  pro666_reference_urls_must_be_https: 'Pro666 参考素材必须是公网 HTTPS 地址。',
  prompt_provider_failed: '提示词模型请求失败，请检查当前选择的提示词模型、API Key、模型名称和网络状态后重试。',
  provider_not_configured: '该供应商尚未配置有效密钥，请检查服务端供应商配置后重试。',
  provider_unauthorized: '供应商鉴权失败：API Key 无效、已过期或没有权限，请更新供应商密钥。',
  provider_400: '供应商拒绝了请求（HTTP 400）：可能是内容审核拒绝或请求校验失败，请查看任务详情中的完整供应商响应。',
  provider_401: '供应商鉴权失败：API Key 无效、已过期或没有权限，请更新供应商密钥。',
  provider_403: '供应商拒绝访问：当前 API Key 没有调用权限，请检查供应商账户权限。',
  provider_404: '供应商接口或模型不存在，请检查 Base URL 和模型配置。',
  provider_408: '供应商响应超时，请稍后重试。',
  provider_429: '供应商请求过于频繁或额度不足，请稍后重试并检查账户余额。',
  provider_500: '供应商服务内部错误，请稍后重试。',
  provider_502: '供应商网关返回错误，请稍后重试。',
  provider_503: '供应商服务暂时不可用，请稍后重试。',
  provider_504: '供应商网关响应超时，请稍后重试。',
  provider_524: '供应商网关响应超时，请稍后重试。',
  provider_model_unavailable: '供应商当前没有可用的模型通道，请稍后重试或联系供应商。',
  provider_upstream_failed: '供应商上游生成失败，任务没有产出可用内容；如已预扣费，请以供应商账单为准。',
  provider_invalid_request: '供应商拒绝了请求参数，请检查模型支持的时长、比例、分辨率和参考素材。',
  provider_content_policy: '供应商内容审核拒绝了本次请求，请修改提示词后重试。',
  provider_reference_rejected: '供应商内容审核拒绝了参考图，请更换参考图后重试。',
  provider_response_too_large: '供应商返回内容超过本地限制，常见于 4K 图片结果过大；请重试，或暂时选择较低分辨率。',
  provider_invalid_json: '供应商返回的数据格式无效，请稍后重试或联系供应商。',
  provider_video_content_invalid: '供应商返回的视频内容无效，暂时无法保存或预览，请重试。',
  provider_request_failed: '供应商请求失败，未能获取明确错误原因；请检查供应商状态、模型和参数后重试。',
  'provider request failed': '供应商请求失败，未能获取明确错误原因；请检查供应商状态、模型和参数后重试。',
  image_provider_failed: '图片供应商请求失败，请检查供应商状态、模型和密钥配置后重试。',
  fallback_reference_limit: '切换备用供应商失败：备用供应商最多支持 3 张参考图。',
  image_outputs_unavailable: '图片任务没有可保存的输出结果，请等待任务完成或重新生成。',
  video_outputs_unavailable: '视频任务没有可保存的输出结果，请等待任务完成或重新生成。',
  provider_resume_unsupported: '该任务已提交给供应商，不能本地重复提交；请等待当前任务完成。',
  scheduler_queue_full: '当前运营账号的生产队列已达到安全上限，请稍后再提交。',
  scheduler_interrupted: '服务器重启时中断了尚未提交的任务，请点击恢复配置重新提交。',
  scheduler_prompt_interrupted: '服务重启导致子提示词生成中断，视频尚未提交给供应商；可以安全恢复。',
  prompt_provider_timeout: '子提示词模型响应超时，视频尚未提交给供应商；可以稍后安全恢复。',
  provider_capacity: '供应商当前繁忙或队列已满，本次没有拿到上游任务编号；可以稍后安全恢复。',
  image_output_cache_failed: '图片已生成但本地缓存失败，请重试或重新生成。',
  // 8765 商品图库（PID 素材）相关错误。8765 自身依赖极空间桌面客户端的本地
  // 代理，客户端未启动或未登录时，8765 会返回 502/401。
  product_source_http_401: '极空间登录会话已失效，请重新打开极空间客户端并登录后重试。',
  product_source_http_403: '8765 图库拒绝了本次访问，请确认 8765 服务的本地会话令牌是否有效。',
  product_source_http_404: '8765 图库没有这个接口或 PID，请确认 8765 服务版本与 PID 是否正确。',
  product_source_http_500: '8765 图库服务内部错误，请查看 8765 服务日志后重试。',
  product_source_http_502: '8765 图库无法读取极空间：通常是极空间桌面客户端未启动或未登录（其本地代理 127.0.0.1:13579 不可用）。请打开极空间客户端并登录后重试。',
  product_source_http_503: '8765 图库服务暂时不可用，请稍后重试。',
  product_source_timeout: '8765 图库响应超时，请确认 8765 服务与极空间客户端状态后重试。',
  product_source_url_invalid: '8765 服务地址配置无效，请检查 WORKSPACE_8765_BASE_URL。',
  product_source_host_not_allowed: '8765 服务地址不是本机地址；如需访问远程 8765，请显式开启远程访问配置。',
  product_source_session_invalid: '8765 服务没有返回有效的本地会话令牌，请重启 8765 服务后重试。',
  product_gallery_response_invalid: '8765 图库返回的数据格式无效，请确认 8765 服务版本后重试。',
  product_pid_required: '请先选择要导入的 PID。',
  product_pid_invalid: 'PID 格式无效，请确认只包含字母、数字、点、下划线或短横线。',
  product_pid_unavailable: '部分 PID 在 8765 图库中不存在或不可用，请确认 PID 后重试。',
  product_archive_no_images: '该 PID 的极空间文件夹里没有可用图片。',
  product_archive_too_large: '商品图片压缩包超过本地大小上限，请减少一次导入的 PID 数量。',
  product_archive_content_type_invalid: '8765 返回的不是压缩包，导入已中止；请查看 8765 服务日志。',
  product_cover_invalid: '商品封面图无效或超过大小上限。',
  product_cover_content_type_invalid: '8765 返回的封面不是图片格式。',
  product_folder_not_found: '没有找到该 PID 的本地商品图片文件夹。',
};

export function formatProviderError(code: string | undefined): string {
  if (!code) return '';
  return PROVIDER_ERROR_MESSAGES[code] ?? code;
}

/**
 * Format an error code together with the upstream explanation carried alongside
 * it. The mapped Chinese message says what to do; the raw upstream text (for
 * example 8765's `极空间代理请求失败: ConnectionError`) is appended so the exact
 * failure stays visible for diagnosis.
 */
export function formatProviderErrorWithDetail(code: string | undefined, detail?: string): string {
  const message = formatProviderError(code);
  const trimmed = detail?.trim();
  if (!trimmed || trimmed === message || trimmed === code) return message;
  return message ? `${message}（${trimmed}）` : trimmed;
}
