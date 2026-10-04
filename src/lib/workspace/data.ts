export type WorkspaceCategory = 'featured' | 'remix';

export type WorkspaceOperator = {
  id: string;
  username: string;
  name: string;
  accountCount: number;
};

export type WorkspaceAccount = {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  category: WorkspaceCategory;
  strategy: string;
  promptCount: number;
  fileCount: number;
  videoCount: number;
  publishedCount: number;
  updatedAt: string;
  planStatus: 'planned' | 'draft';
};

const operators: WorkspaceOperator[] = [
  { id: 'operator-guoqingqing', username: 'guoqingqing', name: '郭青青', accountCount: 0 },
  { id: 'operator-chenxi', username: 'chenxi', name: '陈曦', accountCount: 0 },
  { id: 'operator-wufengyan', username: 'wufengyan', name: '吴凤燕', accountCount: 0 },
  { id: 'operator-zili', username: 'zili', name: '自莉', accountCount: 0 },
  { id: 'operator-meiyi', username: 'meiyi', name: '美怡', accountCount: 0 },
  { id: 'operator-zhangyuxuan', username: 'zhangyuxuan', name: '张羽娟', accountCount: 0 },
];

const accounts: WorkspaceAccount[] = operators.flatMap((operator, operatorIndex) => [
  {
    id: `workspace-account-${operatorIndex + 1}-a`, ownerId: operator.id, ownerName: operator.name,
    name: `${operator.name} · 精选账号`, category: 'featured', strategy: '围绕高转化商品，保持稳定更新和清晰的商品演示。',
    // Counters are intentionally initialised to zero.  They represent live
    // workspace data and must not display fabricated/demo values before an
    // account has produced any assets.
    promptCount: 0, fileCount: 0, videoCount: 0, publishedCount: 0,
    updatedAt: '2026-09-02 11:20', planStatus: operatorIndex % 3 === 0 ? 'draft' : 'planned',
  },
  {
    id: `workspace-account-${operatorIndex + 1}-b`, ownerId: operator.id, ownerName: operator.name,
    name: `${operator.name} · 混发视频`, category: 'remix', strategy: '复用已验证素材，快速测试不同开场和转化结构。',
    promptCount: 0, fileCount: 0, videoCount: 0, publishedCount: 0,
    updatedAt: '2026-09-01 18:40', planStatus: operatorIndex % 2 === 0 ? 'planned' : 'draft',
  },
]);

export function getWorkspaceOperators(): WorkspaceOperator[] {
  return operators.map((operator) => ({ ...operator }));
}

/**
 * Resolve the workbench owner represented by an authenticated user. Existing
 * recovered operators keep their historical ids; newly-created operator
 * users (for example `emily`) receive a deterministic owner id so accounts
 * they create remain scoped to, and visible in, their own workspace.
 */
export function getWorkspaceOperatorForUser(username: string, displayName?: string): WorkspaceOperator {
  const normalized = username.trim();
  const existing = operators.find((operator) => operator.username === normalized);
  if (existing) return { ...existing };
  return {
    id: `operator-${normalized}`,
    username: normalized,
    name: (displayName?.trim() || normalized).slice(0, 120),
    accountCount: 0,
  };
}

export function getWorkspaceAccounts(filters: { ownerId?: string; category?: WorkspaceCategory } = {}): WorkspaceAccount[] {
  return accounts
    .filter((account) => !filters.ownerId || account.ownerId === filters.ownerId)
    .filter((account) => !filters.category || account.category === filters.category)
    .map((account) => ({ ...account }));
}

export function getWorkspaceAccountById(id: string): WorkspaceAccount | undefined {
  const account = accounts.find((candidate) => candidate.id === id);
  return account ? { ...account } : undefined;
}
