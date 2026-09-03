import fs from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getWorkspacePath } from '../storagePaths';
import { createUploadedAsset } from './assetStore';
import {
  cleanupExpiredReferenceAssets,
  publishAssetReference,
  readPublicReference,
  referenceBridgeRegistryPath,
} from './referenceBridge';

const root = `D:\\all_projects\\workspace\\data\\reference-bridge-test-${process.pid}`;
const previous = process.env.WORKSPACE_DATA_ROOT;

beforeEach(() => {
  process.env.WORKSPACE_DATA_ROOT = root;
  process.env.WORKSPACE_PUBLIC_BASE_URL = 'https://workspace.example.test';
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_PUBLIC_BASE_URL;
  if (previous === undefined) delete process.env.WORKSPACE_DATA_ROOT;
  else process.env.WORKSPACE_DATA_ROOT = previous;
});

describe('workspace reference bridge', () => {
  it('publishes an uploaded asset below D drive and reads it through a short-lived token', () => {
    const asset = createUploadedAsset('account-1', 'image', {
      name: 'reference.png',
      type: 'image/png',
      size: 4,
      arrayBuffer: Uint8Array.from([1, 2, 3, 4]).buffer,
    });

    const published = publishAssetReference({ accountId: 'account-1', assetId: asset.id, ttlMs: 60_000 });
    expect(published.url).toMatch(/^https:\/\/workspace\.example\.test\/api\/workspace\/references\/[A-Za-z0-9_-]+$/);
    expect(published.token).toHaveLength(43);
    expect(published.expiresAt).toBeGreaterThan(Date.now());
    expect(referenceBridgeRegistryPath().toLowerCase()).toContain('d:\\all_projects\\workspace\\data');

    const payload = readPublicReference(published.token);
    expect(payload?.mimeType).toBe('image/png');
    expect(payload?.bytes).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(payload?.accountId).toBe('account-1');
  });

  it('rejects cross-account and prompt assets', () => {
    const image = createUploadedAsset('account-1', 'image', {
      name: 'reference.jpg', type: 'image/jpeg', size: 1, arrayBuffer: Uint8Array.from([7]).buffer,
    });
    expect(() => publishAssetReference({ accountId: 'account-2', assetId: image.id })).toThrow('reference_asset_not_found');
    const prompt = createUploadedAsset('account-1', 'audio', {
      name: 'sound.mp3', type: 'audio/mpeg', size: 1, arrayBuffer: Uint8Array.from([8]).buffer,
    });
    expect(() => publishAssetReference({ accountId: 'account-1', assetId: prompt.id, allowedKinds: ['image'] })).toThrow('reference_asset_kind_invalid');
  });

  it('expires tokens and removes their cached files', () => {
    const asset = createUploadedAsset('account-1', 'image', {
      name: 'reference.webp', type: 'image/webp', size: 1, arrayBuffer: Uint8Array.from([9]).buffer,
    });
    const published = publishAssetReference({ accountId: 'account-1', assetId: asset.id, ttlMs: 1 });
    const registry = JSON.parse(fs.readFileSync(referenceBridgeRegistryPath(), 'utf8')) as Array<{ token: string; expiresAt: number }>;
    registry[0].expiresAt = Date.now() - 1;
    fs.writeFileSync(referenceBridgeRegistryPath(), JSON.stringify(registry));

    expect(cleanupExpiredReferenceAssets()).toBe(1);
    expect(readPublicReference(published.token)).toBeNull();
    expect(fs.readdirSync(getWorkspacePath('reference-bridge', 'cache'))).toHaveLength(0);
  });

  it('requires an HTTPS public base and rejects unsafe bases', () => {
    const asset = createUploadedAsset('account-1', 'image', {
      name: 'reference.png', type: 'image/png', size: 1, arrayBuffer: Uint8Array.from([1]).buffer,
    });
    process.env.WORKSPACE_PUBLIC_BASE_URL = 'http://localhost:3000';
    expect(() => publishAssetReference({ accountId: 'account-1', assetId: asset.id })).toThrow('reference_public_base_invalid');
  });
});
