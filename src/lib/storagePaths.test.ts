import { afterEach, describe, expect, it } from 'vitest';
import { getWorkspaceDataRoot, getWorkspacePath } from './storagePaths';

const previous = process.env.WORKSPACE_DATA_ROOT;
afterEach(() => { process.env.WORKSPACE_DATA_ROOT = previous; });

describe('workspace data confinement', () => {
  it('defaults to the D-drive workspace data directory', () => {
    delete process.env.WORKSPACE_DATA_ROOT;
    expect(getWorkspaceDataRoot()).toBe('D:\\all_projects\\workspace\\data');
  });

  it('rejects project data paths on C drive', () => {
    process.env.WORKSPACE_DATA_ROOT = 'C:\\Users\\EDY\\workspace-data';
    expect(() => getWorkspaceDataRoot()).toThrow(/D:\\all_projects\\workspace/);
  });

  it('prevents traversal outside the data root', () => {
    process.env.WORKSPACE_DATA_ROOT = 'D:\\all_projects\\workspace\\data';
    expect(() => getWorkspacePath('..', '..', 'outside.txt')).toThrow(/escaped/);
  });
});
