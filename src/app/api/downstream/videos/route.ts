import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { getDashboardSnapshot } from '@/lib/workspace/dashboardStats';
export async function GET() { const auth = await requireApiRole(['admin', 'operator']); if (auth instanceof Response) return auth; return NextResponse.json({ success: true, data: getDashboardSnapshot().videos }); }
