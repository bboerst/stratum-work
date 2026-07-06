import { NextRequest, NextResponse } from "next/server"
import { getCorsHeaders } from "./lib/cors"

const corsOrigins = process.env.CORS_ORIGINS?.split(",") || []

export function middleware(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request.headers.get("host"), corsOrigins)

  // Handle CORS
  if (request.method === "OPTIONS") {
    return NextResponse.json({}, { headers: corsHeaders })
  }
  const response = NextResponse.next()
  Object.entries(corsHeaders).forEach(([key, value]) => {
    response.headers.set(key, value)
  })

  return response
}

// Configure which paths the middleware runs on
export const config = {
  matcher: [
    // Only apply to API routes
    '/api/:path*',
  ],
}
