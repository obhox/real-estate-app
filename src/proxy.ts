import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isInternalRole } from "@/lib/authz";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";

// Admin responses must never be cached (Back after sign-out must hit the
// server guard, not a stored copy). next.config.ts declares the same headers
// statically; this enforces them at runtime too, including on generated
// pages and redirects, which static header rules do not override.
const NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  Expires: "0",
};

function noStore(res: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(NO_STORE_HEADERS)) res.headers.set(key, value);
  return res;
}

export const proxy = auth((req) => {
  const pathname = req.nextUrl.pathname;

  // Public receipt surface: token-gated, but rate-limited per IP.
  if (pathname === "/r" || pathname.startsWith("/r/") || pathname.startsWith("/api/r/")) {
    const rl = checkRateLimit(`receipt:${clientIp(req.headers)}`, 120, 60_000);
    if (!rl.ok) return rateLimitResponse(rl.retryAfterMs);
    return NextResponse.next();
  }

  const isInternalUser = isInternalRole(req.auth?.user?.role);
  const isLoginPage = pathname === "/admin/login";
  const isApiRoute = pathname.startsWith("/api/admin");

  if (isLoginPage) {
    if (isInternalUser) {
      return noStore(NextResponse.redirect(new URL("/admin/bookings", req.url)));
    }
    return noStore(NextResponse.next());
  }

  if (!isInternalUser) {
    if (isApiRoute) {
      return noStore(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    }
    const loginUrl = new URL("/admin/login", req.url);
    return noStore(NextResponse.redirect(loginUrl));
  }

  return noStore(NextResponse.next());
});

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*", "/r/:path*", "/api/r/:path*"],
};
