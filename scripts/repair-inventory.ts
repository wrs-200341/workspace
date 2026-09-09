import fs from 'node:fs';
import path from 'node:path';
import { flushProviderTaskStore, providerTasksPath } from '../src/lib/providers/taskStore';
import { repairSavedImageTaskInventory } from '../src/lib/workspace/imageInventory';
import { repairSavedVideoTaskInventory } from '../src/lib/workspace/videoInventory';

async function main() {
  const source = providerTasksPath();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(path.dirname(source), `tasks.json.before-inventory-repair-${stamp}`);
  fs.copyFileSync(source, backup);

  const repairedImages = await repairSavedImageTaskInventory();
  const repairedVideos = await repairSavedVideoTaskInventory();
  await flushProviderTaskStore();

  console.log(JSON.stringify({ repairedImages, repairedVideos, backup }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
