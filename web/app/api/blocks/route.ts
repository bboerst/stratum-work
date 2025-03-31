import { NextRequest, NextResponse } from 'next/server';
import { getBlocks } from '@/lib/db/blocks';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const n = searchParams.get('n') || '20';
  const before = searchParams.get('before');
  const height = searchParams.get('height');
  const after = searchParams.get('after');

  try {
    // Use our Prisma service to get blocks
    const data = await getBlocks(
      parseInt(n), 
      before ? parseInt(before) : undefined,
      height ? parseInt(height) : undefined,
      after ? parseInt(after) : undefined
    );

    // Return the data structure as is since it already matches what the frontend expects
    return NextResponse.json(data);
  } catch (error: Error | unknown) {
    console.error('Error in blocks API route:', error);
    
    // More detailed error information
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : '';
    
    // Log the detailed error for server-side debugging
    console.error(`Detailed error in /api/blocks: ${errorMessage}\n${errorStack}`);
    
    // Return a more informative error response
    return NextResponse.json(
      { 
        error: 'Server error', 
        details: errorMessage,
        code: 'BLOCKS_API_ERROR',
        // Include stack trace in development only
        ...(process.env.NODE_ENV !== 'production' ? { stack: errorStack } : {})
      },
      { status: 500 }
    );
  }
} 