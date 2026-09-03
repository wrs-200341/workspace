export type Role = 'admin' | 'workspace' | 'operator';

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  active: boolean;
};

export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理员',
  workspace: '工作台账号',
  operator: '运营账号',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: '全局配置、账号控制和所有业务数据',
  workspace: '生产工作台、素材和任务执行',
  operator: '放映厅看板、账号/PID 数据与运营复盘',
};

export const ROLE_ORDER: Role[] = ['admin', 'workspace', 'operator'];

export const ROLE_PERMISSIONS = {
  admin: ['dashboard', 'downstream', 'workspace', 'assets', 'account-control'],
  workspace: ['workspace'],
  operator: ['dashboard', 'downstream', 'workspace', 'assets'],
} as const satisfies Record<Role, readonly string[]>;

/** Canonical page access matrix used by the route audit and smoke tests. */
export const PAGE_ROUTE_ROLES: Readonly<Record<string, readonly Role[]>> = {
  '/': ['admin', 'operator'],
  '/workspace': ['admin', 'workspace', 'operator'],
  '/workspace/accounts/:id/assets': ['admin', 'workspace', 'operator'],
  '/workspace/accounts/:id/production': ['admin', 'workspace', 'operator'],
  '/workspace/accounts/:id/production/video-tasks/:taskId': ['admin', 'workspace', 'operator'],
  '/workspace/accounts/:id/production/image-tasks/:taskId': ['admin', 'workspace', 'operator'],
  '/entry': ['admin', 'operator'],
  '/downstream': ['admin', 'operator'],
  '/accounts': ['admin', 'operator'],
  '/records': ['admin', 'operator'],
  '/tracked': ['admin', 'operator'],
  '/admin/accounts': ['admin'],
} as const;

export function routeRoles(route: string): readonly Role[] | undefined {
  const pathname = route.split('?', 1)[0];
  if (PAGE_ROUTE_ROLES[pathname]) return PAGE_ROUTE_ROLES[pathname];
  if (/^\/workspace\/accounts\/[^/]+\/production\/(video-tasks|image-tasks)\/[^/]+$/.test(pathname)) {
    return PAGE_ROUTE_ROLES['/workspace/accounts/:id/production/video-tasks/:taskId'];
  }
  if (/^\/workspace\/accounts\/[^/]+\/(assets|production)(?:\/(?:images|audio|videos|prompts))?$/.test(pathname)) {
    const suffix = pathname.includes('/assets') ? 'assets' : 'production';
    return PAGE_ROUTE_ROLES[`/workspace/accounts/:id/${suffix}`];
  }
  return undefined;
}

export function hasPermission(role: Role, permission: string): boolean {
  return (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
}

export function canAccessRole(role: Role, allowed: readonly Role[]): boolean {
  return allowed.includes(role);
}

export function landingPathForRole(role: Role): string {
  if (role === 'workspace') return '/workspace';
  return '/';
}
