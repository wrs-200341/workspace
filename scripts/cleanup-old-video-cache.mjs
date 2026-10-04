import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const REQUIRED_WORKSPACE_ROOT = path.resolve('D:/all_projects/workspace');
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi']);
const SAFE_ID = /^[-a-zA-Z0-9_]+$/;

function fail(message) {
  throw new Error(`[cleanup-old-video-cache] ${message}`);
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const execute = process.argv.includes('--execute');
const cutoff = argument('cutoff');
if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff ?? '')) fail('必须提供 YYYY-MM-DD 格式的 --cutoff');

const workspaceRoot = fs.realpathSync(process.cwd());
if (path.resolve(workspaceRoot).toLowerCase() !== REQUIRED_WORKSPACE_ROOT.toLowerCase()) {
  fail(`拒绝在目标项目外运行：${workspaceRoot}`);
}

const dataRoot = path.resolve(workspaceRoot, 'data');
const generatedRoot = path.resolve(dataRoot, 'generated');
const databasePath = path.resolve(dataRoot, 'providers', 'tasks.sqlite');
if (fs.realpathSync(dataRoot) !== dataRoot) fail(`数据目录不是预期真实路径：${dataRoot}`);
if (fs.realpathSync(generatedRoot) !== generatedRoot) fail(`生成缓存目录不是预期真实路径：${generatedRoot}`);
if (!inside(dataRoot, generatedRoot) || !inside(dataRoot, databasePath)) fail('路径边界校验失败');
if (!fs.statSync(generatedRoot).isDirectory()) fail('generated 不是目录');
if (!fs.statSync(databasePath).isFile()) fail('任务数据库不存在');

const database = new DatabaseSync(databasePath, { readOnly: true });
const tasks = database.prepare(`
  SELECT id, account_id AS accountId, status, business_date AS businessDate
  FROM provider_tasks
  WHERE mode = 'video'
    AND business_date < ?
    AND json_extract(summary, '$.inventorySavedAt') IS NULL
  ORDER BY business_date, account_id, id
`).all(cutoff);
database.close();

const candidates = [];
const skipped = [];
for (const task of tasks) {
  if (!SAFE_ID.test(task.accountId) || !SAFE_ID.test(task.id)) {
    skipped.push({ taskId: task.id, reason: '任务或账号 ID 不符合安全格式' });
    continue;
  }
  const expectedDirectory = path.resolve(generatedRoot, task.accountId, task.id);
  if (!inside(generatedRoot, expectedDirectory) || !fs.existsSync(expectedDirectory)) continue;
  let actualDirectory;
  try { actualDirectory = fs.realpathSync(expectedDirectory); } catch { continue; }
  if (actualDirectory !== expectedDirectory || !inside(generatedRoot, actualDirectory)) {
    skipped.push({ taskId: task.id, reason: '任务目录是真实路径以外的链接或越界路径' });
    continue;
  }
  const stat = fs.statSync(actualDirectory);
  if (!stat.isDirectory()) {
    skipped.push({ taskId: task.id, reason: '任务缓存路径不是目录' });
    continue;
  }
  for (const entry of fs.readdirSync(actualDirectory, { withFileTypes: true })) {
    const extension = path.extname(entry.name).toLowerCase();
    if (!entry.isFile() || !VIDEO_EXTENSIONS.has(extension)) continue;
    const expectedFile = path.resolve(actualDirectory, entry.name);
    const actualFile = fs.realpathSync(expectedFile);
    if (actualFile !== expectedFile || !inside(actualDirectory, actualFile)) {
      skipped.push({ taskId: task.id, reason: `视频文件越界或为链接：${entry.name}` });
      continue;
    }
    const fileStat = fs.statSync(actualFile);
    if (!fileStat.isFile()) continue;
    candidates.push({
      taskId: task.id,
      accountId: task.accountId,
      status: task.status,
      businessDate: task.businessDate,
      directory: actualDirectory,
      file: actualFile,
      bytes: fileStat.size,
    });
  }
}

const totalBytes = candidates.reduce((total, item) => total + item.bytes, 0);
const statusCounts = tasks.reduce((result, task) => {
  result[task.status] = (result[task.status] ?? 0) + 1;
  return result;
}, {});
const candidateStatusCounts = candidates.reduce((result, item) => {
  result[item.status] = (result[item.status] ?? 0) + 1;
  return result;
}, {});
const candidateDates = candidates.map((item) => item.businessDate).sort();
const report = {
  mode: execute ? 'execute' : 'dry-run',
  workspaceRoot,
  dataRoot,
  generatedRoot,
  cutoffExclusive: cutoff,
  rule: '仅清理截止日期以前、未入库的视频任务缓存',
  matchedTasks: tasks.length,
  matchedTaskStatuses: statusCounts,
  files: candidates.length,
  fileStatuses: candidateStatusCounts,
  oldestFileTaskDate: candidateDates[0] ?? null,
  newestFileTaskDate: candidateDates.at(-1) ?? null,
  bytes: totalBytes,
  gibibytes: Number((totalBytes / 1024 / 1024 / 1024).toFixed(3)),
  skipped,
  sampleFiles: candidates.slice(0, 20).map((item) => item.file),
};

if (!execute) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// Revalidate every selected path immediately before the first destructive
// operation. Deletions are exact files only; this script never recursively
// removes a directory.
for (const candidate of candidates) {
  if (!inside(generatedRoot, candidate.file) || !inside(candidate.directory, candidate.file)) fail(`执行前路径越界：${candidate.file}`);
  if (!fs.existsSync(candidate.file) || fs.realpathSync(candidate.file) !== candidate.file) fail(`执行前文件状态变化：${candidate.file}`);
  if (!VIDEO_EXTENSIONS.has(path.extname(candidate.file).toLowerCase())) fail(`执行前扩展名不允许：${candidate.file}`);
}

let deletedFiles = 0;
let deletedBytes = 0;
const touchedDirectories = new Set();
for (const candidate of candidates) {
  fs.rmSync(candidate.file);
  deletedFiles += 1;
  deletedBytes += candidate.bytes;
  touchedDirectories.add(candidate.directory);
}

let removedEmptyTaskDirectories = 0;
for (const directory of touchedDirectories) {
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
