import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
export async function GET() { const auth = await requireApiRole(['admin', 'operator']); if (auth instanceof Response) return auth; return NextResponse.json({ success:true, data:[] }); }
