"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Pure decision helper (unit-tested): a /api/auth/session payload counts
// as authenticated only when it carries a user object. Anything else is
// anonymous and must land on the login page.
export function sessionState(data: unknown): "authenticated" | "anonymous" {
  if (data && typeof data === "object" && "user" in data && (data as { user?: unknown }).user) {
    return "authenticated";
  }
  return "anonymous";
}

const LOGIN = "/admin/login";
// Focus/visibility re-checks are throttled; bfcache restores always check.
const THROTTLE_MS = 30_000;

// Bfcache + stale-tab guard for the admin area. A Back-button restore or a
// refocused tab re-validates the session against the server: gone sessions
// hard-navigate to login (discarding cached admin UI), live sessions just
// refresh server data. Network errors mean "unknown", never "logged out".
export default function SessionGuard() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let lastCheck = 0;

    async function checkSession() {
      let res: Response;
      try {
        res = await fetch("/api/auth/session", { cache: "no-store" });
      } catch {
        return; // network error = unknown, not logged out
      }
      if (!res.ok || cancelled) return;
      const data: unknown = await res.json().catch(() => null);
      if (cancelled) return;
      if (sessionState(data) === "anonymous") {
        window.location.replace(LOGIN);
      } else {
        router.refresh();
      }
    }

    function checkThrottled() {
      const now = Date.now();
      if (now - lastCheck < THROTTLE_MS) return;
      lastCheck = now;
      void checkSession();
    }

    function onPageShow(e: PageTransitionEvent) {
      if (e.persisted) void checkSession();
    }

    function onFocus() {
      checkThrottled();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") checkThrottled();
    }

    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  return null;
}
