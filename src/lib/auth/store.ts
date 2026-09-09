import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getWorkspacePath } from '@/lib/storagePaths';
import type { AuthUser, Role } from './policy';

type StoredUser = AuthUser & { passwordHash: string };
type StoredSession = { tokenHash: string; userId: string; expiresAt: number };

const SESSION_DAYS = 7;

function authDir(): string { return getWorkspacePath('auth'); }
function usersPath(): string { return path.join(authDir(), 'users.json'); }
function sessionsPath(): string { return path.join(authDir(), 'sessions.json'); }

function ensureDir(): void { fs.mkdirSync(authDir(), { recursive: true }); }

type JsonCacheEntry = { mtimeMs: number; size: number; value: unknown };
const jsonCache = new Map<string, JsonCacheEntry>();

function readJson<T>(file: string, fallback: T): T {
  ensureDir();
  try {
    const stat = fs.statSync(file);
    const cached = jsonCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value as T;
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    jsonCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch {
    jsonCache.delete(file);
    return fallback;
  }
}

function writeJson<T>(file: string, value: T): void {
  ensureDir();
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
    const stat = fs.statSync(file);
    jsonCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')): string {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [salt, expected] = encoded.split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function defaultUsers(): StoredUser[] {
  const definitions: Array<[string, string, Role, string | undefined]> = [
    ['admin', '系统管理员', 'admin', process.env.WORKSPACE_ADMIN_PASSWORD],
    ['workspace', '工作台账号', 'workspace', process.env.WORKSPACE_WORKSPACE_PASSWORD],
    ['operator', '运营账号', 'operator', process.env.WORKSPACE_OPERATOR_PASSWORD],
  ];
  return definitions.filter(([, , , password]) => Boolean(password)).map(([username, displayName, role, password]) => ({
    id: `user-${role}`,
    username,
    displayName,
    role,
    active: true,
    passwordHash: hashPassword(password as string),
  }));
}

function loadUsers(): StoredUser[] {
  const existing = readJson<StoredUser[]>(usersPath(), []);
  if (existing.length) return existing;
  const seeded = defaultUsers();
  if (seeded.length) writeJson(usersPath(), seeded);
  return seeded;
}

export function listUsers(): AuthUser[] { return loadUsers().map(({ passwordHash: _passwordHash, ...user }) => user); }

export function getUserById(id: string): AuthUser | null {
  const user = loadUsers().find((candidate) => candidate.id === id);
  if (!user) return null;
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

export function authenticate(username: string, password: string): AuthUser | null {
  const user = loadUsers().find((candidate) => candidate.username === username && candidate.active);
  if (!user || !verifyPassword(password, user.passwordHash)) return null;
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

function tokenHash(token: string): string { return crypto.createHash('sha256').update(token).digest('hex'); }

export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const sessions = readJson<StoredSession[]>(sessionsPath(), []).filter((session) => session.expiresAt > Date.now());
  sessions.push({ tokenHash: tokenHash(token), userId, expiresAt: Date.now() + SESSION_DAYS * 86400000 });
  writeJson(sessionsPath(), sessions);
  return token;
}

export function resolveSession(token: string | undefined): AuthUser | null {
  if (!token) return null;
  const sessions = readJson<StoredSession[]>(sessionsPath(), []).filter((session) => session.expiresAt > Date.now());
  const expectedHash = Buffer.from(tokenHash(token));
  const session = sessions.find((candidate) => {
    const actualHash = Buffer.from(candidate.tokenHash);
    return actualHash.length === expectedHash.length && crypto.timingSafeEqual(actualHash, expectedHash);
  });
  if (!session) return null;
  const user = loadUsers().find((candidate) => candidate.id === session.userId && candidate.active);
  if (!user) return null;
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

export function revokeSession(token: string | undefined): void {
  if (!token) return;
  const hash = tokenHash(token);
  const sessions = readJson<StoredSession[]>(sessionsPath(), []).filter((session) => session.tokenHash !== hash);
  writeJson(sessionsPath(), sessions);
}

export function createUser(input: { username: string; displayName: string; role: Role; password: string }): AuthUser {
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(input.username)) throw new Error('invalid_username');
  if (!['admin', 'workspace', 'operator'].includes(input.role)) throw new Error('invalid_role');
  if (input.password.length < 8) throw new Error('password_too_short');
  if (input.password.length > 256) throw new Error('password_too_long');
  const users = loadUsers();
  if (users.some((user) => user.username === input.username)) throw new Error('username_exists');
  const displayName = (input.displayName.trim() || input.username).slice(0, 120);
  const user: StoredUser = { id: crypto.randomUUID(), username: input.username, displayName, role: input.role, active: true, passwordHash: hashPassword(input.password) };
  writeJson(usersPath(), [...users, user]);
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

export function updateUser(id: string, input: { displayName?: string; role?: Role; password?: string }): AuthUser {
  const users = loadUsers();
  const index = users.findIndex((user) => user.id === id);
  if (index < 0) throw new Error('user_not_found');
  const current = users[index];
  if (input.role !== undefined && !['admin', 'workspace', 'operator'].includes(input.role)) throw new Error('invalid_role');
  if (current.role === 'admin' && input.role !== undefined && input.role !== 'admin'
    && users.filter((user) => user.active && user.role === 'admin').length <= 1) {
    throw new Error('last_admin_cannot_demote');
  }
  const displayName = input.displayName === undefined ? current.displayName : input.displayName.trim();
  if (!displayName) throw new Error('display_name_required');
  if (input.password !== undefined && input.password.length < 8) throw new Error('password_too_short');
  if (input.password !== undefined && input.password.length > 256) throw new Error('password_too_long');
  if (input.displayName !== undefined && input.displayName.trim().length > 120) throw new Error('display_name_too_long');
  const next: StoredUser = {
    ...current,
    displayName: displayName.slice(0, 120),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.password !== undefined ? { passwordHash: hashPassword(input.password) } : {}),
  };
  writeJson(usersPath(), users.map((user, itemIndex) => itemIndex === index ? next : user));
  if (input.password !== undefined) {
    const sessions = readJson<StoredSession[]>(sessionsPath(), []).filter((session) => session.userId !== id);
    writeJson(sessionsPath(), sessions);
  }
  const { passwordHash: _passwordHash, ...safeUser } = next;
  return safeUser;
}

export function deleteUser(id: string): AuthUser {
  const users = loadUsers();
  const target = users.find((user) => user.id === id);
  if (!target) throw new Error('user_not_found');
  if (target.role === 'admin' && users.filter((user) => user.active && user.role === 'admin').length <= 1) {
    throw new Error('last_admin_cannot_delete');
  }
  writeJson(usersPath(), users.filter((user) => user.id !== id));
  const sessions = readJson<StoredSession[]>(sessionsPath(), []).filter((session) => session.userId !== id);
  writeJson(sessionsPath(), sessions);
  const { passwordHash: _passwordHash, ...safeUser } = target;
  return safeUser;
}
