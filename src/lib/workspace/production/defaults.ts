/** Defaults shared by the production UI and API boundaries. */
export const DEFAULT_PRODUCTION_ASPECT_RATIO = '9:16' as const;

/**
 * Pick the production-wide portrait ratio when a model supports it. If a
 * future provider does not advertise 9:16, retain a valid provider option.
 */
export function getDefaultProductionAspectRatio(ratios: readonly string[]): string {
  return ratios.includes(DEFAULT_PRODUCTION_ASPECT_RATIO)
    ? DEFAULT_PRODUCTION_ASPECT_RATIO
    : ratios[0] ?? DEFAULT_PRODUCTION_ASPECT_RATIO;
}

/**
 * Prefer the standard 10-second production preset whenever a video model
 * supports it. This keeps API fallbacks aligned with the production form,
 * including Wan 3 R2V (9:16 / 10s / 720P).
 */
export function getDefaultProductionDuration(durations: readonly number[] | undefined): number {
  if (!durations?.length) return 10;
  const tenSeconds = durations.find((value) => Number(value) === 10);
  return tenSeconds ?? durations[0] ?? 10;
}

/**
 * Image generation defaults to 4K whenever the selected model advertises it;
 * otherwise use the last (normally highest) advertised resolution.
 */
export function getDefaultImageResolution(resolutions: readonly string[]): string {
  const fourK = resolutions.find((value) => value.trim().toLowerCase() === '4k');
  return fourK?.trim().toLowerCase() || resolutions.at(-1)?.trim().toLowerCase() || '';
}

/** Video generation defaults to 720p whenever the selected model supports it. */
export function getDefaultVideoResolution(resolutions: readonly string[]): string {
  const hd = resolutions.find((value) => value.trim().toLowerCase() === '720p');
  return hd?.trim() || resolutions[0]?.trim() || '720p';
}
