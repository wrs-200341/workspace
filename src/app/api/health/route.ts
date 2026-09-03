import { NextResponse } from 'next/server';
import { ensureWorkspaceDataRoot } from '@/lib/storagePaths';

export async function GET() {
  try {
    const dataRoot = ensureWorkspaceDataRoot();
    return NextResponse.json({ success: true, data: { status: 'ok', service: 'workspace', port: 3000, dataRoot, timestamp: new Date().toISOString() } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'workspace_data_root_invalid' }, { status: 500 });
  }
}
