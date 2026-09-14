import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type ControlModule = {
  clearDrainRequest: (paths: Record<string, string>, state: Record<string, unknown>) => void;
  drainRequestMatchesSupervisor: (request: unknown, state: unknown) => boolean;
  processAlive: (pid: number) => boolean;
  providerControlPaths: (root: string, dataRoot: string) => Record<string, string>;
  readDrainRequest: (paths: Record<string, string>) => unknown;
  readSupervisorState: (paths: Record<string, string>) => Record<string, unknown> | undefined;
  supervisorStateMatchesRuntime: (state: unknown, expected: { root: string; script: string }) => boolean;
  writeDrainRequest: (paths: Record<string, string>, state: Record<string, unknown>, reason?: string) => unknown;
  writeSupervisorState: (paths: Record<string, string>, state: Record<string, unknown>) => void;
  waitUntil: <T>(predicate: () => T | Promise<T>, options?: { timeoutMs?: number; intervalMs?: number }) => Promise<T>;
};

async function loadControl(): Promise<ControlModule> {
  // @ts-expect-error The production control helper is a Node .mjs script; this
  // smoke test imports it directly so script/runtime behavior stays covered.
  return await import('../../../scripts/provider-worker-control.mjs') as ControlModule;
}

function fixture(providerControlPaths: ControlModule['providerControlPaths']) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-worker-control-'));
  const dataRoot = join(root, 'data');
  const paths = providerControlPaths(root, dataRoot);
  return { root, dataRoot, paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('provider worker control script helpers', () => {
  it('round-trips supervisor state and validates the exact runtime identity', async () => {
    const control = await loadControl();
    const { root, paths, cleanup } = fixture(control.providerControlPaths);
    try {
      const script = join(root, 'scripts', 'provider-worker-supervisor.mjs');
      control.writeSupervisorState(paths, { pid: process.pid, nonce: 'nonce-1', root, script, startedAt: new Date().toISOString() });
      const state = control.readSupervisorState(paths);
      expect(state).toMatchObject({ pid: process.pid, nonce: 'nonce-1' });
      expect(control.processAlive(process.pid)).toBe(true);
      expect(control.supervisorStateMatchesRuntime(state, { root, script })).toBe(true);
      expect(control.supervisorStateMatchesRuntime(state, { root, script: join(root, 'other.mjs') })).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('only accepts drain requests that match both pid and nonce', async () => {
    const control = await loadControl();
    const { root, paths, cleanup } = fixture(control.providerControlPaths);
    try {
      const script = join(root, 'scripts', 'provider-worker-supervisor.mjs');
      const state = { pid: process.pid, nonce: 'nonce-2', root, script, startedAt: new Date().toISOString() };
      control.writeSupervisorState(paths, state);
      control.writeDrainRequest(paths, state, 'test');
      expect(control.drainRequestMatchesSupervisor(control.readDrainRequest(paths), state)).toBe(true);
      expect(control.drainRequestMatchesSupervisor(control.readDrainRequest(paths), { ...state, nonce: 'other' })).toBe(false);
      control.clearDrainRequest(paths, state);
      expect(control.readDrainRequest(paths)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('returns false on timeout so startup code cannot treat an unfinished drain as success', async () => {
    const control = await loadControl();
    await expect(control.waitUntil(() => false, { timeoutMs: 20, intervalMs: 10 })).resolves.toBe(false);
  });
});
