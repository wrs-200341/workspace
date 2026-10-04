import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { workspaceOwnerIdForUser } from '@/lib/workspace/access';
import { loadTaskAssignmentMetrics, taskAssignmentMetricsKey } from '@/lib/workspace/taskAssignmentMetrics';
import {
  listTaskAssignmentImageCrawls,
  queueTaskAssignmentImageCrawls,
  scheduleTaskAssignmentImageCrawlRefresh,
} from '@/lib/workspace/taskAssignmentImageCrawls';
import { createTaskAssignment, createTaskAssignments, createTaskAssignmentsForPids, listTaskAssignments, listTaskAssignmentsWithProgress } from '@/lib/workspace/taskAssignments';

export async function GET(request: NextRequest) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const operatorId = auth.role === 'admin' ? undefined : workspaceOwnerIdForUser(auth);
  const includeProgress = request.nextUrl.searchParams.get('includeProgress') === '1';
  if (!includeProgress) return NextResponse.json({ success: true, data: listTaskAssignments(operatorId) });
  const assignments = listTaskAssignmentsWithProgress(operatorId);
  scheduleTaskAssignmentImageCrawlRefresh();
  const crawls = new Map(listTaskAssignmentImageCrawls(assignments.map((assignment) => assignment.pid)).map((crawl) => [crawl.pid, crawl]));
  const metrics = await loadTaskAssignmentMetrics(assignments.map((assignment) => ({ pid: assignment.pid, source: assignment.source })));
  return NextResponse.json({
    success: true,
    data: assignments.map((assignment) => {
      const product = metrics.get(taskAssignmentMetricsKey(assignment.pid, assignment.source));
      const crawl = crawls.get(assignment.pid);
      return {
        ...assignment,
        crawlStatus: crawl?.status,
        crawlError: crawl?.error,
        crawlBatchId: crawl?.batchId,
        tapSales: product?.tapSales ?? null,
        localOrders: product?.localOrders ?? null,
        productName: product?.productName ?? null,
        productPreviewUrl: product?.productPreviewUrl ?? null,
        productRating: product?.productRating ?? null,
        commissionAmount: product?.commissionAmount ?? null,
        productStock: product?.productStock ?? null,
      };
    }),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireApiRole(['admin']);
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  try {
    if (Array.isArray(body.pids)) {
      const assignments = Array.isArray(body.assignments) ? body.assignments.map((value) => {
        const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return { operatorId: row.operatorId, quantity: row.quantity };
      }) : [];
      const data = createTaskAssignmentsForPids(body.pids, body.source, assignments, body.urgent);
      // Include skipped assignment PIDs as well: the crawl scheduler itself
      // deduplicates completed/running work, while a previously failed crawl
      // can be retried by submitting the PID again without duplicating tasks.
      const crawl = queueTaskAssignmentImageCrawls(body.pids, body.crawlType);
      return NextResponse.json({ success: true, data, crawl }, { status: 201 });
    }
    if (Array.isArray(body.assignments)) {
      const assignments = body.assignments.map((value) => {
        const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return { pid: body.pid, source: body.source, urgent: body.urgent, operatorId: row.operatorId, quantity: row.quantity };
      });
      const data = createTaskAssignments(assignments);
      const crawl = queueTaskAssignmentImageCrawls([body.pid], body.crawlType);
      return NextResponse.json({ success: true, data, crawl }, { status: 201 });
    }
    const data = createTaskAssignment({ pid: body.pid, source: body.source, urgent: body.urgent, operatorId: body.operatorId, quantity: body.quantity });
    const crawl = queueTaskAssignmentImageCrawls([body.pid], body.crawlType);
    return NextResponse.json({ success: true, data, crawl }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'assignment_create_failed' }, { status: 400 });
  }
}
