import { describe, expect, it } from "vitest";
import { apiOrigin } from "../api-origin";

describe("apiOrigin (where the dev server sends /api)", () => {
  it("follows API_PORT", () => {
    expect(apiOrigin("3001")).toBe("http://localhost:3001");
    expect(apiOrigin(" 4000 ")).toBe("http://localhost:4000");
  });

  it.each([undefined, "", "   ", "abc", "3000.5", "-1", "0", "70000"])(
    "falls back to 3000 for %j",
    (port) => {
      expect(apiOrigin(port)).toBe("http://localhost:3000");
    },
  );
});
