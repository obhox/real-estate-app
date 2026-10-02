import { describe, it, expect } from "vitest";
import nextConfig from "../../../next.config";

// Admin pages and APIs must never be cached (Back after sign-out must hit
// the server guard, not a stored copy).
describe("admin no-store headers", () => {
  it("covers /admin/* and /api/admin/* with no-store + no-cache headers", async () => {
    const headers = await nextConfig.headers?.();
    expect(headers).toBeDefined();
    const bySource = new Map((headers ?? []).map((h) => [h.source, h.headers]));
    for (const source of ["/admin/:path*", "/api/admin/:path*"]) {
      const entries = bySource.get(source);
      expect(entries, source).toBeDefined();
      const values = new Map(entries!.map((h) => [h.key, h.value]));
      expect(values.get("Cache-Control")).toContain("no-store");
      expect(values.get("Cache-Control")).toContain("private");
      expect(values.get("Pragma")).toBe("no-cache");
      expect(values.get("Expires")).toBe("0");
    }
  });
});
