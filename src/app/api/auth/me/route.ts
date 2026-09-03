import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/server';
export async function GET() { const user = await getCurrentUser(); return user ? NextResponse.json({ success:true, data:{ user } }) : NextResponse.json({ success:false, error:'unauthorized' }, { status:401 }); }
