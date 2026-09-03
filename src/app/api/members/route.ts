import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
export async function GET() { const auth = await requireApiRole(['admin']); if (auth instanceof Response) return auth; return NextResponse.json({ success:true, data:[{ id:'op-001', name:'林然', role:'operator' },{ id:'op-002', name:'周宁', role:'operator' },{ id:'op-003', name:'陈曦', role:'operator' },{ id:'op-004', name:'许妍', role:'operator' }] }); }
