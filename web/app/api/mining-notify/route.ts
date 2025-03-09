import { NextRequest, NextResponse } from "next/server";
import { getMiningNotifyByHeight } from "@/lib/db/mining-notify";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const height = searchParams.get('height');

  if (!height) {
    return NextResponse.json({ error: "Missing block height" }, { status: 400 });
  }

  try {
    // Use our Prisma service to get mining notifications
    const records = await getMiningNotifyByHeight(parseInt(height));
    
    return NextResponse.json(records);
  } catch (error: Error | unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
} 