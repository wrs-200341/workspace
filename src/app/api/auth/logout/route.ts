import { NextResponse } from 'next/server';
import { AUTH_COOKIE, logoutCurrentSession } from '@/lib/auth/server';
export async function POST() { await logoutCurrentSession(); const response = NextResponse.json({ success:true }); response.cookies.set(AUTH_COOKIE, '', { httpOnly:true, expires:new Date(0), path:'/' }); return response; }
