export function matchesAssetPidPrefix(assetName: string, query: string): boolean {
  const prefix = query.trim().normalize('NFKC').toLocaleLowerCase();
  if (!prefix) return true;
  const fileName = assetName.split(/[\\/]/).pop()?.trim() ?? assetName.trim();
  return fileName.normalize('NFKC').toLocaleLowerCase().startsWith(prefix);
}
