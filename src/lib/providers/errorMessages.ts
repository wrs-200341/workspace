/** User-facing Chinese messages for provider and task error codes. */
const PROVIDER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  provider_not_configured: '该供应商尚未配置有效密钥，请检查服务端供应商配置后重试。',
  provider_unauthorized: '供应商鉴权失败：API Key 无效、已过期或没有权限，请更新供应商密钥。',
  provider_400: '供应商拒绝了请求：请求参数或 JSON 格式不正确，请检查模型、时长、比例和参考图。',
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
  image_outputs_unavailable: '图片任务没有可保存的输出结果，请等待任务完成或重新生成。',
  video_outputs_unavailable: '视频任务没有可保存的输出结果，请等待任务完成或重新生成。',
};

export function formatProviderError(code: string | undefined): string {
  if (!code) return '';
  return PROVIDER_ERROR_MESSAGES[code] ?? code;
}
