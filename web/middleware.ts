import { NextRequest, NextResponse } from "next/server"

const corsOrigins = process.env.CORS_ORIGINS?.split(",") || []

const corsHeaders = {
  "Access-Control-Allow-Origin": corsOrigins.join(","),
  "Access-Control-Allow-Methods": "GET",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

export function middleware(request: NextRequest) {
  // Handle CORS
  if (request.method === "OPTIONS") {
    return NextResponse.json({}, { headers: corsHeaders })
  }
  const response = NextResponse.next()
  Object.entries(corsHeaders).forEach(([key, value]) => {
    response.headers.append(key, value)
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
