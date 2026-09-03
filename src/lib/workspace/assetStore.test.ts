import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getWorkspacePath } from '../storagePaths';
import {
  createPromptAsset,
  createUploadedAsset,
  deleteAsset,
  getAsset,
  listAssets,
  readAssetFile,
  renameAsset,
  updatePromptAsset,
} from './assetStore';

const root = `D:\\all_projects\\workspace\\data\\asset-store-test-${process.pid}`;
const previous = process.env.WORKSPACE_DATA_ROOT;
beforeEach(() => { process.env.WORKSPACE_DATA_ROOT = root; fs.rmSync(root, { recursive: true, force: true }); });
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.WORKSPACE_DATA_ROOT; else process.env.WORKSPACE_DATA_ROOT = previous; });

describe('workspace asset store', () => {
  it('stores prompt templates below the D-drive workspace data root', () => {
    const asset = createPromptAsset('account-1', { name: 'Video hook', content: 'Open with the product benefit.' });
    expect(asset.kind).toBe('prompt');
    expect(asset.category).toBe('video');
    expect(listAssets('account-1', 'prompt')).toEqual([asset]);
    expect(getWorkspacePath('assets', 'account-1.json').startsWith(root)).toBe(true);
  });

  it('persists image and video prompt categories and migrates legacy prompts to video', () => {
    const imagePrompt = createPromptAsset('account-1', { name: 'Image hook', content: 'Create a product still.', category: 'image' });
    const videoPrompt = createPromptAsset('account-1', { name: 'Video hook', content: 'Animate the product.', category: 'video' });
    expect(imagePrompt.category).toBe('image');
    expect(videoPrompt.category).toBe('video');
    expect(listAssets('account-1', 'prompt').map((asset) => asset.category)).toEqual(['image', 'video']);

    const metadataPath = getWorkspacePath('assets', 'legacy-account.json');
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(metadataPath, JSON.stringify([{ id: 'legacy-prompt', accountId: 'legacy-account', kind: 'prompt', name: 'Legacy', content: 'Old prompt', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }]));
    expect(listAssets('legacy-account', 'prompt')[0]?.category).toBe('video');
  });

  it('persists uploaded assets and sanitizes the physical filename', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const asset = createUploadedAsset('account-1', 'image', {
      name: '../hero image.png',
      type: 'image/png',
      size: bytes.byteLength,
      arrayBuffer: bytes.buffer,
    });

    expect(asset.kind).toBe('image');
    expect(asset.name).toBe('../hero image.png');
    expect(asset.relativePath).toMatch(/^uploads\/account-1\/asset-[^/]+_hero_image\.png$/);
    const storedPath = getWorkspacePath(asset.relativePath!);
    expect(storedPath.startsWith(root)).toBe(true);
    expect(fs.readFileSync(storedPath)).toEqual(Buffer.from(bytes));
  });

  it('renames an asset without changing its file path', () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const asset = createUploadedAsset('account-1', 'audio', {
      name: 'voice.mp3',
      type: 'audio/mpeg',
      size: bytes.byteLength,
      arrayBuffer: bytes.buffer,
    });
    const renamed = renameAsset('account-1', asset.id, '  Product voice  ');

    expect(renamed).not.toBeNull();
    expect(renamed?.name).toBe('Product voice');
    expect(renamed?.relativePath).toBe(asset.relativePath);
    expect(listAssets('account-1', 'audio')[0]?.name).toBe('Product voice');
    expect(fs.existsSync(getWorkspacePath(asset.relativePath!))).toBe(true);
  });

  it('rejects blank rename labels and unknown asset ids', () => {
    const asset = createPromptAsset('account-1', { name: 'Prompt', content: 'Hello' });
    expect(() => renameAsset('account-1', asset.id, '   ')).toThrow();
    expect(renameAsset('account-1', 'asset-missing', 'Name')).toBeNull();
  });

  it('updates a prompt template in place', () => {
    const asset = createPromptAsset('account-1', { name: 'Prompt', content: 'Hello' });
    const updated = updatePromptAsset('account-1', asset.id, { name: 'Updated', content: 'New content' });
    expect(updated).toMatchObject({ id: asset.id, name: 'Updated', content: 'New content' });
    expect(updated?.category).toBe('video');
    const moved = updatePromptAsset('account-1', asset.id, { name: 'Updated image', content: 'New image content', category: 'image' });
    expect(moved?.category).toBe('image');
    expect(listAssets('account-1', 'prompt')).toEqual([moved]);
  });

  it('deletes metadata and the uploaded file for the owning account only', () => {
    const bytes = new Uint8Array([10, 11]);
    const asset = createUploadedAsset('account-1', 'inventory-video', {
      name: 'clip.mp4',
      type: 'video/mp4',
      size: bytes.byteLength,
      arrayBuffer: bytes.buffer,
    });
    const storedPath = getWorkspacePath(asset.relativePath!);
    expect(fs.existsSync(storedPath)).toBe(true);

    expect(deleteAsset('account-2', asset.id)).toBeNull();
    expect(getAsset('account-1', asset.id)).not.toBeNull();

    const deleted = deleteAsset('account-1', asset.id);
    expect(deleted).toEqual(asset);
    expect(getAsset('account-1', asset.id)).toBeNull();
    expect(fs.existsSync(storedPath)).toBe(false);
    expect(deleteAsset('account-1', asset.id)).toBeNull();
  });

  it('returns a readable file only when the relative path stays inside workspace storage', () => {
    const bytes = new Uint8Array([42]);
    const asset = createUploadedAsset('account-1', 'image', {
      name: 'safe.png',
      type: 'image/png',
      size: bytes.byteLength,
      arrayBuffer: bytes.buffer,
    });
    const result = readAssetFile('account-1', asset.id);
    expect(result?.asset).toEqual(asset);
    expect(result?.filePath).toBe(getWorkspacePath(asset.relativePath!));

    const metadataPath = getWorkspacePath('assets', 'account-1.json');
    fs.writeFileSync(metadataPath, JSON.stringify([{ ...asset, relativePath: '../../outside.txt' }]));
    expect(readAssetFile('account-1', asset.id)).toBeNull();
  });
});
