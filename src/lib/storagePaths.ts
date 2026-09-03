import path from 'node:path';
import fs from 'node:fs';

const EXPECTED_PROJECT_ROOT = 'D:\\all_projects\\workspace';
const DEFAULT_DATA_ROOT = path.join(EXPECTED_PROJECT_ROOT, 'data');

export function getWorkspaceDataRoot(): string {
  const configured = process.env.WORKSPACE_DATA_ROOT?.trim();
  const resolved = path.resolve(configured || DEFAULT_DATA_ROOT);
  if (!resolved.toLowerCase().startsWith('d:\\all_projects\\workspace\\')) {
    throw new Error('WORKSPACE_DATA_ROOT must stay under D:\\all_projects\\workspace');
  }
  return resolved;
}

export function getWorkspacePath(...segments: string[]): string {
  const root = getWorkspaceDataRoot();
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Workspace data path escaped the D-drive data root');
  }
  return resolved;
}

export function ensureWorkspaceDataRoot(): string {
  const root = getWorkspaceDataRoot();
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'exports'), { recursive: true });
  fs.mkdirSync(path.join(root, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
  return root;
}
