import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.env.WORKSPACE_DATA_ROOT || 'D:/all_projects/workspace/data');
if (!root.toLowerCase().startsWith('d:\\all_projects\\workspace\\')) throw new Error('WORKSPACE_DATA_ROOT must stay on D drive');
const authDir = path.join(root, 'auth');
const usersFile = path.join(authDir, 'users.json');
const force = process.argv.includes('--force');
const definitions = [
  ['admin', '系统管理员', 'admin', process.env.WORKSPACE_ADMIN_PASSWORD],
  ['workspace', '工作台账号', 'workspace', process.env.WORKSPACE_WORKSPACE_PASSWORD],
  ['operator', '运营账号', 'operator', process.env.WORKSPACE_OPERATOR_PASSWORD],
];
if (definitions.some(([, , , password]) => typeof password !== 'string' || password.length < 10)) throw new Error('Each password must be at least 10 characters');
fs.mkdirSync(authDir, { recursive:true });
let existing = [];
try { existing = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch {}
if (existing.length && !force) throw new Error('users.json already exists; rerun with -Force to replace account passwords');
const users = definitions.map(([username, displayName, role, password]) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
  return { id:`user-${role}`, username, displayName, role, active:true, passwordHash };
});
const temp = `${usersFile}.tmp`;
fs.writeFileSync(temp, JSON.stringify(users, null, 2), { encoding:'utf8', mode:0o600 });
fs.renameSync(temp, usersFile);
