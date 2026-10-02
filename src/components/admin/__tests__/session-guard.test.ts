import { describe, it, expect } from "vitest";
import { sessionState } from "../SessionGuard";

// Drives the SessionGuard bfcache check: only a payload carrying a user
// counts as authenticated; everything else hard-navigates to /admin/login.
describe("sessionState", () => {
  it("is authenticated when the session payload has a user", () => {
    expect(sessionState({ user: { id: "u1", email: "a@x.com" } })).toBe("authenticated");
  });

  it("is anonymous without a user, with null user, or with no payload", () => {
    expect(sessionState({})).toBe("anonymous");
    expect(sessionState({ user: null })).toBe("anonymous");
    expect(sessionState(null)).toBe("anonymous");
    expect(sessionState(undefined)).toBe("anonymous");
  });
});
