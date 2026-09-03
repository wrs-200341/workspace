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
 * Image generation defaults to 4K whenever the selected model advertises it;
 * otherwise use the last (normally highest) advertised resolution.
 */
export function getDefaultImageResolution(resolutions: readonly string[]): string {
  const fourK = resolutions.find((value) => value.trim().toLowerCase() === '4k');
  return fourK?.trim().toLowerCase() || resolutions.at(-1)?.trim().toLowerCase() || '';
}
