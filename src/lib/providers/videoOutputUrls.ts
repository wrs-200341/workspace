/**
 * Return a stable comparison key for a provider video output URL.
 *
 * Wan/ManjuAI exposes the same object through `/videos/` and `/downloads/`.
 * Keep the original URL for the actual request, but compare those paths as
 * one output and ignore ephemeral query/hash components.
 */
export function canonicalVideoOutputUrl(provider: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if ((provider === 'wan3-video' || provider === 'minimax-h3') && parsed.hostname.toLowerCase() === 'media.manjuai.top') {
      parsed.pathname = parsed.pathname.replace(/^\/downloads\//i, '/videos/');
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

/** Keep the first fetchable URL for every logical video output. */
export function dedupeVideoOutputUrls(provider: string, urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of urls) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = canonicalVideoOutputUrl(provider, trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

export function countVideoOutputs(provider: string, urls: readonly string[], base64: readonly string[], hasProviderTaskId = false): number {
  const count = dedupeVideoOutputUrls(provider, urls).length + base64.filter((value) => value.trim()).length;
  return count > 0 ? count : hasProviderTaskId && ['grok-video', 'mgrouter-grok-video', 'oairegbox-omni'].includes(provider) ? 1 : 0;
}
