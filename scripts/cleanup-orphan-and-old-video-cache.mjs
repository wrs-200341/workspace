import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const REQUIRED_PROJECT_ROOT = path.resolve('D:/all_projects/workspace');
const REQUIRED_DATA_ROOT = path.resolve(REQUIRED_PROJECT_ROOT, 'data');
const REQUIRED_GENERATED_ROOT = path.resolve(REQUIRED_DATA_ROOT, 'generated');
const REQUIRED_DATABASE = path.resolve(REQUIRED_DATA_ROOT, 'providers', 'tasks.sqlite');
const EXECUTION_CONFIRMATION = 'DELETE_GENERATED_CACHE_2026-09-21';
const SAFE_ID = /^[-A-Za-z0-9_]+$/;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.tif', '.tiff']);

function fail(message) {
  throw new Error(`[generated-cache-cleanup] ${message}`);
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function realDirectory(expected, label) {
  if (!fs.existsSync(expected)) fail(`${label}不存在：${expected}`);
  const stat = fs.lstatSync(expected);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label}不是普通目录：${expected}`);
  const real = fs.realpathSync(expected);
  if (real.toLowerCase() !== expected.toLowerCase()) fail(`${label}真实路径不一致：${expected} -> ${real}`);
  return real;
}

const execute = process.argv.includes('--execute');
const cutoff = argument('cutoff');
const confirmation = argument('confirm');
if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff ?? '')) fail('必须提供 YYYY-MM-DD 格式的 --cutoff');
if (execute && confirmation !== EXECUTION_CONFIRMATION) fail(`执行删除必须提供 --confirm=${EXECUTION_CONFIRMATION}`);

const projectRoot = fs.realpathSync(process.cwd());
if (projectRoot.toLowerCase() !== REQUIRED_PROJECT_ROOT.toLowerCase()) fail(`拒绝在目标项目外运行：${projectRoot}`);
const dataRoot = realDirectory(REQUIRED_DATA_ROOT, '数据根目录');
const generatedRoot = realDirectory(REQUIRED_GENERATED_ROOT, '生成缓存目录');
if (dataRoot.toLowerCase() !== REQUIRED_DATA_ROOT.toLowerCase()) fail(`数据根目录不匹配：${dataRoot}`);
if (generatedRoot.toLowerCase() !== REQUIRED_GENERATED_ROOT.toLowerCase()) fail(`生成缓存目录不匹配：${generatedRoot}`);
if (!inside(projectRoot, dataRoot) || !inside(dataRoot, generatedRoot) || !inside(dataRoot, REQUIRED_DATABASE)) fail('固定路径边界校验失败');
if (!fs.existsSync(REQUIRED_DATABASE) || !fs.lstatSync(REQUIRED_DATABASE).isFile()) fail(`任务数据库不存在：${REQUIRED_DATABASE}`);

function readTasks() {
  const database = new DatabaseSync(REQUIRED_DATABASE, { readOnly: true });
  try {
    const quickCheck = database.prepare('PRAGMA quick_check').all();
    if (quickCheck.length !== 1 || quickCheck[0].quick_check !== 'ok') fail(`SQLite 完整性检查失败：${JSON.stringify(quickCheck)}`);
    return database.prepare(`
      SELECT id, account_id AS accountId, mode, business_date AS businessDate
      FROM provider_tasks
    `).all();
  } finally {
    database.close();
  }
}

function composite(accountId, taskId) {
  return `${accountId}\u0000${taskId}`;
}

function scanCandidates(taskRows) {
  const tasks = new Map(taskRows.map((task) => [composite(task.accountId, task.id), task]));
  const candidates = [];
  const directories = new Map();

  for (const accountEntry of fs.readdirSync(generatedRoot, { withFileTypes: true })) {
    if (!accountEntry.isDirectory() || accountEntry.isSymbolicLink() || !SAFE_ID.test(accountEntry.name)) {
      fail(`generated 根目录存在异常账号入口：${accountEntry.name}`);
    }
    const accountDirectory = path.resolve(generatedRoot, accountEntry.name);
    if (!inside(generatedRoot, accountDirectory)) fail(`账号目录越界：${accountDirectory}`);
    realDirectory(accountDirectory, '账号目录');

    for (const taskEntry of fs.readdirSync(accountDirectory, { withFileTypes: true })) {
      if (!taskEntry.isDirectory() || taskEntry.isSymbolicLink() || !SAFE_ID.test(taskEntry.name)) {
        fail(`账号目录存在异常任务入口：${path.join(accountDirectory, taskEntry.name)}`);
      }
      const taskDirectory = path.resolve(accountDirectory, taskEntry.name);
      if (!inside(accountDirectory, taskDirectory) || !inside(generatedRoot, taskDirectory)) fail(`任务目录越界：${taskDirectory}`);
      realDirectory(taskDirectory, '任务目录');

      const task = tasks.get(composite(accountEntry.name, taskEntry.name));
      const category = !task
        ? 'orphan'
        : task.mode === 'video' && task.businessDate < cutoff
          ? 'old-queue-video'
          : null;
      if (!category) continue;

      const entries = fs.readdirSync(taskDirectory, { withFileTypes: true });
      if (!entries.length) fail(`候选任务目录为空，拒绝自动处理：${taskDirectory}`);
      const directoryFiles = [];
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) fail(`候选任务目录包含非普通文件：${path.join(taskDirectory, entry.name)}`);
        const extension = path.extname(entry.name).toLowerCase();
        const allowed = category === 'orphan'
          ? VIDEO_EXTENSIONS.has(extension) || IMAGE_EXTENSIONS.has(extension)
          : VIDEO_EXTENSIONS.has(extension);
        if (!allowed) fail(`候选任务目录包含不允许删除的扩展名：${path.join(taskDirectory, entry.name)}`);
        const file = path.resolve(taskDirectory, entry.name);
        const realFile = fs.realpathSync(file);
        if (realFile.toLowerCase() !== file.toLowerCase() || !inside(taskDirectory, realFile)) fail(`候选文件越界或为链接：${file}`);
        const stat = fs.statSync(realFile);
        if (!stat.isFile()) fail(`候选路径不是普通文件：${realFile}`);
        directoryFiles.push({
          category,
          accountId: accountEntry.name,
          taskId: taskEntry.name,
          taskDirectory,
          file: realFile,
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
      directories.set(taskDirectory, { category, accountId: accountEntry.name, taskId: taskEntry.name });
      candidates.push(...directoryFiles);
    }
  }
  return { candidates, directories };
}

function summarize(candidates, directories) {
  const result = {
    orphan: { directories: 0, files: 0, bytes: 0 },
    oldQueueVideo: { directories: 0, files: 0, bytes: 0 },
  };
  for (const directory of directories.values()) {
    const bucket = directory.category === 'orphan' ? result.orphan : result.oldQueueVideo;
    bucket.directories += 1;
  }
  for (const candidate of candidates) {
    const bucket = candidate.category === 'orphan' ? result.orphan : result.oldQueueVideo;
    bucket.files += 1;
    bucket.bytes += candidate.bytes;
  }
  for (const bucket of Object.values(result)) bucket.gibibytes = Number((bucket.bytes / 1024 / 1024 / 1024).toFixed(3));
  return result;
}

const initialTasks = readTasks();
const { candidates, directories } = scanCandidates(initialTasks);
const fingerprint = crypto.createHash('sha256')
  .update(candidates.map((item) => `${item.category}\t${item.file}\t${item.bytes}\t${item.mtimeMs}`).sort().join('\n'))
  .digest('hex');
const summary = summarize(candidates, directories);
const report = {
  mode: execute ? 'execute' : 'dry-run',
  projectRoot,
  dataRoot,
  generatedRoot,
  database: REQUIRED_DATABASE,
  cutoffExclusive: cutoff,
  rules: [
    '删除当前 SQLite 中不存在的全部孤立图片/视频缓存',
    `删除仍有任务记录且 business_date < ${cutoff} 的视频缓存`,
    '不删除 uploads、库存元数据、SQLite 任务记录或其他目录',
  ],
  databaseTasks: initialTasks.length,
  candidateFingerprint: fingerprint,
  ...summary,
  total: {
    directories: directories.size,
    files: candidates.length,
    bytes: candidates.reduce((total, item) => total + item.bytes, 0),
    gibibytes: Number((candidates.reduce((total, item) => total + item.bytes, 0) / 1024 / 1024 / 1024).toFixed(3)),
  },
  sampleFiles: candidates.slice(0, 20).map((item) => item.file),
};

if (!execute) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// Re-open the database and revalidate every candidate before the first unlink.
const currentTasks = new Map(readTasks().map((task) => [composite(task.accountId, task.id), task]));
for (const candidate of candidates) {
  const current = currentTasks.get(composite(candidate.accountId, candidate.taskId));
  if (candidate.category === 'orphan' && current) fail(`孤立任务在执行前重新出现，拒绝删除：${candidate.taskId}`);
  if (candidate.category === 'old-queue-video' && current && !(current.mode === 'video' && current.businessDate < cutoff)) {
    fail(`旧视频任务在执行前已不符合条件，拒绝删除：${candidate.taskId}`);
  }
  if (!fs.existsSync(candidate.file)) fail(`候选文件在执行前消失：${candidate.file}`);
  const fileStat = fs.lstatSync(candidate.file);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== candidate.bytes || fileStat.mtimeMs !== candidate.mtimeMs) {
    fail(`候选文件在执行前发生变化：${candidate.file}`);
  }
  const realFile = fs.realpathSync(candidate.file);
  if (realFile.toLowerCase() !== candidate.file.toLowerCase() || !inside(generatedRoot, realFile) || !inside(candidate.taskDirectory, realFile)) {
    fail(`候选文件执行前路径校验失败：${candidate.file}`);
  }
}

let deletedFiles = 0;
let deletedBytes = 0;
for (const candidate of candidates) {
  fs.unlinkSync(candidate.file);
  deletedFiles += 1;
  deletedBytes += candidate.bytes;
}

let removedEmptyTaskDirectories = 0;
for (const directory of directories.keys()) {
  if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) {
    fs.rmdirSync(directory);
    removedEmptyTaskDirectories += 1;
  }
}

console.log(JSON.stringify({
  ...report,
  deletedFiles,
  deletedBytes,
  deletedGibibytes: Number((deletedBytes / 1024 / 1024 / 1024).toFixed(3)),
  removedEmptyTaskDirectories,
}, null, 2));
