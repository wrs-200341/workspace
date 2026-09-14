import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { closeProviderTaskStore, legacyProviderTasksPath, migrateProviderTaskStore } from '../src/lib/providers/taskStore';

const source = legacyProviderTasksPath();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let backup: string | undefined;
if (fs.existsSync(source)) {
  backup = path.join(path.dirname(source), `tasks.before-sqlite-${stamp}.json`);
  fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL);
}
try {
  const before = fs.existsSync(source) ? createHash('sha256').update(fs.readFileSync(source)).digest('hex') : null;
  const backupDigest = backup ? createHash('sha256').update(fs.readFileSync(backup)).digest('hex') : null;
  if (before !== backupDigest) throw new Error('legacy_task_store_changed_during_backup');
  const result = migrateProviderTaskStore();
  const after = fs.existsSync(source) ? createHash('sha256').update(fs.readFileSync(source)).digest('hex') : null;
  if (before !== after || result.sourceSha256 !== after) throw new Error('legacy_task_store_changed_during_migration');
  console.log(JSON.stringify({ ...result, backup, verified: true }, null, 2));
} finally {
  closeProviderTaskStore();
}
